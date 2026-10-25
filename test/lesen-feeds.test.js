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

test('Feeds: Gruppe pausiert → keiner ihrer Feeds wird abgerufen; direkt auf den Stapel über die Gruppe', async () => {
  const { store, feeds, poller, calls, tick } = setup();
  const { group: paused } = store.addGroup({ name: 'Ruhig', paused: true });
  const { group: stack } = store.addGroup({ name: 'Wichtig', to_stack: true });
  for (const f of [feeds.blog, feeds.atom, feeds.kaputt]) store.updateFeed(f.id, { group_id: paused.id });
  store.updateFeed(feeds.json.id, { group_id: stack.id });

  assert.equal(await poller.runDue(), 2);
  assert.deepEqual(calls.map((c) => c.url), ['https://json.test/feed.json', 'https://json.test/favicon.ico'], 'nur der Feed außerhalb der pausierten Gruppe');
  assert.deepEqual(docsOf(store, feeds.json).map((d) => d.status), ['stapel', 'stapel'], 'Gruppe legt auf den Stapel, der Feed selbst nicht');

  // Zustand: Feeds der pausierten Gruppe zählen als aus, nicht als Fehler.
  const health = poller.health();
  assert.equal(health.state, 'ok');
  assert.equal(health.summary, '4 Feeds, 3 pausiert');
  assert.deepEqual(health.items.map((i) => [i.name, i.state, i.summary]), [['atom.test', 'off', 'pausiert'], ['blog.test', 'off', 'pausiert'], ['kaputt.test', 'off', 'pausiert'], ['JSON-Seite', 'ok', null]]);

  // Gruppe wieder an: ihre Feeds sind sofort dran.
  store.updateGroup(paused.id, { paused: false });
  calls.length = 0;
  tick(1);
  await poller.runDue();
  assert.ok(calls.some((c) => c.url === 'https://blog.test/feed'));
  assert.equal(docsOf(store, feeds.blog)[0].status, 'eingang');
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

test('OPML: verschachtelte outline werden flach importiert, je Feed der nächste Ordner als Gruppe, Export wieder lesbar', () => {
  const list = parseOpml(READER_OPML);
  assert.deepEqual(list, [
    { url: 'https://blog.test/feed', title: 'Blog & Co', site_url: 'https://blog.test/', group: 'Technik' },
    { url: 'https://atom.test/feed.xml', title: 'Atom', site_url: null, group: 'Unterordner' },
    { url: 'https://json.test/feed.json', title: 'JSON', site_url: null, group: null },
  ]);
  assert.throws(() => parseOpml('<rss/>'), /Keine OPML/);
  // Leeres `title` am Ordner: dann zählt `text`.
  assert.equal(parseOpml('<opml><body><outline text="Tech" title=""><outline xmlUrl="https://t.test/feed"/></outline></body></opml>')[0].group, 'Tech');
  assert.deepEqual(parseOpml(toOpml(list.map((f) => ({ ...f, title: `${f.title} "<x>"` })))).map((f) => f.title), ['Blog & Co "<x>"', 'Atom "<x>"', 'JSON "<x>"']);
});

test('OPML: Gruppen als Ordner in ihrer Reihenfolge, Round-Trip ergibt dieselben Gruppen je Feed', () => {
  const store = createReadingStore({ path: ':memory:' });
  const { group: b } = store.addGroup({ name: 'Zweite & "<x>"' });
  const { group: a } = store.addGroup({ name: 'Alpha' });
  store.addGroup({ name: 'Leer' });
  store.moveGroup(a.id, -1);
  for (const [url, group] of [['https://blog.test/feed', b], ['https://atom.test/feed.xml', a], ['https://json.test/feed.json', null], ['https://more.test/feed', a]]) {
    store.addFeed({ url, title: url.split('/')[2], group_id: group?.id });
  }
  const opml = toOpml(store.listFeeds(), { groups: store.listGroups() });
  assert.ok(opml.indexOf('text="Alpha"') < opml.indexOf('text="Zweite &amp; &quot;&lt;x&gt;&quot;"'), 'Gruppenreihenfolge');
  assert.ok(!opml.includes('Leer'), 'leere Gruppe ohne Ordner');
  const back = Object.fromEntries(parseOpml(opml).map((f) => [f.url, f.group]));
  assert.deepEqual(back, Object.fromEntries(store.listFeeds().map((f) => [f.url, store.getGroup(f.group_id)?.name ?? null])));
  assert.equal(back['https://blog.test/feed'], 'Zweite & "<x>"');
  assert.equal(back['https://json.test/feed.json'], null);
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

// --- Gruppen (VCP-97) ----------------------------------------------------------

const csrfOf = async (call) => (await (await call('/lesen/feeds')).text()).match(/name="csrf" value="([^"]+)"/)[1];
const toastAfter = async (call, res) => (await (await call('/lesen/feeds', { cookie: res.headers.getSetCookie() })).text()).match(/toast-text">([^<]*)</)?.[1];
const groupAt = (page, name) => page.indexOf(`feed-group-name">${name}<`);

test('Feeds-Seite: Gruppen anlegen, umbenennen, einstellen, ordnen, löschen', async () => {
  await withWeb(async ({ call, store }) => {
    const csrf = await csrfOf(call);
    const form = (path, fields) => call(path, { form: { csrf, back: '/lesen/feeds', ...fields } });
    assert.equal((await form('/aktion/lesen/gruppe/anlegen', { name: ' Tech ' })).status, 303);
    await form('/aktion/lesen/gruppe/anlegen', { name: 'Politik' });
    assert.equal(await toastAfter(call, await form('/aktion/lesen/gruppe/anlegen', { name: 'tech' })), 'Gibt es schon: Tech');
    assert.equal(await toastAfter(call, await form('/aktion/lesen/gruppe/anlegen', { name: '  ' })), 'Name der Gruppe fehlt');
    const [tech, politik] = store.listGroups();

    const dup = await form('/aktion/lesen/gruppe/aendern', { id: politik.id, name: 'TECH' });
    assert.equal(dup.status, 303);
    assert.equal(await toastAfter(call, dup), 'Eine Gruppe „TECH“ gibt es schon');
    await form('/aktion/lesen/gruppe/aendern', { id: tech.id, name: 'Technik & Co', pausiert: '1', stapel: '1' });
    const changed = store.getGroup(tech.id);
    assert.deepEqual([changed.name, changed.paused, changed.to_stack], ['Technik & Co', true, true]);

    await form('/aktion/lesen/gruppe/verschieben', { id: politik.id, richtung: 'hoch' });
    assert.deepEqual(store.listGroups().map((g) => g.name), ['Politik', 'Technik & Co']);
    const page = await (await call('/lesen/feeds')).text();
    assert.ok(groupAt(page, 'Politik') > 0 && groupAt(page, 'Politik') < groupAt(page, 'Technik &amp; Co'));
    assert.match(page, /value="hoch" class="btn quiet" disabled>Nach oben<span class="sr-only">: Politik/);
    assert.match(page, /zusätzlich zu deren eigener Einstellung/);
    assert.match(page, /Die Feeds bleiben, dann ohne Gruppe/);
    assert.equal(await toastAfter(call, await form('/aktion/lesen/gruppe/verschieben', { id: politik.id, richtung: 'quer' })), 'Unbekannte Richtung');

    const { feed } = store.addFeed({ url: 'https://blog.test/feed', group_id: tech.id });
    const del = await form('/aktion/lesen/gruppe/entfernen', { id: tech.id });
    assert.match(await toastAfter(call, del), /Gruppe gelöscht: Technik &amp; Co\. Ihre Feeds bleiben/);
    assert.equal(store.getGroup(tech.id), null);
    assert.equal(store.getFeed(feed.id).group_id, null);
    assert.equal(await toastAfter(call, await form('/aktion/lesen/gruppe/entfernen', { id: tech.id })), 'Diese Gruppe gibt es nicht mehr');
  });
});

test('Feeds-Seite: Feeds einer Gruppe zuordnen, nach Gruppe anzeigen mit neuen Einträgen', async () => {
  await withWeb(
    async ({ call, store }) => {
      const { group: tech } = store.addGroup({ name: 'Tech', paused: true, to_stack: true });
      store.addGroup({ name: 'Leer' });
      const csrf = await csrfOf(call);
      const form = (path, fields) => call(path, { form: { csrf, back: '/lesen/feeds', ...fields } });

      await form('/aktion/lesen/feed/abonnieren', { url: 'https://atom.test/feed.xml', gruppe: tech.id });
      await form('/aktion/lesen/feed/abonnieren', { url: 'https://json.test/feed.json', gruppe: '' });
      const atom = store.listFeeds().find((f) => f.url.startsWith('https://atom.test'));
      const json = store.listFeeds().find((f) => f.url.startsWith('https://json.test'));
      assert.deepEqual([atom.group_id, json.group_id], [tech.id, null]);
      const unknown = await form('/aktion/lesen/feed/abonnieren', { url: 'https://blog.test/feed', gruppe: 'gibts-nicht' });
      assert.equal(unknown.status, 303);
      assert.equal(await toastAfter(call, unknown), 'Diese Gruppe gibt es nicht');

      // Ohne Feld `gruppe` bleibt die Zuordnung, leer heißt ohne Gruppe.
      await form('/aktion/lesen/feed/aendern', { id: atom.id, intervall: '60' });
      assert.equal(store.getFeed(atom.id).group_id, tech.id);
      await form('/aktion/lesen/feed/aendern', { id: json.id, intervall: '60', gruppe: tech.id });
      assert.equal(store.getFeed(json.id).group_id, tech.id);
      await form('/aktion/lesen/feed/aendern', { id: json.id, intervall: '60', gruppe: '' });
      assert.equal(store.getFeed(json.id).group_id, null);

      store.addDocument({ url: 'https://atom.test/a/1', origin: `feed:${atom.id}` });
      store.addDocument({ url: 'https://atom.test/a/2', origin: `feed:${atom.id}` });
      const page = await (await call('/lesen/feeds')).text();
      assert.match(page, /<details open class="feed-group" data-gruppe>\s*<summary><span class="feed-group-name">Tech<\/span> <span class="count-badge">2 neu<\/span><\/summary>/);
      assert.ok(page.includes(`<a href="/lesen/eingang?gruppe=${tech.id}">2 neue Einträge im Eingang</a>`));
      assert.match(page, /Noch keine Feeds in dieser Gruppe/);
      assert.ok(groupAt(page, 'Tech') < groupAt(page, 'Leer') && groupAt(page, 'Leer') < groupAt(page, 'Ohne Gruppe'));
      assert.match(page, /pausiert \(Gruppe\)/);
      assert.match(page, /direkt auf den Stapel \(Gruppe\)/);
      assert.ok(page.includes(`<option value="${tech.id}" selected>Tech</option>`));
      assert.match(page, /<span class="sr-only">Gruppe<\/span><select name="gruppe"><option value="">ohne Gruppe<\/option>/);
      assert.ok(!/style=|<script>/.test(page), 'keine Inline-Styles oder -Skripte');
    },
    { 'https://atom.test/feed.xml': ATOM, 'https://json.test/feed.json': JSON_FEED, 'https://blog.test/feed': rss([rssItem(1)]) },
  );
});

// Braucht `group` (Ordnername) aus parseOpml, das kommt mit src/lesen/opml.js für VCP-97.
const FOLDER_OPML = `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0"><body>
  <outline text="Tech">
    <outline text="Atom" type="rss" xmlUrl="https://atom.test/feed.xml"/>
    <outline text="JSON" type="rss" xmlUrl="https://json.test/feed.json"/>
    <outline text="Blog" type="rss" xmlUrl="https://blog.test/feed"/>
  </outline>
  <outline text="Ohne Ordner" type="rss" xmlUrl="https://solo.test/feed"/>
  <outline text="Politik">
    <outline text="Zweit" type="rss" xmlUrl="https://zweit.test/feed"/>
  </outline>
</body></opml>`;

test('Feeds-Seite: OPML-Import legt Ordner als Gruppen an, vorhandene Zuordnung bleibt', async () => {
  await withWeb(async ({ call, store }) => {
    const { group: politik } = store.addGroup({ name: 'Politik' });
    const known = store.addFeed({ url: 'https://json.test/feed.json' }).feed;
    const kept = store.addFeed({ url: 'https://blog.test/feed', group_id: politik.id }).feed;
    const body = new FormData();
    body.append('csrf', await csrfOf(call));
    body.append('back', '/lesen/feeds');
    body.append('datei', new Blob([FOLDER_OPML], { type: 'text/x-opml' }), 'abos.opml');
    const imp = await call('/aktion/lesen/feeds/import', { body });
    assert.equal(await toastAfter(call, imp), '3 Feeds importiert, 2 schon abonniert');

    const [, tech] = store.listGroups();
    assert.deepEqual(store.listGroups().map((g) => g.name), ['Politik', 'Tech']);
    assert.deepEqual(Object.fromEntries(store.listFeeds().map((f) => [f.url, f.group_id])), {
      'https://atom.test/feed.xml': tech.id,
      'https://json.test/feed.json': tech.id,
      'https://blog.test/feed': politik.id,
      'https://solo.test/feed': null,
      'https://zweit.test/feed': politik.id,
    });
    assert.equal(store.getFeed(known.id).group_id, tech.id, 'schon abonniert, ohne Gruppe: wird zugeordnet');
    assert.equal(store.getFeed(kept.id).group_id, politik.id, 'vorhandene Zuordnung bleibt');
  });
});

// --- Sammeln (VCP-110) ---------------------------------------------------------

test('Feeds-Seite: viele Feeds auf einmal verschieben, pausieren, einstellen und nach Rückfrage entfernen', async () => {
  await withWeb(async ({ call, store }) => {
    const { group: tech } = store.addGroup({ name: 'Tech' });
    const ids = ['a', 'b', 'c', 'd'].map((n) => store.addFeed({ url: `https://${n}.test/feed`, title: `Feed ${n.toUpperCase()}`, interval_minutes: 30 }).feed.id);
    const [a, b, c, d] = ids;
    const csrf = await csrfOf(call);
    // Mehrere `feed`-Felder: als Liste von Paaren.
    const bulk = (fields, picked) => call('/aktion/lesen/feeds/auswahl', { form: [['csrf', csrf], ['back', '/lesen/feeds'], ...Object.entries(fields), ...picked.map((id) => ['feed', id])] });

    const page = await (await call('/lesen/feeds')).text();
    for (const id of ids) assert.ok(page.includes(`<input type="checkbox" name="feed" value="${id}" form="feeds-auswahl" class="feed-pick" aria-label="Auswählen: Feed`), 'Häkchen je Feed gehört zum Sammelformular');
    assert.match(page, /<form method="post" action="\/aktion\/lesen\/feeds\/auswahl" id="feeds-auswahl"/);
    assert.match(page, /<option value="neu">Neue Gruppe …<\/option>/);
    assert.match(page, /<script src="\/static\/lesen-feeds\.js\?v=[\w-]+" defer>/);
    assert.match(page, /4 Feeds\. Zum gemeinsamen Bearbeiten/);
    assert.ok(!/style=|<script>/.test(page), 'keine Inline-Styles oder -Skripte');

    assert.equal(await toastAfter(call, await bulk({ tun: 'pausieren' }, [])), 'Bitte zuerst Feeds abhaken');

    // In eine vorhandene Gruppe, in eine neue, wieder ohne.
    assert.equal(await toastAfter(call, await bulk({ tun: 'gruppe', ziel: tech.id }, [a, b, a])), '2 Feeds in „Tech“');
    assert.deepEqual([a, b, c].map((id) => store.getFeed(id).group_id), [tech.id, tech.id, null]);
    assert.equal(await toastAfter(call, await bulk({ tun: 'gruppe', ziel: 'neu', neu: ' Politik ' }, [c, d])), '2 Feeds in „Politik“');
    const politik = store.listGroups().find((g) => g.name === 'Politik');
    assert.deepEqual([c, d].map((id) => store.getFeed(id).group_id), [politik.id, politik.id]);
    assert.equal(await toastAfter(call, await bulk({ tun: 'gruppe', ziel: 'neu', neu: '' }, [c])), 'Name der Gruppe fehlt');
    assert.equal(await toastAfter(call, await bulk({ tun: 'gruppe', ziel: 'weg' }, [c])), 'Diese Gruppe gibt es nicht mehr');
    assert.equal(await toastAfter(call, await bulk({ tun: 'gruppe', ziel: '' }, [d])), '1 Feed jetzt ohne Gruppe');
    assert.equal(store.getFeed(d).group_id, null);

    // Schalter und Abstand; unbekannte Feeds fallen weg.
    assert.equal(await toastAfter(call, await bulk({ tun: 'pausieren' }, [a, c, 'gibts-nicht'])), '2 Feeds pausiert');
    assert.deepEqual(ids.map((id) => store.getFeed(id).paused), [true, false, true, false]);
    await bulk({ tun: 'fortsetzen' }, [a]);
    assert.equal(store.getFeed(a).paused, false);
    await bulk({ tun: 'stapel-an' }, [b, d]);
    assert.deepEqual(ids.map((id) => store.getFeed(id).to_stack), [false, true, false, true]);
    await bulk({ tun: 'stapel-aus' }, [d]);
    assert.equal(store.getFeed(d).to_stack, false);
    assert.equal(await toastAfter(call, await bulk({ tun: 'abstand', intervall: '2' }, [a, b])), '2 Feeds alle 5 min');
    assert.deepEqual(ids.map((id) => store.getFeed(id).interval_minutes), [5, 5, 30, 30]);
    assert.equal(await toastAfter(call, await bulk({ tun: 'abstand', intervall: 'x' }, [a])), 'Bitte einen Abstand in Minuten angeben');
    assert.equal(await toastAfter(call, await bulk({ tun: 'quer' }, [a])), 'Unbekannte Aktion');
    assert.equal(await toastAfter(call, await bulk({ tun: 'pausieren' }, ['gibts-nicht'])), 'Diese Feeds gibt es nicht mehr');

    // Entfernen ohne Bestätigung: erst die Rückfrage, nichts ist weg.
    const ask = await bulk({ tun: 'entfernen' }, [a, b]);
    assert.equal(ask.status, 303);
    assert.equal(ask.headers.get('location'), `/lesen/feeds/entfernen?feed=${a}&feed=${b}`);
    assert.equal(store.listFeeds().length, 4);
    const confirm = await (await call(ask.headers.get('location'), { cookie: ask.headers.getSetCookie() })).text();
    assert.match(confirm, /2 Feeds entfernen\? Gespeicherte Artikel bleiben/);
    assert.match(confirm, /Feed A[\s\S]*Feed B/);
    assert.ok(!confirm.includes('Feed C'));
    assert.ok(confirm.includes(`<input type="hidden" name="feed" value="${a}">`) && confirm.includes('name="bestaetigt" value="1"'));
    assert.ok(!/toast-text/.test(confirm), 'keine leere Meldung');

    store.addDocument({ url: 'https://a.test/1', origin: `feed:${a}` });
    const del = await bulk({ tun: 'entfernen', bestaetigt: '1' }, [a, b]);
    assert.equal(await toastAfter(call, del), '2 Feeds entfernt. Gespeicherte Artikel bleiben.');
    assert.deepEqual(store.listFeeds().map((f) => f.id).sort(), [c, d].sort());
    assert.equal(store.list({ limit: 10 }).length, 1, 'Artikel bleibt');
    assert.match(await (await call(`/lesen/feeds/entfernen?feed=${a}`)).text(), /Diese Feeds gibt es nicht mehr/);
  });
});

test('Lesestapel: updateFeeds und deleteFeeds gehen alles oder nichts', () => {
  const store = createReadingStore({ path: ':memory:' });
  const a = store.addFeed({ url: 'https://a.test/feed' }).feed.id;
  const b = store.addFeed({ url: 'https://b.test/feed' }).feed.id;
  assert.throws(() => store.updateFeeds([a, b], { group_id: 'gibts-nicht' }), /Diese Gruppe gibt es nicht/);
  assert.deepEqual(store.updateFeeds([a, a, 'x'], { paused: true }).map((f) => f.id), [a]);
  assert.equal(store.getFeed(b).paused, false);
  assert.equal(store.deleteFeeds([a, b, 'x']), 2);
  assert.equal(store.listFeeds().length, 0);
});
