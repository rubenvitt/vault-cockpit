import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/http/app.js';
import { createWebHttp } from '../src/web/http.js';
import { createSettingsStore } from '../src/cockpit/settings.js';
import { createTokenStore } from '../src/cockpit/tokens.js';
import { createReadingStore } from '../src/lesen/store.js';
import { readingRoutes } from '../src/lesen/http.js';
import { sanitizeHtml } from '../src/lesen/extract.js';
import { htmlText, anchorAt, markHighlights } from '../src/lesen/anchor.js';
import { textBlocks } from '../src/lesen/blocks.js';

const quiet = { info() {}, warn() {}, error() {} };
const DAY = 24 * 60 * 60 * 1000;

/** Folgen ohne ElevenLabs und Claude: feste Liste, Vorlesen kostet je Text 1000 Zeichen, Gehörtes nichts. */
function fakeEpisodes({ list = [], heard = new Set() } = {}) {
  return {
    availability: () => ({ vorlesen: null, podcast: 'Podcast und Report brauchen Claude', report: 'Podcast und Report brauchen Claude' }),
    list: () => list,
    resumable: (id) => id === 'f-fehler',
    preview: ({ docIds }) => ({ docs: docIds, chars: docIds.filter((id) => !heard.has(id)).length * 1000 }),
    audioPath: () => null,
  };
}

/**
 * Cockpit mit Lesestapel im Speicher und Geräte-Token der App (Recht `app`).
 * `get` liest JSON mit dem Token, `act` schickt eine Aktion wie die App
 * (Formular, `Accept: application/json`, ohne Cookie und CSRF).
 */
