import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../src/http/app.js';
import { createWebHttp } from '../src/web/http.js';
import { createCookieSigner } from '../src/web/session.js';
import { createSettingsStore } from '../src/cockpit/settings.js';
import { createHealth } from '../src/health/collect.js';
import { createReadingStore } from '../src/lesen/store.js';
import { readingRoutes } from '../src/lesen/http.js';
import { FetchError, safeFetch } from '../src/lesen/fetch.js';
import { parseFeed, findFeedLink, matchesFilter, createFeedPoller } from '../src/lesen/feeds.js';
import { parseOpml, toOpml } from '../src/lesen/opml.js';

const quiet = { info() {}, warn() {}, error() {} };
const SECRET = 'x'.repeat(40);
const T0 = Date.parse('2026-10-20T08:00:00Z');
const LONG = `<p>${'Ein langer Absatz mit vielen Wörtern, damit der Feed als Volltext gilt und nichts nachgeladen wird. '.repeat(15)}</p>`;

// --- Fixtures ------------------------------------------------------------------

const rssItem = (n, { body = LONG } = {}) => `<item><title>Beitrag ${n}</title><link>https://blog.test/p/${n}</link><guid isPermaLink="false">blog-${n}</guid>
  <pubDate>${new Date(T0 - (10 - n) * 3600_000).toUTCString()}</pubDate><dc:creator>Ann</dc:creator>
  <content:encoded><![CDATA[${body}<script>alert(1)</script>]]></content:encoded></item>`;
const rss = (items) => `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/">
<channel><title>Blog &amp; Co</title><link>https://blog.test/</link>${items.join('\n')}</channel></rss>`;

const ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"><title>Atom-Seite</title><link rel="self" href="https://atom.test/feed.xml"/><link href="https://atom.test/"/>
<entry><id>urn:atom:1</id><title>Erster</title><link rel="alternate" href="/a/1"/><updated>2026-10-19T10:00:00Z</updated><author><name>Bo</name></author>
  <content type="html">${LONG.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</content></entry>
<entry><id>urn:atom:2</id><title>Zweiter</title><link href="https://atom.test/a/2"/><updated>2026-10-19T11:00:00Z</updated>
  <content type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml">${LONG}</div></content></entry>
</feed>`;

const JSON_FEED = JSON.stringify({
  version: 'https://jsonfeed.org/version/1.1',
  title: 'JSON-Seite',
  home_page_url: 'https://json.test/',
  items: [
    { id: 'j1', url: 'https://json.test/1', title: 'Kurz', summary: 'Nur ein Satz.', date_published: '2026-10-19T09:00:00Z' },
    { id: 'j2', url: 'https://json.test/2', title: 'Lang', content_html: LONG, date_published: '2026-10-19T10:00:00Z' },
  ],
});

const ARTICLE = `<html><head><title>Kurz</title></head><body><article><h1>Kurz</h1>${'<p>Der volle Artikel von der Seite, viel länger als der eine Satz im Feed.</p>'.repeat(20)}</article></body></html>`;

/** Fetch ohne Netz: `routes[url]` ist Text oder `(opts) => Antwort`; alles andere ist nicht erreichbar. */
const fakeFetch = (routes, calls = []) => async (url, opts = {}) => {
  calls.push({ url, opts });
  const r = routes[url];
  if (r === undefined) throw new FetchError(`${new URL(url).host} ist nicht erreichbar`);
  if (typeof r === 'function') return r(opts);
  return { url, status: 200, body: r, bytes: Buffer.from(r), headers: {} };
};

// --- Parser --------------------------------------------------------------------

test('Feeds: RSS, Atom und JSON Feed werden gelesen', () => {
  const r = parseFeed(rss([rssItem(1)]), 'https://blog.test/feed');
  assert.equal(r.title, 'Blog & Co');
  assert.equal(r.siteUrl, 'https://blog.test/');
  assert.deepEqual({ ...r.entries[0], html: undefined }, { key: 'blog-1', url: 'https://blog.test/p/1', title: 'Beitrag 1', author: 'Ann', html: undefined, published: T0 - 9 * 3600_000 });
  assert.match(r.entries[0].html, /<script>/, 'ungesäubert, gesäubert wird beim Anlegen');

  const a = parseFeed(ATOM, 'https://atom.test/feed.xml');
  assert.equal(a.title, 'Atom-Seite');
  assert.equal(a.siteUrl, 'https://atom.test/');
  assert.deepEqual(a.entries.map((e) => [e.key, e.url, e.author]), [['urn:atom:1', 'https://atom.test/a/1', 'Bo'], ['urn:atom:2', 'https://atom.test/a/2', null]]);
  assert.match(a.entries[0].html, /^<p>Ein langer/);
  assert.match(a.entries[1].html, /<p>Ein langer/);

  const j = parseFeed(JSON_FEED, 'https://json.test/feed.json');
  assert.equal(j.title, 'JSON-Seite');
  assert.deepEqual(j.entries.map((e) => e.key), ['j1', 'j2']);
  assert.equal(j.entries[0].html, 'Nur ein Satz.');

  // RSS ohne GUID: die Adresse ist der Schlüssel.
  assert.equal(parseFeed(rss(['<item><title>x</title><link>https://blog.test/x</link></item>']), 'https://blog.test/').entries[0].key, 'https://blog.test/x');
  // Ohne Link und ohne Permalink-GUID keine Adresse (nicht die des Feeds); Link mit &amp; aus Atom-Attribut.
  assert.equal(parseFeed(rss(['<item><title>x</title><guid isPermaLink="false">k</guid></item>']), 'https://blog.test/feed').entries[0].url, null);
  assert.equal(parseFeed('<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>1</id><link href="https://a.test/?p=1&amp;q=2"/></entry></feed>', 'https://a.test/').entries[0].url, 'https://a.test/?p=1&q=2');
  for (const bad of ['<html><body>Kein Feed</body></html>', 'einfach Text', '{"kaputt":', '{"title":"ohne items"}']) {
    assert.throws(() => parseFeed(bad, 'https://x.test/'), /Feed/, bad);
  }
});

test('Feeds: XML löst keine Entitäten aus der DTD auf (XXE)', () => {
  const xml = `<?xml version="1.0"?><!DOCTYPE rss [<!ENTITY xxe SYSTEM "file:///etc/passwd"><!ENTITY wort "ERSETZT">]>
<rss version="2.0"><channel><title>T &xxe; &wort;</title><item><title>&xxe;</title><link>https://x.test/1</link></item></channel></rss>`;
  const r = parseFeed(xml, 'https://x.test/');
  assert.equal(r.title, 'T &xxe; &wort;');
  assert.equal(r.entries[0].title, '&xxe;');
});

test('Feeds: Website verweist per <link rel="alternate"> auf den Feed; Stichwort-Filter', () => {
  const html = '<html><head><link rel="stylesheet" href="/a.css"><link rel="alternate" type="application/atom+xml" href="/feed.xml"></head></html>';
  assert.equal(findFeedLink(html, 'https://atom.test/blog/'), 'https://atom.test/feed.xml');
  assert.equal(findFeedLink('<html><head></head></html>', 'https://atom.test/'), null);

  assert.equal(matchesFilter('', { title: 'x' }), true);
  assert.equal(matchesFilter('rust, KI', { title: 'Neues zu ki-Modellen', html: '' }), true);
  assert.equal(matchesFilter('rust', { title: 'Python', html: '<p class="rust">Schlangen</p>' }), false, 'Tags zählen nicht');
});

// --- Hintergrundabruf ----------------------------------------------------------

