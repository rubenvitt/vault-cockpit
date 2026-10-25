import { parseMarkdown, parseInline } from './markdown-render.js';
import { obsidianLink } from './render.js';
import { SYNTHESIS, fmValue, openPoints, synthesisOutline } from './synthesis-render.js';

/** Frontmatter-Wert als Text: Listen mit Komma, Objekte als JSON. */
export const fmText = (v) => (Array.isArray(v) ? v.join(', ') : typeof v === 'object' && v ? JSON.stringify(v) : String(v ?? ''));

/** Wie `fmText`, Wikilinks nur mit ihrer Anzeige (für die kompakte Zeile). */
export const fmPlain = (v) => fmText(v).replace(/!?\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, t, l) => l ?? t);

/** Frontmatter, das die Notizseite zeigt: alles außer den Tags, als `[Schlüssel, Wert]`. */
export const visibleFrontmatter = (note) => Object.entries(note.frontmatter ?? {}).filter(([k]) => k !== 'tags' && k !== 'tag');

/** So viele ähnliche Notizen zeigt die Notizseite unter „Ähnlich“. */
const SIMILAR_SHOWN = 6;

/** Id des Dokuments aus einem Link wie `/lesen/doc?id=…#h-…`, sonst null. */
function docIdOf(href) {
  try {
    return new URL(href, 'http://cockpit.invalid').searchParams.get('id');
  } catch {
    return null;
  }
}

/**
 * Notizseite als JSON für die iOS-App (`GET /api/notiz?pfad=…`): dieselben
 * Daten wie `renderNote` (src/web/note-render.js), der Text als Baum aus
 * `parseMarkdown` (Blöcke und Inline-Teile, Wikilinks schon aufgelöst).
 *
 * - `frontmatter`: `[{ key, text, content }]` ohne Tags; `text` kompakt
 *   (Wikilinks als Anzeige), `content` als Inline-Teile mit aufgelösten Links
 * - `synthesis` (nur `type: synthesis`): Zusammenfassung (Inline-Teile), Art,
 *   Status, Vertrauen, Thesen (`{ id, text }`, Anker im Text), offene Punkte;
 *   `toZunder` sagt, ob „Als Aufgaben nach Zunder“ geht
 * - `evidence` (nur Synthesen): passende neue Markierungen aus dem Lesestapel
 *   für `/aktion/synthese/beleg` (`id` ist die Markierung, `docId` das Dokument)
 * - `related`: Backlinks und bis zu sechs ähnliche Notizen wie auf der Seite
 * - `suggestions` (nur Inbox, nur mit Schreibrecht): Tags, Ordner, nicht verlinkte Ähnliche
 * - `targets`, `archive` (null, wenn die Notiz schon im Archiv liegt), `can`
 *
 * Die Optionen sind die von `renderNote` ohne das, was nur die HTML-Seite braucht.
 */
export function noteJson(note, { write = false, targets = [], archive = null, vaultName = null, related = null, graph = false, suggestions = null, zunder = false, evidence = null } = {}) {
  const links = note.links ?? null;
  const fm = note.frontmatter ?? {};
  const blocks = parseMarkdown(note.body, { links });
  const synthesis = fm.type === SYNTHESIS ? synthesisJson(note, blocks, { write, zunder }) : null;
  const inArchive = Boolean(archive) && (note.folder === archive || note.folder.startsWith(`${archive}/`));
  return {
    path: note.path,
    title: note.title,
    folder: note.folder,
    tags: note.tags,
    inInbox: Boolean(note.inInbox),
    type: fmValue(fm.type),
    obsidian: obsidianLink(note.path, vaultName),
    frontmatter: visibleFrontmatter(note).map(([key, v]) => ({ key, text: fmPlain(v), content: parseInline(fmText(v), links) })),
    synthesis,
    evidence: synthesis && evidence ? evidence.map((h) => ({ id: h.id, text: h.text, title: h.title ?? null, score: h.score ?? null, docId: docIdOf(h.href), href: h.href })) : null,
    blocks,
    related: related
      ? { backlinks: related.backlinks, similar: related.similar.hits.slice(0, SIMILAR_SHOWN), source: related.similar.source ?? null, problem: related.similar.problem ?? null }
      : null,
    suggestions: write && suggestions
      ? {
          of: suggestions.of,
          source: suggestions.source ?? null,
          problem: suggestions.problem ?? null,
          tags: suggestions.tags,
          folders: suggestions.folders,
          unlinked: suggestions.unlinked.map((h) => ({ path: h.path, title: h.title, score: h.score ?? null })),
        }
      : null,
    targets: write ? targets : [],
    archive: write && !inArchive ? archive : null,
    can: { write: Boolean(write), graph: Boolean(graph) },
  };
}

function synthesisJson(note, blocks, { write, zunder }) {
  const fm = note.frontmatter ?? {};
  const summary = fmValue(fm.summary);
  const points = openPoints(note.body);
  return {
    summary: summary ? parseInline(summary, note.links ?? null) : null,
    art: fmValue(fm.art),
    status: fmValue(fm.status),
    confidence: fmValue(fm.confidence),
    theses: synthesisOutline(blocks).map(({ id, text }) => ({ id, text })),
    openPoints: points,
    toZunder: Boolean(write && zunder && points.length),
  };
}
