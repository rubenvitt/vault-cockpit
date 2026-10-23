import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { localDate } from '../cockpit/week.js';
import { sectionBlock, findSection, writeSection } from '../vault/generated-section.js';

/**
 * Lesestapel → Vault (VCP-75): eine Notiz je Text mit Markierungen, damit der
 * Vault Quelle der Wahrheit bleibt (Suche, Embeddings, Links in Obsidian).
 *
 * Angelegt wird sie beim Archivieren oder „fertig gelesen“ (Fortschritt 1),
 * sobald es Markierungen gibt, im Ordner aus den Einstellungen (Standard
 * `30-ressourcen/lesestapel`), über den Editor und nie in vertraulichen,
 * ausgeschlossenen oder Readwise-Ordnern. Danach schreibt das Cockpit nur noch
 * den generierten Bereich „markierungen“ unter „## Markierungen“ neu
 * (src/vault/generated-section.js); „## Eigene Gedanken“ darunter und alles
 * andere bleibt unberührt.
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
 * Wirft der Editor, weil der Sync die Notiz gleichzeitig geändert hat, bleibt
 * das Dokument vorgemerkt und der nächste Lauf versucht es wieder.
 * shortcut: Vorgemerktes lebt nur im Speicher (beim Herunterfahren wird es
 * geschrieben, ein Absturz verliert es bis zur nächsten Änderung); bei Bedarf
 * eine Tabelle per Migration.
 * shortcut: Jeder Fehler wird alle 30 s wiederholt, auch ein bleibender (etwa
 * beide Dateinamen schon vergeben); bei Bedarf Fehler zählen und aufgeben.
 */

export const NOTE_TYPE = 'lesestapel';
export const DEFAULT_FOLDER = '30-ressourcen/lesestapel';
export const SECTION = 'markierungen';
const HEADING = 'Markierungen';
const LABEL = 'aus dem Lesestapel, das Cockpit schreibt bis zum Endmarker neu';
const LINKS = 'Verknüpft:';
const BLOCK_LINE = /^\^(hl-[0-9a-z]+)[ \t]*$/;
const WIKILINK = /\[\[([^[\]\n]+)\]\]/g;

/** Block-ID einer Markierung: `hl-` und die ersten 8 Zeichen ihrer ID. */
export const blockId = (highlightId) => `hl-${String(highlightId).toLowerCase().replace(/[^0-9a-z]/g, '').slice(0, 8)}`;

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
      const quote = String(h.quote).trim().split(/\r?\n/).map((l) => `> ${l}`.trimEnd()).join('\n');
      const note = h.note?.trim().replaceAll('<!--', '&lt;!--');
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