/** Lesestapel mit vier Feeds (RSS mit 7 Einträgen, Atom, JSON, einer kaputt) und steuerbarer Uhr. */
function setup({ rssItems = [1, 2, 3, 4, 5, 6, 7].map((n) => rssItem(n)) } = {}) {
  let now = T0;
  const store = createReadingStore({ path: ':memory:', now: () => now });
  const routes = {
    'https://blog.test/feed': rss(rssItems),
    'https://atom.test/feed.xml': ATOM,
    'https://json.test/feed.json': JSON_FEED,
    // Icon des Blogs; die übrigen haben keins.
    'https://blog.test/favicon.ico': async () => ({ url: 'https://blog.test/favicon.ico', status: 200, contentType: 'image/png', bytes: Buffer.from([1, 2, 3]), headers: {} }),
    'https://kaputt.test/feed': async () => {
      throw new FetchError('Die Seite antwortet mit HTTP 500');
    },
  };
  const pages = { 'https://json.test/1': ARTICLE };
  const calls = [];
  const pageCalls = [];
  const urls = { blog: 'https://blog.test/feed', atom: 'https://atom.test/feed.xml', json: 'https://json.test/feed.json', kaputt: 'https://kaputt.test/feed' };
  const feeds = Object.fromEntries(Object.entries(urls).map(([k, url]) => [k, store.addFeed({ url, interval_minutes: 30 }).feed]));
  const poller = createFeedPoller({
    store,
    fetchFeed: fakeFetch(routes, calls),
    fetchPage: async (url) => {
      pageCalls.push(url);
      if (!pages[url]) throw new FetchError('nicht erreichbar');
      return { url, body: pages[url] };
    },
    now: () => now,
    logger: quiet,
  });
  return { store, routes, pages, calls, pageCalls, feeds, poller, tick: (min) => (now += min * 60_000), now: () => now };
}

const docsOf = (store, feed) => store.list({ limit: 1000 }).filter((d) => d.origin === `feed:${feed.id}`);

test('Feeds: neue Einträge landen ohne Zutun im Eingang, jeder genau einmal, auch über mehrere Abrufe', async () => {
  const { store, routes, feeds, poller, tick, pageCalls } = setup();

  assert.equal(await poller.runDue(), 5 + 2 + 2);
  // Erster Abruf: nur die neuesten fünf, die älteren gelten als bekannt.
  assert.deepEqual(docsOf(store, feeds.blog).map((d) => d.title), ['Beitrag 7', 'Beitrag 6', 'Beitrag 5', 'Beitrag 4', 'Beitrag 3']);
  assert.equal(docsOf(store, feeds.atom).length, 2);
  assert.equal(docsOf(store, feeds.json).length, 2);
  const doc = store.get(docsOf(store, feeds.blog)[0].id);
  assert.equal(doc.kind, 'feed');
  assert.equal(doc.status, 'eingang');
  assert.equal(doc.author, 'Ann');
  assert.equal(doc.site, 'Blog & Co');
  assert.ok(doc.word_count > 150);
  assert.ok(!/script|alert/.test(doc.content_html), 'Feed-Inhalt gesäubert');
  // Volltext: langer Feed-Inhalt reicht, der kurze JSON-Eintrag holt die Seite.
  assert.deepEqual(pageCalls, ['https://json.test/1']);
  assert.match(store.get(docsOf(store, feeds.json).find((d) => d.title === 'Kurz').id).content_text, /Der volle Artikel/);

  // Zu früh: nichts fällig, kein Abruf.
  tick(10);
  assert.equal(await poller.runDue(), 0);

  // Zweiter Abruf mit demselben Inhalt: nichts doppelt, auch nicht Beitrag 1 und 2.
  tick(25);
  assert.equal(await poller.runDue(), 0);
  assert.equal(store.list({ limit: 1000 }).length, 9);

  // Dritter Abruf mit einem neuen Eintrag: genau der kommt dazu.
  routes['https://blog.test/feed'] = rss([8, 7, 6, 5, 4, 3, 2, 1].map((n) => rssItem(n)));
  tick(31);
  assert.equal(await poller.runDue(), 1);
  assert.equal(docsOf(store, feeds.blog)[0].title, 'Beitrag 8');
  assert.equal(store.list({ limit: 1000 }).length, 10);
  assert.equal(store.getFeed(feeds.blog.id).title, 'Blog & Co', 'Titel aus dem Feed');
  assert.equal(store.getFeed(feeds.blog.id).icon, 'data:image/png;base64,AQID', 'Icon als data:-Adresse');
  assert.equal(store.getFeed(feeds.atom.id).icon, '', 'kein Icon gefunden');
});

