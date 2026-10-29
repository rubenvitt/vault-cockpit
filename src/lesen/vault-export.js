import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { localDate } from '../cockpit/week.js';
import { sectionBlock, findSection, writeSection } from '../vault/generated-section.js';
import { esc } from '../web/layout.js';
import { htmlToMarkdown } from './extract.js';
import { safeWikiMarkdown } from './wiki-markdown.js';

/**
 * Lesestapel → Vault (VCP-75): eine Notiz je Text, damit der Vault Quelle der
 * Wahrheit bleibt (Suche, Embeddings, Links in Obsidian).
 *
 * Angelegt wird sie mit „In den Vault“ oder „Im Vault ablegen“ (`save`,
 * VCP-96), sonst beim Archivieren, sobald es Markierungen gibt, im Ordner aus
 * den Einstellungen (Standard `raw`, die Rohquellen des Wikis), über den Editor
 * und nie in vertraulichen, ausgeschlossenen oder Readwise-Ordnern. Der
 * Dateiname folgt den Rohquellen: `YYYY-MM-DD_<slug>.md` mit dem Tag des
 * Speicherns. Danach schreibt das Cockpit nur noch den generierten Bereich
 * „markierungen“ unter „## Markierungen“ neu (src/vault/generated-section.js),
 * auf Wunsch den Bereich „text“ (Volltext als Markdown) unter „## Text“, und
 * trägt `lesestatus: gelesen` samt `gelesen:` nach; „## Eigene Gedanken“
 * darunter und alles andere bleibt unberührt.
 *
 * Mit dem Volltext kommt `ingest: offen` ins Frontmatter, wenn das Feld noch
 * fehlt: Der Skill `wiki-ingest` holt die Notiz dann als Rohquelle und setzt
 * dort ein Datum, das Cockpit fasst es danach nicht mehr an. Der Ingest des
 * Cockpits (src/lesen/ingest.js) setzt es nicht (`markIngest: false`), sonst
 * holte der Skill den Text nach einem Abbruch ein zweites Mal. `gehoert:` trägt
 * den Tag, an dem der Text zuletzt gehört wurde (`heard`, aus den Folgen).
 *
 * Gefunden wird die Notiz über `lesestapel_id` im Frontmatter (Index), nicht
 * über einen Pfad: Umbenennen und Verschieben in Obsidian schadet nicht. Liegt
 * sie inzwischen in einem vertraulichen Ordner, schreibt das Cockpit nichts
 * und legt auch keine zweite an.
 *
 * Jede Markierung steht als Zitat mit eigener Block-ID `^hl-<kurz-id>`
 * (`[[notiz#^hl-1a2b3c4d]]`), darunter ihre Notiz und eine Zeile
 * „Verknüpft: [[…]]“. Diese Wikilinks kommen aus der Notiz selbst
 * (`addLink`) und bleiben beim Neuschreiben erhalten.
 *
 * Änderungen sind entprellt (`changed(docId)`, Standard 30 s, `flush()` sofort).
 * Vorgemerktes steht in der Tabelle `export_pending` des Lesestapels und
 * übersteht so einen Absturz; beim Start holt der Export es nach. Wirft der
 * Editor (etwa weil der Sync die Notiz gleichzeitig geändert hat), bleibt das
 * Dokument vorgemerkt und der nächste Versuch kommt mit wachsendem Abstand
 * (30 s, 1, 2, 4 … min, höchstens stündlich), damit ein bleibender Fehler
 * (etwa beide Dateinamen schon vergeben) nicht alle 30 s ins Log läuft. Eine
 * neue Änderung am Dokument versucht es wieder sofort entprellt. Ab dem
 * zweiten Fehlversuch zeigt `/zustand` den Fehler (`health()`).
 */

export const NOTE_TYPE = 'lesestapel';
export const DEFAULT_FOLDER = 'raw';
export const SECTION = 'markierungen';
const HEADING = 'Markierungen';
const LABEL = 'aus dem Lesestapel, das Cockpit schreibt bis zum Endmarker neu';
export const TEXT_SECTION = 'text';
const TEXT_HEADING = 'Text';
const TEXT_LABEL = 'Volltext aus dem Lesestapel, das Cockpit schreibt bis zum Endmarker neu';
const LINKS = 'Verknüpft:';
const BLOCK_LINE = /^\^(hl-[0-9a-z]+)[ \t]*$/;
const WIKILINK = /\[\[([^[\]\n]+)\]\]/g;
/** Längster Abstand zwischen zwei Versuchen nach Fehlern. */
const MAX_BACKOFF_MS = 60 * 60 * 1000;
/** Ab so vielen Fehlversuchen in Folge meldet `/zustand` einen Fehler; einer allein ist meist der Sync. */
const FAILING_AFTER = 2;

