import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { localDate } from '../cockpit/week.js';
import { toWebRequest, writeWebResponse } from '../http/bridge.js';
import { parseNote } from '../vault/markdown.js';
import { logStep, logTool } from './worklog.js';

/**
 * Einpflanzen nach dem Ingest: Ist ein Entwurf übernommen (src/lesen/ingest.js),
 * startet das Cockpit einen Claude-Agenten, der die Quelle in die Seiten
 * einarbeitet, an die sie andockt, Widersprüche als Spannung festhält und neue
 * Seiten im Index einträgt. Der Auftrag ist der Skill `wiki-einpflanzen`
 * (src/lesen/skills/wiki-einpflanzen/SKILL.md), derselbe, den man in den Vault
 * kopieren und von Hand aufrufen kann.
 *
 * Der Agent arbeitet nur über die Vault-Werkzeuge des Cockpits (MCP), auf einem
 * eigenen Server nur an 127.0.0.1 mit einem Token, das nur für diesen Lauf gilt.
 * Was er darf, prüft das Cockpit selbst, nicht der Prompt:
 * - lesen wie über den Connector, aber nie vertrauliche Ordner;
 * - schreiben nur in bestehende Seiten unter `wiki/` (nicht ins Log), höchstens
 *   `MAX_PAGES` Seiten je Lauf;
 * - nur ergänzen: `vault_edit` nur, wenn der neue Text den alten unverändert
 *   enthält, `vault_append` frei, im Frontmatter nur `relations`, und nur so,
 *   dass die bisherigen Einträge bleiben. Verschieben, Anlegen, Capture gibt es nicht.
 * So kann ein Text, der per Prompt-Injection Anweisungen enthält, im
 * schlimmsten Fall Unsinn anfügen, aber nichts löschen.
 *
 * Danach setzt das Cockpit `updated` der geänderten Seiten auf heute und
 * schreibt einen Eintrag „einpflanzen (cockpit)“ ins Log. Der Stand steht in
 * `applied.plant` des Ingests: `wartet`, `laeuft`, `fertig` oder `fehler`, mit
 * Zusammenfassung, geänderten Seiten und dem, was offen bleibt.
 *
 * Worklog (src/lesen/worklog.js): was der Agent liest und ergänzt, live unter
 * `worklog(docId)`, danach in `applied.plant.log`.
 *
 * Immer nur ein Lauf zugleich; nach einem Neustart gehen wartende und
 * angefangene wieder in die Warteschlange.
 */

export class PlantError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const SKILL = parseNote(readFileSync(new URL('./skills/wiki-einpflanzen/SKILL.md', import.meta.url), 'utf8')).body.trim();
const LOG = 'wiki/log.md';
const MAX_PAGES = 15;
const BODY_LIMIT = 4 * 1024 * 1024;
const READ_TOOLS = ['vault_search', 'vault_read', 'vault_links', 'vault_list', 'vault_similar', 'vault_graph'];
const EDIT_TOOLS = ['vault_edit', 'vault_append', 'vault_set_frontmatter'];
export const PLANT_STATUSES = ['wartet', 'laeuft', 'fertig', 'fehler'];

