import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildIndex, openIndex } from '../src/vault/index.js';
import { compilePolicy } from '../src/vault/policy.js';
import { createEditor } from '../src/vault/edit.js';
import { createSettingsStore } from '../src/cockpit/settings.js';
import { normalize } from '../src/semantic/embedder.js';
import { createSemanticIndex } from '../src/semantic/index.js';
import { createReadingStore } from '../src/lesen/store.js';
import { createReadingExport, blockId } from '../src/lesen/vault-export.js';
import { createEmbedCache } from '../src/lesen/embed-cache.js';
import { readingRoutes } from '../src/lesen/http.js';
import { createApp } from '../src/http/app.js';
import { createWebHttp } from '../src/web/http.js';
import { createCookieSigner } from '../src/web/session.js';

const quiet = { info() {}, warn() {}, error() {} };
const WORDS = ['apfel', 'birne', 'kirsche'];

/** Feste Vektoren: je Obstsorte eine Dimension, dazu ein kleiner Rest, damit kein Vektor null ist. */
const fruitEmbedder = () => ({
  model: 'obst-1',
  async embed(texts) {
    return texts.map((t) => {
      const words = t.toLowerCase().match(/\p{L}+/gu) ?? [];
      return normalize(Float32Array.from([...WORDS.map((w) => words.filter((x) => x === w).length), 0.05]));
    });
  },
});

let root, policy, idx, editor, store, exporter, semantic, docs, hl;

function note(path, type, body) {
  mkdirSync(join(root, path, '..'), { recursive: true });
  writeFileSync(join(root, path), `---\ntype: ${type}\n---\n${body}`);
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'verbindungen-'));
  note('wiki/obst.md', 'synthesis', '# Obst\n\n## Äpfel im Herbst\n\nApfel Apfel Apfel.\n');
  note('wiki/birnen.md', 'concept', '# Birnen\n\nBirne Apfel Birne Birne.\n');
  note('wiki/notiz.md', 'note', '# Notiz\n\nApfel.\n');
  note('20-bereiche/Gesundheit/geheim.md', 'synthesis', '# Geheim\n\nApfel.\n');
  policy = compilePolicy({ sensitive: { '20-bereiche/Gesundheit': 'gesundheit' } });
  buildIndex({ vaultPath: root, dbPath: ':memory:', policy, logger: quiet, persist: (db, vp) => (idx = openIndex(db, { vaultPath: vp, policy })) });
  editor = createEditor({ vaultPath: root, index: idx });
  store = createReadingStore({ path: ':memory:' });
  docs = {
    a: store.addDocument({ url: 'https://a.test/1', title: 'Eigener Text' }).doc,
    b: store.addDocument({ url: 'https://b.test/2', title: 'Zweiter Text' }).doc,
    c: store.addDocument({ url: 'https://c.test/3', title: 'Dritter Text' }).doc,
  };
  hl = {
    a: store.addHighlight({ doc_id: docs.a.id, quote: 'Apfel', start_hint: 1 }),
    a2: store.addHighlight({ doc_id: docs.a.id, quote: 'Apfel Apfel', start_hint: 9 }),
    b: store.addHighlight({ doc_id: docs.b.id, quote: 'Apfel und Birne' }),
    c: store.addHighlight({ doc_id: docs.c.id, quote: 'Kirsche' }),
  };
  const settings = createSettingsStore({ defaults: { tz: 'Europe/Berlin' }, logger: quiet });
  exporter = createReadingExport({ vaultPath: root, index: idx, editor, policy, store, settings, delayMs: 60_000, logger: quiet });
  semantic = createSemanticIndex({ dbPath: ':memory:', vaultPath: root, index: idx, embedder: fruitEmbedder(), logger: quiet });
  await semantic.schedule();
});
afterEach(() => {
  exporter.stop();
  semantic.close();
  idx.close();
  rmSync(root, { recursive: true, force: true });
});

const routesWith = (embedder) =>
  readingRoutes({ store, logger: quiet, embedCache: createEmbedCache({ embedder: () => embedder, logger: quiet }), connections: { index: idx, semantic: () => semantic, policy, exporter } });
async function find(routes, params) {
  const r = await routes.pages['/api/lesen/verbindungen']({ url: new URL(`https://vault.test/api/lesen/verbindungen?${new URLSearchParams(params)}`) });
  return { status: r.status, ...JSON.parse(r.body) };
}
const connect = (routes, fields) => routes.actions['/aktion/lesen/verbinden'](new URLSearchParams(fields), { sub: 'ruben' });

