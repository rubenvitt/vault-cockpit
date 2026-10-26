import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReadingStore } from '../src/lesen/store.js';
import { BOX_DAYS, dueAt, isDue, keep, letGo, findClusters } from '../src/lesen/review.js';
import { reviewRoutes } from '../src/lesen/review-page.js';
import { readingRoutes } from '../src/lesen/http.js';
import { createApp } from '../src/http/app.js';
import { createWebHttp } from '../src/web/http.js';
import { createCookieSigner } from '../src/web/session.js';
import { createSettingsStore } from '../src/cockpit/settings.js';

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse('2026-10-19T08:00:00.000Z'); // Montag, KW 43
const quiet = { info() {}, warn() {}, error() {} };

test('Wiedersehen: neu nach einem Tag fällig, Behalten mit wachsenden Abständen, Loslassen nie mehr', () => {
  let h = { created_at: new Date(T0).toISOString(), review_box: 0, review_due: null, review_state: 'aktiv' };
  assert.equal(dueAt(h), new Date(T0 + DAY).toISOString());
  assert.equal(isDue(h, T0 + DAY - 1), false);
  assert.equal(isDue(h, T0 + DAY), true);

  let now = T0 + DAY;
  const gaps = [];
  for (let i = 0; i < 6; i += 1) {
    h = { ...h, ...keep(h, now) };
    const gap = (Date.parse(h.review_due) - now) / DAY;
    gaps.push(gap);
    assert.equal(isDue(h, now + gap * DAY - 1), false);
    now += gap * DAY;
    assert.equal(isDue(h, now), true);
  }
  assert.deepEqual(gaps, [3, 7, 21, 60, 60, 60]);
  assert.deepEqual([1, ...gaps.slice(0, 4)], BOX_DAYS);

  h = { ...h, ...letGo() };
  assert.equal(isDue(h, now + 1000 * DAY), false);
});

test('Wiedersehen: der Speicher setzt beim Anlegen die erste Fälligkeit', () => {
  const store = createReadingStore({ path: ':memory:', now: () => T0 });
  const { doc } = store.addDocument({ url: 'https://a.test/1' });
  const h = store.addHighlight({ doc_id: doc.id, quote: 'Zitat' });
  assert.equal(h.review_due, new Date(T0 + DAY).toISOString());
  assert.equal(h.review_state, 'aktiv');
});

test('Querverbindung: Gruppen ähnlicher Markierungen nur über verschiedene Dokumente', () => {
  const items = [
    { id: 'a', doc_id: 'd1' },
    { id: 'b', doc_id: 'd2' },
    { id: 'c', doc_id: 'd1' }, // gleiches Dokument wie a, darf nicht dazu
    { id: 'd', doc_id: 'd3' },
    { id: 'e', doc_id: 'd4' }, // ganz woanders
  ];
  const n = (v) => { const l = Math.hypot(...v); return v.map((x) => x / l); };
  const vectors = [n([1, 0, 0]), n([0.95, 0.05, 0]), n([1, 0.01, 0]), n([0.9, 0.1, 0]), n([0, 0, 1])];
  const groups = findClusters(items, vectors, { threshold: 0.8 });
  assert.deepEqual(groups.map((g) => g.map((h) => h.id)), [['a', 'b', 'd']]);
  assert.deepEqual(findClusters([items[0], items[4]], [vectors[0], vectors[4]], { threshold: 0.5 }), []);
  assert.deepEqual(findClusters([items[0], items[2]], [vectors[0], vectors[2]], { threshold: 0.5 }), []);
});

/** Wiedersehen ohne Server: Seiten und Aktionen direkt, Uhr und Inbox zum Nachsehen. */
function setup({ embedder = () => null, highlights = 3 } = {}) {
  let clock = T0;
  const now = () => clock;
  const store = createReadingStore({ path: ':memory:', now });
  const a = store.addDocument({ url: 'https://a.test/1', title: 'Erster Text', site: 'a.test', topics: ['Lernen'] }).doc;
  const b = store.addDocument({ url: 'https://b.test/2', title: 'Zweiter Text', site: 'b.test' }).doc;
  for (let i = 0; i < highlights; i += 1) store.addHighlight({ doc_id: i % 2 ? b.id : a.id, quote: `Zitat ${i}` });
  const captured = [];
  const ownWords = [];
  const capture = async (input) => (captured.push(input), { kind: 'note', path: 'Inbox/x.md', duplicate: false });
  const routes = reviewRoutes({ store, capture, embedder, onOwnWords: (x) => ownWords.push(x), logger: quiet, now });
  const ctx = (search = '') => ({ url: new URL(`https://vault.test/lesen/wiedersehen${search}`), user: 'ruben', tz: 'Europe/Berlin', write: { csrf: 'c', back: '/lesen/wiedersehen' }, flash: null });
  const page = async (search) => (await routes.pages['/lesen/wiedersehen'](ctx(search))).html;
  const act = (path, fields) => routes.actions[path](new URLSearchParams(fields), { sub: 'ruben' });
  return { store, routes, page, act, ctx, captured, ownWords, advance: (ms) => (clock += ms), now };
}

