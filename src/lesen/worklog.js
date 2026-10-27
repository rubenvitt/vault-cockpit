import { esc } from '../web/layout.js';

/**
 * Worklog: grob, was Claude im Hintergrund tut (Fragen, Folgen, Ingest,
 * Einpflanzen), zum Aufklappen neben dem Stand. Ein Log ist ein Array von
 * Einträgen `{ at, kind, items, text }`, das am Auftrag liegt (Gespräch,
 * Folge, Ingest) und mit ihm gespeichert wird.
 *
 * - `logStep(log, text)`: ein Schritt des Cockpits („Recherche fertig …“).
 * - `logTool(log, name, input)`: ein Werkzeugaufruf von Claude, gemeldet von
 *   src/lesen/claude.js (`onTool`). Gleichartige Aufrufe direkt hintereinander
 *   werden eine Zeile („Liest „A“, „B“ und 3 weitere“), damit es grob bleibt.
 * - `worklogHtml(log, { tz })`: ausklappbar, standardmäßig zu.
 *
 * Höchstens `MAX` Zeilen; ältere fallen vorn weg.
 */

const MAX = 40;
const SHOWN = 3;
const CUT = 90;

const clip = (s) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > CUT ? `${t.slice(0, CUT - 1)}…` : t;
};
const noteName = (p) => clip(String(p ?? '').split('/').pop().replace(/\.md$/i, '')) || 'Vault';
const host = (u) => {
  try {
    return new URL(String(u)).hostname.replace(/^www\./, '');
  } catch {
    return clip(u);
  }
};

// Je Werkzeug: Art der Zeile, was davon genannt wird, und der Satzanfang.
const TOOLS = {
  vault_search: ['suche', (i) => `„${clip(i.query)}“`],
  vault_read: ['lesen', (i) => `„${noteName(i.path)}“`],
  vault_links: ['links', (i) => `„${noteName(i.path)}“`],
  vault_graph: ['links', (i) => `„${noteName(i.path)}“`],
  vault_similar: ['aehnlich', (i) => `„${noteName(i.path)}“`],
  vault_list: ['ordner', (i) => `„${clip(i.folder) || 'Vault'}“`],
  vault_inbox_note: ['inbox', (i) => `„${clip(i.title)}“`],
  vault_edit: ['schreiben', (i) => `„${noteName(i.path)}“`],
  vault_append: ['schreiben', (i) => `„${noteName(i.path)}“`],
  vault_set_frontmatter: ['schreiben', (i) => `„${noteName(i.path)}“`],
  WebSearch: ['web', (i) => `„${clip(i.query)}“`],
  WebFetch: ['seite', (i) => host(i.url)],
  StructuredOutput: ['ergebnis', () => null],
};
const LEAD = {
  suche: 'Sucht im Vault nach',
  lesen: 'Liest',
  links: 'Folgt den Verknüpfungen von',
  aehnlich: 'Sucht Ähnliches zu',
  ordner: 'Schaut in',
  inbox: 'Legt in der Inbox an:',
  schreiben: 'Ergänzt',
  web: 'Sucht im Internet nach',
  seite: 'Liest im Internet:',
};

function textOf(kind, items) {
  if (kind === 'ergebnis') return 'Schreibt das Ergebnis zusammen';
  const head = items.slice(0, SHOWN);
  const rest = items.length - head.length;
  const list = rest > 0 ? `${head.join(', ')} und ${rest} weitere` : head.length > 1 ? `${head.slice(0, -1).join(', ')} und ${head.at(-1)}` : head[0];
  return `${LEAD[kind] ?? 'Nutzt'} ${list}`;
}

function push(log, entry) {
  log.push(entry);
  if (log.length > MAX) log.splice(0, log.length - MAX);
  return entry;
}

/** Schritt des Cockpits als eigene Zeile. Gleicher Text direkt hintereinander zählt einmal. */
export function logStep(log, text, at = new Date()) {
  if (!Array.isArray(log)) return null;
  const t = clip(text);
  if (!t || log.at(-1)?.text === t) return null;
  return push(log, { at: at.toISOString(), kind: 'schritt', items: [], text: t });
}

/** Werkzeugaufruf von Claude (Name mit oder ohne `mcp__<server>__`). */
export function logTool(log, name, input = {}, at = new Date()) {
  if (!Array.isArray(log)) return null;
  const bare = String(name ?? '').replace(/^mcp__.+?__/, '');
  const [kind, itemOf] = TOOLS[bare] ?? ['sonst', () => clip(bare)];
  const item = itemOf(input ?? {});
  const last = log.at(-1);
  if (last && last.kind === kind && kind !== 'schritt') {
    if (item && !last.items.includes(item)) last.items.push(item);
    last.text = textOf(kind, last.items);
    return last;
  }
  const items = item ? [item] : [];
  return push(log, { at: at.toISOString(), kind, items, text: textOf(kind, items) });
}

/** Für JSON (App): nur Zeit und Text. */
export const worklogJson = (log) => (Array.isArray(log) ? log.map((e) => ({ at: e.at, text: e.text })) : []);

/** Ausklappbarer Worklog; leer → ''. `live`: läuft noch (letzte Zeile hervorgehoben). */
export function worklogHtml(log, { tz = null, live = false } = {}) {
  if (!Array.isArray(log) || !log.length) return '';
  const time = new Intl.DateTimeFormat('de-DE', { timeZone: tz ?? undefined, hour: '2-digit', minute: '2-digit' });
  const rows = log
    .map((e, i) => {
      const at = Date.parse(e.at);
      const now = live && i === log.length - 1;
      return `<li${now ? ' aria-current="step"' : ''}>${Number.isFinite(at) ? `<time datetime="${esc(e.at)}">${esc(time.format(at))}</time>` : ''}<span>${esc(e.text)}</span></li>`;
    })
    .join('');
  return `<details class="worklog" data-worklog><summary>Worklog <span class="meta">· ${log.length} ${log.length === 1 ? 'Schritt' : 'Schritte'}</span></summary><ol class="worklog-list">${rows}</ol></details>`;
}