test('Querverbindungen: ähnlichste Markierungen anderer Texte und Synthesen/Konzepte, ohne eigenes Dokument und Vertrauliches', async () => {
  const routes = routesWith(fruitEmbedder());
  const r = await find(routes, { markierung: hl.a.id });
  assert.equal(r.status, 200);
  assert.equal(r.source, 'semantic');
  assert.equal(r.problem, null);
  assert.deepEqual(r.highlights.map((h) => h.id), [hl.b.id, hl.c.id], 'eigenes Dokument fehlt, Reihenfolge nach Ähnlichkeit');
  assert.equal(r.highlights[0].title, 'Zweiter Text');
  assert.equal(r.highlights[0].href, `/lesen/doc?id=${docs.b.id}#h-${hl.b.id}`);
  assert.deepEqual(r.notes.map((n) => n.path), ['wiki/obst.md', 'wiki/birnen.md'], 'nur Synthesen und Konzepte, nichts Vertrauliches');
  assert.equal(r.notes[0].heading, 'Äpfel im Herbst');
  assert.match(r.notes[0].text, /Apfel Apfel/);
  assert.ok(r.notes[0].score > r.notes[1].score);

  // Eine Auswahl ohne Markierung wird direkt eingebettet.
  const sel = await find(routes, { doc: docs.a.id, text: 'Kirsche' });
  assert.equal(sel.highlightId, null);
  assert.equal(sel.highlights[0].id, hl.c.id);

  assert.equal((await find(routes, { markierung: 'gibt-es-nicht' })).status, 404);
  assert.equal((await find(routes, { doc: docs.a.id, text: '  ' })).status, 400);
});

test('Querverbindungen: Verknüpfen schreibt den Wikilink in die Lesestapel-Notiz, der Index kennt ihn, danach „Schon verknüpft“', async () => {
  const routes = routesWith(fruitEmbedder());
  const before = readFileSync(join(root, 'wiki/obst.md'), 'utf8');
  const r1 = await connect(routes, { markierung: hl.a.id, pfad: 'wiki/obst.md', abschnitt: 'Äpfel im Herbst' });
  assert.equal(r1.message, 'Verknüpft mit Obst');
  const own = exporter.notePath(docs.a.id);
  assert.ok(own, 'Lesestapel-Notiz angelegt');
  assert.match(readFileSync(join(root, own), 'utf8'), new RegExp(`\\^${blockId(hl.a.id)}\\n\\nVerknüpft: \\[\\[obst#Äpfel im Herbst\\]\\]`));
  assert.equal(readFileSync(join(root, 'wiki/obst.md'), 'utf8'), before, 'die Zielnotiz bleibt unberührt');

  // Ziel Markierung: Der andere Text bekommt seine Notiz, damit der Link nicht ins Leere zeigt.
  const r2 = await connect(routes, { markierung: hl.a.id, zu: hl.b.id });
  assert.equal(r2.message, 'Verknüpft mit Zweiter Text');
  const other = exporter.notePath(docs.b.id);
  assert.ok(other);
  assert.equal(r2.link.target, `${other.split('/').pop().replace(/\.md$/, '')}#^${blockId(hl.b.id)}`);

  assert.deepEqual(idx.outgoingLinks(own).map((l) => l.path).sort(), [other, 'wiki/obst.md'].sort());
  let fresh;
  buildIndex({ vaultPath: root, dbPath: ':memory:', policy, logger: quiet, persist: (db, vp) => (fresh = openIndex(db, { vaultPath: vp, policy })) });
  assert.deepEqual(fresh.outgoingLinks(own).map((l) => l.path).sort(), [other, 'wiki/obst.md'].sort(), 'auch nach dem Neuindexieren');
  fresh.close();

  const again = await find(routes, { markierung: hl.a.id });
  assert.deepEqual(again.linked.map((l) => l.target), ['obst#Äpfel im Herbst', r2.link.target]);
  assert.equal(again.linked[0].href, '/notiz?pfad=wiki%2Fobst.md');
  assert.equal(again.notes.find((n) => n.path === 'wiki/obst.md').linked, true);
  assert.equal(again.notes.find((n) => n.path === 'wiki/birnen.md').linked, false);
  assert.equal(again.highlights.find((h) => h.id === hl.b.id).linked, true);
  assert.equal((await connect(routes, { markierung: hl.a.id, pfad: 'wiki/obst.md', abschnitt: 'Äpfel im Herbst' })).message, 'Schon verknüpft mit Obst');

  await assert.rejects(connect(routes, { markierung: hl.a.id, pfad: '20-bereiche/Gesundheit/geheim.md' }), { status: 404 });
  await assert.rejects(connect(routes, { markierung: hl.a.id, pfad: own }), /verlinkt sich nicht selbst/);
  await assert.rejects(connect(routes, { markierung: hl.a.id, zu: hl.a.id }), { status: 404 });

  // In einen vertraulichen Ordner verschoben: Das Cockpit liest die Notiz nicht mehr.
  const moved = '20-bereiche/Gesundheit/eigener-text.md';
  mkdirSync(join(root, '20-bereiche/Gesundheit'), { recursive: true });
  renameSync(join(root, own), join(root, moved));
  idx.refresh(own);
  idx.refresh(moved);
  assert.equal(exporter.notePath(docs.a.id), moved);
  assert.deepEqual((await find(routes, { markierung: hl.a.id })).linked, []);
});