const cardId = (html) => html.match(/class="inbox-card wiedersehen-card" data-id="([^"]+)"/)?.[1] ?? null;

test('Wiedersehen: Behalten rückt weiter, Rückgängig holt die Karte zurück, doppelt abgeschickt ändert nichts', async () => {
  const { store, page, act, advance } = setup();
  assert.match(await page(), /Nichts fällig/);
  advance(DAY);
  const html = await page();
  assert.match(html, /Heute 0 von 3 gesehen/);
  const id = cardId(html);
  const r = await act('/aktion/lesen/wiedersehen', { id, ziel: 'behalten' });
  assert.equal(r.message, 'Behalten');
  assert.equal(store.getHighlight(id).review_box, 2);
  await assert.rejects(act('/aktion/lesen/wiedersehen', { id, ziel: 'behalten' }), { status: 409 });
  assert.match(await page(), /Heute 1 von 3 gesehen/);

  await act(r.undo.action, r.undo.fields);
  const back = store.getHighlight(id);
  assert.equal(back.review_box, 0);
  assert.match(await page(), /Heute 0 von 3 gesehen/);

  const gone = await act('/aktion/lesen/wiedersehen', { id, ziel: 'loslassen' });
  assert.equal(store.getHighlight(id).review_state, 'losgelassen');
  assert.ok(store.getHighlight(id), 'Loslassen löscht nichts');
  advance(400 * DAY);
  assert.doesNotMatch(await page(), new RegExp(`data-id="${id}"`));
  await act(gone.undo.action, gone.undo.fields);
  assert.equal(store.getHighlight(id).review_state, 'aktiv');
});

test('Wiedersehen: höchstens 20 Karten am Tag, der Rest morgen', async () => {
  const { page, act, advance } = setup({ highlights: 23 });
  advance(DAY);
  assert.match(await page(), /Heute 0 von 20 gesehen · 3 weitere morgen/);
  for (let i = 0; i < 20; i += 1) await act('/aktion/lesen/wiedersehen', { id: cardId(await page()), ziel: 'behalten' });
  const html = await page();
  assert.equal(cardId(html), null);
  assert.match(html, /Für heute reicht es/);
  assert.match(html, /3 Markierungen kommen morgen dran/);
  advance(DAY);
  assert.ok(cardId(await page()));
});

test('Wiedersehen: In eigenen Worten landet mit Zitat und Quelle in der Inbox, ruft den Haken und rückt weiter', async () => {
  const { store, page, act, advance, captured, ownWords } = setup();
  advance(DAY);
  const id = cardId(await page());
  await assert.rejects(act('/aktion/lesen/wiedersehen', { id, ziel: 'worte', worte: '  ' }), /eigenen Worten/);
  const r = await act('/aktion/lesen/wiedersehen', { id, ziel: 'worte', worte: 'So sehe ich das.', cid: 'abc-1' });
  assert.equal(r.message, 'In der Inbox: Inbox/x.md');
  const h = store.getHighlight(id);
  assert.match(captured[0].text, new RegExp(`^> ${h.quote}\\n\\nSo sehe ich das\\.\\n\\nAus \\[.+\\]\\(https://.+\\)$`));
  assert.equal(captured[0].captureId, 'abc-1');
  assert.equal(ownWords.length, 1);
  assert.equal(ownWords[0].highlight.id, id);
  assert.equal(ownWords[0].words, 'So sehe ich das.');
  assert.equal(h.review_box, 2);
});

