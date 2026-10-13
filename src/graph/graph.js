import { zonedToUtc } from '../cockpit/week.js';

const TASK_LINK = /\[([^\]]*)\]\((https?:\/\/[^)\s]+\/#\/aufgabe\/([A-Za-z0-9_-]+))\)/g;
const DAILY_TYPES = /daily|tages/i;

/** Zunder-Links in einer Notiz, mit dem Text der Zeile als Bezeichnung (Codeblöcke ausgenommen). */
export function findTaskLinks(content) {
  const found = new Map();
  let fence = null;
  for (const line of String(content ?? '').split(/\r?\n/)) {
    const f = line.match(/^\s*(```|~~~)/);
    if (f) {
      fence = fence === null ? f[1] : fence === f[1] ? null : fence;
      continue;
    }
    if (fence) continue;
    for (const m of line.matchAll(TASK_LINK)) {
      if (found.has(m[3])) continue;
      const label = line
        .replace(TASK_LINK, '')
        .replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/, '')
        .replace(/\s+/g, ' ')
        .trim();
      const checkbox = line.match(/^\s*(?:[-*+]|\d+[.)])\s+\[([ xX])\]/);
      found.set(m[3], { id: m[3], url: m[2], label: label || m[1].replace(/^↗\s*/, '') || 'Zunder-Aufgabe', done: checkbox ? checkbox[1] !== ' ' : null });
    }
  }
  return [...found.values()];
}

/** Datum einer Tagesnotiz: Dateiname beginnt mit JJJJ-MM-TT oder `type` ist eine Tagesnotiz mit `date`. */
export function dailyDate(note) {
  const base = note.path.slice(note.path.lastIndexOf('/') + 1);
  const m = base.match(/^(\d{4})-(\d{2})-(\d{2})(?!\d)/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const type = note.frontmatter?.type;
  const date = note.frontmatter?.date;
  if (typeof type === 'string' && DAILY_TYPES.test(type) && typeof date === 'string' && /^\d{4}-\d{2}-\d{2}/.test(date)) return date.slice(0, 10);
  return null;
}

/**
 * Graph rund um eine Notiz.
 *
 * Knotenarten: Notizen, Zunder-Aufgaben (aus Zunder-Links in der Notiz, mit
 * Status aus Zunder) und Termine (bei Tagesnotizen die Termine des Tages).
 * Kantenarten:
 *
 * - `link`: Wikilink, gerichtet von der verlinkenden Notiz zum Ziel
 * - `semantic`: inhaltlich ähnlich, aber nicht verlinkt (Embeddings)
 * - `task`, `event`: Notiz → Aufgabe bzw. Termin
 *
 * Vertrauliche Notizen bleiben ohne `includeSensitive` außen vor, Readwise-
 * Importe immer. Fällt Zunder oder der Kalender aus, steht das in `problems`,
 * der Rest des Graphen bleibt.
 */
export function createGraph({ index, semantic: semanticOrGetter = null, zunder = null, calendar = null, tz = 'Europe/Berlin', logger = console }) {
  // Client oder Funktion, die den aktuellen Client liefert (Zugang aus den Einstellungen).
  const currentZunder = typeof zunder === 'function' ? zunder : () => zunder;
  const noteId = (path) => `note:${path}`;

  async function around(path, { depth = 1, includeSensitive = false, similar = 8, minSimilarity = 0.55, maxNodes = 80 } = {}) {
    const allowed = index.filterPaths({ includeSensitive });
    if (!allowed.has(path)) return null;
    // Index oder Funktion, die den aktuellen liefert (Einstellungen → Embeddings).
    const semantic = typeof semanticOrGetter === 'function' ? semanticOrGetter() : semanticOrGetter;

    const nodes = new Map();
    const edges = new Map();
    const problems = [];
    const addNode = (node) => {
      if (!nodes.has(node.id)) nodes.set(node.id, node);
      return nodes.get(node.id);
    };
    const addEdge = (from, to, kind, extra = {}) => {
      const key = kind === 'link' ? `${from}>${to}` : `${[from, to].sort().join('|')}:${kind}`;
      if (from !== to && !edges.has(key)) edges.set(key, { from, to, kind, ...extra });
    };
    const addNote = (p, level) => addNode({ id: noteId(p), kind: 'note', path: p, level });

    // Wikilinks, Ebene für Ebene. Pro Ebene höchstens so viele neue Knoten, wie noch Platz ist.
    addNote(path, 0);
    let frontier = [path];
    for (let level = 1; level <= depth; level += 1) {
      const next = [];
      for (const p of frontier) {
        for (const n of index.outgoingLinks(p)) {
          if (!n.path || !allowed.has(n.path)) continue;
          if (!nodes.has(noteId(n.path))) {
            if (nodes.size >= maxNodes) continue;
            addNote(n.path, level);
            next.push(n.path);
          }
          addEdge(noteId(p), noteId(n.path), 'link');
        }
        for (const n of index.backlinks(p)) {
          if (!n.path || !allowed.has(n.path)) continue;
          if (!nodes.has(noteId(n.path))) {
            if (nodes.size >= maxNodes) continue;
            addNote(n.path, level);
            next.push(n.path);
          }
          addEdge(noteId(n.path), noteId(p), 'link');
        }
      }
      frontier = next;
    }

    // Semantische Kanten: ähnlich, aber nicht direkt verlinkt.
    if (semantic && similar > 0) {
      const linked = new Set([...index.outgoingLinks(path), ...index.backlinks(path)].map((n) => n.path));
      const hits = semantic.similarTo(path, { limit: similar + linked.size, allow: (p) => allowed.has(p), minScore: minSimilarity }) ?? [];
      for (const hit of hits.filter((h) => !linked.has(h.path)).slice(0, similar)) {
        if (!nodes.has(noteId(hit.path))) addNote(hit.path, 1);
        addEdge(noteId(path), noteId(hit.path), 'semantic', { score: Math.round(hit.score * 1000) / 1000 });
      }
    } else if (!semantic) {
      problems.push('Semantische Kanten sind nicht eingerichtet (Einstellungen → Embeddings)');
    }

    // Aufgaben aus Zunder-Links der Notiz und ihrer direkten Nachbarn.
    const meta = index.describe([...nodes.values()].filter((n) => n.kind === 'note').map((n) => n.path));
    const taskSources = [...nodes.values()].filter((n) => n.kind === 'note' && n.level <= 1);
    const taskNodes = [];
    for (const src of taskSources) {
      const note = index.getNote(src.path);
      for (const t of findTaskLinks(note?.content)) {
        const node = addNode({ id: `task:${t.id}`, kind: 'task', taskId: t.id, label: t.label, url: t.url, status: t.done === null ? null : t.done ? 'done' : 'open', level: src.level + 1 });
        if (node.level > src.level + 1) node.level = src.level + 1;
        if (!taskNodes.includes(node)) taskNodes.push(node);
        addEdge(src.id, node.id, 'task');
      }
    }
    const zunder = currentZunder();
    if (taskNodes.length && zunder) {
      const results = await Promise.allSettled(taskNodes.slice(0, 30).map((n) => zunder.getTask(n.taskId)));
      let failed = 0;
      results.forEach((r, i) => {
        const node = taskNodes[i];
        if (r.status === 'fulfilled' && r.value) {
          node.label = r.value.title ?? node.label;
          node.status = r.value.status ?? node.status;
          node.ref = r.value.ref ?? null;
          node.url = zunder.taskUrl(r.value.id ?? node.taskId);
        } else failed += 1;
      });
      if (failed) problems.push(`Zunder: ${failed} Aufgabe(n) nicht abrufbar, Status aus der Notiz`);
    }

    // Termine des Tages, wenn die Notiz eine Tagesnotiz ist.
    const center = index.getNote(path);
    const day = center ? dailyDate({ path, frontmatter: center.frontmatter }) : null;
    const hasCalendar = Boolean(calendar) && (calendar.configured?.() ?? true);
    if (day && hasCalendar) {
      try {
        const [y, m, d] = day.split('-').map(Number);
        const zone = typeof tz === 'function' ? tz() : tz;
        const start = zonedToUtc({ year: y, month: m, day: d }, zone);
        const end = zonedToUtc({ year: y, month: m, day: d + 1 }, zone);
        for (const e of await calendar.events(start, end)) {
          const id = `event:${e.start.toISOString()}:${e.title}`;
          addNode({ id, kind: 'event', label: e.title, start: e.start.toISOString(), end: e.end.toISOString(), allDay: e.allDay, calendar: e.calendar ?? null, level: 1 });
          addEdge(noteId(path), id, 'event');
        }
      } catch (err) {
        logger.warn?.(`Graph: Termine nicht verfügbar — ${err.message}`);
        problems.push(`Kalender: ${err.message}`);
      }
    } else if (day) {
      problems.push('Termine sind nicht eingerichtet (Einstellungen → Kalender)');
    }

    for (const n of nodes.values()) {
      if (n.kind !== 'note') continue;
      const m = meta.get(n.path) ?? index.describe([n.path]).get(n.path);
      n.label = m?.title ?? m?.basename ?? n.path;
      n.type = m?.type ?? null;
      n.sensitivity = m?.sensitivity ?? null;
    }

    return {
      center: noteId(path),
      nodes: [...nodes.values()],
      edges: [...edges.values()],
      problems,
    };
  }

  return { around };
}