test('Querverbindungen: ohne Embedder oder ohne Ollama Volltext mit Hinweis, ohne eigene Lesestapel-Notiz', async () => {
  exporter.ensureNote(docs.a.id);
  exporter.ensureNote(docs.b.id);
  const off = await find(routesWith(null), { markierung: hl.a.id });
  assert.equal(off.source, 'text');
  assert.match(off.problem, /Ohne Embeddings .*nur Volltext/);
  assert.deepEqual(off.highlights, []);
  const paths = off.notes.map((n) => n.path);
  assert.ok(paths.includes('wiki/obst.md') && paths.includes(exporter.notePath(docs.b.id)));
  assert.ok(!paths.includes(exporter.notePath(docs.a.id)), 'eigene Lesestapel-Notiz fehlt');
  assert.ok(!paths.includes('20-bereiche/Gesundheit/geheim.md') && !paths.includes('wiki/notiz.md'));

  const broken = await find(routesWith({ model: 'obst-1', embed: async () => Promise.reject(new Error('Ollama nicht erreichbar')) }), { markierung: hl.a.id });
  assert.equal(broken.source, 'text');
  assert.match(broken.problem, /Embeddings gerade nicht erreichbar \(Ollama nicht erreichbar\), nur Volltext/);
  assert.ok(broken.notes.some((n) => n.path === 'wiki/obst.md'));
});

test('Querverbindungen über das Cockpit: JSON nur angemeldet (sonst 401), Leseansicht lädt das Skript', async () => {
  const SECRET = 'x'.repeat(40);
  const webHttp = createWebHttp({
    cockpit: { week: async () => null },
    settings: createSettingsStore({ defaults: { tz: 'Europe/Berlin' }, logger: quiet }),
    reading: routesWith(fruitEmbedder()),
    oidc: {},
    sessionSecret: SECRET,
    publicUrl: 'https://vault.test',
    allowedSubjects: ['ruben'],
    logger: quiet,
  });
  const app = createApp({
    config: { publicUrl: 'https://vault.test', resource: 'https://vault.test/mcp', issuer: 'https://id.test', supportedScopes: [], allowedHosts: ['vault.test'], trustProxy: true },
    verifyToken: async () => {
      throw new Error('nicht benutzt');
    },
    mcpHandler: async () => {},
    webHttp,
    logger: quiet,
  });
  app.listen(0, '127.0.0.1');
  await new Promise((res) => app.once('listening', res));
  const t = Math.floor(Date.now() / 1000);
  const cookie = `vc_session=${createCookieSigner(SECRET).seal({ sub: 'ruben', sid: 's1', gen: 0, iat: t, seen: t, exp: t + 3600 })}`;
  const get = (path, headers = {}) => fetch(`http://127.0.0.1:${app.address().port}${path}`, { redirect: 'manual', headers: { 'x-forwarded-host': 'vault.test', ...headers } });
  try {
    const api = `/api/lesen/verbindungen?markierung=${hl.a.id}`;
    const anon = await get(api);
    assert.equal(anon.status, 401);
    assert.equal((await anon.json()).error, 'unauthorized');
    const res = await get(api, { cookie });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /^application\/json/);
    assert.equal((await res.json()).highlights[0].id, hl.b.id);
    const html = await (await get(`/lesen/doc?id=${docs.a.id}`, { cookie })).text();
    const src = html.match(/<script src="(\/static\/lesen-verbinden\.js\?v=[\w-]+)"/)[1];
    assert.match(html, /data-verbindungen/);
    const js = await get(src);
    assert.equal(js.status, 200);
    assert.match(await js.text(), /lesen:verbinden/);
  } finally {
    app.close();
  }
});

test('Querverbindungen (VCP-85): Verknüpfen kommt mit Rückgängig, das den Link wieder herausnimmt', async () => {
  const routes = routesWith(fruitEmbedder());
  const r = await connect(routes, { markierung: hl.a.id, pfad: 'wiki/obst.md' });
  assert.deepEqual(r.undo, { action: '/aktion/lesen/verbinden/loesen', fields: { markierung: hl.a.id, ziel: 'obst' } });
  assert.equal((await connect(routes, { markierung: hl.a.id, pfad: 'wiki/obst.md' })).undo, null, 'schon verknüpft: kein Rückgängig');

  const undo = (fields) => routes.actions[r.undo.action](new URLSearchParams(fields), { sub: 'ruben' });
  assert.equal((await undo(r.undo.fields)).message, 'Verknüpfung gelöst');
  const own = exporter.notePath(docs.a.id);
  assert.doesNotMatch(readFileSync(join(root, own), 'utf8'), /Verknüpft:/);
  assert.deepEqual((await find(routes, { markierung: hl.a.id })).linked, []);
  assert.equal((await undo(r.undo.fields)).message, 'War nicht (mehr) verknüpft');
  await assert.rejects(undo({ markierung: 'nein', ziel: 'obst' }), { status: 404 });
  await assert.rejects(undo({ markierung: hl.a.id, ziel: ' ' }), /Welche Verknüpfung/);
});
