import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, unlinkSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildIndex, openIndex } from '../src/vault/index.js';
import { compilePolicy } from '../src/vault/policy.js';
import { chunkNote } from '../src/semantic/chunks.js';
import { createOllamaEmbedder, normalize } from '../src/semantic/embedder.js';
import { createSemanticIndex } from '../src/semantic/index.js';
import { hybridSearch } from '../src/semantic/search.js';
import { createGraph, findTaskLinks, dailyDate } from '../src/graph/graph.js';
import { renderGraph, renderSearch, layout } from '../src/web/graph-render.js';

const quiet = { info() {}, warn() {}, error() {} };

/**
 * Embedder für Tests: Wörter werden auf Dimensionen gehasht, Synonyme auf
 * dieselbe. So ähneln sich Texte mit gemeinsamen (oder synonymen) Wörtern,
 * ohne dass ein Modell läuft.
 */
const SYNONYMS = { hund: 'tier', katze: 'tier', haustier: 'tier', spaziergang: 'bewegung', joggen: 'bewegung', sport: 'bewegung' };
function fakeEmbedder({ dim = 64 } = {}) {
  const calls = [];
  return {
    model: 'fake-1',
    calls,
    async embed(texts) {
      calls.push(texts.length);
      return texts.map((t) => {
        const v = new Float32Array(dim);
        for (const raw of t.toLowerCase().match(/\p{L}+/gu) ?? []) {
          const w = SYNONYMS[raw] ?? raw;
          let h = 0;
          for (const ch of w) h = (h * 31 + ch.codePointAt(0)) >>> 0;
          v[h % dim] += 1;
        }
        return normalize(v);
      });
    },
  };
}

let root;
let index;

function write(rel, text) {
  mkdirSync(join(root, rel, '..'), { recursive: true });
  writeFileSync(join(root, rel), text);
}

before(() => {
  root = mkdtempSync(join(tmpdir(), 'vault-semantic-'));
  write('wiki/hund.md', '---\ntype: concept\n---\n# Hund\n\nMit dem Hund rausgehen ist Bewegung ohne Sport-Zwang. [[wiki/bewegung]]\n');
  write('wiki/bewegung.md', '# Bewegung\n\nSpaziergang statt Fitnessstudio.\n');
  write('wiki/katze.md', '# Katze\n\nDie Katze ist ein Haustier und schläft viel.\n');
  write('wiki/finanzen.md', '# Finanzen\n\nErst sich selbst bezahlen, dann andere. Rendite und Zinsen.\n');
  write('privat/tagebuch.md', '# Tagebuch\n\nHeute mit dem Hund im Wald.\n');
  write('readwise/artikel.md', '# Artikel\n\nHaustier Hund Katze.\n');
  write('journal/2026-10-12.md', '# Montag\n\n- [ ] Angebot schreiben [↗ VCP-3](https://zunder.example/#/aufgabe/abc123)\n- [x] Tierarzt [↗ Zunder](https://zunder.example/#/aufgabe/def456)\n\n```\n[x](https://zunder.example/#/aufgabe/imcode)\n```\n[[wiki/hund]]\n');
  const policy = compilePolicy({ sensitive: { privat: 'privat' }, readwise: 'readwise' });
  buildIndex({ vaultPath: root, dbPath: ':memory:', policy, logger: quiet, persist: (db, vp) => (index = openIndex(db, { vaultPath: vp, policy })) });
});

after(() => rmSync(root, { recursive: true, force: true }));

// --- Abschnitte -------------------------------------------------------------