const SYSTEM = [
  'Du pflegst das persönliche Wissenswiki „Mycel“ in einem Obsidian-Vault. Eine Quelle wurde gerade ins Wiki übernommen; du pflanzt sie jetzt ein. Dein Auftrag ist der folgende Skill.',
  '',
  SKILL,
  '',
  '## Im Cockpit',
  '',
  '- Du arbeitest nur mit den Vault-Werkzeugen (vault_read, vault_search, vault_links, vault_list, vault_similar, vault_graph zum Lesen; vault_edit, vault_append, vault_set_frontmatter zum Schreiben). Vor jeder Änderung die Seite mit vault_read lesen.',
  '- Einfügen mitten in einer Seite: vault_edit mit einer eindeutigen Stelle als old_text und new_text = dieselbe Stelle plus der neue Text. Das Cockpit lehnt jede Änderung ab, bei der der alte Text nicht unverändert im neuen steht.',
  '- Ans Ende eines Abschnitts: vault_append mit heading. Einen neuen Abschnitt („## Spannungen“) legst du an, indem du ihn per vault_edit vor „## Quellen“ einfügst oder per vault_append ans Ende stellst.',
  '- Frontmatter nur `relations` (Liste wie "contradicts [[ziel]]"), immer mit allen bisherigen Einträgen. `updated` setzt das Cockpit selbst.',
  `- Höchstens ${MAX_PAGES} Seiten, nur unter wiki/, nicht ${LOG}. Neue Seiten legst du nicht an.`,
  '- Am Ende lieferst du das verlangte JSON: `zusammenfassung` (1–3 Sätze), `eingepflanzt` (je geänderter Seite Pfad und was sie bekommen hat), `offen` (was ein Mensch entscheiden sollte, 0–5 Punkte).',
].join('\n');

const PROMPT = 'Auf stdin steht, was gerade ins Wiki übernommen wurde (<ingest>). Pflanze die Quelle ein, wie im Skill beschrieben, und berichte danach.';

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['zusammenfassung', 'eingepflanzt', 'offen'],
  properties: {
    zusammenfassung: { type: 'string' },
    eingepflanzt: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['path', 'was'], properties: { path: { type: 'string' }, was: { type: 'string' } } } },
    offen: { type: 'array', items: { type: 'string' } },
  },
};

const oneLine = (v, max = 300) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const stemOf = (path) => String(path).split('/').pop().replace(/\.md$/i, '');
const list = (v) => (Array.isArray(v) ? v : []);
const relationList = (v) => [v ?? []].flat().filter((x) => x != null && String(x).trim()).map((x) => String(x).trim());

/**
 * Editor für den Agenten: nur bestehende Seiten unter `wiki/` (ohne Log, ohne
 * versteckte Ordner), nur ergänzen, höchstens `maxPages` Seiten. `onWrite(path)`
 * nach jeder tatsächlichen Änderung.
 */
export function guardEditor(editor, { index, maxPages = MAX_PAGES, onWrite = () => {} }) {
  const touched = new Set();
  const check = (path) => {
    const p = String(path ?? '');
    if (!/^wiki\/.+\.md$/.test(p) || p === LOG || p.split('/').some((s) => s.startsWith('.') || s === '..')) {
      throw new Error(`Nur Seiten unter wiki/ (außer ${LOG}) sind für das Einpflanzen freigegeben, nicht „${p}“`);
    }
    if (!touched.has(p) && touched.size >= maxPages) throw new Error(`Höchstens ${maxPages} Seiten je Lauf; „${p}“ bleibt unverändert`);
    return p;
  };
  const done = (r) => {
    if (r?.changed) {
      touched.add(r.path);
      onWrite(r.path);
    }
    return r;
  };
  return {
    touched,
    replace({ path, oldText, newText, replaceAll = false }) {
      const p = check(path);
      if (replaceAll) throw new Error('replace_all ist beim Einpflanzen gesperrt; eine eindeutige Stelle wählen');
      if (!String(newText ?? '').includes(String(oldText ?? ''))) {
        throw new Error('Beim Einpflanzen wird nur ergänzt: new_text muss old_text unverändert enthalten. Bestehenden Text nicht umschreiben oder löschen.');
      }
      return done(editor.replace({ path: p, oldText, newText }));
    },
    append({ path, text, heading = null }) {
      return done(editor.append({ path: check(path), text, heading }));
    },
    setFrontmatter({ path, set }) {
      const p = check(path);
      const keys = Object.keys(set ?? {});
      if (keys.some((k) => k !== 'relations')) throw new Error('Beim Einpflanzen ist im Frontmatter nur `relations` freigegeben; `updated` setzt das Cockpit');
      const before = relationList(index.getNote(p)?.frontmatter?.relations);
      const after = relationList(set.relations);
      const lost = before.filter((r) => !after.includes(r));
      if (lost.length) throw new Error(`relations nur ergänzen; es fehlten danach: ${lost.join(', ')}`);
      return done(editor.setFrontmatter({ path: p, set: { relations: after } }));
    },
    move() {
      throw new Error('Verschieben ist beim Einpflanzen gesperrt');
    },
  };
}

