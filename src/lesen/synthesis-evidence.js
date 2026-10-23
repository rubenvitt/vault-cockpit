import { ActionError } from '../cockpit/actions.js';
import { findSection, writeSection } from '../vault/generated-section.js';
import { esc, formHead } from '../web/render.js';
import { SYNTHESIS } from '../web/synthesis-render.js';
import { docLink } from './doc.js';
import { blockId } from './vault-export.js';

/**
 * Belege aus dem Lesestapel für Synthesen (VCP-82).
 *
 * Vorschläge: Markierungen, die seit `updated` der Synthese (Frontmatter, sonst
 * Änderungszeit der Datei) entstanden sind und inhaltlich passen. Verglichen
 * wird das Embedding der Markierung (src/lesen/embed-cache.js) mit jedem
 * Abschnitt der Synthese im semantischen Index; zählt der beste Abschnitt
 * (Kosinus, `MIN_SCORE`). Höchstens `LIMIT` Treffer, ähnlichste zuerst. Was
 * schon in der Synthese verlinkt ist (`#^hl-…`), kommt nicht wieder. Ohne
 * Embeddings oder ohne Vektoren der Synthese gibt es keine Vorschläge.
 *
 * „Als Beleg anhängen“ schreibt nur in den generierten Bereich
 * „aus-dem-lesestapel“ unter „## Aus dem Lesestapel“ der Synthese
 * (src/vault/generated-section.js): je Beleg ein Zitat, dessen letzte Zeile
 * die Markierung in ihrer Lesestapel-Notiz verlinkt (`[[notiz#^hl-…]]`, die
 * Notiz legt `exporter.ensureNote` notfalls an) und die Quelle nennt.
 * Bestehende Einträge bleiben, „Rückgängig“ entfernt genau diesen Eintrag.
 *
 * - `POST /aktion/synthese/beleg`: `pfad` (Synthese) und `markierung`
 * - `POST /aktion/synthese/beleg/entfernen`: dieselben Felder
 *
 * `pfad` gilt nur, wenn `/notiz` die Notiz zeigen darf (`notes.get`) und sie
 * `type: synthesis` hat; geschrieben wird an den Pfad aus dem Index.
 */

export const SECTION = 'aus-dem-lesestapel';
const HEADING = 'Aus dem Lesestapel';
const LABEL = 'Belege aus dem Lesestapel, das Cockpit schreibt bis zum Endmarker neu';
/** shortcut: Schwelle für bge-m3 gegen den besten Abschnitt geschätzt, nicht an einem echten Vault geprüft; bei Bedarf in die Einstellungen. */
export const MIN_SCORE = 0.6;
const LIMIT = 5;
/** shortcut: verglichen werden höchstens die neuesten so vielen Markierungen, wie bei den Querverbindungen. */
const CORPUS_MAX = 1000;
const BLOCK_REF = /#\^(hl-[0-9a-z]+)/g;

const noteName = (path) => path.split('/').pop().replace(/\.md$/i, '');
const refs = (text) => [...String(text).matchAll(BLOCK_REF)].map((m) => m[1]);
const round = (x) => Math.round(x * 1000) / 1000;
const clean = (s) => String(s ?? '').replace(/[[\]|\r\n]+/g, ' ').replaceAll('<!--', '&lt;!--').trim();

/** Ein Eintrag im Bereich: ein Zitat-Absatz ohne Leerzeile, die letzte Zeile verlinkt die Markierung und nennt die Quelle. */
export function evidenceEntry(quote, target, doc) {
  const lines = String(quote).trim().replaceAll('<!--', '&lt;!--').split(/\r?\n/).map((l) => `> ${l}`.trimEnd());
  const source = [clean(doc?.title || doc?.url), clean(doc?.site || URL.parse(doc?.url ?? '')?.hostname)].filter(Boolean).join(' · ');
  return [...lines, '>', `> — [[${target}]]${source ? ` · ${source}` : ''}`].join('\n');
}

/**
 * `notes` ist der Notiz-Schreibtisch (src/cockpit/notes.js), `semantic` der
 * semantische Index oder ein Getter dafür, `exporter` die Lesestapel-Notizen.
 */
