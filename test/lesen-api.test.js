import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/http/app.js';
import { createTokenStore } from '../src/cockpit/tokens.js';
import { createReadingStore } from '../src/lesen/store.js';
import { createReadingApi } from '../src/lesen/api.js';
import { safeFetch } from '../src/lesen/fetch.js';

const quiet = { info() {}, warn() {}, error() {} };

const ARTICLE = `<html><head><title>Vom Lesen</title></head><body><article>
<h1>Vom Lesen</h1>${'<p>Ein Absatz über das Lesen von Texten, die man sich aufgehoben hat, und warum der Stapel wächst.</p>'.repeat(30)}
</article></body></html>`;

/**
 * Endpunkt mit Lesestapel im Speicher. Adressen aus `pages` liefert der Test,
 * alles andere geht an den echten, SSRF-geschützten Abruf.
 */
async function withApi(run, { pages = { 'https://blatt.test/lesen': ARTICLE } } = {}) {
  const store = createReadingStore({ path: ':memory:' });
  const tokens = createTokenStore({ logger: quiet });
  const reading = tokens.create('iPhone', 'lesestapel');
  const capture = tokens.create('iPhone', 'capture');
  let fetched = 0;
  const fetchPage = async (url) => {
    fetched += 1;
    if (pages[url]) return { url, body: pages[url] };
    return safeFetch(url);
  };
  const app = createApp({
    config: { publicUrl: 'https://vault.test', resource: 'https://vault.test/mcp', issuer: 'https://id.test', supportedScopes: [], allowedHosts: ['vault.test'], trustProxy: true },
    verifyToken: async () => {
      throw new Error('nicht benutzt');
    },
    mcpHandler: async () => {},
    readingApi: createReadingApi({ tokens, store, fetchPage, logger: quiet }),
    logger: quiet,
  });
  app.listen(0, '127.0.0.1');
  await new Promise((res) => app.once('listening', res));
  const base = `http://127.0.0.1:${app.address().port}`;
  const call = (body, { type = 'application/json', auth = reading.token, method = 'POST', query = '' } = {}) =>
    fetch(`${base}/lesestapel/speichern${query}`, {
      method,
      headers: { 'x-forwarded-host': 'vault.test', 'content-type': type, ...(auth ? { authorization: `Bearer ${auth}` } : {}) },
      body: method === 'POST' ? (typeof body === 'string' || body instanceof Uint8Array ? body : JSON.stringify(body)) : undefined,
    });
  try {
    await run({ call, store, tokens: { reading, capture }, fetched: () => fetched });
  } finally {
    app.close();
  }
}

test('/lesestapel/speichern: Artikel per JSON landet im Eingang, mit Satz für die Mitteilung', async () => {
  await withApi(async ({ call, store }) => {
    const res = await call({ url: 'https://blatt.test/lesen' });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.message, 'Im Lesestapel: Vom Lesen');
    const doc = store.get(body.id);
    assert.equal(doc.status, 'eingang');
    assert.equal(doc.origin, 'kurzbefehl');
    assert.equal(doc.kind, 'artikel');
  });
});

test('/lesestapel/speichern: Adresse als Text, eigener Titel und Quelle', async () => {
  await withApi(async ({ call, store }) => {
    const text = await call('Schau mal: https://blatt.test/lesen', { type: 'text/plain' });
    assert.equal(text.status, 201);
    assert.equal(store.get((await text.json()).id).url, 'https://blatt.test/lesen');
  });
  await withApi(async ({ call, store }) => {
    const res = await call({ url: 'https://blatt.test/lesen', title: 'Mein Titel', source: 'import' });
    const doc = store.get((await res.json()).id);
    assert.equal(doc.title, 'Mein Titel');
    assert.equal(doc.origin, 'import');
  });
});

test('/lesestapel/speichern: dieselbe id zweimal ergibt ein Dokument, ohne zweiten Abruf', async () => {
  await withApi(async ({ call, store, fetched }) => {
    const first = await call({ url: 'https://blatt.test/lesen', id: 'kb-1' });
    assert.equal(first.status, 201);
    const second = await call({ url: 'https://blatt.test/lesen', id: 'kb-1' });
    assert.equal(second.status, 200);
    const body = await second.json();
    assert.equal(body.duplicate, true);
    assert.match(body.message, /^Schon im Lesestapel/);
    assert.equal(store.list().length, 1);
    assert.equal(fetched(), 1);
  });
});

test('/lesestapel/speichern: ohne Recht „Lesestapel“ 403, ohne gültigen Token 401', async () => {
  await withApi(async ({ call, store, tokens }) => {
    const forbidden = await call({ url: 'https://blatt.test/lesen' }, { auth: tokens.capture.token });
    assert.equal(forbidden.status, 403, 'ein Capture-Token bekommt das Recht nicht automatisch');
    const body = await forbidden.json();
    assert.equal(body.status, 403);
    assert.match(body.message, /Lesestapel/);
    assert.equal((await call({ url: 'https://blatt.test/lesen' }, { auth: null })).status, 401);
    assert.equal((await call({ url: 'https://blatt.test/lesen' }, { auth: 'vct_falsch' })).status, 401);
    assert.equal(store.list().length, 0);
  });
});

test('/lesestapel/speichern: Vertrauensgrenze (SSRF, Größe, Eingaben)', async () => {
  await withApi(async ({ call, store }) => {
    const local = await call({ url: 'http://127.0.0.1:1/admin' });
    assert.equal(local.status, 400);
    assert.match((await local.json()).message, /lokalen oder privaten Netz/);
    assert.equal((await call({ url: 'file:///etc/passwd' })).status, 400);
    assert.equal((await call({ url: 'https://blatt.test/lesen', id: 'nicht erlaubt!' })).status, 400);
    assert.equal((await call({ url: 42 })).status, 400);
    assert.equal((await call('{kaputt')).status, 400);
    assert.equal((await call({ url: 'https://blatt.test/lesen', source: 'mail' })).status, 400);
    const big = await call(JSON.stringify({ url: 'https://blatt.test/lesen', title: 'x'.repeat(20_000) }));
    assert.equal(big.status, 413);
    assert.equal((await call(null, { method: 'GET' })).status, 405);
    assert.equal(store.list().length, 0);
  });
});
