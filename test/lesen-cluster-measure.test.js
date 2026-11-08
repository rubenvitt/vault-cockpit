import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { clusterReport, measureThresholds, pairs, quantile } from '../src/lesen/cluster-measure.js';
import { createReadingStore } from '../src/lesen/store.js';

const n = (v) => {
  const l = Math.hypot(...v);
  return v.map((x) => x / l);
};

// a/b/c aus drei Texten nah beieinander, d im Text von a fast gleich, e weit weg.
const items = [
  { id: 'a', doc_id: 'A', quote: 'Erste Aussage', doc_title: 'Text A', created_at: '2026-10-28T10:00:00.000Z', week: 'W44' },
  { id: 'b', doc_id: 'B', quote: 'Zweite Aussage', doc_title: 'Text B', created_at: '2026-10-27T10:00:00.000Z', week: 'W44' },
  { id: 'c', doc_id: 'C', quote: 'Dritte Aussage', doc_title: 'Text C', created_at: '2026-10-20T10:00:00.000Z', week: 'W43' },
  { id: 'd', doc_id: 'A', quote: 'Noch eine aus A', doc_title: 'Text A', created_at: '2026-10-26T10:00:00.000Z', week: 'W44' },
  { id: 'e', doc_id: 'E', quote: 'Etwas ganz anderes', doc_title: 'Text E', created_at: '2026-10-26T09:00:00.000Z', week: 'W44' },
];
const vectors = [n([1, 0, 0]), n([0.9, 0.3, 0]), n([0.95, 0.2, 0]), n([1, 0.01, 0]), n([0, 0, 1])];
const groupOf = (h) => h.week;

test('Cluster-Messung: Paare, Quantile und Wirkung je Schwelle wie auf der Seite (je Woche)', () => {
  const all = pairs(items, vectors);
  assert.equal(all.length, 10);
  assert.ok(all.every((p, i) => i === 0 || all[i - 1].sim >= p.sim), 'ähnlichste zuerst');
  assert.equal(all.filter((p) => p.sameDoc).length, 1);

  assert.equal(quantile([], 0.5), null);
  assert.equal(quantile([3, 1, 2, 4], 0.5), 2);
  assert.equal(quantile([3, 1, 2, 4], 0.99), 4);

  const [low, high] = measureThresholds(items, vectors, { thresholds: [0.9, 0.999], groupOf });
  // a–b liegt bei 0,95 und in derselben Woche; c steht in einer anderen Woche, d im selben Text wie a.
  assert.equal(low.clusters.length, 1);
  assert.deepEqual(low.clusters[0].items.map((h) => h.id).sort(), ['a', 'b']);
  assert.equal(low.clusters[0].group, 'W44');
  assert.equal(low.groupsWithCluster, 1);
  assert.equal(low.clustered, 2);
  assert.ok(low.pairsAbove >= 3, 'über alle Wochen zählen auch a–c und b–c');
  assert.equal(high.clusters.length, 0);
});

test('Cluster-Messung: Bericht nennt Verteilung, Schwellen, Häufungen und Grenzfälle', () => {
  const md = clusterReport({ items, vectors, model: 'bge-m3', current: 0.9, date: '2026-11-08', groupOf, thresholds: [0.8, 0.95] });
  assert.match(md, /^# Cluster-Schwelle im Wiedersehen \(VCP-129\)/);
  assert.match(md, /2026-11-08, Modell bge-m3: 5 Markierungen aus 4 Texten, 2 Wochen\. Aktuelle Schwelle 0,90\./);
  assert.match(md, /\| verschiedene Texte \| 9 \|/);
  assert.match(md, /\| derselbe Text \| 1 \|/);
  assert.match(md, /\| 0,80 \|.*\n\| 0,90 \(aktuell\) \| \d+ \| 1 \| 1 \| 2 \|\n\| 0,95 \|/);
  assert.match(md, /## Häufungen bei 0,90\n\n- W44:\n {2}- „Erste Aussage“ \(Text A\)\n {2}- „Zweite Aussage“ \(Text B\)/);
  assert.match(md, /## Grenzfälle 0,85 bis 0,95/);
  assert.match(md, /## Ähnlichste Paare aus verschiedenen Texten\n\n- 0,99: „Zweite Aussage“ \(Text B\) ↔ „Dritte Aussage“ \(Text C\)/);
  assert.doesNotMatch(md, /„Noch eine aus A“ \(Text A\) ↔ „Erste Aussage“/, 'Paare aus demselben Text stehen nicht in den Listen');
});

test('Cluster-Messung: npm run messen:cluster liest den Lesestapel und bettet über Ollama ein', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cluster-'));
  const store = createReadingStore({ path: join(dir, 'lesestapel.db') });
  const a = store.addDocument({ url: 'https://a.test/1', title: 'Erster Text' }).doc;
  const b = store.addDocument({ url: 'https://b.test/2', title: 'Zweiter Text' }).doc;
  store.addHighlight({ doc_id: a.id, quote: 'Hund draußen' });
  store.addHighlight({ doc_id: b.id, quote: 'Hund im Park' });
  store.addHighlight({ doc_id: b.id, quote: 'Steuern' });
  store.close();

  const seen = [];
  const vec = (t) => (t.startsWith('Hund') ? [1, t.length / 100, 0] : [0, 0, 1]);
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const { model, input } = JSON.parse(body);
    seen.push({ path: req.url, model, input });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ embeddings: input.map(vec) }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    writeFileSync(join(dir, 'cockpit-settings.json'), JSON.stringify({ embed: { url: `http://127.0.0.1:${server.address().port}`, model: 'bge-test' } }));
    const { stdout } = await promisify(execFile)(process.execPath, ['src/cli/cluster-schwelle.js'], {
      env: { ...process.env, COCKPIT_SETTINGS_FILE: join(dir, 'cockpit-settings.json'), EMBED_URL: '', NODE_NO_WARNINGS: '1' },
    });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].path, '/api/embed');
    assert.equal(seen[0].model, 'bge-test');
    assert.deepEqual(seen[0].input.sort(), ['Hund draußen', 'Hund im Park', 'Steuern']);
    assert.match(stdout, /Modell bge-test: 3 Markierungen aus 2 Texten, 1 Wochen\. Aktuelle Schwelle 0,75\./);
    assert.match(stdout, /„Hund (draußen|im Park)“ \(\w+ Text\) ↔ „Hund (draußen|im Park)“/);
  } finally {
    server.close();
  }
});
