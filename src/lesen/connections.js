import { ActionError } from '../cockpit/actions.js';
import { dot } from '../semantic/embedder.js';
import { hybridSearch, excerpt } from '../semantic/search.js';
import { findSection } from '../vault/generated-section.js';
import { docLink } from './doc.js';
import { NOTE_TYPE, SECTION, blockId, parseLinks } from './vault-export.js';

/**
 * Querverbindungen beim Lesen (VCP-73): zu einer Markierung oder einer noch
 * nicht gespeicherten Auswahl ähnliche Stellen aus anderen Quellen.
 *
 * - Markierungen anderer Texte aus dem Lesestapel, über Embeddings aus dem
 *   gemeinsamen Speicher (src/lesen/embed-cache.js); eine frische Markierung
 *   wird dabei sofort eingebettet, nicht erst beim nächsten Indexlauf.
 * - Synthesen und Konzepte aus dem semantischen Index; der beste Abschnitt
 *   (Chunk) liefert Überschrift und Ausschnitt.
 *
 * Gezeigt werden nur eigene Notizen, die das Cockpit auch unter „Ähnlich“ in
 * `/notiz` zeigen darf (nicht vertraulich, nicht ausgeschlossen), nie die
 * eigene Lesestapel-Notiz des Dokuments. Ohne Embedder oder ohne erreichbares
 * Ollama sucht es im Volltext (dann auch in den Lesestapel-Notizen) und sagt
 * das in `problem`.
 *
 * „Verknüpfen“ schreibt nur einen Wikilink unter die Markierung in ihre
 * Lesestapel-Notiz (`exporter.addLink`), nie in die Zielnotiz. Ist das Ziel
 * eine Markierung, deren Text noch keine Notiz hat, legt es die an, damit der
 * Link nicht ins Leere zeigt.
 *
 * - `GET /api/lesen/verbindungen?markierung=<id>` oder `?doc=<id>&text=<Auswahl>`:
 *   JSON `{ highlightId, docId, source, problem, highlights, notes, linked }`, siehe `find`.
 * - `POST /aktion/lesen/verbinden`: `markierung` und entweder `pfad` (Notiz,
 *   optional `abschnitt`) oder `zu` (andere Markierung). Eine Auswahl ohne
 *   Markierung markiert der Client vorher über `/aktion/lesen/markierung/neu`.
 */

/** Typen nach der Vault-Konvention, am echten Vault geprüft (VCP-84): `wiki/concepts` hat `type: concept`, `wiki/synthesis` hat `type: synthesis`. */
export const NOTE_TYPES = ['synthesis', 'concept'];
const LIMIT = 6;
/**
 * Mindest-Kosinus für Markierungen und Notizen (bge-m3), am echten Vault
 * gemessen (VCP-84): Passende Konzepte liegen bei 0,56 bis 0,68, der beste
 * Treffer zu einer Auswahl ohne passendes Gegenstück (Spiele-Patchnotes, Lego
 * mit dem Kind) bei 0,46 bis 0,51. Darunter zeigt die Seitenleiste lieber
 * „Nichts Passendes gefunden“ als die besten sechs um jeden Preis.
 */