/** Block-ID einer Markierung: `hl-` und die ersten 8 Zeichen ihrer ID. */
// Aus einem Hash: Markierungs-IDs kommen auch vom Client (`cid`) und müssen vorn nicht zufällig sein.
export const blockId = (highlightId) => `hl-${createHash('sha256').update(String(highlightId)).digest('hex').slice(0, 8)}`;

/** Wikilinks je Block-ID aus dem Bereich (Zeilen „Verknüpft: …“ unter einer Markierung). */
export function parseLinks(inner) {
  const links = new Map();
  let current = null;
  for (const line of String(inner ?? '').split('\n')) {
    const id = BLOCK_LINE.exec(line.trim());
    if (id) current = id[1];
    else if (current && line.startsWith(LINKS)) links.set(current, [...(links.get(current) ?? []), ...[...line.matchAll(WIKILINK)].map((m) => m[1])]);
  }
  return links;
}

/** Inhalt des Bereichs: je Markierung Zitat, Block-ID, Notiz und Verknüpfungen. */
export function renderHighlights(highlights, links = new Map()) {
  if (!highlights.length) return 'Keine Markierungen.';
  return highlights
    .map((h) => {
      const id = blockId(h.id);
      // Zitate stehen ganz hinter `> `, Notizen ohne `<!--`: so ähnelt keine Zeile einem Marker.
      // Beides entschärft (src/lesen/wiki-markdown.js): Obsidian blendet `<…>` sonst als HTML aus, und ein Zitat aus dem Artikel bliebe angreifbar.
      const quote = safeWikiMarkdown(String(h.quote).trim().replace(/\r\n?/g, '\n')).split('\n').map((l) => `> ${l}`.trimEnd()).join('\n');
      const note = h.note?.trim() ? safeWikiMarkdown(h.note.trim()).replaceAll('<!--', '&lt;!--') : null;
      const targets = [...new Set(links.get(id) ?? [])];
      // Die Block-ID einer Zitat-Gruppe steht in Obsidian in eigener Zeile, mit Leerzeile davor.
      return [quote, `^${id}`, note, targets.length ? `${LINKS} ${targets.map((t) => `[[${t}]]`).join(' · ')}` : null].filter(Boolean).join('\n\n');
    })
    .join('\n\n');
}

/** Dateiname aus dem Titel: klein, ASCII, Bindestriche. */
export function slugOf(text) {
  const map = { ä: 'ae', ö: 'oe', ü: 'ue', ß: 'ss' };
  return (
    String(text ?? '')
      .toLowerCase()
      .replace(/[äöüß]/g, (c) => map[c])
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+/, '')
      .slice(0, 80)
      .replace(/-+$/, '') || 'text'
  );
}

/** Volltext des Dokuments als Markdown für den Bereich „text“. */
export const fullTextOf = (doc) => htmlToMarkdown(doc.content_html) || 'Für diesen Text gibt es keinen Lesetext.';

/** Lokaler Tag eines Zeitpunkts (ISO) oder null. */
const dayOf = (iso, tz) => (iso ? localDate(new Date(iso), tz) : null);
/** `gehoert:` setzen? Nur wenn es fehlt oder einen früheren Tag nennt. */
const laterThan = (current, day) => Boolean(day) && !(String(current ?? '') >= day);

const textBlock = (doc) => sectionBlock(TEXT_SECTION, fullTextOf(doc), { label: TEXT_LABEL, spaced: true });

/**
 * Die neue Notiz: Frontmatter, Titel, Link zum Original, Kurzfassung,
 * Markierungen, mit `fullText` der Volltext (und `ingest: offen`, außer bei
 * `markIngest: false`), Platz für
 * eigene Gedanken. `read`: gelesen (Datum aus `read_at`, sonst `readAt`) oder
 * ungelesen; `gehoert:` mit `heard_at`.
 */
