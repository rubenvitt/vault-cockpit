import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/http/app.js';
import { createWebHttp } from '../src/web/http.js';
import { createCookieSigner } from '../src/web/session.js';
import { createSettingsStore } from '../src/cockpit/settings.js';
import { createReadingStore } from '../src/lesen/store.js';
import { readingRoutes } from '../src/lesen/http.js';
import { safeFetch } from '../src/lesen/fetch.js';

const quiet = { info() {}, warn() {}, error() {} };
const SECRET = 'x'.repeat(40);

const ARTICLE = `<html><head><title>Vom Lesen</title><meta property="og:site_name" content="Blatt"></head><body><article>
<h1>Vom Lesen</h1>${'<p>Ein Absatz über das Lesen von Texten, die man sich aufgehoben hat, und warum der Stapel wächst.</p>'.repeat(30)}
</article></body></html>`;

/**
 * Cockpit mit Lesestapel im Speicher, angemeldet über ein selbst signiertes
 * Sitzungs-Cookie. Adressen aus `pages` liefert der Test, alles andere geht an
 * den echten Abruf mit einem DNS, das nur `localhost` kennt.
 */
async function withReading(run, { pages = {}, wrap = (r) => r } = {}) {
  const store = createReadingStore({ path: ':memory:' });
  const fetchPage = async (url) => {
    if (pages[url]) return { url, body: pages[url] };
    return safeFetch(url, { resolve: async (host) => (host === 'localhost' ? [{ address: '127.0.0.1', family: 4 }] : []) });
  };
  const webHttp = createWebHttp({
    cockpit: { week: async () => null },
    settings: createSettingsStore({ defaults: { tz: 'Europe/Berlin' }, logger: quiet }),
    reading: wrap(readingRoutes({ store, fetchPage, logger: quiet })),
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
  const base = `http://127.0.0.1:${app.address().port}`;
  const t = Math.floor(Date.now() / 1000);
  const session = createCookieSigner(SECRET).seal({ sub: 'ruben', sid: 's1', gen: 0, iat: t, seen: t, exp: t + 3600 });
  const jar = { vc_session: session };
  const call = async (path, { method = 'GET', form = null, cookie = true, accept = null } = {}) => {
    const headers = { 'x-forwarded-host': 'vault.test', ...(cookie ? { cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ') } : {}), ...(accept ? { accept } : {}) };
    if (form) headers['content-type'] = 'application/x-www-form-urlencoded';
    const res = await fetch(base + path, { method, redirect: 'manual', headers, body: form ? new URLSearchParams(form).toString() : undefined });
    for (const c of res.headers.getSetCookie()) {
      const [pair, ...attrs] = c.split('; ');
      const [k, v] = pair.split('=');
      if (attrs.includes('Max-Age=0')) delete jar[k];
      else if (k !== 'vc_session') jar[k] = v;
    }
    return res;
  };
  try {
    await run({ call, store });
  } finally {
    app.close();
  }
}

const csrfFrom = (html) => html.match(/name="csrf" value="([^"]+)"/)[1];

test('Lesen: nur angemeldet, /lesen führt zu „Weiter“, Navigation mit Lesen und Unternavigation', async () => {
  await withReading(async ({ call }) => {
    const anon = await call('/lesen/eingang', { cookie: false });
    assert.equal(anon.status, 303);
    assert.equal(anon.headers.get('location'), '/login?next=%2Flesen%2Feingang');
    assert.equal((await call('/aktion/lesen/speichern', { method: 'POST', form: { url: 'https://a.test' }, cookie: false, accept: 'application/json' })).status, 401);

    const root = await call('/lesen');
    assert.equal(root.status, 303);
    assert.equal(root.headers.get('location'), '/lesen/weiter');

    const html = await (await call('/lesen/eingang')).text();
    assert.match(html, /<a href="\/lesen" class="nav-link" aria-current="page">/);
    // Leiste unten: vier Plätze, Lesen statt Suche; im Kopf bleibt die Suche.
    const tabs = html.match(/<nav class="tabbar"[^]*?<\/nav>/)[0];
    assert.deepEqual([...tabs.matchAll(/<span>([^<]+)<\/span>/g)].map((m) => m[1]), ['Woche', 'Rückblick', 'Lesen', 'Einstellungen']);
    assert.match(html, /<a href="\/graph" class="nav-link">/);
    // Vier Reiter für den Ablauf, der Rest unter „Mehr“.
    assert.match(html, /<nav class="subnav lesen-tabs" aria-label="Lesen"><a href="\/lesen\/weiter" class="subnav-link">Weiter<\/a><a href="\/lesen\/eingang" class="subnav-link" aria-current="page">Eingang<\/a><a href="\/lesen\/stapel"[^>]*>Stapel<\/a><a href="\/lesen\/folgen"[^>]*>Folgen<\/a><details class="menu subnav-mehr"><summary class="subnav-link">Mehr<svg/);
    const menu = html.match(/<div class="subnav-menu">[^]*?<\/div><\/details>/)[0];
    assert.deepEqual([...menu.matchAll(/class="subnav-item"[^>]*><span>([^<]+)/g)].map((m) => m[1]), ['Markiert', 'Wiedersehen', 'Wissen', 'Feeds']);
    // Auf dem Desktop stehen dieselben Einträge als Reiter neben den vier (CSS blendet „Mehr“ dort aus).
    const nav = html.match(/<nav class="subnav lesen-tabs"[^]*?<\/nav>/)[0];
    assert.deepEqual([...nav.matchAll(/class="subnav-link subnav-weit"[^>]*>([^<]+)/g)].map((m) => m[1]), ['Markiert', 'Wiedersehen', 'Wissen', 'Feeds']);
    // Auf einer Seite aus „Mehr“ trägt der Knopf ihren Namen, der breite Reiter ist markiert.
    const markiert = await (await call('/lesen/markiert')).text();
    assert.match(markiert, /<summary class="subnav-link" aria-current="page">Markiert<svg/);
    assert.match(markiert, /<a href="\/lesen\/markiert" class="subnav-link subnav-weit" aria-current="page">Markiert<\/a>/);
    assert.match(html, /<form method="post" action="\/aktion\/lesen\/speichern"/);
    assert.match(html, /Eingang leer/);
    assert.ok(!/style=|<script>/.test(html), 'keine Inline-Styles oder -Skripte');

    assert.match(await (await call('/lesen/stapel')).text(), /Auf dem Stapel liegt nichts/);
    assert.match(await (await call('/lesen/markiert')).text(), /Noch nichts markiert/);
    assert.equal((await call('/wissen')).status, 404, '/wissen kommt aus VCP-76');
  });
});

test('Lesen: URL speichern erscheint mit Titel, Quelle und Lesezeit im Eingang; doppelt und Fehler mit Meldung', async () => {
  await withReading(
    async ({ call, store }) => {
      const csrf = csrfFrom(await (await call('/lesen/eingang')).text());
      const noCsrf = await call('/aktion/lesen/speichern', { method: 'POST', form: { url: 'https://blatt.test/vom-lesen', back: '/lesen/eingang' } });
      assert.equal(noCsrf.status, 403);

      const saved = await call('/aktion/lesen/speichern', { method: 'POST', form: { url: 'https://blatt.test/vom-lesen', cid: 'cid-1', csrf, back: '/lesen/eingang' } });
      assert.equal(saved.status, 303);
      assert.equal(saved.headers.get('location'), '/lesen/eingang');
      const html = await (await call('/lesen/eingang')).text();
      assert.match(html, /<span class="toast-text">Gespeichert: Vom Lesen<\/span>/);
      assert.match(html, /<p class="inbox-meta"><a href="https:\/\/blatt\.test\/vom-lesen" rel="noopener noreferrer" target="_blank">Blatt<\/a> · Artikel · \d+ min<\/p>\s*<h2 class="inbox-title">Vom Lesen<\/h2>/);
      assert.equal(store.list({ status: 'eingang' })[0].origin, 'formular');

      // Doppelt abgeschickt (gleiche cid): nichts Neues, mit JavaScript als JSON.
      const again = await call('/aktion/lesen/speichern', { method: 'POST', form: { url: 'https://blatt.test/vom-lesen', cid: 'cid-1', csrf }, accept: 'application/json' });
      assert.equal(again.status, 200);
      assert.equal((await again.json()).message, 'Schon im Lesestapel: Vom Lesen');
      assert.equal(store.list().length, 1);

      // Private Adresse: Meldung auf der Seite, nichts gespeichert.
      const local = await call('/aktion/lesen/speichern', { method: 'POST', form: { url: 'http://192.168.1.1/admin', csrf, back: '/lesen/eingang' } });
      assert.equal(local.status, 303);
      assert.match(await (await call('/lesen/eingang')).text(), /class="toast error"[^>]*><span class="toast-text">Adressen im lokalen oder privaten Netz werden nicht geholt/);
      const localhost = await call('/aktion/lesen/speichern', { method: 'POST', form: { url: 'http://localhost:3000/', csrf }, accept: 'application/json' });
      assert.equal(localhost.status, 400);
      const v6 = await call('/aktion/lesen/speichern', { method: 'POST', form: { url: 'http://[::1]:3000/', csrf }, accept: 'application/json' });
      assert.equal(v6.status, 400);
      assert.match((await v6.json()).message, /lokalen oder privaten Netz/);
      assert.equal(store.list().length, 1);
    },
    { pages: { 'https://blatt.test/vom-lesen': ARTICLE } },
  );
});

test('Lesen: Einmal-Link eines Transkripts ohne Anmeldung, HEAD verbraucht ihn nicht', async () => {
  const seen = [];
  const shared = {
    path: '/geteilt.md',
    async get(token, { consume }) {
      seen.push([token, consume]);
      return token === 'gut' ? { status: 200, body: '# Text\n', headers: { 'content-type': 'text/markdown; charset=utf-8', 'cache-control': 'no-store' } } : { status: 404, body: 'weg\n', headers: { 'content-type': 'text/plain; charset=utf-8' } };
    },
  };
  await withReading(
    async ({ call }) => {
      const ok = await call('/geteilt.md?t=gut', { cookie: false });
      assert.equal(ok.status, 200);
      assert.equal(ok.headers.get('content-type'), 'text/markdown; charset=utf-8');
      assert.equal(await ok.text(), '# Text\n');
      assert.equal((await call('/geteilt.md?t=gut', { method: 'HEAD', cookie: false })).status, 200);
      assert.equal((await call('/geteilt.md?t=falsch', { cookie: false })).status, 404);
      assert.equal((await call('/geteilt.md?t=gut', { method: 'POST', form: {}, cookie: false })).status, 405, 'nur GET und HEAD');
      assert.deepEqual(seen, [['gut', true], ['gut', false], ['falsch', true]]);
    },
    { wrap: (r) => ({ ...r, shared }) },
  );
});
