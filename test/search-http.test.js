import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildIndex, openIndex } from '../src/vault/index.js';
import { compilePolicy } from '../src/vault/policy.js';
import { createSearchHttp } from '../src/search/http.js';
import { createTokenStore } from '../src/cockpit/tokens.js';
import { createApp } from '../src/http/app.js';

const quiet = { info() {}, warn() {}, error() {} };
let root, index, tokens, token;

function write(rel, text) {
  mkdirSync(join(root, rel, '..'), { recursive: true });
  writeFileSync(join(root, rel), text);
}

before(() => {
  root = mkdtempSync(join(tmpdir(), 'vault-search-http-'));
  write('wiki/hund.md', '# Hund\n\nMit dem Hund in den Wald. [[wiki/wald]]\n');
  write('wiki/wald.md', '# Wald\n\nBäume und Wege.\n');
  write('privat/tagebuch.md', '# Tagebuch\n\nHeute mit dem Hund im Wald.\n');
  write('readwise/artikel.md', '# Artikel\n\nHund und Wald.\n');
  for (let i = 0; i < 60; i++) write(`masse/notiz-${i}.md`, `# Notiz ${i}\n\nZettelkasten Eintrag ${i}.\n`);
  // Synthese für die Fragesuche (VCP-76) und ablenkende Nicht-Synthesen mit denselben Wörtern.
  write('wiki/synthesis/Architektur statt Disziplin.md', '---\ntype: synthesis\nsummary: Gute Struktur ersetzt Willenskraft.\n---\n# Architektur statt Disziplin\n\nWo Struktur fehlt, muss Willenskraft alles tragen.\n');
  write('wiki/synthesis/Gewohnheiten.md', '---\ntype: synthesis\n---\n# Gewohnheiten\n\nKleine Schritte, jeden Tag.\n');
  write('wiki/concepts/Willenskraft.md', '---\ntype: concept\n---\n# Willenskraft\n\nWo hilft Willenskraft mehr als Struktur? Willenskraft, Willenskraft, Struktur, Struktur, mehr als genug.\n');
  write('wiki/Struktur.md', '# Struktur\n\nStruktur hilft mehr als Willenskraft, sagt man. Struktur, Struktur.\n');
  write('privat/Synthese Willenskraft.md', '---\ntype: synthesis\n---\n# Geheime Synthese\n\nWo hilft Struktur mehr als Willenskraft? Struktur Willenskraft.\n');
  const policy = compilePolicy({ sensitive: { privat: 'privat' }, readwise: 'readwise' });
  tokens = createTokenStore({ logger: quiet });
  ({ token } = tokens.create('Test'));
  buildIndex({ vaultPath: root, dbPath: ':memory:', policy, logger: quiet, persist: (db, vp) => (index = openIndex(db, { vaultPath: vp, policy })) });
});

after(() => rmSync(root, { recursive: true, force: true }));

async function withServer(run, { searchHttp = createSearchHttp({ tokens, index }) } = {}) {
  const app = createApp({
    config: { publicUrl: 'https://vault.test', resource: 'https://vault.test/mcp', issuer: 'https://id.test', supportedScopes: [], allowedHosts: ['vault.test'], trustProxy: true },
    verifyToken: async () => {
      throw new Error('nicht benutzt');
    },
    mcpHandler: async () => {},
    searchHttp,
    logger: quiet,
  });
  app.listen(0, '127.0.0.1');
  await new Promise((res) => app.once('listening', res));
  const base = `http://127.0.0.1:${app.address().port}`;
  const call = (path, { method = 'GET', auth = `Bearer ${token}` } = {}) =>
    fetch(base + path, { method, headers: { 'x-forwarded-host': 'vault.test', ...(auth ? { authorization: auth } : {}) } });
  try {
    await run(call);
  } finally {
    app.close();
  }
}

test('/api/search verlangt einen angelegten API-Token, widerrufene gelten nicht', async () => {
  await withServer(async (call) => {
    assert.equal((await call('/api/search?q=Hund')).status, 200);
    assert.equal((await call('/api/search?q=Hund', { auth: null })).status, 401);
    assert.equal((await call('/api/search?q=Hund', { auth: 'Bearer falsch' })).status, 401);
    assert.equal((await call('/api/search?q=Hund', { auth: `Bearer ${token}x` })).status, 401);
    assert.equal((await call('/api/search?q=Hund', { auth: token })).status, 401);
    assert.equal((await call('/api/search?q=Hund', { method: 'POST' })).status, 405);

    const second = tokens.create('Zweiter');
    assert.equal((await call('/api/search?q=Hund', { auth: `Bearer ${second.token}` })).status, 200);
    tokens.revoke(second.id);
    assert.equal((await call('/api/search?q=Hund', { auth: `Bearer ${second.token}` })).status, 401);
    assert.equal((await call('/api/search?q=Hund')).status, 200);
  });
});

