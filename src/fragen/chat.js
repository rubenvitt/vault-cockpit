import { readFileSync, writeFileSync, renameSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SCHEMA, normalizeBlocks, normalizeWeb, blocksText } from './ui.js';
import { localDate } from '../cockpit/week.js';

/**
 * „Fragen“: Gespräche mit Claude über den ganzen Vault, mit Antworten als
 * Bausteinen (src/fragen/ui.js). Je Frage läuft Claude als Agent über die CLI
 * (src/lesen/claude.js) mit dem nur lesenden Vault-Zugang aus
 * src/lesen/research-mcp.js, auf Wunsch mit Internet.
 *
 * Schreiben, gemischt: Eine neue Notiz in der Inbox legt Claude selbst an
 * (Werkzeug `vault_inbox_note`, über `inbox`). Änderungen an bestehenden
 * Notizen und neue Notizen außerhalb der Inbox kommen als Vorschlag
 * (`proposal`) und werden erst mit `apply` geschrieben, über den Vault-Editor
 * (der vertrauliche Ordner und Readwise ablehnt).
 *
 * Weiterverwenden: Antwort als Notiz in die Inbox (`saveAsNote`), Checkliste
 * als Zunder-Aufgaben (`tasksFrom`, über `task(text)`).
 *
 * Nachfragen: Jede Frage bekommt die letzten Fragen und Antworten (als
 * Markdown) mit. Ein Gespräch liegt als `<id>.json` unter `dir`; es läuft
 * immer nur eine Frage zugleich, die übrigen warten.
 */

export class ChatError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

// So viel Verlauf geht bei Nachfragen mit.
const HISTORY_TURNS = 6;
const HISTORY_CHARS = 40_000;
const TIMEOUT_MS = 20 * 60_000;
const MAX_QUESTION = 4000;
const WEB_TOOLS = ['WebSearch', 'WebFetch'];
const ID = /^[0-9a-f-]{36}$/;

const SYSTEM = [
  'Du bist der Denkpartner des Menschen, dem dieser Obsidian-Vault gehört. Du sprichst ihn mit du an und antwortest auf Deutsch.',
  'Du beantwortest seine Fragen aus seinem Vault, mit den Werkzeugen mcp__vault__vault_search, vault_read, vault_links, vault_similar und vault_list. Such gründlich, bevor du antwortest: mehrere Formulierungen, die einschlägigen Notizen ganz lesen, Links folgen. Erfinde nichts; was der Vault nicht hergibt, sagst du.',
  'Du antwortest mit Bausteinen und wählst die Form, die die Antwort am klarsten macht: Vergleiche als table, Entwicklungen als timeline, Zahlen als stats oder chart, Schritte und offene Punkte als checklist, passende Notizen als notes, wörtliche Stellen als quote, Wichtiges als callout, sonst text. Lieber wenige gute Bausteine als viele. Text knapp und klar.',
  'Verweise auf Notizen mit dem Pfad, genau wie die Werkzeuge ihn nennen, im Text als [[pfad|titel]], und nur auf Notizen, die du gesehen hast.',
  'Schreiben: Bittet er dich, etwas festzuhalten oder zu notieren, legst du mit vault_inbox_note eine neue Notiz in seiner Inbox an. Bestehende Notizen änderst du nie selbst, und neue Notizen außerhalb der Inbox legst du nie selbst an: Das schlägst du als Baustein proposal vor, er bestätigt. Für replace stammt old_text wörtlich aus der Notiz (vorher mit vault_read lesen). Schlag Änderungen nur vor, wenn er darum bittet oder sie klar helfen.',
  'Du lieferst ausschließlich das verlangte JSON.',
].join('\n');

/**
 * - `dir`: Ablage der Gespräche.
 * - `writer`: Claude (src/lesen/claude.js); `research`: Vault-Zugang (`{ open() }`).
 * - `inbox({ title, text })` → `{ path }`: neue Notiz in der Inbox.
 * - `task(text)`: Zunder-Aufgabe aus einer Zeile (Schnelleingabe mit `!`).
 * - `editor`: Vault-Editor (`append`, `replace`, `setFrontmatter`, `create`).
 * - `canCreate(folder)`: darf dort eine neue Notiz hin (nicht vertraulich,
 *   ausgeschlossen, Readwise)? Wirft sonst.
 * - `tz`: Zeitzone (Wert oder Funktion) fürs Datum.
 */
