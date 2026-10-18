import { parseNote } from '../vault/markdown.js';

/** Wörter, die für die Ähnlichkeit per Volltext nichts aussagen. */
const STOPWORDS = new Set(
  ('aber alle allem allen aller alles also auch auf aus bei beim bist bitte dann darf darum dass dein deine dem den denn der des dessen die dies diese diesem diesen dieser dieses doch dort durch eine einem einen einer eines etwas euch euer für gegen gibt habe haben hast hatte hier hinter ihre ihrem ihren ihrer immer jede jedem jeden jeder jedes jetzt kann kein keine keinem keinen keiner können mehr mein meine meinem meinen meiner mich mit muss nach nicht noch nun nur oder ohne schon sehr sein seine seinem seinen seiner selbst sich sie sind soll sollte sonst über ueber unter und uns unser viel vom von vor wann warum was weil weiter welche wenn wer werden wie wieder will wir wird wo zum zur zwischen ' +
    'about after also been before being could does from have here into just like more much only other over some such than that their them then there these they this those very what when where which while with would your')
    .split(' '),
);

/**
 * Was zu einer Notiz gehört, ohne in ihr zu stehen: Backlinks („Verweist
 * hierher“) und inhaltlich ähnliche Notizen, wie `vault_links` und
 * `vault_similar`, aber nur unter den Notizen, die das Cockpit zeigen darf.
 *
 * Ähnlich heißt: Schwerpunkt der Embeddings gegen Schwerpunkt, aus dem
 * Vektorindex im Speicher (nichts wird neu eingebettet). Gibt es keine
 * Embeddings (Ollama aus, Notiz noch nicht eingebettet), fällt die Suche auf
 * den Volltext zurück: die markantesten Wörter der Notiz, ODER-verknüpft.
 */
export function createRelated({ index, semantic: semanticOrGetter = null, visible }) {
  const titleOf = (row) => row.title ?? row.basename ?? row.path.split('/').pop().replace(/\.md$/i, '');

  /** Häufigste aussagekräftige Wörter aus Titel und Text, der Titel zählt doppelt. */
  function keywords(title, body, max = 10) {
    const count = new Map();
    const add = (text, weight) => {
      for (const m of String(text ?? '').toLowerCase().matchAll(/[\p{L}][\p{L}\p{N}-]{3,}/gu)) {
        const w = m[0].replace(/-+$/, '');
        if (w.length < 4 || STOPWORDS.has(w)) continue;
        count.set(w, (count.get(w) ?? 0) + weight);
      }
    };
    add(title, 2);
    add(body.replace(/```[\s\S]*?```/g, ' ').replace(/https?:\/\/\S+/g, ' '), 1);
    return [...count.entries()].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length).slice(0, max).map(([w]) => w);
  }

  function byText(path, limit) {
    const row = index.getNote(path);
    if (!row?.content) return [];
    const terms = keywords(row.title, parseNote(row.content).body);
    if (!terms.length) return [];
    const { results } = index.search(terms.join(' '), { any: true, limit: limit + 1 });
    // BM25 ist kein Prozentwert; die Rangfolge reicht für Liste und Mehrheit.
    return results.filter((r) => r.path !== path).slice(0, limit).map((r, i) => ({ path: r.path, score: null, rank: i }));
  }

  return {
    /**
     * `{ backlinks: [{ path, title }], similar: { source, hits, problem } }`.
     * `source` ist `semantic`, `text` oder null (nichts gefunden), `hits` sind
     * `{ path, title, type, folder, score, linked }`, ähnlichste zuerst.
     */
    of(path, { limit = 10 } = {}) {
      const backlinks = index
        .backlinks(path)
        .filter((b) => b.path !== path && visible(b.path))
        .map((b) => ({ path: b.path, title: b.title ?? b.path.split('/').pop().replace(/\.md$/i, '') }));

      const linked = new Set([...index.outgoingLinks(path), ...index.backlinks(path)].map((n) => n.path));
      const semantic = typeof semanticOrGetter === 'function' ? semanticOrGetter() : semanticOrGetter;
      let source = null;
      let problem = null;
      // Vorfilter als Menge, weil er über alle eingebetteten Notizen läuft; `visible` nur für die Treffer.
      const allowed = index.filterPaths();
      let hits = semantic ? semantic.similarTo(path, { limit, allow: (p) => allowed.has(p) })?.filter((h) => visible(h.path)) ?? null : null;
      if (hits) source = 'semantic';
      else {
        problem = semantic ? 'Für diese Notiz gibt es noch keine Embeddings, ähnlich nach Volltext' : 'Ohne Embeddings (Einstellungen → Embeddings) ähnlich nach Volltext';
        hits = byText(path, limit).filter((h) => visible(h.path));
        source = 'text';
      }
      const meta = index.describe(hits.map((h) => h.path));
      const similar = hits
        .filter((h) => meta.has(h.path))
        .map((h) => {
          const m = meta.get(h.path);
          return {
            path: h.path,
            title: titleOf(m),
            type: m.type ?? null,
            folder: h.path.includes('/') ? h.path.slice(0, h.path.lastIndexOf('/')) : '',
            score: h.score == null ? null : Math.round(h.score * 1000) / 1000,
            linked: linked.has(h.path),
          };
        });
      return { backlinks, similar: { source: similar.length ? source : null, hits: similar, problem } };
    },
  };
}