test('chunkNote: schneidet an Überschriften, trägt Titel und Überschrift, ignoriert Codeblock-Überschriften', () => {
  const chunks = chunkNote('---\ntitle: Notiz\n---\nEinleitung mit genug Text für einen eigenen Abschnitt hier.\n\n## Teil A\nInhalt von Teil A, lang genug um nicht verworfen zu werden.\n\n```\n# kein Titel\n```\n## Teil B\nInhalt von Teil B, ebenfalls lang genug für einen Abschnitt.\n');
  assert.equal(chunks.length, 3);
  assert.equal(chunks[0].heading, null);
  assert.match(chunks[0].text, /^Notiz\nEinleitung/);
  assert.equal(chunks[1].heading, 'Teil A');
  assert.match(chunks[1].text, /# kein Titel/);
  assert.match(chunks[2].text, /^Notiz\nTeil B\n/);
});

test('chunkNote: lange Abschnitte werden an Absätzen geteilt, Obergrenze je Notiz', () => {
  const para = 'Wort '.repeat(100).trim();
  const chunks = chunkNote(`# T\n\n${Array.from({ length: 10 }, () => para).join('\n\n')}`, { maxChars: 1100, maxChunks: 3 });
  assert.equal(chunks.length, 3);
  for (const c of chunks) assert.ok(c.text.length <= 1100 + 10);
  assert.deepEqual(chunkNote('---\ntype: x\n---\n', { title: 'Leer' }).map((c) => c.text), ['Leer']);
});

// --- Embedder ---------------------------------------------------------------

test('Ollama-Embedder: lädt fehlendes Modell einmal, normalisiert Vektoren, meldet Fehler', async () => {
  const seen = [];
  let pulled = false;
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const msg = JSON.parse(body);
      seen.push(`${req.url} ${msg.model}`);
      if (req.url === '/api/pull') {
        pulled = true;
        res.end('{"status":"success"}');
      } else if (!pulled) {
        res.writeHead(404).end('{"error":"model not found"}');
      } else if (msg.input[0] === 'kaputt') {
        res.writeHead(500).end('{"error":"boom"}');
      } else {
        res.end(JSON.stringify({ embeddings: msg.input.map(() => [3, 4]) }));
      }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const e = createOllamaEmbedder({ url: `http://127.0.0.1:${server.address().port}/`, model: 'bge-m3', logger: quiet });
    const [v] = await e.embed(['hallo']);
    assert.deepEqual([...v].map((x) => Math.round(x * 10) / 10), [0.6, 0.8]);
    assert.deepEqual(seen, ['/api/embed bge-m3', '/api/pull bge-m3', '/api/embed bge-m3']);
    await assert.rejects(e.embed(['kaputt']), /HTTP 500/);
    assert.deepEqual(await e.embed([]), []);
  } finally {
    server.close();
  }
});

// --- Semantischer Index ------------------------------------------------------

test('Semantischer Index: bettet eigene Notizen ein, Readwise nicht, und nur Geändertes neu', async () => {
  const embedder = fakeEmbedder();
  const dbPath = join(root, '..', `vectors-${process.pid}-a.db`);
  const s = createSemanticIndex({ dbPath, vaultPath: root, index, embedder, logger: quiet });
  try {
    await s.schedule();
    const st = s.status();
    assert.equal(st.state, 'idle');
    assert.equal(st.notes, 7 - 1); // ohne readwise
    assert.ok(!s.has('readwise/artikel.md'));
    assert.ok(s.has('privat/tagebuch.md'));

    const before = embedder.calls.length;
    await s.schedule();
    assert.equal(embedder.calls.length, before, 'unveränderte Notizen werden nicht neu eingebettet');

    write('wiki/finanzen.md', '# Finanzen\n\nErst sich selbst bezahlen.\n\n## Neu\nEin neuer Abschnitt über Vermögen und Verbindlichkeiten.\n');
    await s.schedule(['wiki/finanzen.md']);
    assert.equal(embedder.calls.length, before + 1);
  } finally {
    s.close();
  }

  // Neu geöffnet: Vektoren kommen aus der Datei, kein neuer Lauf nötig.
  const again = createSemanticIndex({ dbPath, vaultPath: root, index, embedder, logger: quiet });
  assert.equal(again.status().notes, 6);
  again.close();

  // Anderes Modell: alle Vektoren verfallen.
  const other = createSemanticIndex({ dbPath, vaultPath: root, index, embedder: { ...fakeEmbedder(), model: 'fake-2' }, logger: quiet });
  assert.equal(other.status().notes, 0);
  other.close();
  unlinkSync(dbPath);
});

test('Semantischer Index: gelöschte Notizen verschwinden, Fehler des Servers landen im Status', async () => {
  write('wiki/weg.md', '# Weg\n\nGleich wieder gelöscht.\n');
  index.refresh('wiki/weg.md');
  let fail = false;
  const base = fakeEmbedder();
  const embedder = { model: 'fake-1', embed: (t) => (fail ? Promise.reject(new Error('Ollama nicht erreichbar')) : base.embed(t)) };
  const s = createSemanticIndex({ dbPath: ':memory:', vaultPath: root, index, embedder, logger: quiet });
  await s.schedule();
  assert.ok(s.has('wiki/weg.md'));

  rmSync(join(root, 'wiki/weg.md'));
  index.refresh('wiki/weg.md');
  await s.schedule(['wiki/weg.md']);
  assert.ok(!s.has('wiki/weg.md'));

  fail = true;
  write('wiki/neu.md', '# Neu\n\nNoch nicht eingebettet.\n');
  index.refresh('wiki/neu.md');
  await s.schedule(['wiki/neu.md']);
  assert.equal(s.status().state, 'error');
  assert.match(s.status().lastError, /nicht erreichbar/);
  assert.ok(s.has('wiki/hund.md'), 'der alte Stand bleibt nutzbar');
  rmSync(join(root, 'wiki/neu.md'));
  index.refresh('wiki/neu.md');
  s.close();
});