export function noteContent(doc, inner, { tz, read = false, readAt = null, fullText = false, markIngest = true }) {
  const str = (v) => JSON.stringify(String(v));
  const day = (iso) => dayOf(iso, tz);
  const title = String(doc.title || doc.url).replace(/\s+/g, ' ').trim();
  const url = /^https?:\/\//i.test(doc.url ?? '') ? doc.url : null;
  const comments = /^https?:\/\//i.test(doc.comments_url ?? '') ? doc.comments_url : null;
  const link = (u) => u.replace(/[<>]/g, encodeURIComponent);
  const gelesen = read ? day(doc.read_at ?? readAt) : null;
  const gehoert = day(doc.heard_at);
  // Die Kurzfassung kommt von der Webseite: eine Zeile, maskiert wie der Volltext.
  const excerpt = doc.excerpt ? htmlToMarkdown(`<p>${esc(doc.excerpt)}</p>`).replace(/\s+/g, ' ') : '';
  return [
    '---',
    `type: ${NOTE_TYPE}`,
    `lesestapel_id: ${str(doc.id)}`,
    ...(doc.site ? [`quelle: ${str(doc.site)}`] : []),
    `url: ${str(doc.url)}`,
    `gespeichert: ${day(doc.saved_at)}`,
    `lesestatus: ${read ? 'gelesen' : 'ungelesen'}`,
    ...(gelesen ? [`gelesen: ${gelesen}`] : []),
    ...(gehoert ? [`gehoert: ${gehoert}`] : []),
    ...(fullText && markIngest ? ['ingest: offen'] : []),
    ...(doc.topics.length ? ['themen:', ...doc.topics.map((t) => `  - ${str(t)}`)] : ['themen: []']),
    '---',
    '',
    `# ${title}`,
    '',
    ...(url ? [`[Original](<${link(url)}>)${comments ? ` · [Kommentare](<${link(comments)}>)` : ''}${doc.author ? ` · ${doc.author}` : ''}`, ''] : []),
    ...(excerpt ? [excerpt, ''] : []),
    `## ${HEADING}`,
    '',
    sectionBlock(SECTION, inner, { label: LABEL, spaced: true }),
    '',
    ...(fullText ? [`## ${TEXT_HEADING}`, '', textBlock(doc), ''] : []),
    '## Eigene Gedanken',
    '',
  ].join('\n');
}

/**
 * `index`, `editor`, `policy` wie für die übrigen Schreibwege; `store` ist der
 * Lesestapel, `settings.get().readingNotes.folder` der Zielordner.
 * `now` liefert die Zeit (für „gelesen“ ohne `read_at`), `delayMs` die Entprellung.
 */