/** Die neue Notiz: Frontmatter, Titel, Link zum Original, Markierungen, Platz für eigene Gedanken. */
export function noteContent(doc, inner, { tz, finishedAt = null }) {
  const str = (v) => JSON.stringify(String(v));
  const day = (iso) => (iso ? localDate(new Date(iso), tz) : null);
  const title = String(doc.title || doc.url).replace(/\s+/g, ' ').trim();
  const url = /^https?:\/\//i.test(doc.url ?? '') ? doc.url : null;
  const gelesen = day(doc.read_at ?? finishedAt);
  return [
    '---',
    `type: ${NOTE_TYPE}`,
    `lesestapel_id: ${str(doc.id)}`,
    ...(doc.site ? [`quelle: ${str(doc.site)}`] : []),
    `url: ${str(doc.url)}`,
    `gespeichert: ${day(doc.saved_at)}`,
    ...(gelesen ? [`gelesen: ${gelesen}`] : []),
    ...(doc.topics.length ? ['themen:', ...doc.topics.map((t) => `  - ${str(t)}`)] : ['themen: []']),
    '---',
    '',
    `# ${title}`,
    '',
    ...(url ? [`[Original](<${url.replace(/[<>]/g, encodeURIComponent)}>)${doc.author ? ` · ${doc.author}` : ''}`, ''] : []),
    `## ${HEADING}`,
    '',
    sectionBlock(SECTION, inner, { label: LABEL, spaced: true }),
    '',
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
  const pending = new Set();
  const status = { lastRun: null, lastError: null, lastWrite: null };
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

  function create(doc, inner, finished) {
    const folder = settings.get().readingNotes?.folder ?? DEFAULT_FOLDER;
    const probe = `${folder}/_.md`;
    if (policy.isExcluded(probe) || policy.sensitivityOf(probe) || policy.classify(probe) !== 'core') {
      return { state: 'übersprungen', reason: `„${folder}“ ist vertraulich, ausgeschlossen oder Readwise; dort legt das Cockpit keine Lesestapel-Notiz an` };
    }
    const slug = slugOf(doc.title || doc.url);
    const name = [`${slug}.md`, `${slug}-${blockId(doc.id).slice(3)}.md`].find((n) => !existsSync(join(vaultPath, folder, n)));
    if (!name) throw new Error(`In „${folder}“ gibt es schon „${slug}.md“`);
    const r = editor.create({ folder, name, content: noteContent(doc, inner, { tz: settings.get().tz, finishedAt: finished ? now().toISOString() : null }) });
    return { state: 'angelegt', path: r.path };
  }

  /** Eine Notiz anlegen oder ihren Bereich neu schreiben; `force` legt auch ungelesen an, `link` ergänzt einen Wikilink. */
  function exportDoc(docId, { force = false, link = null } = {}) {
    const doc = store.get(docId);
    if (!doc) return { state: 'weg' };
    const found = locate(doc.id);
    if (found && !found.writable) return { state: 'übersprungen', path: found.path, reason: `„${found.path}“ liegt in einem vertraulichen oder importierten Ordner` };
    const highlights = store.listHighlights({ docId: doc.id });
    const finished = doc.status === 'archiv' || doc.progress >= 1;
    if (!found && !force && !(finished && highlights.length)) return { state: 'wartet' };

    let links = new Map();
    if (found) {
      const current = findSection(readFileSync(join(vaultPath, found.path), 'utf8'), SECTION);
      if (current && !current.broken && !current.edited) links = parseLinks(current.inner);
    }
    if (link) links.set(link.id, [...(links.get(link.id) ?? []), link.target]);
    const inner = renderHighlights(highlights, links);
    if (!found) return { ...create(doc, inner, finished), doc: doc.id };
    // Vorzeitig (beim Verknüpfen) angelegt: „gelesen“ beim Abschluss nachtragen.
    if (finished && index.getNote(found.path)?.frontmatter.gelesen == null) {
      editor.setFrontmatter({ path: found.path, set: { gelesen: localDate(new Date(doc.read_at ?? now().toISOString()), settings.get().tz) } });
    }
    const r = writeSection({ vaultPath, editor, path: found.path, name: SECTION, inner, label: LABEL, spaced: true, heading: HEADING, createHeading: true });
    return { ...r, path: found.path, doc: doc.id };
  }

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(flush, delayMs);
    timer.unref?.();
  }

  /** Alles Vorgemerkte jetzt schreiben; Fehlgeschlagenes bleibt vorgemerkt. */
  function flush() {
    clearTimeout(timer);
    timer = null;
    const results = [];
    for (const id of [...pending]) {
      pending.delete(id);
      status.lastRun = now().toISOString();
      try {
        const r = exportDoc(id);
        if (r.state === 'angelegt' || r.state === 'geschrieben') status.lastWrite = { at: status.lastRun, path: r.path };
        if (r.state === 'übersprungen') logger.warn?.(`Lesestapel → Vault: ${r.reason}`);
        results.push(r);
      } catch (err) {
        pending.add(id);
        status.lastError = { at: status.lastRun, message: err.message };
        logger.warn?.(`Lesestapel → Vault: später noch einmal — ${err.message}`);
        results.push({ state: 'fehler', doc: id, error: err.message });
      }
    }
    if (pending.size) schedule();
    return results;
  }

  return {
    /** Dokument hat sich geändert (Status, Fortschritt, Markierungen): entprellt exportieren. */
    changed(docId) {
      if (!docId) return;
      pending.add(String(docId));
      schedule();
    },
    flush,

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
     * Notiz zum Dokument anlegen, auch ungelesen, oder ihren Bereich auffrischen
     * (Ziel eines Links aus „Verknüpfen“). Zustand wie `addLink`.
     */
    ensureNote: (docId) => exportDoc(String(docId), { force: true }),

    /** Pfad der Lesestapel-Notiz zum Dokument oder null. */
    notePath: (docId) => locate(String(docId))?.path ?? null,
    pending: () => [...pending],
    status: () => ({ ...status }),
    stop() {
      clearTimeout(timer);
      timer = null;
    },
  };
}
