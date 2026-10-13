import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildIndex, openIndex } from '../src/vault/index.js';
import { compilePolicy } from '../src/vault/policy.js';
import { createSearchHttp } from '../src/search/http.js';
import { createApp } from '../src/http/app.js';

const quiet = { info() {}, warn() {}, error() {} };
let root, index;

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
  const policy = compilePolicy({ sensitive: { privat: 'privat' }, readwise: 'readwise' });
  buildIndex({ vaultPath: root, dbPath: ':memory:', policy, logger: quiet, persist: (db, vp) => (index = openIndex(db, { vaultPath: vp, policy })) });
});

after(() => rmSync(root, { recursive: true, force: true }));

async function withServer(run, { searchHttp = createSearchHttp({ token: 'such-geheim', index }) } = {}) {
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
  const call = (path, { method = 'GET', auth = 'Bearer such-geheim' } = {}) =>
    fetch(base + path, { method, headers: { 'x-forwarded-host': 'vault.test', ...(auth ? { authorization: auth } : {}) } });
  try {
    await run(call);
  } finally {
    app.close();
  }
}

test('/api/search ist ohne SEARCH_TOKEN aus', async () => {
  await withServer(async (call) => {
    assert.equal((await call('/api/search?q=Hund')).status, 404);
  }, { searchHttp: null });
});

test('/api/search verlangt den Such-Token', async () => {
  await withServer(async (call) => {
    assert.equal((await call('/api/search?q=Hund', { auth: null })).status, 401);
    assert.equal((await call('/api/search?q=Hund', { auth: 'Bearer falsch' })).status, 401);
    assert.equal((await call('/api/search?q=Hund', { method: 'POST' })).status, 405);
  });
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
    assert.match(body.degraded, /EMBED_URL/);
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
  }, { searchHttp: createSearchHttp({ token: 'such-geheim', index, semantic }) });
});