// --- Hybride Suche -----------------------------------------------------------

async function semanticIndex() {
  const s = createSemanticIndex({ dbPath: ':memory:', vaultPath: root, index, embedder: fakeEmbedder(), logger: quiet });
  await s.schedule();
  return s;
}

test('Hybride Suche: findet über Bedeutung, was der Volltext nicht findet', async () => {
  const s = await semanticIndex();
  // „Haustier“ steht wörtlich nur in der Katze; der Hund kommt über das Synonym.
  const res = await hybridSearch({ index, semantic: s, query: 'Haustier', limit: 10 });
  const paths = res.results.map((r) => r.path);
  assert.equal(res.degraded, null);
  assert.ok(paths.includes('wiki/katze.md'));
  assert.ok(paths.includes('wiki/hund.md'));
  const katze = res.results.find((r) => r.path === 'wiki/katze.md');
  assert.deepEqual(katze.streams.sort(), ['semantic', 'text']);
  const hund = res.results.find((r) => r.path === 'wiki/hund.md');
  assert.ok(hund.streams.includes('semantic'));
  assert.ok(hund.snippet, 'Treffer ohne Volltext bekommen einen Ausschnitt');
  // Vertrauliches und Readwise bleiben außen vor.
  assert.ok(!paths.includes('privat/tagebuch.md'));
  assert.ok(!paths.includes('readwise/artikel.md'));
  const withSensitive = await hybridSearch({ index, semantic: s, query: 'Hund', includeSensitive: true, limit: 20 });
  assert.ok(withSensitive.results.some((r) => r.path === 'privat/tagebuch.md'));
  s.close();
});

test('Hybride Suche: Graph hebt Nachbarn, Filter wirken, ohne Embeddings nur Volltext', async () => {
  const s = await semanticIndex();
  const res = await hybridSearch({ index, semantic: s, query: 'Fitnessstudio', limit: 10 });
  const hund = res.results.find((r) => r.path === 'wiki/hund.md');
  assert.ok(hund?.streams.includes('graph'), 'die verlinkte Hund-Notiz kommt über den Graphen');

  const filtered = await hybridSearch({ index, semantic: s, query: 'Hund', folder: 'journal', limit: 10 });
  assert.deepEqual(filtered.results.map((r) => r.path), ['journal/2026-10-12.md']);

  const only = await hybridSearch({ index, semantic: s, query: 'Haustier', mode: 'semantic', limit: 3 });
  assert.ok(only.results.every((r) => r.streams.join() === 'semantic'));
  s.close();

  const plain = await hybridSearch({ index, semantic: null, query: 'Katze Haustier', limit: 5 });
  assert.match(plain.degraded, /nicht eingerichtet/);
  assert.equal(plain.results[0].path, 'wiki/katze.md');

  const down = { embedQuery: () => Promise.reject(new Error('weg')), searchVector: () => [] };
  const fallback = await hybridSearch({ index, semantic: down, query: 'Katze', limit: 5 });
  assert.match(fallback.degraded, /nicht verfügbar \(weg\)/);
  assert.equal(fallback.results[0].path, 'wiki/katze.md');
});

// --- Graph -------------------------------------------------------------------

test('findTaskLinks und dailyDate', () => {
  const links = findTaskLinks('- [ ] Angebot [↗ VCP-3](https://z/#/aufgabe/a1)\n- [x] Fertig [↗ Zunder](https://z/#/aufgabe/b2)\n```\n[x](https://z/#/aufgabe/c3)\n```\nSiehe [Aufgabe](https://z/#/aufgabe/a1)');
  assert.deepEqual(links.map((l) => [l.id, l.label, l.done]), [['a1', 'Angebot', false], ['b2', 'Fertig', true]]);
  assert.equal(dailyDate({ path: 'journal/2026-10-12.md', frontmatter: {} }), '2026-10-12');
  assert.equal(dailyDate({ path: 'journal/Montag.md', frontmatter: { type: 'daily-note', date: '2026-10-12' } }), '2026-10-12');
  assert.equal(dailyDate({ path: 'wiki/hund.md', frontmatter: { date: '2026-10-12' } }), null);
});