test('Feeds: ein kaputter Feed stört die anderen nicht, Backoff und Zustand auf /zustand', async () => {
  const { store, feeds, poller, tick, routes, calls } = setup();
  await poller.runDue();
  const broken = store.getFeed(feeds.kaputt.id);
  assert.equal(broken.error_count, 1);
  assert.match(broken.last_error, /HTTP 500/);
  // Doppelter Abstand nach dem ersten Fehler.
  assert.equal(Date.parse(broken.next_fetch_at) - T0, 60 * 60_000);
  assert.equal(store.getFeed(feeds.blog.id).error_count, 0);

  const health = createHealth({ settings: createSettingsStore({ defaults: { tz: 'Europe/Berlin' }, logger: quiet }), feeds: () => poller.health() });
  const svc = health.services().find((s) => s.id === 'feeds');
  assert.equal(svc.state, 'error');
  assert.equal(svc.summary, '1 von 4 mit Fehler');
  assert.match(svc.lastError, /^kaputt\.test: Die Seite antwortet mit HTTP 500/);
  assert.deepEqual(svc.items.map((i) => [i.name, i.state]), [['kaputt.test', 'error'], ['Atom-Seite', 'ok'], ['Blog & Co', 'ok'], ['JSON-Seite', 'ok']]);
  assert.ok(health.degraded());

  // Nach 31 min sind die anderen dran, der kaputte erst nach 60.
  calls.length = 0;
  tick(31);
  await poller.runDue();
  assert.ok(!calls.some((c) => c.url.startsWith('https://kaputt.test')));
  tick(30);
  routes['https://kaputt.test/feed'] = rss([rssItem(1)]);
  await poller.runDue();
  assert.equal(store.getFeed(feeds.kaputt.id).error_count, 0);
  assert.equal(health.services().find((s) => s.id === 'feeds').state, 'ok');

  // Pausiert: wird nicht abgerufen und zählt als aus.
  store.updateFeed(feeds.kaputt.id, { paused: true, next_fetch_at: null });
  calls.length = 0;
  await poller.runDue();
  assert.ok(!calls.some((c) => c.url.startsWith('https://kaputt.test')));
  assert.equal(poller.health().items.find((i) => i.name === 'Blog & Co').state, 'ok');
});

test('Feeds: bedingte Anfrage mit ETag und Last-Modified, 304 ändert nichts', async () => {
  const { store, feeds, poller, tick, routes, calls } = setup();
  routes['https://blog.test/feed'] = (opts) =>
    opts.headers?.['if-none-match'] === '"v1"'
      ? { url: 'https://blog.test/feed', status: 304, body: '', headers: {} }
      : { url: 'https://blog.test/feed', status: 200, body: rss([rssItem(1)]), headers: { etag: '"v1"', 'last-modified': 'Mon, 19 Oct 2026 10:00:00 GMT' } };
  await poller.runDue();
  assert.equal(store.getFeed(feeds.blog.id).etag, '"v1"');
  tick(31);
  calls.length = 0;
  await poller.runDue();
  const sent = calls.find((c) => c.url === 'https://blog.test/feed').opts.headers;
  assert.deepEqual(sent, { 'if-none-match': '"v1"', 'if-modified-since': 'Mon, 19 Oct 2026 10:00:00 GMT' });
  const feed = store.getFeed(feeds.blog.id);
  assert.equal(feed.etag, '"v1"', 'bleibt nach 304');
  assert.equal(feed.error_count, 0);
  assert.equal(docsOf(store, feeds.blog).length, 1);
});

test('Feeds: direkt auf den Stapel, Stichwort-Filter, Seite nicht erreichbar → Feed-Inhalt', async () => {
  const { store, feeds, poller, pages } = setup({ rssItems: [rssItem(1, { body: '<p>Rust kurz</p>' }), rssItem(2, { body: '<p>Python kurz</p>' })] });
  store.updateFeed(feeds.blog.id, { to_stack: true, keyword_filter: 'rust' });
  store.updateFeed(feeds.json.id, { paused: true });
  delete pages['https://json.test/1'];
  await poller.runDue();
  const blog = docsOf(store, feeds.blog);
  assert.deepEqual(blog.map((d) => [d.title, d.status]), [['Beitrag 1', 'stapel']]);
  assert.equal(store.get(blog[0].id).content_text, 'Rust kurz', 'Seite nicht erreichbar: der Feed-Inhalt bleibt');
  assert.equal(docsOf(store, feeds.json).length, 0, 'pausiert');
});