export function createVaultChat({ dir, writer, research, inbox = null, task = null, editor = null, canCreate = () => {}, tz = null, now = () => new Date(), logger = console }) {
  const threads = new Map();
  try {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const t = JSON.parse(readFileSync(join(dir, f), 'utf8'));
        if (t?.id) threads.set(t.id, t);
      } catch {
        /* kaputte Datei überspringen */
      }
    }
  } catch {
    /* noch keine */
  }
  const queue = [];
  let running = null;

  function save(t) {
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${t.id}.json`);
    writeFileSync(`${file}.tmp`, `${JSON.stringify(t, null, 1)}\n`, { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
  }
  const stamp = () => now().toISOString();
  const today = () => {
    const zone = typeof tz === 'function' ? tz() : tz;
    return zone ? localDate(now(), zone) : now().toISOString().slice(0, 10);
  };

  // Unterbrochenes nach einem Neustart: als Fehler, der sich erneut stellen lässt.
  for (const t of threads.values()) {
    let changed = false;
    for (const turn of t.turns) {
      if (turn.role === 'claude' && (turn.status === 'wartet' || turn.status === 'denkt')) {
        Object.assign(turn, { status: 'fehler', error: 'Durch einen Neustart unterbrochen.' });
        changed = true;
      }
    }
    if (changed) save(t);
  }

  function get(id) {
    const t = ID.test(String(id ?? '')) ? threads.get(id) : null;
    if (!t) throw new ChatError('Dieses Gespräch gibt es nicht', 404);
    return t;
  }
  function turnOf(t, n) {
    const turn = t.turns[Number(n)];
    if (!turn || turn.role !== 'claude' || turn.status !== 'fertig') throw new ChatError('Diese Antwort gibt es nicht (mehr)', 404);
    return turn;
  }

  function missing() {
    if (!writer?.available()) return 'Fragen brauchen Claude: CLAUDE_CODE_OAUTH_TOKEN im Deployment (Token aus `claude setup-token`)';
    if (!research) return 'Fragen brauchen den Vault-Zugang für die Recherche';
    return null;
  }

  /** Frühere Fragen und Antworten als Text für Claude. */
  function history(t, upTo) {
    const pairs = [];
    for (let i = 0; i < upTo; i += 1) {
      const q = t.turns[i];
      const a = t.turns[i + 1];
      if (q.role !== 'du' || a?.role !== 'claude') continue;
      const answer = a.status === 'fertig' ? blocksText(a.blocks) : '(keine Antwort)';
      pairs.push(`<frage>\n${q.text}\n</frage>\n<antwort>\n${answer}\n</antwort>`);
    }
    let out = pairs.slice(-HISTORY_TURNS);
    while (out.length > 1 && out.join('\n').length > HISTORY_CHARS) out = out.slice(1);
    return out.join('\n\n');
  }

  async function answer(t, n) {
    const turn = t.turns[n];
    const question = t.turns[n - 1];
    Object.assign(turn, { status: 'denkt', started_at: stamp() });
    save(t);
    const session = await research.open({ inbox });
    running.session = session;
    let raw;
    try {
      const before = history(t, n - 1);
      const input = [`Heute ist ${today()}.`, before && `Bisher im Gespräch:\n\n${before}`, `Seine Frage jetzt:\n${question.text}`].filter(Boolean).join('\n\n');
      const prompt = [
        'Beantworte seine Frage (auf stdin, mit dem bisherigen Gespräch) aus seinem Vault.',
        question.web
          ? 'Ergänze mit WebSearch und WebFetch, wo der Vault nicht reicht, und nenn die Seiten unter `web`. Suchanfragen ans Internet enthalten nie persönliche Details aus dem Vault (Namen, Gesundheit, Finanzen, Arbeitgeber, Beziehungen). Was aus dem Internet kommt, kennzeichnest du.'
          : 'Kein Internet, nur sein Vault.',
      ].join('\n');
      raw = await writer.write({ system: SYSTEM, prompt, input, schema: SCHEMA, tools: question.web ? WEB_TOOLS : [], mcp: session.mcp, timeoutMs: TIMEOUT_MS });
    } finally {
      Object.assign(turn, { read: session.read(), created: session.created() });
      running.session = null;
      await session.close();
    }
    const blocks = normalizeBlocks(raw?.blocks);
    if (!blocks.length) throw new ChatError('Claude hat keine Antwort geliefert');
    Object.assign(turn, {
      status: 'fertig',
      blocks,
      followups: (Array.isArray(raw.followups) ? raw.followups : []).map((f) => String(f ?? '').trim().slice(0, 300)).filter(Boolean).slice(0, 4),
      web: question.web ? normalizeWeb(raw.web) : [],
      finished_at: stamp(),
    });
    if (!t.named) Object.assign(t, { title: String(raw.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 80) || t.title, named: true });
    t.updated_at = stamp();
    save(t);
  }

  async function next() {
    if (running || !queue.length) return;
    const { id, n } = queue.shift();
    const t = threads.get(id);
    if (!t || t.turns[n]?.status !== 'wartet') return next();
    running = { id, n, session: null };
    try {
      await answer(t, n);
    } catch (err) {
      logger.warn?.(`Fragen „${t.title}“: ${err.message}`);
      Object.assign(t.turns[n], { status: 'fehler', error: err.message });
      save(t);
    } finally {
      running = null;
    }
    return next();
  }

  function enqueue(t, n) {
    queue.push({ id: t.id, n });
    return next();
  }

  return {
    missing,
    list: () => [...threads.values()].sort((a, b) => b.updated_at.localeCompare(a.updated_at)),
    get: (id) => (ID.test(String(id ?? '')) ? (threads.get(id) ?? null) : null),
    /** Wie weit die laufende Antwort ist: gelesene Notizen bisher. */
    progress(id) {
      if (running?.id !== id) return null;
      return { turn: running.n, read: running.session?.read().length ?? 0 };
    },

    /**
     * Neue Frage, in einem neuen Gespräch oder als Nachfrage (`id`). Liefert
     * `{ thread, turn }` sofort; `done` wartet auf die Antwort (Tests).
     */
    ask({ id = null, question, web = false }) {
      const why = missing();
      if (why) throw new ChatError(why, 409);
      const q = String(question ?? '').replace(/\r\n?/g, '\n').trim();
      if (!q) throw new ChatError('Bitte eine Frage eingeben');
      if (q.length > MAX_QUESTION) throw new ChatError(`Die Frage darf höchstens ${MAX_QUESTION} Zeichen lang sein`);
      let t;
      if (id) {
        t = get(id);
        if (t.turns.some((x) => x.status === 'wartet' || x.status === 'denkt')) throw new ChatError('Claude beantwortet in diesem Gespräch noch eine Frage', 409);
      } else {
        const at = stamp();
        t = { id: randomUUID(), title: q.replace(/\s+/g, ' ').slice(0, 80), named: false, created_at: at, updated_at: at, turns: [] };
        threads.set(t.id, t);
      }
      t.turns.push({ role: 'du', text: q, web: web === true, at: stamp() }, { role: 'claude', status: 'wartet', at: stamp() });
      t.updated_at = stamp();
      save(t);
      const n = t.turns.length - 1;
      return { thread: t, turn: n, done: enqueue(t, n) };
    },

    /** Fehlgeschlagene Antwort noch einmal. */
    retry(id, n) {
      const t = get(id);
      const turn = t.turns[Number(n)];
      if (turn?.role !== 'claude' || turn.status !== 'fehler') throw new ChatError('Nur eine fehlgeschlagene Antwort lässt sich wiederholen', 409);
      const why = missing();
      if (why) throw new ChatError(why, 409);
      Object.assign(turn, { status: 'wartet', error: null });
      save(t);
      return { thread: t, turn: Number(n), done: enqueue(t, Number(n)) };
    },

    /** Vorschlag übernehmen: über den Editor, danach am Baustein vermerkt. */
    async apply(id, n, b) {
      const t = get(id);
      const turn = turnOf(t, n);
      const block = turn.blocks[Number(b)];
      if (block?.type !== 'proposal') throw new ChatError('Diesen Vorschlag gibt es nicht', 404);
      if (block.applied) throw new ChatError('Schon übernommen', 409);
      if (!editor) throw new ChatError('Der Vault ist hier nicht beschreibbar', 503);
      let path = block.path ?? null;
      try {
        if (block.action === 'append') editor.append({ path: block.path, text: block.text, heading: block.heading });
        else if (block.action === 'replace') editor.replace({ path: block.path, oldText: block.old_text, newText: block.new_text });
        else if (block.action === 'frontmatter') editor.setFrontmatter({ path: block.path, set: Object.fromEntries(block.set.map((s) => [s.key, s.value === '' ? null : s.value])) });
        else {
          canCreate(block.folder);
          path = (await editor.create({ folder: block.folder, name: `${block.name}.md`, content: `${block.text}\n` }))?.path ?? `${block.folder}/${block.name}.md`;
        }
      } catch (err) {
        if (err.code === 'EROFS' || err.code === 'EACCES') throw new ChatError('Der Vault ist auf dem Server schreibgeschützt', 503);
        throw new ChatError(err.message, 409);
      }
      block.applied = { at: stamp(), path };
      t.updated_at = stamp();
      save(t);
      return { block, path };
    },

    dismiss(id, n, b) {
      const t = get(id);
      const block = turnOf(t, n).blocks[Number(b)];
      if (block?.type !== 'proposal' || block.applied) throw new ChatError('Diesen Vorschlag gibt es nicht (mehr)', 404);
      block.dismissed = true;
      save(t);
      return block;
    },

    /** Antwort samt Frage und Quellen als neue Notiz in die Inbox. */
    async saveAsNote(id, n) {
      const t = get(id);
      const turn = turnOf(t, n);
      if (!inbox) throw new ChatError('Ohne Inbox kein Speichern', 503);
      if (turn.saved) throw new ChatError('Schon als Notiz gespeichert', 409);
      const q = t.turns[Number(n) - 1];
      const sources = [...(turn.read ?? []).map((p) => `- [[${p.replace(/\.md$/i, '')}]]`), ...(turn.web ?? []).map((w) => `- [${w.title.replace(/[[\]]/g, ' ')}](<${w.url}>) (extern)`)];
      const text = [`> ${q.text.split('\n').join('\n> ')}`, blocksText(turn.blocks), sources.length ? `## Quellen\n\n${sources.join('\n')}` : ''].filter(Boolean).join('\n\n');
      const made = await inbox({ title: `Frage – ${q.text.replace(/[\\/\n]+/g, ' ').replace(/\.\.+/g, '.').trim().slice(0, 100)}`, text });
      turn.saved = made.path;
      save(t);
      return made;
    },

    /** Checkliste als Zunder-Aufgaben; legt jede Zeile höchstens einmal an. */
    async tasksFrom(id, n, b) {
      const t = get(id);
      const turn = turnOf(t, n);
      const block = turn.blocks[Number(b)];
      if (block?.type !== 'checklist') throw new ChatError('Diese Checkliste gibt es nicht', 404);
      if (!task) throw new ChatError('Für Aufgaben fehlt der Zunder-Zugang', 503);
      block.done ??= [];
      let made = 0;
      try {
        for (const [k, item] of block.items.entries()) {
          if (block.done.includes(k)) continue;
          await task(`!${item.text.replace(/^!+/, '')}`);
          block.done.push(k);
          made += 1;
        }
      } finally {
        turn.tasks = { ...(turn.tasks ?? {}), [b]: `${block.done.length} von ${block.items.length} als Aufgaben in Zunder` };
        save(t);
      }
      return { made, total: block.items.length };
    },

    remove(id) {
      const t = get(id);
      if (running?.id === id) throw new ChatError('Claude antwortet gerade; danach löschen', 409);
      threads.delete(id);
      rmSync(join(dir, `${id}.json`), { force: true });
      return t;
    },
  };
}
