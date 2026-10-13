import { parseNote } from '../vault/markdown.js';

const RRF_K = 60;
const WEIGHTS = { text: 1, semantic: 1, graph: 0.5 };
const STREAM_DEPTH = 50;

/**
 * Hybride Suche: Volltext (FTS5, Begriffe ODER-verknüpft), Ähnlichkeit der
 * Embeddings und Nachbarschaft im Link-Graphen, zusammengeführt per Reciprocal
 * Rank Fusion. Dasselbe Verfahren wie `mycel.py search`, aber über den ganzen
 * Vault und mit eigenen Embeddings statt geliehener Smart-Connections-Vektoren.
 *
 * - Volltext findet exakte Begriffe, Namen, Kennungen.
 * - Embeddings finden Notizen mit anderen Worten für dasselbe.
 * - Der Graph hebt Notizen, die mit den besten Treffern verlinkt sind.
 *
 * `mode: 'semantic'` nutzt nur die Embeddings. Ist der Embedding-Server nicht
 * erreichbar, fällt die Suche auf Volltext zurück und sagt das in `degraded`.
 */
export async function hybridSearch({ index, semantic = null, query, mode = 'hybrid', include = ['core'], includeSensitive = false, tag = null, folder = null, type = null, limit = 10, offset = 0 }) {
  const filters = { include, includeSensitive, tag, folder, type };
  const allowed = index.filterPaths(filters);
  const streams = {};
  let degraded = null;

  if (mode !== 'semantic') {
    streams.text = index.search(query, { ...filters, any: true, limit: STREAM_DEPTH, offset: 0 }).results;
  }

  if (semantic) {
    try {
      const vec = await semantic.embedQuery(query);
      streams.semantic = semantic.searchVector(vec, { limit: STREAM_DEPTH, allow: (p) => allowed.has(p) });
    } catch (err) {
      degraded = `Semantische Suche nicht verfügbar (${err.message}), nur Volltext`;
      if (mode === 'semantic') streams.text = index.search(query, { ...filters, any: true, limit: STREAM_DEPTH, offset: 0 }).results;
    }
  } else {
    degraded = 'Semantische Suche ist nicht eingerichtet (EMBED_URL), nur Volltext';
    if (mode === 'semantic') streams.text = index.search(query, { ...filters, any: true, limit: STREAM_DEPTH, offset: 0 }).results;
  }

  if (mode !== 'semantic') {
    const seeds = [...(streams.text ?? []).slice(0, 3), ...(streams.semantic ?? []).slice(0, 3)].map((r) => r.path);
    streams.graph = graphStream(index, [...new Set(seeds)], allowed);
  }

  const fused = new Map();
  for (const [name, ranking] of Object.entries(streams)) {
    ranking.forEach((hit, i) => {
      const entry = fused.get(hit.path) ?? { path: hit.path, score: 0, streams: [], snippet: null, heading: null, similarity: null };
      entry.score += WEIGHTS[name] / (RRF_K + i + 1);
      entry.streams.push(name);
      if (name === 'text' && hit.snippet) entry.snippet = hit.snippet;
      if (name === 'semantic') {
        entry.heading = hit.heading;
        entry.similarity = round(hit.score);
      }
      fused.set(hit.path, entry);
    });
  }

  const ranked = [...fused.values()].sort((a, b) => b.score - a.score);
  const page = ranked.slice(offset, offset + limit);
  const meta = index.describe(page.map((r) => r.path));
  const results = page
    .filter((r) => meta.has(r.path))
    .map((r) => {
      const m = meta.get(r.path);
      return {
        path: r.path,
        title: m.title ?? m.basename,
        type: m.type,
        status: m.status,
        updated: m.updated,
        sensitivity: m.sensitivity,
        snippet: r.snippet ?? excerpt(index, r.path, r.heading),
        streams: r.streams,
        similarity: r.similarity,
        score: round(r.score * 1000),
      };
    });

  return { results, total: ranked.length, hasMore: offset + page.length < ranked.length, degraded };
}

/** Nachbarn der besten Treffer (Links in beide Richtungen), nach Zahl der Treffer, die auf sie zeigen. */
function graphStream(index, seeds, allowed) {
  const score = new Map();
  seeds.forEach((seed, rank) => {
    const neighbours = new Set([...index.outgoingLinks(seed), ...index.backlinks(seed)].map((n) => n.path));
    for (const n of neighbours) {
      if (!n || n === seed || !allowed.has(n)) continue;
      score.set(n, (score.get(n) ?? 0) + 1 / (rank + 1));
    }
  });
  return [...score.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, STREAM_DEPTH)
    .map(([path]) => ({ path }));
}

/** Kurzer Ausschnitt für Treffer ohne Volltext-Snippet: der Abschnitt mit dem ähnlichsten Text. */
function excerpt(index, path, heading, max = 220) {
  const note = index.getNote(path);
  if (!note?.content) return null;
  let body = parseNote(note.content).body;
  if (heading) {
    const at = body.split(/\r?\n/).findIndex((l) => /^#{1,6}\s/.test(l) && l.replace(/^#{1,6}\s+/, '').trim() === heading);
    if (at >= 0) body = body.split(/\r?\n/).slice(at + 1).join('\n');
  }
  const text = body.replace(/^#{1,6}\s+.*$/gm, '').replace(/\s+/g, ' ').trim();
  if (!text) return heading ?? null;
  const cut = text.length > max ? `${text.slice(0, max).replace(/\s+\S*$/, '')} …` : text;
  return heading ? `${heading}: ${cut}` : cut;
}

const round = (x) => Math.round(x * 1000) / 1000;