/** Eingabe für den Agenten: Source-Page, Rohquelle, Digest, was das Übernehmen schon geschrieben hat. */
export function inputFor(row) {
  const a = row.applied ?? {};
  const d = row.draft?.digest ?? {};
  const r = a.result ?? {};
  const lines = (items, fmt) => (list(items).length ? list(items).map((x) => `- ${fmt(x)}`).join('\n') : '- keine');
  const pages = (paths) => (list(paths).length ? list(paths).join(', ') : 'keine');
  return [
    '<ingest>',
    `Source-Page: ${a.source} (Titel: ${oneLine(a.title ?? row.draft?.source?.title, 200)}, Slug: ${a.slug})`,
    `Rohquelle: ${a.raw ?? '?'}`,
    '',
    'Kernaussagen:',
    lines(d.kernaussagen, (k) => oneLine(k, 600)),
    '',
    'Neu für das Wiki:',
    lines(d.neu, (k) => oneLine(k, 600)),
    '',
    'Bestätigt:',
    lines(d.bestaetigt, (b) => `${b.path} — ${oneLine(b.claim, 500)}`),
    '',
    'Widerspricht:',
    lines(d.widerspricht, (w) => `${w.path} — ${oneLine(w.claim, 500)}${w.vorschlag ? ` — Vorschlag: ${oneLine(w.vorschlag, 500)}` : ''}`),
    '',
    'Dockt an:',
    lines(d.dockt_an, (x) => `${x.path} — ${oneLine(x.warum, 500)}`),
    '',
    'Hinweise aus dem Entwurf:',
    lines(row.draft?.hinweise, (h) => oneLine(h, 300)),
    '',
    'Beim Übernehmen schon geschrieben:',
    `- neu angelegt: ${pages(list(r.written).filter((p) => p !== a.source))}`,
    `- verknüpft (Link unter „## Quellen“): ${pages(r.linked)}`,
    `- bestätigt: ${pages(r.confirmed)}`,
    `- Synthesen um einen Abschnitt ergänzt: ${pages(r.extended)}`,
    '</ingest>',
  ].join('\n');
}

/** Body bis `limit` Bytes; mehr bricht ab. */
function readBody(req, limit = BODY_LIMIT) {
  return new Promise((resolve, reject) => {
    const parts = [];
    let size = 0;
    req.on('data', (b) => {
      size += b.length;
      if (size > limit) {
        reject(new Error('Anfrage zu groß'));
        req.destroy();
      } else parts.push(b);
    });
    req.on('end', () => resolve(Buffer.concat(parts)));
    req.on('error', reject);
  });
}

/**
 * MCP-Server für einen Lauf: nur 127.0.0.1, zufälliger Port, nur `/mcp` mit
 * dem Token dieses Laufs. `handler` ist ein `createVaultMcpHandler`.
 */
async function startLoopback(handler, token, logger) {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname !== '/mcp') {
        res.writeHead(404).end();
        return;
      }
      if ((req.headers.authorization ?? '') !== `Bearer ${token}`) {
        res.writeHead(401).end();
        return;
      }
      const body = req.method === 'GET' || req.method === 'HEAD' ? null : await readBody(req);
      await writeWebResponse(res, await handler.fetch(toWebRequest(req, body, 'http://127.0.0.1')));
    } catch (err) {
      logger.warn?.(`Einpflanzen: MCP-Anfrage fehlgeschlagen: ${err.message}`);
      if (!res.headersSent) res.writeHead(500).end();
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return { url: `http://127.0.0.1:${server.address().port}/mcp`, close: () => new Promise((r) => server.close(() => r())) };
}