export const MIN_SCORE = 0.55;
/** So lange wartet die Suche auf das Embedding der Auswahl, danach Volltext. */
const QUERY_WAIT_MS = 4000;
/** shortcut: verglichen werden höchstens die neuesten so vielen Markierungen; reicht für einige Jahre Lesen. */
const CORPUS_MAX = 1000;
const MAX_TEXT = 4000;
/** Überschriften, die als `[[notiz#Überschrift]]` taugen. */
const HEADING_OK = /^[^[\]|#^\n\r]{1,200}$/;

const noteName = (path) => path.split('/').pop().replace(/\.md$/i, '');
const noteHref = (path) => `/notiz?pfad=${encodeURIComponent(path)}`;
const round = (x) => Math.round(x * 1000) / 1000;

/**
 * `index`, `policy` wie für `/notiz`; `semantic` ist der semantische Index oder
 * ein Getter dafür, `exporter` die Lesestapel-Notizen (src/lesen/vault-export.js).
 */
export function createConnections({ store, index, semantic = null, policy, exporter = null, embedCache = null, limit = LIMIT, minScore = MIN_SCORE }) {
  const semanticOf = () => (typeof semantic === 'function' ? semantic() : semantic);

  /** Wie `listed` in src/cockpit/notes.js: eigene Notiz, nicht vertraulich, nicht ausgeschlossen. */
  function listed(path) {
    const p = String(path ?? '');
    if (!p || policy.isExcluded(p) || policy.sensitivityOf(p)) return null;
    const row = index.describe([p]).get(p);
    return row && !row.sensitivity && row.class === 'core' ? row : null;
  }

  /** Wikilink-Ziel: Basename, wenn er eindeutig ist, sonst der Pfad ohne `.md` (wie „Verlinken“ in /notiz). */
  const linkName = (path) => (index.basenameCount(noteName(path)) === 1 ? noteName(path) : path.replace(/\.md$/i, ''));

  /** Ziele, die schon unter der Markierung stehen (Zeile „Verknüpft:“ in ihrer Lesestapel-Notiz). */
  function linkedTargets(h, notePath) {
    // Liegt die Notiz inzwischen in einem vertraulichen Ordner, liest das Cockpit sie nicht.
    if (!h || !notePath || !listed(notePath)) return [];
    const content = index.getNote(notePath)?.content;
    const section = content ? findSection(content, SECTION) : null;
    return section?.inner ? [...new Set(parseLinks(section.inner).get(blockId(h.id)) ?? [])] : [];
  }

  const noteHit = (path, { heading = null, score = null, snippet = null }, linkedPaths) => {
    const row = listed(path);
    return {
      path,
      title: row.title ?? noteName(path),
      type: row.type ?? null,
      heading: heading && HEADING_OK.test(heading) ? heading : null,
      text: snippet ?? excerpt(index, path, heading),
      href: noteHref(path),
      score: score == null ? null : round(score),
      linked: linkedPaths.has(path),
    };
  };

  /**
   * Ähnliche Stellen zu einer Markierung (`highlightId`) oder einer Auswahl
   * (`docId` + `text`):
   * - `highlights`: `{ id, docId, title, text, note, href, score, linked }`, ähnlichste zuerst;
   *   wie `notes` nur Treffer ab `minScore` (Volltext ohne Schwelle)
   * - `notes`: `{ path, title, type, heading, text, href, score, linked }`
   * - `linked`: schon verknüpfte Ziele `{ target, href }` (nur zu einer Markierung)
   * - `source`: `semantic` oder `text`, `problem`: Hinweis, warum nur Volltext
   * Wirft `ActionError` für unbekannte Markierungen oder Dokumente.
   */
  async function find({ highlightId = null, docId = null, text = null }) {
    const h = highlightId ? store.getHighlight(highlightId) : null;
    if (highlightId && !h) throw new ActionError('Diese Markierung gibt es nicht', 404);
    const doc = store.get(h?.doc_id ?? docId);
    if (!doc) throw new ActionError('Diesen Artikel gibt es nicht', 404);
    const query = String(h?.quote ?? text ?? '').trim().slice(0, MAX_TEXT);
    if (!query) throw new ActionError('Nichts ausgewählt');

    const ownNote = exporter?.notePath(doc.id) ?? null;
    const linked = linkedTargets(h, ownNote);
    const linkedPaths = new Set(linked.map((t) => index.resolveLink(t.split('|')[0].split('#')[0])).filter(Boolean));
    const linkedBlocks = new Set(linked.map((t) => /#\^(hl-[0-9a-z]+)/.exec(t)?.[1]).filter(Boolean));
    const result = {
      highlightId: h?.id ?? null,
      docId: doc.id,
      source: 'semantic',
      problem: null,
      highlights: [],
      notes: [],
      linked: linked.map((target) => {
        const path = index.resolveLink(target.split('|')[0].split('#')[0]);
        return { target, href: path && listed(path) ? noteHref(path) : null };
      }),
    };

    // Erst die Auswahl, dann die übrigen Markierungen: so kommt sie bei Ollama zuerst dran.
    const corpus = store.listHighlights({ limit: CORPUS_MAX }).filter((o) => o.doc_id !== doc.id);
    const [queryVecs, corpusVecs] = embedCache
      ? await Promise.all([embedCache.vectors([query], { waitMs: QUERY_WAIT_MS }), embedCache.vectors(corpus.map((o) => o.quote), { waitMs: QUERY_WAIT_MS })])
      : [null, null];
    const vec = queryVecs?.[0];

    if (vec) {
      result.highlights = corpus
        .map((o, i) => ({ o, v: corpusVecs?.[i] }))
        .filter((x) => x.v)
        .map(({ o, v }) => ({ o, score: dot(vec, v) }))
        .filter((x) => x.score >= minScore)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map(({ o, score }) => ({
          id: o.id,
          docId: o.doc_id,
          title: o.doc_title || o.doc_url,
          text: o.quote,
          note: o.note ?? null,
          href: `${docLink(o.doc_id)}#h-${o.id}`,
          score: round(score),
          linked: linkedBlocks.has(blockId(o.id)),
        }));
      const allowed = new Set();
      for (const type of NOTE_TYPES) for (const p of index.filterPaths({ type })) if (p !== ownNote && listed(p)) allowed.add(p);
      const hits = semanticOf()?.searchVector(vec, { limit, allow: (p) => allowed.has(p) }) ?? [];
      result.notes = hits.filter((x) => x.score >= minScore).map((x) => noteHit(x.path, x, linkedPaths));
      return result;
    }

    const status = embedCache?.status() ?? { state: 'aus', error: null };
    result.source = 'text';
    result.problem =
      status.state === 'aus'
        ? 'Ohne Embeddings (Einstellungen → Embeddings) nur Volltext'
        : `Embeddings gerade nicht erreichbar${status.error ? ` (${status.error})` : ''}, nur Volltext`;
    // `semantic: null`, sonst fragt die Suche das nicht erreichbare Ollama noch einmal.
    const { results } = await hybridSearch({ index, semantic: null, query: query.slice(0, 500), mode: 'fts', limit: 30 });
    const types = [...NOTE_TYPES, NOTE_TYPE];
    result.notes = results
      .filter((r) => types.includes(r.type) && r.path !== ownNote && listed(r.path))
      .slice(0, limit)
      .map((r) => noteHit(r.path, { snippet: r.snippet }, linkedPaths));
    return result;
  }

  /** Wikilink unter die Markierung schreiben; Ziel ist eine Notiz (`pfad`, `abschnitt`) oder eine andere Markierung (`zu`). */
  function link({ highlightId, path = null, heading = null, toHighlight = null }) {
    if (!exporter) throw new ActionError('Die Lesestapel-Notizen sind hier nicht angebunden', 503);
    const h = store.getHighlight(highlightId);
    if (!h) throw new ActionError('Diese Markierung gibt es nicht', 404);
    try {
      let target;
      let label;
      if (toHighlight) {
        const o = store.getHighlight(toHighlight);
        if (!o || o.id === h.id) throw new ActionError('Diese Markierung gibt es nicht', 404);
        // Ohne Notiz zum anderen Text zeigte der Link ins Leere; also anlegen.
        const r = exporter.ensureNote(o.doc_id);
        if (!r.path || r.state === 'übersprungen' || !listed(r.path)) throw new ActionError(r.reason ?? 'Zu dieser Markierung gibt es keine Notiz im Vault, die das Cockpit verlinken darf', 409);
        target = `${linkName(r.path)}#^${blockId(o.id)}`;
        label = store.get(o.doc_id)?.title ?? noteName(r.path);
      } else {
        const row = listed(path);
        if (!row) throw new ActionError('Das Ziel gibt es nicht oder das Cockpit darf es nicht verlinken', 404);
        if (row.path === exporter.notePath(h.doc_id)) throw new ActionError('Die Lesestapel-Notiz verlinkt sich nicht selbst');
        const section = String(heading ?? '').trim();
        target = `${linkName(row.path)}${section && HEADING_OK.test(section) ? `#${section}` : ''}`;
        label = row.title ?? noteName(row.path);
      }
      const r = exporter.addLink({ highlightId: h.id, target });
      if (r.state === 'übersprungen') throw new ActionError(r.reason, 409);
      return { ...r, target, label };
    } catch (err) {
      if (err instanceof ActionError) throw err;
      // Der Editor wirft, wenn der Sync die Notiz gerade geändert hat.
      throw new ActionError(`Nicht verknüpft: ${err.message}`, 409);
    }
  }

  return { find, link };
}

/** Endpunkt und Aktion für src/lesen/http.js. */
export function connectionRoutes({ logger = console, ...options }) {
  const connections = createConnections(options);
  const json = (status, body) => ({ status, body: JSON.stringify(body), headers: { 'content-type': 'application/json; charset=utf-8' } });
  return {
    connections,
    pages: {
      async '/api/lesen/verbindungen'(ctx) {
        const q = ctx.url.searchParams;
        try {
          return json(200, await connections.find({ highlightId: q.get('markierung'), docId: q.get('doc'), text: q.get('text') }));
        } catch (err) {
          if (!(err instanceof ActionError)) throw err;
          return json(err.status, { error: 'connections_failed', message: err.message });
        }
      },
    },
    actions: {
      async '/aktion/lesen/verbinden'(form, session) {
        const r = connections.link({ highlightId: form.get('markierung'), path: form.get('pfad'), heading: form.get('abschnitt'), toHighlight: form.get('zu') });
        if (r.state !== 'aktuell') logger.info?.(`Lesestapel: [[${r.target}]] in ${r.path} (${session.sub})`);
        return { message: `${r.state === 'aktuell' ? 'Schon verknüpft' : 'Verknüpft'} mit ${r.label}`, link: { target: r.target, path: r.path } };
      },
    },
  };
}