async function withApp(run, { episodes = null, embedder = () => null } = {}) {
  const clock = { t: Date.now() };
  const store = createReadingStore({ path: ':memory:', now: () => clock.t });
  const tokens = createTokenStore({ logger: quiet });
  const webHttp = createWebHttp({
    cockpit: { week: async () => null },
    settings: createSettingsStore({ defaults: { tz: 'Europe/Berlin' }, logger: quiet }),
    tokens,
    reading: readingRoutes({ store, episodes, logger: quiet, capture: async () => ({ path: 'Inbox/x.md', duplicate: false }), review: { now: () => clock.t, embedder } }),
    oidc: {},
    sessionSecret: 'x'.repeat(40),
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
  const bearer = tokens.create('Rubens iPhone', 'app').token;
  const raw = (path, { token = bearer } = {}) => fetch(base + path, { redirect: 'manual', headers: { 'x-forwarded-host': 'vault.test', ...(token ? { authorization: `Bearer ${token}` } : {}) } });
  const get = async (path) => {
    const res = await raw(path);
    assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8', path);
    assert.equal(res.headers.get('cache-control'), 'no-store', path);
    return { status: res.status, body: await res.json() };
  };
  const act = async (path, fields) => {
    const res = await fetch(base + path, {
      method: 'POST',
      headers: { 'x-forwarded-host': 'vault.test', accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded', authorization: `Bearer ${bearer}` },
      body: new URLSearchParams(fields),
    });
    return { status: res.status, body: await res.json() };
  };
  try {
    await run({ get, act, raw, store, clock, tokens });
  } finally {
    app.close();
  }
}

test('Lesen-JSON: nur mit Geräte-Token oder Sitzung, die HTML-Seiten bleiben beim Cookie', async () => {
  await withApp(async ({ raw, tokens }) => {
    const search = tokens.create('Suche', 'search').token;
    for (const path of ['/api/lesen/eingang', '/api/lesen/stapel', '/api/lesen/doc?id=x', '/api/lesen/markiert', '/api/lesen/wiedersehen', '/api/lesen/wiedersehen.md', '/api/lesen/folgen', '/api/lesen/folgen/neu']) {
      assert.equal((await raw(path, { token: null })).status, 401, path);
      assert.equal((await raw(path, { token: search })).status, 401, `${path}: nur Recht „App“`);
      assert.notEqual((await raw(path)).status, 401, path);
    }
    assert.equal((await raw('/lesen/eingang')).status, 303);
    const missing = await raw('/api/lesen/doc?id=gibt-es-nicht');
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { error: 'not_found', message: 'Diesen Artikel gibt es nicht (mehr).' });
  });
});

test('Lesen-JSON Eingang: Karte mit Herkunft und Feed, „Heute x von y“, Rückgängig, Gruppen mit Zählern', async () => {
  await withApp(async ({ get, act, store }) => {
    const { group } = store.addGroup({ name: 'Technik' });
    const { feed } = store.addFeed({ url: 'https://blog.test/feed.xml', title: 'Blog', group_id: group.id });
    const older = store.addDocument({ url: 'https://blog.test/1', title: 'Aus dem Feed', site: 'Blog', origin: `feed:${feed.id}`, kind: 'feed', reading_minutes: 4, topics: ['Technik'], excerpt: 'Kurz.' }).doc;
    const saved = store.addDocument({ url: 'https://a.test/2', title: 'Gespeichert', origin: 'kurzbefehl', reading_minutes: 2 }).doc;

    let { body } = await get('/api/lesen/eingang');
    assert.equal(body.doc.id, saved.id, 'neueste zuerst');
    assert.equal(body.doc.why, 'Über den Kurzbefehl gespeichert');
    assert.equal(body.doc.siteLabel, 'a.test');
    assert.equal(body.doc.kindLabel, 'Artikel');
    assert.equal(body.doc.feed, null);
    assert.deepEqual([body.left, body.more, body.today, body.undo], [2, true, { seen: 0, total: 2, last: null }, null]);
    assert.deepEqual(body.groups, [{ id: group.id, name: 'Technik', count: 1 }]);
    assert.equal(body.noFeedCount, 1);
    assert.deepEqual([body.showGroups, body.vault, body.filter], [true, false, { gruppe: null }]);

    const sorted = await act('/aktion/lesen/sortieren', { id: saved.id, ziel: 'stapel' });
    assert.equal(sorted.status, 200);
    ({ body } = await get('/api/lesen/eingang'));
    assert.equal(body.doc.id, older.id);
    assert.match(body.doc.why, /^Feed Blog, abonniert im /);
    assert.deepEqual(body.doc.feed, { id: feed.id, title: 'Blog', url: 'https://blog.test/feed.xml', siteUrl: null, groupId: group.id });
    assert.deepEqual(body.doc.topics, ['Technik']);
    assert.deepEqual(body.today, { seen: 1, total: 2, last: { id: saved.id, title: 'Gespeichert', url: 'https://a.test/2' } });
    assert.deepEqual(body.undo, { action: '/aktion/lesen/sortieren', fields: { id: saved.id, ziel: 'eingang' } });
    assert.equal(body.more, false);

    ({ body } = await get('/api/lesen/eingang?gruppe=ohne'));
    assert.deepEqual([body.doc, body.left, body.filter.gruppe], [null, 0, 'ohne']);
  });
});

test('Lesen-JSON Stapel: Zeitfenster mit x von y Min. und Rest, nichts passt, Sortierung, Schalter', async () => {
  await withApp(async ({ get, store }) => {
    const add = (title, minutes, progress = 0) => {
      const { doc } = store.addDocument({ url: `https://a.test/${encodeURIComponent(title)}`, title, status: 'stapel', reading_minutes: minutes });
      if (progress) store.setProgress(doc.id, progress);
      return doc;
    };
    const long = add('Lang', 40);
    const started = add('Angefangen', 10, 0.5);
    const mid = add('Mittel', 8);
    add('Ohne Lesezeit', 0);

    let { body } = await get('/api/lesen/stapel?zeit=15');
    assert.deepEqual(body.items.map((d) => [d.title, d.remaining, d.started]), [['Angefangen', 5, true], ['Mittel', 8, false]]);
    assert.deepEqual(body.window, { used: 13, of: 15, more: 2, fits: true });
    assert.deepEqual([body.zeit, body.count, body.listenZeit, body.episodeZeit, body.episodes, body.vault], [15, 4, 15, 15, false, false]);

    ({ body } = await get('/api/lesen/stapel?zeit=5'));
    assert.deepEqual(body.window, { used: 5, of: 5, more: 3, fits: true }, 'Angefangen passt mit 5 Min. Rest');

    store.setProgress(started.id, 0);
    ({ body } = await get('/api/lesen/stapel?zeit=5'));
    assert.equal(body.window.fits, false);
    assert.deepEqual(body.items.map((d) => d.id), [mid.id], 'nur der kürzeste');

    ({ body } = await get('/api/lesen/stapel?sort=kurz'));
    assert.equal(body.window, null);
    assert.equal(body.sort, 'kurz');
    assert.deepEqual(body.items.map((d) => [d.title, d.remaining]), [['Ohne Lesezeit', null], ['Mittel', 8], ['Angefangen', 10], ['Lang', 40]]);
    assert.deepEqual(body.sorts.map((s) => s.label), ['Passt jetzt', 'Neueste', 'Kürzeste']);
    assert.deepEqual(body.windows, [5, 15, 30, 60]);
    assert.equal(body.items.at(-1).id, long.id);
    ({ body } = await get('/api/lesen/stapel?sort=quatsch'));
    assert.equal(body.sort, 'passt');
  });
});

test('Lesetext als Blöcke: Überschriften, Listen, Zitat, Code, Bild, Tabelle; Stellen wie im Lesetext', () => {
  const html = sanitizeHtml(
    `<h2>Vom   Lesen</h2>
<p>Der <strong>Stapel <em>wächst</em></strong> &amp; wächst.<br>Neue Zeile.</p>
<blockquote><p>Zitat <a href="https://a.test/x">hier</a></p></blockquote>
<ol start="3"><li>Drei<ul><li>Unterpunkt</li></ul></li><li>Vier</li></ol>
<pre><code>let x = 1;
  y();
</code></pre><hr>
<figure><img src="/b.png" alt="Ein Bild"><figcaption>Unterschrift</figcaption></figure>
<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>`,
    'https://a.test/',
  );
  const { text, blocks } = textBlocks(html);
  assert.equal(text, htmlText(html));
  assert.deepEqual(
    blocks.map((b) => [b.kind, b.level ?? b.number ?? b.depth ?? b.alt ?? b.header ?? null]),
    [['heading', 2], ['paragraph', null], ['quote', null], ['listItem', 3], ['listItem', 2], ['listItem', 4], ['code', null], ['rule', null], ['image', 'Ein Bild'], ['caption', null], ['row', true], ['row', false]],
  );
  assert.deepEqual(blocks[0].runs, [{ text: 'Vom ', start: 0 }, { text: 'Lesen', start: 6 }], 'Leerraum zusammengefasst, eigene Stelle danach');
  assert.deepEqual(blocks[1].runs.map((r) => [r.text, r.bold ?? false, r.italic ?? false, r.extra ?? false]), [
    ['Der ', false, false, false],
    ['Stapel ', true, false, false],
    ['wächst', true, true, false],
    [' & wächst.', false, false, false],
    ['\n', false, false, true],
    ['Neue Zeile.', false, false, false],
  ]);
  assert.equal(blocks[2].runs[1].link, 'https://a.test/x');
  assert.deepEqual([blocks[4].ordered, blocks[4].depth, blocks[3].ordered], [false, 2, true]);
  assert.equal(blocks[6].runs[0].text, 'let x = 1;\n  y();', 'Code behält Leerraum');
  assert.equal(blocks[8].src, 'https://a.test/b.png');
  assert.deepEqual(blocks[10].runs.map((r) => r.text), ['A', '\t', 'B']);
  for (const b of blocks) {
    assert.ok(b.start <= b.end && b.end <= text.length);
    for (const r of b.runs.filter((x) => !x.extra)) {
      const source = text.slice(r.start, r.start + r.text.length);
      assert.equal(b.kind === 'code' ? source : source.replace(/[ \t\n\r\f]/g, ' '), r.text, `Lauf „${r.text}“ steht so im Lesetext`);
    }
  }
});

test('Lesen-JSON Leseansicht: Blöcke und Markierungen stimmen mit dem Web überein, auch für neue Markierungen der App', async () => {
  await withApp(async ({ get, act, store }) => {
    const content = sanitizeHtml(`<h2>Anfang &amp; Ende</h2>
<p>Der Stapel <em>wächst  und
   <strong>wächst</strong></em> – jeden Tag.</p>
<ul><li>Erster <a href="https://a.test/l">Punkt</a> mit 😀 Emoji</li><li>Zweiter Punkt<ol><li>Tief drin</li></ol></li></ul>
<blockquote><p>Ein Satz, den man sich merkt.</p></blockquote>`);
    const { doc } = store.addDocument({ url: 'https://blatt.test/a', title: 'Vom Lesen', site: 'Blatt', status: 'stapel', reading_minutes: 10, content_html: content });
    const text = htmlText(content);
    const at = (quote) => anchorAt(text, text.indexOf(quote), text.indexOf(quote) + quote.length);
    // Über Hervorhebungen hinweg, wie eine Auswahl im Browser.
    const existing = store.addHighlight({ doc_id: doc.id, ...at('wächst  und\n   wächst'), note: 'Wichtig' });
    const lost = store.addHighlight({ doc_id: doc.id, ...anchorAt('Nicht mehr da', 0, 13) });
    // Gespeicherte Stelle im Leerraum vor der Liste: `weiter` ist das erste Zeichen danach.
    store.setProgress(doc.id, 0.4, String(text.indexOf('Erster') - 1));

    const { status, body } = await get(`/api/lesen/doc?id=${doc.id}`);
    assert.equal(status, 200);
    assert.deepEqual([body.hasText, body.length, body.anchor, body.weiter], [true, text.length, text.indexOf('Erster') - 1, text.indexOf('Erster')]);
    assert.deepEqual([body.doc.title, body.doc.rest, body.doc.remaining, body.nav, body.vault], ['Vom Lesen', 'noch 6 min', 6, 'stapel', false]);
    assert.deepEqual(body.decisions, { fertig: true, vault: false, zurueck: false });
    assert.deepEqual(body.stack.map((d) => [d.id, d.current, d.rest]), [[doc.id, true, 'noch 6 min']]);
    assert.equal(body.counts.stapel, 1);

    // Jeder Block beginnt dort, wo sein Text im Lesetext steht (UTF-16, das Emoji zählt doppelt).
    const blockAt = (needle) => body.blocks.find((b) => b.runs.some((r) => r.text.includes(needle)));
    assert.deepEqual(body.blocks.map((b) => b.kind), ['heading', 'paragraph', 'listItem', 'listItem', 'listItem', 'quote']);
    for (const [needle, kind] of [['Anfang & Ende', 'heading'], ['Der Stapel', 'paragraph'], ['Erster', 'listItem'], ['Zweiter Punkt', 'listItem'], ['Tief drin', 'listItem'], ['Ein Satz', 'quote']]) {
      const b = blockAt(needle);
      assert.equal(b.kind, kind);
      assert.equal(b.start, text.indexOf(needle), `${needle}: Anfang`);
    }
    const item = blockAt('Erster');
    assert.equal(item.end, text.indexOf('Emoji') + 'Emoji'.length);
    assert.equal(item.runs.find((r) => r.link).start, text.indexOf('Punkt'));
    assert.equal(item.runs.at(-1).start, text.indexOf(' mit 😀'));
    assert.deepEqual([blockAt('Tief drin').depth, blockAt('Tief drin').ordered, blockAt('Tief drin').number], [2, true, 1]);
    for (const b of body.blocks) for (const r of b.runs.filter((x) => !x.extra)) assert.equal(text.slice(r.start, r.start + r.text.length).replace(/[ \t\n\r\f]/g, ' '), r.text);

    // Markierungen: dieselbe Stelle wie die <mark> der Webseite.
    const start = text.indexOf('wächst  und');
    const end = start + 'wächst  und\n   wächst'.length;
    assert.deepEqual(body.ranges, [{ id: existing.id, start, end, note: 'Wichtig' }]);
    const marked = markHighlights(content, store.listHighlights({ docId: doc.id })).html;
    assert.equal([...marked.matchAll(/<mark[^>]*>([^<]*)<\/mark>/g)].map((m) => m[1]).join(''), text.slice(start, end));
    const byId = Object.fromEntries(body.highlights.map((h) => [h.id, h]));
    assert.deepEqual([byId[existing.id].start, byId[existing.id].end, byId[existing.id].lost, byId[existing.id].note], [start, end, false, 'Wichtig']);
    assert.deepEqual([byId[lost.id].start, byId[lost.id].lost], [null, true], 'Stelle nicht mehr im Text');

    // Die App markiert eine Auswahl über zwei Läufe (Link und Text danach) aus den Stellen der Blöcke.
    const link = item.runs.find((r) => r.link);
    const from = link.start;
    const to = item.end;
    const anchor = anchorAt(text, from, to);
    const made = await act('/aktion/lesen/markierung/neu', { id: doc.id, quote: anchor.quote, prefix: anchor.prefix, suffix: anchor.suffix, start: String(from), cid: 'app-1' });
    assert.equal(made.status, 200);
    const again = (await get(`/api/lesen/doc?id=${doc.id}`)).body;
    assert.deepEqual(again.ranges.find((r) => r.id === made.body.highlight.id), { id: made.body.highlight.id, start: from, end: to, note: null });
    assert.equal(text.slice(from, to), 'Punkt mit 😀 Emoji');

    // Ohne Lesetext: der Anriss als Absatz, Markierungen ohne Stelle.
    const bare = store.addDocument({ url: 'https://blatt.test/b', title: 'Leer', excerpt: 'Nur ein Anriss.' }).doc;
    const empty = (await get(`/api/lesen/doc?id=${bare.id}`)).body;
    assert.deepEqual([empty.hasText, empty.length, empty.blocks.map((b) => b.runs[0].text), empty.nav, empty.decisions.fertig], [false, 0, ['Nur ein Anriss.'], 'eingang', true]);
    store.setStatus(bare.id, 'weg');
    assert.deepEqual((await get(`/api/lesen/doc?id=${bare.id}`)).body.decisions, { fertig: false, vault: false, zurueck: true });
  });
});

test('Lesen-JSON Markiert und Wiedersehen: Filter, fällige Karten, Woche mit Häufungen und Export', async () => {
  const embedder = () => ({ model: 'm', embed: async (texts) => texts.map(() => Float32Array.from([1, 0])) });
  await withApp(
    async ({ get, act, raw, store, clock }) => {
      const a = store.addDocument({ url: 'https://a.test/1', title: 'Erster', site: 'A', topics: ['Lernen'] }).doc;
      const b = store.addDocument({ url: 'https://b.test/2', title: 'Zweiter', site: 'B' }).doc;
      const h1 = store.addHighlight({ doc_id: a.id, quote: 'Zitat eins', note: 'Notiz' });
      const h2 = store.addHighlight({ doc_id: b.id, quote: 'Zitat zwei' });

      let { body } = await get('/api/lesen/markiert');
      assert.deepEqual(body.facets, { sites: ['A', 'B'], topics: ['Lernen'] });
      assert.deepEqual(body.items.map((h) => h.id).sort(), [h1.id, h2.id].sort());
      ({ body } = await get('/api/lesen/markiert?quelle=A'));
      assert.deepEqual(body.filter, { quelle: 'A', thema: null });
      assert.deepEqual(body.items.map((h) => [h.id, h.quote, h.note, h.docTitle, h.docSite, h.docTopics]), [[h1.id, 'Zitat eins', 'Notiz', 'Erster', 'A', ['Lernen']]]);

      ({ body } = await get('/api/lesen/wiedersehen'));
      assert.deepEqual([body.cards.length, body.seen, body.left, body.later, body.limit, body.maxBox, body.canCapture], [0, 0, 0, 0, 20, 5, true]);
      assert.deepEqual(body.week.stats, { highlights: 2, texts: 2, topics: 2 });
      assert.deepEqual(body.week.topics, [{ label: 'B', count: 1 }, { label: 'Lernen', count: 1 }]);
      assert.equal(body.week.clusters.length, 1);
      assert.deepEqual(body.week.clusters[0].ids.sort(), [h1.id, h2.id].sort());
      assert.match(body.week.export, /^\/api\/lesen\/wiedersehen\.md\?woche=\d{4}-W\d\d$/);
      assert.ok(body.week.prev.id < body.week.id && body.week.next.id > body.week.id);
      assert.equal(body.week.prev.week, Number(body.week.prev.id.slice(6)));
      const md = await raw(body.week.export);
      assert.equal(md.status, 200);
      assert.match(await md.text(), /^# Markierungen KW \d+/);

      clock.t += DAY + 1000;
      ({ body } = await get('/api/lesen/wiedersehen'));
      assert.deepEqual([body.cards.length, body.left, body.total], [2, 2, 2]);
      assert.deepEqual([body.cards[0].box, typeof body.cards[0].dueAt], [1, 'string']);
      const kept = await act('/aktion/lesen/wiedersehen', { id: body.cards[0].id, ziel: 'behalten' });
      assert.equal(kept.body.undo.action, '/aktion/lesen/wiedersehen/zurueck');
      ({ body } = await get('/api/lesen/wiedersehen'));
      assert.deepEqual([body.seen, body.left, body.total, body.cards.length], [1, 1, 2, 1]);

      ({ body } = await get('/api/lesen/wiedersehen?woche=2020-W01'));
      assert.deepEqual([body.week.id, body.week.prev.id, body.week.next.id], ['2020-W01', '2019-W52', '2020-W02']);
      assert.deepEqual([body.week.stats.highlights, body.week.topics, body.week.clusters, body.week.export], [0, [], [], null]);
    },
    { embedder },
  );
});

test('Lesen-JSON Folgen: Felder, Stand beim Sprechen, Fehler mit Fortsetzen; Neue Folge mit Zeichen je Text', async () => {
  const now = Date.now();
  const list = [
    { id: 'f-spricht', kind: 'podcast', minutes: 10, title: 'Podcast: A', docs: ['d1'], status: 'spricht', chars: 9000, created_at: new Date(now - 120_000).toISOString(), updated_at: new Date(now).toISOString(), speaking_at: new Date(now - 60_000).toISOString(), speaking_from: 0, done: 1, total: 4 },
    { id: 'f-fehler', kind: 'vorlesen', minutes: null, title: 'Vorlesen: B', docs: ['d2'], status: 'fehler', error: 'ElevenLabs: 401', chars: 1200, created_at: new Date(now - DAY).toISOString(), updated_at: new Date(now - DAY).toISOString() },
    { id: 'f-fertig', kind: 'report', minutes: 5, title: 'Report: C', docs: ['d3'], status: 'fertig', chars: 4500, bytes: 16000 * 75, note: 'Inbox/Report.md', created_at: new Date(now - 2 * DAY).toISOString(), updated_at: new Date(now - 2 * DAY).toISOString(), finished_at: new Date(now - 2 * DAY).toISOString() },
  ];
  const heard = new Set();
  await withApp(async ({ get, store }) => {
    const one = store.addDocument({ url: 'https://a.test/1', title: 'Eins', status: 'stapel', reading_minutes: 10, content_html: '<p>Eins.</p>' }).doc;
    const two = store.addDocument({ url: 'https://a.test/2', title: 'Zwei', status: 'stapel', reading_minutes: 12, content_html: '<p>Zwei.</p>' }).doc;
    store.addDocument({ url: 'https://a.test/3', title: 'Zu lang', status: 'stapel', reading_minutes: 50, content_html: '<p>Drei.</p>' });
    heard.add(two.id);

    let { body } = await get('/api/lesen/folgen');
    assert.equal(body.enabled, true);
    const [speaking, failed, ready] = body.items;
    assert.deepEqual([speaking.busy, speaking.progress.step, speaking.progress.percent, speaking.progress.fraction, speaking.progress.restMinutes], [true, 2, 25, 0.25, 3]);
    assert.match(speaking.progress.label, /noch etwa 3 Min\./);
    assert.deepEqual([failed.error, failed.resumable, failed.retry.label, failed.progress], ['ElevenLabs: 401', true, 'Fortsetzen', null]);
    assert.deepEqual([ready.seconds, ready.bytes, ready.note, ready.kindLabel, ready.chars, ready.resumable, ready.retry], [75, 1200000, 'Inbox/Report.md', 'Report', 4500, false, null]);
    assert.deepEqual(body.availability, { vorlesen: null, podcast: 'Podcast und Report brauchen Claude', report: 'Podcast und Report brauchen Claude' });
    assert.deepEqual(body.kinds.map((k) => [k.kind, k.label, Boolean(k.missing)]), [['vorlesen', 'Vorlesen', false], ['podcast', 'Podcast', true], ['report', 'Report', true]]);

    ({ body } = await get('/api/lesen/folgen/neu?zeit=30'));
    assert.deepEqual(body.docs.map((d) => [d.id, d.chars]).sort(), [[one.id, 1000], [two.id, 0]].sort(), 'Gehörtes kostet nichts');
    assert.deepEqual([body.zeit, body.chars, body.defaultKind, body.defaultLength, body.lengths, body.maxDocs, body.spokenCharsPerMinute], [30, 1000, 'vorlesen', 10, [5, 10, 20], 20, 900]);
    assert.deepEqual(body.summary, { main: 'Vorlesen · 2 Texte · etwa 1 Min.', cost: 'rund 1.000 Zeichen bei ElevenLabs' });
    assert.deepEqual(Object.keys(body.summaries), ['vorlesen']);
    ({ body } = await get('/api/lesen/folgen/neu?zeit=5'));
    assert.deepEqual([body.zeit, body.docs, body.chars], [5, [], 0]);
  }, { episodes: fakeEpisodes({ list, heard }) });

  await withApp(async ({ get }) => {
    const { body } = await get('/api/lesen/folgen');
    assert.deepEqual([body.enabled, body.items], [false, []]);
    assert.equal((await get('/api/lesen/folgen/neu')).body.enabled, false);
    assert.equal((await get('/api/lesen/stapel')).body.episodes, false);
  });
});