test('API-Tokens: nur der Hash landet in der Datei, Grenzen werden geprüft', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vault-tokens-'));
  try {
    const file = join(dir, 'api-tokens.json');
    const store = createTokenStore({ file, logger: quiet });
    const created = store.create('  Raycast  ');
    assert.match(created.token, /^vct_[\w-]{43}$/);
    const text = readFileSync(file, 'utf8');
    assert.ok(!text.includes(created.token));
    assert.equal(statSync(file).mode & 0o777, 0o600);
    const [saved] = JSON.parse(text);
    assert.deepEqual(Object.keys(saved).sort(), ['createdAt', 'hash', 'id', 'name', 'scope']);
    assert.equal(saved.scope, 'search');
    assert.equal(saved.name, 'Raycast');

    const reloaded = createTokenStore({ file, logger: quiet });
    assert.ok(reloaded.verify(created.token));
    assert.ok(!reloaded.verify('vct_falsch'));
    assert.throws(() => reloaded.create(' '), /Namen/);
    assert.throws(() => reloaded.create('x'.repeat(81)), /zu lang/);
    for (let i = 1; i < 20; i++) reloaded.create(`T${i}`);
    assert.throws(() => reloaded.create('zu viel'), /Höchstens 20/);
    assert.ok(reloaded.revoke(saved.id));
    assert.ok(!reloaded.revoke(saved.id));
    assert.ok(!createTokenStore({ file, logger: quiet }).verify(created.token));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('/api/search prüft die Parameter', async () => {
  await withServer(async (call) => {
    assert.equal((await call('/api/search')).status, 400);
    assert.equal((await call('/api/search?q=%20')).status, 400);
    assert.equal((await call('/api/search?q=Hund&mode=text')).status, 400);
    assert.equal((await call('/api/search?q=Hund&limit=abc')).status, 400);
    assert.equal((await call('/api/search?q=Hund&offset=-1')).status, 400);
  });
});

test('/api/search liefert das Ergebnis der hybriden Suche, nur eigene Notizen', async () => {
  await withServer(async (call) => {
    const res = await call('/api/search?q=Hund%20Wald');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const body = await res.json();
    assert.deepEqual(Object.keys(body).sort(), ['degraded', 'hasMore', 'results', 'total']);
    assert.match(body.degraded, /Embeddings/);
    const paths = body.results.map((r) => r.path);
    assert.ok(paths.includes('wiki/hund.md'));
    assert.ok(!paths.some((p) => p.startsWith('privat/') || p.startsWith('readwise/')));
    for (const r of body.results) {
      for (const key of ['path', 'title', 'streams', 'similarity', 'score']) assert.ok(key in r, key);
    }

    const folder = await (await call('/api/search?q=Hund%20Wald&folder=wiki&limit=1')).json();
    assert.equal(folder.results.length, 1);
    assert.ok(folder.results[0].path.startsWith('wiki/'));
  });
});

test('/api/search begrenzt limit auf 50', async () => {
  // Der Volltext liefert höchstens 50 Treffer; die Semantik-Attrappe ergänzt
  // alle 60 Notizen, damit es mehr Treffer als das Limit gibt.
  const semantic = {
    embedQuery: async () => [1],
    searchVector: (_vec, { allow }) =>
      Array.from({ length: 60 }, (_, i) => ({ path: `masse/notiz-${i}.md`, score: 0.5, heading: null })).filter((h) => allow(h.path)),
  };
  await withServer(async (call) => {
    const body = await (await call('/api/search?q=Zettelkasten&limit=500')).json();
    assert.equal(body.total, 60);
    assert.equal(body.results.length, 50);
    assert.equal(body.hasMore, true);
    assert.equal(body.degraded, null);
    const rest = await (await call('/api/search?q=Zettelkasten&limit=50&offset=50')).json();
    assert.equal(rest.results.length, 10);
    assert.equal(rest.hasMore, false);
  }, { searchHttp: createSearchHttp({ tokens, index, semantic }) });
});

test('API-Tokens: Rechte trennen Suche und Capture, alte Tokens gelten als Suche', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vault-tokens-'));
  try {
    const file = join(dir, 'api-tokens.json');
    const store = createTokenStore({ file, logger: quiet });
    const search = store.create('Raycast');
    const cap = store.create('iPhone', 'capture');
    assert.equal(cap.scope, 'capture');
    assert.ok(store.verify(search.token, 'search'));
    assert.ok(!store.verify(search.token, 'capture'));
    assert.ok(store.verify(cap.token, 'capture'));
    assert.ok(!store.verify(cap.token), 'ohne Angabe nur Suche');
    assert.ok(store.has('capture'));
    assert.throws(() => store.create('x', 'admin'), /Recht/);

    // Datei aus der Zeit vor den Rechten: Eintrag ohne scope.
    const legacy = JSON.parse(readFileSync(file, 'utf8')).map(({ scope, ...rest }) => rest);
    writeFileSync(file, JSON.stringify(legacy));
    const reloaded = createTokenStore({ file, logger: quiet });
    assert.deepEqual(reloaded.list().map((t) => t.scope), ['search', 'search']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('/api/search lehnt Capture-Tokens ab', async () => {
  const cap = tokens.create('Kurzbefehl', 'capture');
  try {
    await withServer(async (call) => {
      assert.equal((await call('/api/search?q=Hund', { auth: `Bearer ${cap.token}` })).status, 401);
    });
  } finally {
    tokens.revoke(cap.id);
  }
});

test('/api/search filtert nach type: die Frage findet die Synthese, nicht die ablenkenden Notizen', async () => {
  await withServer(async (call) => {
    const q = encodeURIComponent('Wo hilft Struktur mehr als Willenskraft?');
    const all = await (await call(`/api/search?q=${q}`)).json();
    assert.notEqual(all.results[0].title, 'Architektur statt Disziplin', 'ohne Filter liegen die ablenkenden Notizen vorn');

    const only = await (await call(`/api/search?q=${q}&type=synthesis`)).json();
    assert.equal(only.results[0].title, 'Architektur statt Disziplin');
    assert.ok(only.results.every((r) => r.type === 'synthesis'));
    // Vertrauliche Ordner bleiben draußen, auch mit Typfilter.
    assert.ok(!only.results.some((r) => r.path.startsWith('privat/')));
  });
});