test('safeFetch: eigene Header gehen mit, 304 kommt ohne Inhaltsprüfung zurück, Antwort-Header sind dabei', async () => {
  const server = http.createServer((req, res) => {
    if (req.headers['if-none-match'] === '"v1"') return res.writeHead(304).end();
    res.writeHead(200, { 'content-type': 'application/rss+xml', etag: '"v1"' }).end('<rss/>');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const opts = { resolve: async () => [{ address: '127.0.0.1', family: 4 }], isAllowed: (ip) => ip === '127.0.0.1', accept: null };
  try {
    const url = `http://feed.test:${server.address().port}/`;
    const first = await safeFetch(url, opts);
    assert.deepEqual([first.status, first.body, first.headers.etag], [200, '<rss/>', '"v1"']);
    const again = await safeFetch(url, { ...opts, accept: ['text/html'], headers: { 'if-none-match': '"v1"' } });
    assert.deepEqual([again.status, again.body], [304, '']);
  } finally {
    server.close();
  }
});

// --- OPML ----------------------------------------------------------------------

const READER_OPML = `<?xml version="1.0" encoding="UTF-8"?>
<opml version="1.0">
  <head><title>Abos aus dem Reader</title></head>
  <body>
    <outline text="Technik" title="Technik">
      <outline text="Blog &amp; Co" title="Blog &amp; Co" type="rss" xmlUrl="https://blog.test/feed" htmlUrl="https://blog.test/"/>
      <outline text="Unterordner">
        <outline text="Atom" type="rss" xmlUrl="https://atom.test/feed.xml"/>
      </outline>
    </outline>
    <outline text="JSON" type="rss" xmlUrl="https://json.test/feed.json"/>
    <outline text="Doppelt" type="rss" xmlUrl="https://json.test/feed.json"/>
    <outline text="Kaputt" type="rss" xmlUrl="javascript:alert(1)"/>
  </body>
</opml>`;

test('OPML: verschachtelte outline werden flach importiert, Export wieder lesbar', () => {
  const list = parseOpml(READER_OPML);
  assert.deepEqual(list, [
    { url: 'https://blog.test/feed', title: 'Blog & Co', site_url: 'https://blog.test/' },
    { url: 'https://atom.test/feed.xml', title: 'Atom', site_url: null },
    { url: 'https://json.test/feed.json', title: 'JSON', site_url: null },
  ]);
  assert.throws(() => parseOpml('<rss/>'), /Keine OPML/);
  assert.deepEqual(parseOpml(toOpml(list.map((f) => ({ ...f, title: `${f.title} "<x>"` })))).map((f) => f.title), ['Blog & Co "<x>"', 'Atom "<x>"', 'JSON "<x>"']);
});

// --- Seite ---------------------------------------------------------------------

async function withWeb(run, routes = {}) {
  const store = createReadingStore({ path: ':memory:' });
  const webHttp = createWebHttp({
    cockpit: { week: async () => null },
    settings: createSettingsStore({ defaults: { tz: 'Europe/Berlin' }, logger: quiet }),
    reading: readingRoutes({ store, fetchFeed: fakeFetch(routes), logger: quiet }),
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
  const cookie = `vc_session=${createCookieSigner(SECRET).seal({ sub: 'ruben', sid: 's1', gen: 0, iat: t, seen: t, exp: t + 3600 })}`;
  // `cookie`: Set-Cookie einer Antwort (Meldung) für den nächsten Aufruf mitgeben.
  const call = (path, { form = null, body = null, cookie: extra = [] } = {}) =>
    fetch(base + path, {
      method: form || body ? 'POST' : 'GET',
      redirect: 'manual',
      headers: { 'x-forwarded-host': 'vault.test', cookie: [cookie, ...extra.map((c) => c.split(';')[0])].join('; '), ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
      body: form ? new URLSearchParams(form).toString() : body,
    });
  try {
    await run({ call, store });
  } finally {
    app.close();
  }
}

test('Feeds-Seite: Website abonnieren, einstellen, OPML importieren und exportieren, entfernen', async () => {
  const site = '<html><head><title>Atom</title><link rel="alternate" type="application/atom+xml" title="Feed" href="/feed.xml"></head><body></body></html>';
  await withWeb(
    async ({ call, store }) => {
      const html = await (await call('/lesen/feeds')).text();
      assert.match(html, /<a href="\/lesen\/feeds" class="subnav-link" aria-current="page">Feeds<\/a>/);
      assert.match(html, /Noch keine Feeds abonniert/);
      assert.ok(!/style=|<script>/.test(html), 'keine Inline-Styles oder -Skripte');
      const csrf = html.match(/name="csrf" value="([^"]+)"/)[1];

      // Website-Adresse: der Feed wird über <link rel="alternate"> gefunden.
      const sub = await call('/aktion/lesen/feed/abonnieren', { form: { csrf, back: '/lesen/feeds', url: 'https://atom.test/' } });
      assert.equal(sub.status, 303);
      const [feed] = store.listFeeds();
      assert.deepEqual([feed.url, feed.title, feed.site_url, feed.interval_minutes], ['https://atom.test/feed.xml', 'Atom-Seite', 'https://atom.test/', 30]);
      const noFeed = await call('/aktion/lesen/feed/abonnieren', { form: { csrf, back: '/lesen/feeds', url: 'https://leer.test/' } });
      assert.equal(noFeed.status, 303);
      assert.match(await (await call('/lesen/feeds', { cookie: noFeed.headers.getSetCookie() })).text(), /toast-text">Unter dieser Adresse ist kein Feed zu finden/);

      await call('/aktion/lesen/feed/aendern', { form: { csrf, back: '/lesen/feeds', id: feed.id, stapel: '1', filter: ' rust, ki ', intervall: '1' } });
      const changed = store.getFeed(feed.id);
      assert.deepEqual([changed.to_stack, changed.paused, changed.keyword_filter, changed.interval_minutes], [true, false, 'rust, ki', 5]);

      // OPML-Upload als multipart/form-data.
      const form = new FormData();
      form.append('csrf', csrf);
      form.append('back', '/lesen/feeds');
      form.append('datei', new Blob([READER_OPML], { type: 'text/x-opml' }), 'abos.opml');
      const imp = await call('/aktion/lesen/feeds/import', { body: form });
      assert.equal(imp.status, 303);
      assert.deepEqual(store.listFeeds().map((f) => f.url).sort(), ['https://atom.test/feed.xml', 'https://blog.test/feed', 'https://json.test/feed.json']);
      const page = await (await call('/lesen/feeds', { cookie: imp.headers.getSetCookie() })).text();
      assert.match(page, /2 Feeds importiert, 1 schon abonniert/);
      assert.match(page, /Blog &amp; Co/);
      const badCsrf = new FormData();
      badCsrf.append('datei', new Blob([READER_OPML]), 'abos.opml');
      assert.equal((await call('/aktion/lesen/feeds/import', { body: badCsrf })).status, 403);

      const opml = await call('/lesen/feeds.opml');
      assert.equal(opml.status, 200);
      assert.match(opml.headers.get('content-type'), /^text\/x-opml/);
      assert.match(opml.headers.get('content-disposition'), /attachment; filename="feeds\.opml"/);
      assert.equal(parseOpml(await opml.text()).length, 3);

      await call('/aktion/lesen/feed/entfernen', { form: { csrf, back: '/lesen/feeds', id: feed.id } });
      assert.equal(store.getFeed(feed.id), null);
    },
    { 'https://atom.test/': site, 'https://atom.test/feed.xml': ATOM, 'https://leer.test/': '<html><head></head></html>' },
  );
});