export function createReadingExport({ vaultPath, index, editor, policy, store, settings, now = () => new Date(), delayMs = 30_000, logger = console }) {
  const status = { lastRun: null, lastError: null, lastWrite: null, lastOkAt: null };
  let timer = null;

  /**
   * Notiz zum Dokument über `lesestapel_id`; `writable: false` in vertraulichen oder importierten Ordnern.
   * shortcut: In einen ausgeschlossenen Ordner verschoben, kennt der Index sie
   * nicht mehr und es entsteht eine neue; bei Bedarf Pfade als Cache in der Datenbank.
   */
  function locate(docId) {
    const own = index.notesOfType(NOTE_TYPE);
    const hit = own.find((n) => String(n.frontmatter.lesestapel_id) === docId);
    if (hit) return { path: hit.path, writable: true };
    const seen = new Set(own.map((n) => n.path));
    for (const path of index.filterPaths({ include: ['core', 'readwise'], includeSensitive: true, type: NOTE_TYPE })) {
      if (!seen.has(path) && String(index.getNote(path)?.frontmatter.lesestapel_id) === docId) return { path, writable: false };
    }
    return null;
  }

  function create(doc, inner, { read, fullText, markIngest }) {
    const folder = settings.get().readingNotes?.folder ?? DEFAULT_FOLDER;
    const probe = `${folder}/_.md`;
    if (policy.isExcluded(probe) || policy.sensitivityOf(probe) || policy.classify(probe) !== 'core') {
      return { state: 'übersprungen', reason: `„${folder}“ ist vertraulich, ausgeschlossen oder Readwise; dort legt das Cockpit keine Lesestapel-Notiz an` };
    }
    // Wie die Rohquellen des Wikis (`raw/YYYY-MM-DD_slug.md`), der Tag wie bei `gespeichert:`.
    const base = `${dayOf(doc.saved_at, settings.get().tz)}_${slugOf(doc.title || doc.url)}`;
    const name = [`${base}.md`, `${base}-${blockId(doc.id).slice(3)}.md`].find((n) => !existsSync(join(vaultPath, folder, n)));
    if (!name) throw new Error(`In „${folder}“ gibt es schon „${base}.md“`);
    const r = editor.create({ folder, name, content: noteContent(doc, inner, { tz: settings.get().tz, read, readAt: now().toISOString(), fullText, markIngest }) });
    return { state: 'angelegt', path: r.path };
  }

  /**
   * Eine Notiz anlegen oder ihren Bereich neu schreiben; `force` legt auch ohne
   * Markierungen an, `link` ergänzt einen Wikilink, `unlink` nimmt einen heraus. `read` (Standard: archiviert)
   * trägt `lesestatus: gelesen` und `gelesen:` nach, `fullText` schreibt den
   * Bereich „text“ (fehlt er, kommt er vor „## Eigene Gedanken“) und
   * `ingest: offen`, wenn `ingest` fehlt und `markIngest` gilt; `gehoert:` folgt `heard_at`.
   */
  function exportDoc(docId, { force = false, link = null, unlink = null, read = undefined, fullText = false, markIngest = true } = {}) {
    const doc = store.get(docId);
    if (!doc) return { state: 'weg' };
    const found = locate(doc.id);
    if (found && !found.writable) return { state: 'übersprungen', path: found.path, reason: `„${found.path}“ liegt in einem vertraulichen oder importierten Ordner` };
    const highlights = store.listHighlights({ docId: doc.id });
    const isRead = read ?? doc.status === 'archiv';
    if (!found && !force && !(isRead && highlights.length)) return { state: 'wartet' };

    let links = new Map();
    let content = '';
    if (found) {
      content = readFileSync(join(vaultPath, found.path), 'utf8');
      const current = findSection(content, SECTION);
      if (current && !current.broken && !current.edited) links = parseLinks(current.inner);
    }
    if (link) links.set(link.id, [...(links.get(link.id) ?? []), link.target]);
    if (unlink) links.set(unlink.id, (links.get(unlink.id) ?? []).filter((t) => t !== unlink.target));
    const inner = renderHighlights(highlights, links);
    if (!found) return { ...create(doc, inner, { read: isRead, fullText, markIngest }), doc: doc.id };

    // Vorzeitig (Verknüpfen) oder ungelesen (Ablegen) angelegt: Lesestand nachtragen, nie zurücknehmen.
    const fm = index.getNote(found.path)?.frontmatter ?? {};
    const set = {};
    if (isRead && fm.lesestatus !== 'gelesen') set.lesestatus = 'gelesen';
    if (isRead && fm.gelesen == null) set.gelesen = localDate(new Date(doc.read_at ?? now().toISOString()), settings.get().tz);
    if (!isRead && fm.lesestatus == null) set.lesestatus = 'ungelesen';
    // `ingest` setzt danach der Skill (ein Datum): nur anlegen, nie überschreiben.
    if (fullText && markIngest && fm.ingest == null) set.ingest = 'offen';
    const gehoert = dayOf(doc.heard_at, settings.get().tz);
    if (laterThan(fm.gehoert, gehoert)) set.gehoert = gehoert;
    if (Object.keys(set).length) editor.setFrontmatter({ path: found.path, set });
    if (fullText && findSection(content, TEXT_SECTION)) {
      writeSection({ vaultPath, editor, path: found.path, name: TEXT_SECTION, inner: fullTextOf(doc), label: TEXT_LABEL, spaced: true, create: false });
    } else if (fullText) {
      // Ans Ende von „## Markierungen“, also vor „## Eigene Gedanken“; ohne den Abschnitt ans Ende der Notiz.
      const under = new RegExp(`^##[ \\t]+${HEADING}[ \\t]*$`, 'm').test(content) ? HEADING : null;
      editor.append({ path: found.path, heading: under, text: `\n## ${TEXT_HEADING}\n\n${textBlock(doc)}\n` });
    }
    const r = writeSection({ vaultPath, editor, path: found.path, name: SECTION, inner, label: LABEL, spaced: true, heading: HEADING, createHeading: true });
    return { ...r, path: found.path, doc: doc.id };
  }

  /** Abstand nach `attempts` Fehlversuchen: `delayMs`, dann jeweils doppelt, höchstens stündlich. */
  const backoff = (attempts) => Math.min(MAX_BACKOFF_MS, delayMs * 2 ** Math.max(0, attempts - 1));

  /** Zeitgeber auf den nächsten fälligen Versuch: frisch Vorgemerktes entprellt, Fehlgeschlagenes nach Backoff. */
  function schedule() {
    clearTimeout(timer);
    timer = null;
    const rows = store.listExportPending();
    if (!rows.length) return;
    // Abstände nach der Uhr des Rechners, nicht nach `now` (das ist nur das Datum für „gelesen“).
    const t = Date.now();
    const wait = Math.min(...rows.map((r) => (r.next_at ? Math.max(0, Date.parse(r.next_at) - t) : delayMs)));
    timer = setTimeout(() => flush({ due: true }), Math.max(wait, Math.min(delayMs, 1000)));
    timer.unref?.();
  }

  /**
   * Vorgemerktes jetzt schreiben; Fehlgeschlagenes bleibt vorgemerkt.
   * `due: true` (Zeitgeber) lässt Dokumente aus, deren Backoff noch läuft.
   */
  function flush({ due = false } = {}) {
    clearTimeout(timer);
    timer = null;
    const results = [];
    const t = Date.now();
    for (const row of store.listExportPending()) {
      if (due && row.next_at && Date.parse(row.next_at) > t) continue;
      const id = row.doc_id;
      status.lastRun = now().toISOString();
      try {
        const r = exportDoc(id);
        store.exportDone(id);
        status.lastOkAt = status.lastRun;
        if (r.state === 'angelegt' || r.state === 'geschrieben') status.lastWrite = { at: status.lastRun, path: r.path };
        if (r.state === 'übersprungen') logger.warn?.(`Lesestapel → Vault: ${r.reason}`);
        results.push(r);
      } catch (err) {
        const attempts = row.attempts + 1;
        store.exportFailed(id, { error: err.message, nextAt: new Date(t + backoff(attempts)).toISOString() });
        status.lastError = { at: status.lastRun, message: err.message };
        logger.warn?.(`Lesestapel → Vault: ${attempts === 1 ? 'später noch einmal' : `${attempts}. Fehlversuch, nächster in ${Math.round(backoff(attempts) / 60_000) || 1} min`} — ${err.message}`);
        results.push({ state: 'fehler', doc: id, error: err.message });
      }
    }
    schedule();
    return results;
  }

  // Nach einem Neustart: was vor dem Absturz vorgemerkt war, kommt jetzt dran.
  schedule();

  return {
    /** Dokument hat sich geändert (Status, Fortschritt, Markierungen): entprellt exportieren. */
    changed(docId) {
      if (!docId) return;
      store.markExportPending(String(docId));
      schedule();
    },
    flush: () => flush(),

    /**
     * Wikilink `[[target]]` zur Markierung in den Bereich „Markierungen“ ihrer
     * Lesestapel-Notiz schreiben (für „Verknüpfen“, VCP-73); legt die Notiz an,
     * wenn es sie noch nicht gibt. `target` wie in Obsidian: Notizname oder
     * Pfad ohne `.md`, auch mit `#Abschnitt` oder `|Alias`. Liefert den Zustand
     * wie `flush` (`geschrieben`, `aktuell`, `angelegt`, `übersprungen`);
     * Fehler des Editors (gleichzeitig geändert) wirft er.
     */
    addLink({ highlightId, target }) {
      const t = String(target ?? '').trim();
      if (!t || t.length > 300 || /[[\]\n\r\u0000-\u001f]/.test(t)) throw new Error('Ungültiges Ziel für einen Wikilink');
      const h = store.getHighlight(highlightId);
      if (!h) throw new Error('Diese Markierung gibt es nicht');
      return exportDoc(h.doc_id, { force: true, link: { id: blockId(h.id), target: t } });
    },

    /**
     * Rückgängig zu `addLink` (VCP-85): den Wikilink `[[target]]` unter der
     * Markierung wieder herausnehmen. Legt nie eine Notiz an; ohne Notiz oder
     * ohne den Link ist der Zustand `aktuell`. Fehler des Editors wirft er.
     */
    removeLink({ highlightId, target }) {
      const t = String(target ?? '').trim();
      const h = store.getHighlight(highlightId);
      if (!h) throw new Error('Diese Markierung gibt es nicht');
      const r = exportDoc(h.doc_id, { unlink: { id: blockId(h.id), target: t } });
      return r.state === 'wartet' ? { state: 'aktuell', doc: h.doc_id } : r;
    },

    /**
     * Notiz zum Dokument anlegen, auch ungelesen, oder ihren Bereich auffrischen
     * (Ziel eines Links aus „Verknüpfen“). Zustand wie `addLink`.
     */
    ensureNote: (docId) => exportDoc(String(docId), { force: true }),

    /**
     * „In den Vault“ (`read: true`) und „Im Vault ablegen“ (`read: false`,
     * VCP-96): Notiz sofort anlegen oder auffrischen, auch ohne Markierungen;
     * `fullText` schreibt den Volltext dazu, ein vorhandener bleibt sonst
     * unberührt; `markIngest: false` lässt `ingest: offen` weg (Ingest des
     * Cockpits). Zustand wie `addLink`; Fehler des Editors wirft er.
     */
    save: (docId, { read, fullText = false, markIngest = true }) => exportDoc(String(docId), { force: true, read: Boolean(read), fullText, markIngest }),

    /** Pfad der Lesestapel-Notiz zum Dokument oder null. */
    notePath: (docId) => locate(String(docId))?.path ?? null,

    /**
     * Gehört (Folgen): `heard_at` im Lesestapel setzen und, wo es schon eine
     * beschreibbare Notiz gibt, sofort `gehoert:` mit dem Tag. Ohne Notiz
     * bleibt es beim Lesestapel; eine später angelegte bekommt das Feld beim
     * Anlegen. Liefert je Dokument den Zustand: `vermerkt` (ohne Notiz),
     * `geschrieben`, `aktuell`, `übersprungen` (vertraulich oder importiert),
     * `weg` (unbekannt) oder `fehler`; dann holt der entprellte Export es nach.
     */
    heard(docIds) {
      const ids = [...new Set([...docIds].map(String))];
      const docs = new Map(store.markHeard(ids, now()).map((d) => [d.id, d]));
      return ids.map((id) => {
        const doc = docs.get(id);
        if (!doc) return { state: 'weg', doc: id };
        const found = locate(id);
        if (!found) return { state: 'vermerkt', doc: id };
        if (!found.writable) return { state: 'übersprungen', path: found.path, doc: id, reason: `„${found.path}“ liegt in einem vertraulichen oder importierten Ordner` };
        const gehoert = dayOf(doc.heard_at, settings.get().tz);
        if (!laterThan(index.getNote(found.path)?.frontmatter.gehoert, gehoert)) return { state: 'aktuell', path: found.path, doc: id };
        try {
          editor.setFrontmatter({ path: found.path, set: { gehoert } });
          return { state: 'geschrieben', path: found.path, doc: id };
        } catch (err) {
          store.markExportPending(id);
          schedule();
          logger.warn?.(`Lesestapel → Vault: „gehört“ später noch einmal — ${err.message}`);
          return { state: 'fehler', path: found.path, doc: id, error: err.message };
        }
      });
    },
    pending: () => store.listExportPending().map((r) => r.doc_id),
    status: () => ({ ...status }),

    /** Dienst für `/zustand` (src/health/collect.js): Fehler erst ab dem zweiten Fehlversuch in Folge. */
    health() {
      const rows = store.listExportPending();
      const failing = rows.filter((r) => r.attempts >= FAILING_AFTER);
      const last = [...failing].sort((a, b) => a.updated_at.localeCompare(b.updated_at)).at(-1);
      const name = (id) => store.get(id)?.title || id;
      const state = failing.length ? 'error' : status.lastOkAt ? 'ok' : 'unknown';
      return {
        id: 'reading-export',
        name: 'Lesestapel → Vault',
        state,
        summary: failing.length
          ? `${failing.length === 1 ? `„${name(failing[0].doc_id)}“ kommt` : `${failing.length} Texte kommen`} nicht in den Vault`
          : status.lastOkAt
            ? 'schreibt Lesestapel-Notizen'
            : 'wartet auf die erste Änderung',
        lastOkAt: status.lastOkAt,
        lastErrorAt: last?.updated_at ?? null,
        lastError: last ? `${name(last.doc_id)}: ${last.last_error}` : null,
        facts: [
          ...(rows.length ? [{ label: 'Vorgemerkt', value: String(rows.length) }] : []),
          ...(last?.next_at ? [{ label: 'Nächster Versuch', at: last.next_at }] : []),
          ...(status.lastWrite ? [{ label: 'Zuletzt geschrieben', value: status.lastWrite.path }] : []),
        ],
      };
    },
    stop() {
      clearTimeout(timer);
      timer = null;
    },
  };
}
