import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { buildIndex, openIndex } from '../src/vault/index.js';
import { compilePolicy } from '../src/vault/policy.js';
import { createWholeGraph, layoutInWorker } from '../src/graph/whole.js';
import { computeLayout } from '../src/graph/whole-layout.js';

const quiet = { info() {}, warn() {}, error() {} };
const policy = compilePolicy({
  exclude: ['^privat/'],
  sensitive: { 'areas/Gesundheit': 'gesundheit' },
  readwise: 'resources/readwise',
});

let root;
let idx;

before(() => {
  root = mkdtempSync(join(tmpdir(), 'vault-whole-'));
  const w = (p, c) => {
    mkdirSync(join(root, p, '..'), { recursive: true });
    writeFileSync(join(root, p), c);
  };
  w('projects/Alpha.md', '---\ntype: projekt\n---\n# Alpha\n\n[[Beta]] [[Werte]] [[Fremdtext]] [[Geheim]] [[Alpha]]');
  w('projects/Beta.md', '# Beta\n\n[[Alpha]] und nochmal [[Alpha]]');
  w('Start.md', '# Start\n\n[[Beta]] [[Fehlt]]');
  w('Einsam.md', 'ohne Links');
  w('areas/Gesundheit/Werte.md', '# Werte\n\n[[Alpha]]');
  w('resources/readwise/Fremdtext.md', '# Fremdtext\n\n[[Alpha]]');
  w('privat/Geheim.md', '# Geheim\n\n[[Alpha]]');
  buildIndex({ vaultPath: root, dbPath: ':memory:', policy, persist: (db, vp) => (idx = openIndex(db, { vaultPath: vp, policy })) });
});

after(() => rmSync(root, { recursive: true, force: true }));

test('Index: wholeGraph liefert eigene, nicht vertrauliche Notizen und ihre Links untereinander', () => {
  const { notes, links } = idx.wholeGraph();
  assert.deepEqual(notes.map((n) => n.path), ['Einsam.md', 'Start.md', 'projects/Alpha.md', 'projects/Beta.md']);
  assert.equal(notes.find((n) => n.path === 'projects/Alpha.md').type, 'projekt');
  // Ohne Selbstlink, ohne Doppelte, ohne vertrauliche, Readwise- und ausgeschlossene Notizen.
  assert.deepEqual(links, [
    ['Start.md', 'projects/Beta.md'],
    ['projects/Alpha.md', 'projects/Beta.md'],
    ['projects/Beta.md', 'projects/Alpha.md'],
  ]);
});

test('Layout: deterministisch, endlich, Startpunkte bleiben vertraut', () => {
  const input = { count: 6, edges: [0, 1, 1, 2, 2, 0, 3, 4], start: [] };
  const a = computeLayout(input);
  assert.deepEqual(a, computeLayout(input));
  assert.equal(a.length, 12);
  assert.ok(a.every(Number.isFinite));
  // Verbundene liegen näher beieinander als der Einzelgänger (Knoten 5) am Dreieck.
  const d = (i, j) => Math.hypot(a[2 * i] - a[2 * j], a[2 * i + 1] - a[2 * j + 1]);
  assert.ok(d(0, 1) < d(0, 5));

  const start = Array.from({ length: 6 }, (_, i) => [a[2 * i], a[2 * i + 1]]);
  const again = computeLayout({ ...input, start: [...start, null], count: 7, edges: [...input.edges, 6, 0] });
  // Ein neuer Knoten verschiebt die alten kaum.
  const moved = Math.max(...start.map(([x, y], i) => Math.hypot(again[2 * i] - x, again[2 * i + 1] - y)));
  const size = Math.max(...start.map(([x, y]) => Math.hypot(x, y)));
  assert.ok(moved < size, `verschoben ${moved}, Ausdehnung ${size}`);
  assert.deepEqual(computeLayout({ count: 0, edges: [] }), []);
  assert.deepEqual(computeLayout({ count: 1, edges: [] }).length, 2);
});

test('Layout im Worker-Thread liefert dasselbe wie im Haupt-Thread', async () => {
  const input = { count: 5, edges: [0, 1, 1, 2, 3, 4], start: [] };
  assert.deepEqual(await layoutInWorker(input), computeLayout(input));
});

/** Index-Attrappe mit Beobachtern wie der Index-Manager. */
function fakeIndex(state) {
  const listeners = new Set();
  return {
    wholeGraph: () => structuredClone(state),
    onChange: (fn) => (listeners.add(fn), () => listeners.delete(fn)),
    change: () => listeners.forEach((fn) => fn({ full: false, paths: [] })),
    listeners,
  };
}

