import { dot } from '../semantic/embedder.js';
import { findClusters } from './review.js';

/**
 * Messen der Cluster-Schwelle im Wiedersehen (VCP-129), reine Funktionen. Das
 * Werkzeug dazu ist `npm run messen:cluster` (src/cli/cluster-schwelle.js): Es
 * bettet alle Markierungen mit dem konfigurierten Modell ein und schreibt einen
 * Bericht, an dem sich `CLUSTER_THRESHOLD` (src/lesen/review-page.js)
 * begründen lässt.
 *
 * `items` sind Markierungen wie aus `listHighlights` (mindestens `id`,
 * `doc_id`, `quote`, `created_at`, gern `doc_title`/`doc_url`), neueste zuerst;
 * `vectors[i]` gehört zu `items[i]` und ist normiert.
 */

export const THRESHOLDS = [0.65, 0.7, 0.75, 0.8, 0.85];

const num = (x) => x.toFixed(2).replace('.', ',');
const pct = (q) => `${String(q * 100).replace('.', ',')} %`;
const short = (q, n = 120) => {
  const t = String(q).replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
};
const titleOf = (h) => short(h.doc_title || h.doc_url || h.doc_id, 60);

/** Alle Paare `{ a, b, sim, sameDoc }` (Indizes in `items`), ähnlichste zuerst. */
export function pairs(items, vectors) {
  const out = [];
  for (let i = 0; i < items.length; i += 1) {
    for (let j = i + 1; j < items.length; j += 1) out.push({ a: i, b: j, sim: dot(vectors[i], vectors[j]), sameDoc: items[i].doc_id === items[j].doc_id });
  }
  return out.sort((x, y) => y.sim - x.sim);
}

/** Quantile nach dem Nächster-Rang-Verfahren; `null` ohne Werte. */
export function quantile(values, q) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];
}

/**
 * Je Schwelle, was das Wiedersehen zeigen würde: Wie die Seite clustert sie
 * jede Gruppe (`groupOf`, dort die Woche) für sich, höchstens `maxItems`
 * neueste Markierungen. Liefert je Schwelle die Zahl der Paare aus
 * verschiedenen Texten darüber, die Häufungen je Gruppe und wie viele
 * Markierungen in einer Häufung stehen.
 */
export function measureThresholds(items, vectors, { thresholds = THRESHOLDS, groupOf = () => 'alle', maxItems = 200, all = pairs(items, vectors) } = {}) {
  const groups = new Map();
  items.forEach((h, i) => {
    const g = groupOf(h);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(i);
  });
  const cross = all.filter((p) => !p.sameDoc);
  return thresholds.map((threshold) => {
    const clusters = [];
    for (const [group, idx] of groups) {
      const sample = idx.slice(0, maxItems);
      for (const c of findClusters(
        sample.map((i) => items[i]),
        sample.map((i) => vectors[i]),
        { threshold },
      )) {
        clusters.push({ group, items: c });
      }
    }
    return {
      threshold,
      pairsAbove: cross.filter((p) => p.sim >= threshold).length,
      clusters,
      groupsWithCluster: new Set(clusters.map((c) => c.group)).size,
      clustered: clusters.reduce((n, c) => n + c.items.length, 0),
    };
  });
}

/** Bis zu `n` Elemente gleichmäßig über die Liste verteilt. */
const spread = (list, n) => (list.length <= n ? list : Array.from({ length: n }, (_, k) => list[Math.floor((k * list.length) / n)]));

/**
 * Bericht als Markdown: Verteilung der Paar-Ähnlichkeiten, Wirkung jeder
 * Schwelle, die Häufungen bei der aktuellen Schwelle, Grenzfälle rund um sie
 * zum Beurteilen („gehört das zusammen?“) und die ähnlichsten Paare.
 */
export function clusterReport({ items, vectors, model, current, date, groupOf = () => 'alle', thresholds = THRESHOLDS, maxItems = 200, borderWidth = 0.05, borderMax = 20, top = 10 }) {
  const all = pairs(items, vectors);
  const cross = all.filter((p) => !p.sameDoc).map((p) => p.sim);
  const same = all.filter((p) => p.sameDoc).map((p) => p.sim);
  const docs = new Set(items.map((h) => h.doc_id)).size;
  const groups = new Set(items.map(groupOf)).size;
  const ts = [...new Set([...thresholds, current])].sort((a, b) => a - b);
  const measured = measureThresholds(items, vectors, { thresholds: ts, groupOf, maxItems, all });
  const pair = (p) => `- ${num(p.sim)}: „${short(items[p.a].quote)}“ (${titleOf(items[p.a])}) ↔ „${short(items[p.b].quote)}“ (${titleOf(items[p.b])})`;
  const qs = [0.5, 0.9, 0.95, 0.99];
  const row = (label, values) =>
    `| ${label} | ${values.length} | ${values.length ? qs.map((q) => num(quantile(values, q))).join(' | ') : qs.map(() => '–').join(' | ')} | ${values.length ? num(Math.max(...values)) : '–'} |`;

  const lines = [
    '# Cluster-Schwelle im Wiedersehen (VCP-129)',
    '',
    `${date}, Modell ${model}: ${items.length} Markierungen aus ${docs} Texten, ${groups} Wochen. Aktuelle Schwelle ${num(current)}.`,
    '',
    '## Ähnlichkeit von Markierungspaaren',
    '',
    `| Paare | Anzahl | ${qs.map(pct).join(' | ')} | Höchstwert |`,
    `|---|---|${qs.map(() => '---').join('|')}|---|`,
    row('verschiedene Texte', cross),
    row('derselbe Text', same),
    '',
    '## Wirkung der Schwellen',
    '',
    'Häufungen wie auf der Seite: je Woche, nur Markierungen aus verschiedenen Texten, höchstens fünf je Häufung.',
    '',
    '| Schwelle | Paare darüber (verschiedene Texte) | Häufungen | Wochen mit Häufung | Markierungen in Häufungen |',
    '|---|---|---|---|---|',
    ...measured.map((m) => `| ${num(m.threshold)}${m.threshold === current ? ' (aktuell)' : ''} | ${m.pairsAbove} | ${m.clusters.length} | ${m.groupsWithCluster} | ${m.clustered} |`),
    '',
    `## Häufungen bei ${num(current)}`,
    '',
  ];
  const now = measured.find((m) => m.threshold === current);
  if (!now.clusters.length) lines.push('Keine.', '');
  for (const c of now.clusters) {
    lines.push(`- ${c.group}:`);
    for (const h of c.items) lines.push(`  - „${short(h.quote)}“ (${titleOf(h)})`);
  }
  if (now.clusters.length) lines.push('');

  const crossPairs = all.filter((p) => !p.sameDoc);
  const border = crossPairs.filter((p) => Math.abs(p.sim - current) <= borderWidth);
  lines.push(
    `## Grenzfälle ${num(current - borderWidth)} bis ${num(current + borderWidth)}`,
    '',
    'Gehört das jeweils zusammen? Passt es über der Schwelle und nicht darunter, sitzt sie richtig.',
    '',
    ...(border.length ? spread(border, borderMax).map(pair) : ['Keine.']),
    '',
    '## Ähnlichste Paare aus verschiedenen Texten',
    '',
    ...(crossPairs.length ? crossPairs.slice(0, top).map(pair) : ['Keine.']),
    '',
  );
  return lines.join('\n');
}