export function createSynthesisEvidence({ notes, index, store, exporter, embedCache = null, semantic = null, vaultPath, editor, minScore = MIN_SCORE, limit = LIMIT }) {
  const semanticOf = () => (typeof semantic === 'function' ? semantic() : semantic);
  /** Wikilink-Ziel: Basename, wenn er eindeutig ist, sonst der Pfad ohne `.md` (wie in src/lesen/connections.js). */
  const linkName = (path) => (index.basenameCount(noteName(path)) === 1 ? noteName(path) : path.replace(/\.md$/i, ''));

  /** Pfad der Synthese, wenn `/notiz` sie zeigen darf; sonst ActionError. */
  function mustSynthesis(path) {
    const note = notes.get(path);
    if (note?.frontmatter?.type !== SYNTHESIS) throw new ActionError('Diese Synthese gibt es nicht oder das Cockpit darf sie nicht zeigen', 404);
    return note.path;
  }

  /** Synthese mit frischem Inhalt und Stichtag (`updated` oder Änderungszeit) oder null. */
  function synthesis(path) {
    const note = notes.get(path);
    const row = note?.frontmatter?.type === SYNTHESIS ? index.getNote(note.path) : null;
    // shortcut: `updated` ist ein Tag, verglichen mit UTC-Zeitstempeln; der ganze Tag zählt als „seit“.
    return row?.content == null ? null : { path: row.path, content: row.content, since: row.updated ?? new Date(row.mtime).toISOString() };
  }

  /** Passende neue Markierungen je Synthese, `Map` Pfad → Treffer. */
  async function scan(paths, { waitMs } = {}) {
    const out = new Map();
    const sem = semanticOf();
    const targets = paths.map(synthesis).filter((t) => t && sem?.has(t.path));
    if (!targets.length || !embedCache) return out;
    const oldest = targets.reduce((a, t) => (t.since < a ? t.since : a), targets[0].since);
    // Nur einbetten, was überhaupt in Frage kommt.
    const corpus = store.listHighlights({ limit: CORPUS_MAX }).filter((h) => h.created_at >= oldest);
    if (!corpus.length) return out;
    const vecs = await embedCache.vectors(corpus.map((h) => h.quote), { waitMs });
    if (!vecs) return out;
    const allowed = new Set(targets.map((t) => t.path));
    const scores = corpus.map((h, i) => (vecs[i] ? new Map(sem.searchVector(vecs[i], { limit: allowed.size, allow: (p) => allowed.has(p) }).map((x) => [x.path, x.score])) : null));
    for (const t of targets) {
      const attached = new Set(refs(t.content));
      const hits = corpus
        .map((h, i) => ({ h, score: scores[i]?.get(t.path) }))
        .filter(({ h, score }) => score >= minScore && h.created_at >= t.since && !attached.has(blockId(h.id)))
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map(({ h, score }) => ({ id: h.id, text: h.quote, title: h.doc_title || h.doc_url, href: `${docLink(h.doc_id)}#h-${h.id}`, score: round(score) }));
      out.set(t.path, hits);
    }
    return out;
  }

  /** Bereich frisch lesen, Einträge über `change(blocks)` ändern (null = nichts zu tun) und schreiben. */
  function rewrite(path, change) {
    const found = findSection(index.getNote(path)?.content ?? '', SECTION);
    // Von Hand geändert oder kaputt: `writeSection` lässt den Bereich stehen und nennt den Grund.
    const blocks = found?.inner && !found.broken && !found.edited ? found.inner.split(/\n{2,}/) : [];
    const next = change(blocks);
    if (!next) return { state: 'aktuell' };
    const r = writeSection({ vaultPath, editor, path, name: SECTION, inner: next.join('\n\n'), label: LABEL, spaced: true, heading: HEADING, createHeading: true });
    if (r.state === 'übersprungen') throw new ActionError(r.reason, 409);
    return r;
  }

  /** Fehler des Editors (vom Sync gleichzeitig geändert) als verständliche Meldung. */
  function guarded(verb, run) {
    try {
      return run();
    } catch (err) {
      if (err instanceof ActionError) throw err;
      throw new ActionError(`Nicht ${verb}: ${err.message}`, 409);
    }
  }

  return {
    /** Bis zu `limit` passende neue Markierungen `{ id, text, title, href, score }`; leer ohne Embeddings. */
    suggest: async (path, { waitMs } = {}) => (await scan([path], { waitMs })).get(path) ?? [],

    /** Die Synthesen unter `paths` mit mindestens einem Vorschlag; wartet wie `suggest` höchstens kurz auf Embeddings. */
    async matching(paths) {
      const hits = await scan(paths);
      return new Set([...hits].filter(([, h]) => h.length).map(([p]) => p));
    },

    /** Markierung als Beleg in den Bereich der Synthese schreiben; `{ state, path, highlightId, label }`. */
    attach({ path, highlightId }) {
      if (!exporter) throw new ActionError('Die Lesestapel-Notizen sind hier nicht angebunden', 503);
      const p = mustSynthesis(path);
      const h = store.getHighlight(highlightId);
      if (!h) throw new ActionError('Diese Markierung gibt es nicht', 404);
      const doc = store.get(h.doc_id);
      return guarded('angehängt', () => {
        const id = blockId(h.id);
        // Ohne Lesestapel-Notiz zeigte der Link ins Leere; also anlegen.
        const note = exporter.ensureNote(h.doc_id);
        if (!note.path || note.state === 'übersprungen' || !notes.visible(note.path)) throw new ActionError(note.reason ?? 'Zu dieser Markierung gibt es keine Notiz im Vault, die das Cockpit verlinken darf', 409);
        const r = rewrite(p, (blocks) => (blocks.some((b) => refs(b).includes(id)) ? null : [...blocks, evidenceEntry(h.quote, `${linkName(note.path)}#^${id}`, doc)]));
        return { ...r, path: p, highlightId: h.id, label: doc?.title || doc?.url || 'Markierung' };
      });
    },

    /** Eintrag der Markierung wieder aus dem Bereich entfernen (Rückgängig). */
    detach({ path, highlightId }) {
      const p = mustSynthesis(path);
      if (!highlightId) throw new ActionError('Diese Markierung gibt es nicht', 404);
      const id = blockId(highlightId);
      return guarded('entfernt', () => ({ ...rewrite(p, (blocks) => (blocks.some((b) => refs(b).includes(id)) ? blocks.filter((b) => !refs(b).includes(id)) : null)), path: p }));
    },
  };
}