/**
 * - `store`: Lesestapel mit `getIngest`, `saveIngest`, `listIngests`.
 * - `claude`: src/lesen/claude.js mit `available()` und `agent()`.
 * - `mcp({ editor, verifyToken })` → MCP-Handler (createVaultMcpHandler, ohne vertrauliche Ordner).
 * - `editor`, `index`: wie für die übrigen Schreibwege; der Agent bekommt `guardEditor(editor)`.
 * - `settings.get()`: `tz` und `ingest.agent` (aus = kein Einpflanzen nach dem Übernehmen).
 * - `log(entry)`: hängt einen Eintrag an `wiki/log.md` (vom Ingest-Dienst).
 */
export function createPlanter({ store, claude, mcp, editor, index, settings, log = () => {}, logger = console, now = () => new Date(), resumeDelayMs = 1000 }) {
  const queue = [];
  let pump = null;
  // Worklog des laufenden Agenten (nur im Speicher, bis er fertig ist).
  const logs = new Map();
  const iso = () => now().toISOString();
  const today = () => localDate(now(), settings.get().tz);

  function available() {
    if (!claude?.available?.() || typeof claude.agent !== 'function') return { ok: false, reason: 'Einpflanzen braucht Claude: CLAUDE_CODE_OAUTH_TOKEN im Deployment' };
    return { ok: true };
  }
  const enabled = () => settings.get().ingest?.agent !== false;

  /** Stand in `applied.plant` ändern; der Rest von `applied` bleibt. */
  function setPlant(docId, patch) {
    const row = store.getIngest(docId);
    if (!row?.applied) return null;
    const plant = { ...(row.applied.plant ?? {}), ...patch };
    store.saveIngest(docId, { applied: { ...row.applied, plant } });
    return plant;
  }

  async function plantOne(docId) {
    const row = store.getIngest(docId);
    if (row?.status !== 'uebernommen' || row.applied?.plant?.status !== 'wartet') return;
    const a = row.applied;
    const title = oneLine(a.title ?? row.draft?.source?.title ?? docId, 200);
    setPlant(docId, { status: 'laeuft', started_at: iso(), error: null, log: null });
    const steps = [];
    logs.set(docId, steps);
    logStep(steps, `Agent startet mit der Source-Page „${a.slug ?? title}“`, now());
    const token = randomBytes(32).toString('base64url');
    const guarded = guardEditor(editor, { index });
    let server = null;
    try {
      if (!a.source || !a.slug) throw new PlantError('Zu diesem Ingest fehlt die Source-Page');
      const principal = { subject: 'cockpit-einpflanzen', scopes: ['vault:read', 'vault:edit'], expiresAt: Math.floor(Date.now() / 1000) + 3600 };
      server = await startLoopback(mcp({ editor: guarded, verifyToken: (t) => (t === token ? principal : null) }), token, logger);
      const out = await claude.agent({ system: SYSTEM, prompt: PROMPT, input: inputFor(row), schema: SCHEMA, mcp: { name: 'vault', url: server.url, token }, tools: [...READ_TOOLS, ...EDIT_TOOLS], onTool: (name, args) => logTool(steps, name, args, now()) });

      // Was sich geändert hat, weiß das Cockpit selbst; Claudes Bericht liefert nur die Beschreibung.
      const changed = [...guarded.touched];
      const was = new Map(list(out?.eingepflanzt).filter((e) => changed.includes(e?.path)).map((e) => [e.path, oneLine(e.was, 300)]));
      for (const p of changed) {
        try {
          if (String(index.getNote(p)?.frontmatter?.updated ?? '').slice(0, 10) !== today()) editor.setFrontmatter({ path: p, set: { updated: today() } });
        } catch (err) {
          logger.warn?.(`Einpflanzen: updated in ${p} nicht gesetzt: ${err.message}`);
        }
      }
      const offen = list(out?.offen).map((o) => oneLine(o, 300)).filter(Boolean).slice(0, 5);
      const summary = oneLine(out?.zusammenfassung, 600);
      try {
        log(
          [
            `## [${today()}] einpflanzen (cockpit) | ${title}`,
            `- Source-Page: [[${a.slug}]]`,
            `- Eingepflanzt: ${changed.length ? changed.map((p) => `[[${stemOf(p)}]]`).join(', ') : '—'}`,
            ...offen.map((o) => `- Offen: ${o}`),
          ].join('\n'),
        );
      } catch (err) {
        logger.warn?.(`Einpflanzen: Log nicht geschrieben: ${err.message}`);
      }
      logStep(steps, `Fertig: ${changed.length} ${changed.length === 1 ? 'Seite' : 'Seiten'} ergänzt`, now());
      setPlant(docId, { log: steps, status: 'fertig', finished_at: iso(), summary, changed: changed.map((path) => ({ path, was: was.get(path) ?? null })), open: offen, error: null });
      logger.info?.(`Einpflanzen „${title}“: ${changed.length} Seiten geändert`);
    } catch (err) {
      logger.warn?.(`Einpflanzen „${title}“: ${err.message}`);
      // Was schon geschrieben ist, bleibt; ein neuer Lauf sieht es und ergänzt nicht doppelt.
      logStep(steps, `Abgebrochen: ${err.message}`, now());
      setPlant(docId, { log: steps, status: 'fehler', finished_at: iso(), error: err.message, changed: [...guarded.touched].map((path) => ({ path, was: null })) });
    } finally {
      logs.delete(docId);
      await server?.close();
    }
  }

  function kick() {
    if (pump) return pump;
    pump = (async () => {
      while (queue.length) await plantOne(queue.shift());
    })().finally(() => {
      pump = null;
      if (queue.length) kick();
    });
    return pump;
  }

  /**
   * Einreihen. Nach dem Übernehmen (`auto`) nur, wenn eingeschaltet und Claude
   * da ist, sonst still null; von Hand (Knopf) mit Fehlermeldung. Liefert den
   * Status oder null.
   */
  function request(docId, { auto = false } = {}) {
    const id = String(docId ?? '');
    const row = store.getIngest(id);
    const ok = available();
    if (auto && (!enabled() || !ok.ok)) return null;
    if (!ok.ok) throw new PlantError(ok.reason, 409);
    if (row?.status !== 'uebernommen') throw new PlantError('Erst ins Wiki übernehmen, dann einpflanzen', 409);
    const cur = row.applied?.plant?.status;
    if (cur === 'wartet' || cur === 'laeuft') return cur;
    setPlant(id, { status: 'wartet', requested_at: iso(), started_at: null, finished_at: null, error: null, summary: null, changed: [], open: [], log: null });
    queue.push(id);
    kick();
    return 'wartet';
  }

  // Beim Start: Wartendes und Angefangenes wieder einreihen, älteste zuerst.
  const pending = store
    .listIngests({ status: 'uebernommen' })
    .filter((r) => ['wartet', 'laeuft'].includes(r.applied?.plant?.status))
    .sort((x, y) => String(x.applied.plant.requested_at ?? '').localeCompare(String(y.applied.plant.requested_at ?? '')));
  for (const r of pending) {
    setPlant(r.doc_id, { status: 'wartet' });
    queue.push(r.doc_id);
  }
  if (queue.length && available().ok) setTimeout(kick, resumeDelayMs).unref?.();

  return {
    available,
    enabled,
    request,
    /** Worklog eines Laufs: live, sonst der gespeicherte; sonst null. */
    worklog: (docId) => logs.get(docId) ?? store.getIngest(docId)?.applied?.plant?.log ?? null,
    /** Läufe, die warten oder laufen. */
    busy: () => store.listIngests({ status: 'uebernommen' }).filter((r) => ['wartet', 'laeuft'].includes(r.applied?.plant?.status)).length,
    /** Wartet, bis die Warteschlange leer ist (Tests). */
    async idle() {
      if (!pump && queue.length) kick();
      while (pump) await pump;
    },
    SYSTEM,
    SCHEMA,
  };
}