test('Graph: Links, semantische Kanten, Aufgaben mit Zunder-Status und Termine der Tagesnotiz', async () => {
  const s = await semanticIndex();
  const zunder = {
    taskUrl: (id) => `https://zunder.example/#/aufgabe/${id}`,
    async getTask(id) {
      if (id === 'def456') throw new Error('Zunder weg');
      return { id, ref: 'VCP-3', title: 'Angebot schreiben (Zunder)', status: 'in_progress' };
    },
  };
  const days = [];
  const calendar = {
    async events(start, end) {
      days.push([start.toISOString(), end.toISOString()]);
      return [{ title: 'Tierarzt', start: new Date('2026-10-12T08:00:00Z'), end: new Date('2026-10-12T09:00:00Z'), allDay: false, calendar: 'Privat' }];
    },
  };
  const graph = createGraph({ index, semantic: s, zunder, calendar, logger: quiet });

  const g = await graph.around('journal/2026-10-12.md', { minSimilarity: 0 });
  const kinds = (k) => g.edges.filter((e) => e.kind === k);
  assert.equal(g.center, 'note:journal/2026-10-12.md');
  assert.deepEqual(kinds('link').map((e) => e.to), ['note:wiki/hund.md']);
  assert.deepEqual(days, [['2026-10-11T22:00:00.000Z', '2026-10-12T22:00:00.000Z']]);
  assert.equal(kinds('event').length, 1);
  const tasks = g.nodes.filter((n) => n.kind === 'task');
  assert.deepEqual(tasks.map((t) => [t.taskId, t.label, t.status]).sort(), [
    ['abc123', 'Angebot schreiben (Zunder)', 'in_progress'],
    ['def456', 'Tierarzt', 'done'],
  ]);
  assert.ok(g.problems.some((p) => /1 Aufgabe/.test(p)));
  // Semantische Kanten nur zu nicht verlinkten Notizen, nie zu Vertraulichem.
  const sem = kinds('semantic').map((e) => e.to);
  assert.ok(sem.length > 0);
  assert.ok(!sem.includes('note:wiki/hund.md'));
  assert.ok(!sem.includes('note:privat/tagebuch.md'));

  // Tiefe 2 holt die Nachbarn des Hundes.
  const g2 = await graph.around('journal/2026-10-12.md', { depth: 2, similar: 0 });
  assert.ok(g2.nodes.some((n) => n.path === 'wiki/bewegung.md' && n.level === 2));

  assert.equal(await graph.around('privat/tagebuch.md'), null);
  assert.ok(await graph.around('privat/tagebuch.md', { includeSensitive: true }));
  assert.equal(await graph.around('gibt/es/nicht.md'), null);

  // Ohne Embeddings, Zunder und Kalender: Graph aus Links, Hinweise statt Fehler.
  const bare = await createGraph({ index, logger: quiet }).around('journal/2026-10-12.md');
  assert.ok(bare.nodes.some((n) => n.kind === 'task' && n.status === 'open'));
  assert.ok(bare.problems.some((p) => /EMBED_URL/.test(p)));
  assert.ok(bare.problems.some((p) => /Einstellungen → Kalender/.test(p)));
  s.close();
});

test('Graph-Seite: SVG mit Knoten als Links, gestrichelte semantische Kanten, kein Skript', async () => {
  const s = await semanticIndex();
  const g = await createGraph({ index, semantic: s, logger: quiet }).around('wiki/hund.md', { minSimilarity: 0, depth: 2 });
  const html = renderGraph(g, { vaultName: 'r-notes', user: 'ruben' });
  assert.match(html, /<svg class="graph"/);
  assert.match(html, /class="edge semantic"/);
  assert.match(html, /href="\/graph\?pfad=wiki%2Fbewegung\.md"/);
  assert.match(html, /obsidian:\/\/open\?vault=r-notes&amp;file=wiki%2Fhund/);
  assert.match(html, /Ähnlich, nicht verlinkt/);
  assert.doesNotMatch(html, /<script/i);
  const pos = layout(g);
  for (const n of g.nodes) assert.ok(pos.has(n.id), `Position für ${n.id}`);

  const res = await hybridSearch({ index, semantic: s, query: 'Haustier <b>', limit: 5 });
  const page = renderSearch('Haustier <b>', res, { user: 'ruben' });
  assert.match(page, /Treffer/);
  assert.match(page, /value="Haustier &lt;b&gt;"/);
  assert.match(renderSearch('', { results: [] }), /Suchbegriff oder Frage/);
  s.close();
});