/** Aktionen für src/web/http.js. */
export function evidenceRoutes(evidence, { logger = console } = {}) {
  return {
    async '/aktion/synthese/beleg'(form, session) {
      const r = evidence.attach({ path: form.get('pfad'), highlightId: form.get('markierung') });
      if (r.state === 'aktuell') return { message: 'Schon als Beleg angehängt', path: r.path };
      logger.info?.(`Cockpit: Beleg ${blockId(r.highlightId)} in ${r.path} (${session.sub})`);
      return { message: `Als Beleg angehängt: ${r.label}`, path: r.path, undo: { action: '/aktion/synthese/beleg/entfernen', fields: { pfad: r.path, markierung: r.highlightId } } };
    },
    async '/aktion/synthese/beleg/entfernen'(form, session) {
      const r = evidence.detach({ path: form.get('pfad'), highlightId: form.get('markierung') });
      if (r.state !== 'aktuell') logger.info?.(`Cockpit: Beleg aus ${r.path} entfernt (${session.sub})`);
      return { message: r.state === 'aktuell' ? 'Der Beleg steht nicht mehr in der Synthese' : 'Beleg entfernt', path: r.path };
    },
  };
}

/** Kasten „Aus dem Lesestapel passt dazu“ auf der Notizseite einer Synthese; leer ohne Vorschläge. */
export function evidenceBox(items, note, ctx) {
  if (!items?.length) return '';
  const button = (h) => (ctx.write ? `${formHead(ctx, '/aktion/synthese/beleg', { pfad: note.path, markierung: h.id })}<button type="submit" class="chip">Als Beleg anhängen</button></form>` : '');
  return `<section class="synth-reading">
    <h2>Aus dem Lesestapel passt dazu</h2>
    <ul>${items.map((h) => `<li><a class="lesen-quote" href="${esc(h.href)}">${esc(h.text)}</a><p class="meta">${esc(h.title)} <span class="score">${Math.round(h.score * 100)} %</span></p>${button(h)}</li>`).join('')}</ul>
  </section>`;
}