test('Wiedersehen: Woche mit Themen-Balken, Querverbindung nur mit Embedder, Export als Markdown', async () => {
  const embedder = () => ({ model: 'm', embed: async (texts) => texts.map(() => Float32Array.from([1, 0])) });
  const withVectors = setup({ embedder });
  const html = await withVectors.page();
  assert.match(html, /<progress max="2" value="2">2<\/progress>/);
  assert.match(html, /Lernen/);
  assert.match(html, /Querverbindung entdeckt/);
  const ids = html.match(/name="ids" value="([^"]+)"/)[1];
  await withVectors.act('/aktion/lesen/wiedersehen/verbindung', { ids });
  assert.match(withVectors.captured[0].captureId, /^verbindung-[0-9a-f]{32}$/);
  assert.match(withVectors.captured[0].text, /^Querverbindung entdeckt\n\n> Zitat/);

  assert.doesNotMatch(await setup().page(), /Querverbindung/);
  const broken = setup({ embedder: () => ({ model: 'm', embed: async () => { throw new Error('nicht erreichbar'); } }) });
  assert.doesNotMatch(await broken.page(), /Querverbindung/);

  const md = await withVectors.routes.pages['/lesen/wiedersehen.md'](withVectors.ctx());
  assert.match(md.headers['content-disposition'], /attachment; filename="markierungen-2026-W43\.md"/);
  assert.match(md.body, /^# Markierungen KW 43 \(19\.10\.2026 – 25\.10\.2026\)/);
  assert.match(md.body, /## \[Erster Text\]\(https:\/\/a\.test\/1\)\n\n> Zitat \d/);
  const empty = await withVectors.routes.pages['/lesen/wiedersehen.md'](withVectors.ctx('?woche=2026-W40'));
  assert.match(empty.body, /Keine Markierungen/);
});

test('Wiedersehen über das Cockpit: ohne JavaScript Behalten → Rückgängig aus der Meldung, Export als Download', async () => {
  const SECRET = 'x'.repeat(40);
  let clock = T0;
  const store = createReadingStore({ path: ':memory:', now: () => clock });
  const { doc } = store.addDocument({ url: 'https://a.test/1', title: 'Text' });
  const h = store.addHighlight({ doc_id: doc.id, quote: 'Zitat' });
  clock += DAY;
  const webHttp = createWebHttp({
    cockpit: { week: async () => null },
    settings: createSettingsStore({ defaults: { tz: 'Europe/Berlin' }, logger: quiet }),
    reading: readingRoutes({ store, logger: quiet, review: { now: () => clock } }),
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
  const jar = { vc_session: createCookieSigner(SECRET).seal({ sub: 'ruben', sid: 's1', gen: 0, iat: t, seen: t, exp: t + 3600 }) };
  const call = async (path, form = null) => {
    const headers = { 'x-forwarded-host': 'vault.test', cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ') };
    if (form) headers['content-type'] = 'application/x-www-form-urlencoded';
    const res = await fetch(base + path, { method: form ? 'POST' : 'GET', redirect: 'manual', headers, body: form ? new URLSearchParams(form).toString() : undefined });
    for (const c of res.headers.getSetCookie()) {
      const [pair, ...attrs] = c.split('; ');
      const [k, v] = pair.split('=');
      if (attrs.includes('Max-Age=0')) delete jar[k];
      else if (k !== 'vc_session') jar[k] = v;
    }
    return res;
  };
  try {
    let html = await (await call('/lesen/wiedersehen')).text();
    assert.ok(!/style=|<script>/.test(html), 'keine Inline-Styles oder -Skripte');
    assert.match(html, /<a href="\/lesen\/wiedersehen" class="subnav-item" aria-current="page"><span>Wiedersehen<\/span>/);
    assert.equal(cardId(html), h.id);
    assert.doesNotMatch(html, /In eigenen Worten/, 'ohne Inbox kein Textfeld');
    const csrf = html.match(/name="csrf" value="([^"]+)"/)[1];

    const res = await call('/aktion/lesen/wiedersehen', { csrf, back: '/lesen/wiedersehen', id: h.id, ziel: 'behalten' });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), '/lesen/wiedersehen');
    assert.equal(store.getHighlight(h.id).review_box, 2);

    html = await (await call('/lesen/wiedersehen')).text();
    assert.match(html, /Nichts fällig/);
    const undo = html.match(/<form method="post" action="\/aktion\/lesen\/wiedersehen\/zurueck" class="act">(.*?)<\/form>/)[1];
    const fields = Object.fromEntries([...undo.matchAll(/name="([^"]+)" value="([^"]*)"/g)].map((m) => [m[1], m[2]]));
    assert.equal((await call('/aktion/lesen/wiedersehen/zurueck', fields)).status, 303);
    assert.equal(cardId(await (await call('/lesen/wiedersehen')).text()), h.id);

    const md = await call('/lesen/wiedersehen.md?woche=2026-W43');
    assert.equal(md.status, 200);
    assert.match(md.headers.get('content-disposition'), /attachment; filename="markierungen-2026-W43\.md"/);
    assert.match(await md.text(), /> Zitat/);
  } finally {
    app.close();
  }
});