test('Ganzer Vault: rechnet einmal, nach Änderungen gebündelt neu, nur Titel ändern das Layout nicht', async () => {
  const state = {
    notes: [
      { path: 'a.md', title: 'A', basename: 'a', type: null },
      { path: 'x/b.md', title: 'B', basename: 'b', type: 'projekt' },
    ],
    links: [['a.md', 'x/b.md'], ['a.md', 'fehlt.md']],
  };
  const index = fakeIndex(state);
  let runs = 0;
  const layout = async (input) => {
    runs += 1;
    return computeLayout(input);
  };
  const whole = createWholeGraph({ index, layout, debounceMs: 10, logger: quiet });
  const [first, second] = await Promise.all([whole.get(), whole.get()]);
  assert.equal(first, second, 'gleichzeitige Aufrufe teilen sich eine Berechnung');
  assert.equal(runs, 1);
  assert.deepEqual(first.payload.links, [0, 1], 'Links ins Leere fallen weg');
  assert.deepEqual(first.payload.folders, ['', 'x']);
  assert.deepEqual(JSON.parse(gunzipSync(first.gzip)), first.payload);
  assert.equal(first.etag, `"${first.payload.version}"`);

  // Nur ein Titel ändert sich: neuer Stand, gleiche Positionen, kein Layout.
  state.notes[0].title = 'A neu';
  index.change();
  index.change();
  await new Promise((r) => setTimeout(r, 40));
  const renamed = await whole.get();
  assert.equal(runs, 1);
  assert.equal(renamed.payload.nodes[0][1], 'A neu');
  assert.notEqual(renamed.etag, first.etag);
  assert.deepEqual(renamed.payload.nodes.map((n) => n.slice(4)), first.payload.nodes.map((n) => n.slice(4)));

  // Eine neue Notiz: Layout läuft wieder, mit den alten Positionen als Start.
  state.notes.push({ path: 'c.md', title: 'C', basename: 'c', type: null });
  state.links.push(['c.md', 'a.md']);
  const before = runs;
  index.change();
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(runs, before + 1);
  const grown = await whole.get();
  assert.equal(grown.payload.nodes.length, 3);
  assert.equal(grown.notes, 3);
  assert.equal(grown.links, 2);
  assert.ok(grown.payload.seconds >= 0);
  whole.stop();
  assert.equal(index.listeners.size, 0);
});

test('Ganzer Vault: Positionen überstehen einen Neustart ohne neues Layout', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'whole-file-'));
  const file = join(dir, 'graph-layout.json');
  const state = { notes: [{ path: 'a.md', title: 'A', basename: 'a', type: null }, { path: 'b.md', title: 'B', basename: 'b', type: null }], links: [['a.md', 'b.md']] };
  try {
    let runs = 0;
    const layout = async (input) => {
      runs += 1;
      return computeLayout(input);
    };
    const one = createWholeGraph({ index: fakeIndex(state), file, layout, logger: quiet });
    const a = await one.get();
    one.stop();
    assert.ok(JSON.parse(readFileSync(file, 'utf8')).positions['a.md']);

    const two = createWholeGraph({ index: fakeIndex(state), file, layout, logger: quiet });
    const b = await two.get();
    two.stop();
    assert.equal(runs, 1, 'gleiche Notizen und Links: Positionen aus der Datei');
    assert.deepEqual(b.payload.nodes, a.payload.nodes);

    // Neue Notiz nach dem Neustart: Layout startet bei den gespeicherten Positionen.
    state.notes.push({ path: 'c.md', title: 'C', basename: 'c', type: null });
    let start = null;
    const three = createWholeGraph({ index: fakeIndex(state), file, layout: async (input) => ((start = input.start), computeLayout(input)), logger: quiet });
    await three.get();
    three.stop();
    assert.deepEqual(start.slice(0, 2), [a.payload.nodes[0].slice(4), a.payload.nodes[1].slice(4)]);
    assert.equal(start[2], null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Ganzer Vault: scheitert das Layout, bleibt der alte Stand', async () => {
  const state = { notes: [{ path: 'a.md', title: 'A', basename: 'a', type: null }], links: [] };
  const index = fakeIndex(state);
  let fail = false;
  const whole = createWholeGraph({ index, layout: async (input) => {
    if (fail) throw new Error('kaputt');
    return computeLayout(input);
  }, debounceMs: 5, logger: quiet });
  const first = await whole.get();
  fail = true;
  state.notes.push({ path: 'b.md', title: 'B', basename: 'b', type: null });
  index.change();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(await whole.get(), first);
  whole.stop();

  const broken = createWholeGraph({ index: fakeIndex(state), layout: async () => { throw new Error('kaputt'); }, logger: quiet });
  await assert.rejects(broken.get(), /kaputt/);
  broken.stop();
});
