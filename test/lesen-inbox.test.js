import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/http/app.js';
import { createWebHttp } from '../src/web/http.js';
import { createCookieSigner } from '../src/web/session.js';
import { createSettingsStore } from '../src/cockpit/settings.js';
import { createReadingStore } from '../src/lesen/store.js';
import { readingRoutes } from '../src/lesen/http.js';
import { whyHere } from '../src/lesen/inbox.js';

const quiet = { info() {}, warn() {}, error() {} };
const SECRET = 'x'.repeat(40);

/** Cockpit mit Lesestapel im Speicher, angemeldet über ein selbst signiertes Sitzungs-Cookie (wie lesen-web.test.js). */
async function withInbox(run) {
  const store = createReadingStore({ path: ':memory:' });
  const webHttp = createWebHttp({
    cockpit: { week: async () => null },
    settings: createSettingsStore({ defaults: { tz: 'Europe/Berlin' }, logger: quiet }),
    reading: readingRoutes({ store, logger: quiet }),
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
  const call = async (path, { form = null, accept = null } = {}) => {
    const headers = { 'x-forwarded-host': 'vault.test', cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; '), ...(accept ? { accept } : {}) };
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
  const page = async () => (await call('/lesen/eingang')).text();
  try {
    await run({ call, store, page });
  } finally {
    app.close();
  }
}

const csrfFrom = (html) => html.match(/name="csrf" value="([^"]+)"/)[1];
const SORT = '/aktion/lesen/sortieren';

test('Eingang: Warum hier? nennt die Herkunft in einem Satz', () => {
  const feed = { id: 'f1', url: 'https://blatt.test/feed.xml', title: 'Blatt', created_at: '2026-03-14T10:00:00.000Z' };
  const getFeed = (id) => (id === 'f1' ? feed : null);
  const why = (origin) => whyHere({ origin }, { getFeed, tz: 'Europe/Berlin' });
  assert.equal(why('kurzbefehl'), 'Über den Kurzbefehl gespeichert');
  assert.equal(why('mail'), 'Per Mail');
  assert.equal(why('feed:f1'), 'Feed Blatt, abonniert im März 2026');
  assert.equal(why('feed:weg'), 'Aus einem Feed');
  assert.equal(why('formular'), 'Im Cockpit gespeichert');
  assert.equal(why('schnelleingabe'), 'Im Cockpit gespeichert');
  assert.equal(why('import'), 'Importiert');
});

test('Eingang: Karte mit Quelle, Art, Lesezeit, Themen und Herkunft; ohne JavaScript weg → Rückgängig → wieder im Eingang', async () => {
  await withInbox(async ({ call, store, page }) => {
    const { feed } = store.addFeed({ url: 'https://blatt.test/feed.xml', title: 'Blatt' });
    store.addDocument({ url: 'https://a.test/1', title: 'Älterer Text', origin: 'mail', kind: 'newsletter' });
    const { doc } = store.addDocument({ url: 'https://blatt.test/2', title: 'Vom Lesen', site: 'Blatt', reading_minutes: 7, excerpt: 'Kurz gesagt.', topics: ['Lesen', 'Gewohnheit'], origin: `feed:${feed.id}` });

    let html = await page();
    assert.ok(!/style=|<script>/.test(html), 'keine Inline-Styles oder -Skripte');
    assert.match(html, /<script src="\/static\/lesen-eingang\.js\?v=[\w-]+" defer><\/script>/);
    // Nur die oberste (neueste) Karte, mit angedeutetem Stapel darunter.
    assert.equal(html.match(/<article class="inbox-card/g).length, 1);
    assert.match(html, /<article class="inbox-card more" data-id="[^"]+">/);
    assert.match(html, /Blatt<\/a> · Artikel · 7 min/);
    assert.match(html, /<h2 class="inbox-title">Vom Lesen<\/h2>/);
    assert.match(html, /<p class="inbox-excerpt">Kurz gesagt\.<\/p>/);
    assert.match(html, /<ul class="inbox-topics" aria-label="Themen"><li>Lesen<\/li><li>Gewohnheit<\/li><\/ul>/);
    assert.match(html, /<strong>Warum hier\?<\/strong> Feed Blatt, abonniert im \p{L}+ \d{4} ·/u);
    assert.match(html, /Heute 0 von 2 gesichtet/);
    assert.match(html, /<button type="submit" name="ziel" value="weg"[^>]*>.*Weg <kbd aria-hidden="true">X<\/kbd><\/button>/);
    assert.match(html, /value="stapel"[^>]*>.*Stapel/);
    assert.match(html, /value="lesen"[^>]*>Jetzt lesen/);
    assert.match(html, /<form method="post" action="\/aktion\/lesen\/speichern"/, 'URL speichern bleibt auf der Seite');
    assert.ok(!html.includes('aria-label="Gruppe"'), 'ohne Gruppen keine Gruppen-Chips');
    const csrf = csrfFrom(html);

    const res = await call(SORT, { form: { csrf, back: '/lesen/eingang', id: doc.id, ziel: 'weg' } });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), '/lesen/eingang');
    assert.equal(store.get(doc.id).status, 'weg', 'weg heißt Status weg, nicht löschen');

    html = await page();
    assert.match(html, /<span class="toast-text">Weg: Vom Lesen<\/span><form method="post" action="\/aktion\/lesen\/sortieren"/);
    assert.match(html, /Heute 1 von 2 gesichtet/);
    assert.match(html, /<h2 class="inbox-title">Älterer Text<\/h2>/);
    assert.match(html, /Newsletter/);
    assert.match(html, /Warum hier\?<\/strong> Per Mail/);
    // Rückgängig steht auch dauerhaft über den Knöpfen, mit der letzten Entscheidung.
    const undo = html.match(/<form method="post" action="\/aktion\/lesen\/sortieren" class="act inbox-undo">(.*?)<\/form>/)[1];
    assert.match(undo, new RegExp(`name="id" value="${doc.id}"`));
    assert.match(undo, /name="ziel" value="eingang"/);

    const back = await call(SORT, { form: { csrf, back: '/lesen/eingang', id: doc.id, ziel: 'eingang' } });
    assert.equal(back.status, 303);
    assert.equal(store.get(doc.id).status, 'eingang');
    html = await page();
    assert.match(html, /Zurück im Eingang: Vom Lesen/);
    assert.match(html, /Heute 0 von 2 gesichtet/);
    assert.match(html, /<h2 class="inbox-title">Vom Lesen<\/h2>/);
    assert.ok(!/inbox-undo/.test(html), 'nach dem Rückgängig ist heute nichts mehr entschieden');
  });
});

test('Eingang: mit JavaScript als JSON, Jetzt lesen legt auf den Stapel und öffnet die Leseansicht, leerer Zustand', async () => {
  await withInbox(async ({ call, store, page }) => {
    const { doc: a } = store.addDocument({ url: 'https://a.test/a', title: 'A' });
    const { doc: b } = store.addDocument({ url: 'https://a.test/b', title: 'B' });
    const csrf = csrfFrom(await page());
    const json = 'application/json';

    const res = await call(SORT, { form: { csrf, id: b.id, ziel: 'stapel' }, accept: json });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.message, 'Auf dem Stapel: B');
    assert.deepEqual(body.undo, { action: SORT, fields: { id: b.id, ziel: 'eingang' } });
    assert.equal(store.get(b.id).status, 'stapel');
    // Rückgängig wie cockpit.js: das Formular aus `undo` mit CSRF.
    const undone = await call(body.undo.action, { form: { ...body.undo.fields, csrf }, accept: json });
    assert.equal(undone.status, 200);
    assert.equal(store.get(b.id).status, 'eingang');

    // Doppelt abgeschickt: nichts passiert, kein Rückgängig.
    await call(SORT, { form: { csrf, id: b.id, ziel: 'weg' }, accept: json });
    const twice = await (await call(SORT, { form: { csrf, id: b.id, ziel: 'weg' }, accept: json })).json();
    assert.equal(twice.undo, null);
    // Was den Eingang schon verlassen hat, lässt sich nicht anders entscheiden.
    const moved = await call(SORT, { form: { csrf, id: b.id, ziel: 'stapel' }, accept: json });
    assert.equal(moved.status, 409);
    assert.equal((await call(SORT, { form: { csrf, id: a.id, ziel: 'löschen' }, accept: json })).status, 400);
    assert.equal((await call(SORT, { form: { csrf, id: 'gibt-es-nicht', ziel: 'weg' }, accept: json })).status, 404);

    const read = await call(SORT, { form: { csrf, back: '/lesen/eingang', id: a.id, ziel: 'lesen' } });
    assert.equal(read.status, 303);
    assert.equal(read.headers.get('location'), `/lesen/doc?id=${a.id}`);
    assert.equal(store.get(a.id).status, 'stapel');

    const html = await page();
    assert.match(html, /<p class="inbox-empty-title">Eingang leer<\/p>/);
    assert.match(html, /Heute 2 von 2 gesichtet/);
    assert.ok(!/inbox-decide/.test(html), 'ohne Karte keine Knöpfe');
    assert.match(html, /<details class="more inbox-save" open>/);
  });
});

test('Eingang lässt sich auf eine Gruppe einschränken: Karte, Zähler, Rückgängig; ohne = Gespeichertes und Mail; Unbekanntes = alle', async () => {
  await withInbox(async ({ call, store }) => {
    const tech = store.addGroup({ name: 'Tech' }).group;
    store.addGroup({ name: 'News' });
    const a = store.addFeed({ url: 'https://a.test/feed', title: 'A', group_id: tech.id }).feed;
    const b = store.addFeed({ url: 'https://b.test/feed', title: 'B' }).feed;
    store.addDocument({ url: 'https://m.test/1', title: 'Mail', origin: 'mail' });
    store.addDocument({ url: 'https://a.test/1', title: 'A1', origin: `feed:${a.id}` });
    const { doc: a2 } = store.addDocument({ url: 'https://a.test/2', title: 'A2', origin: `feed:${a.id}` });
    store.addDocument({ url: 'https://k.test/1', title: 'Gespeichert', origin: 'kurzbefehl' });
    store.addDocument({ url: 'https://b.test/1', title: 'B1', origin: `feed:${b.id}` });
    const filtered = `/lesen/eingang?gruppe=${tech.id}`;
    const at = async (path) => (await call(path)).text();
    const title = (html) => html.match(/<h2 class="inbox-title">([^<]+)</)[1];

    let html = await at(filtered);
    assert.equal(title(html), 'A2');
    assert.match(html, /Heute 0 von 2 gesichtet/);
    assert.match(html, /<nav class="chips lesen-gruppe" aria-label="Gruppe"><a href="\/lesen\/eingang" class="chip">Alle<\/a>/);
    assert.match(html, new RegExp(`<a href="/lesen/eingang\\?gruppe=${tech.id}" class="chip" aria-current="true">Tech</a>`));
    assert.match(html, /<a href="\/lesen\/eingang\?gruppe=ohne" class="chip">Ohne Feed<\/a>/);
    // `back` trägt die Query: ohne JavaScript zurück in den gefilterten Eingang.
    assert.match(html, new RegExp(`name="back" value="${filtered.replace('?', '\\?')}"`));
    const res = await call(SORT, { form: { csrf: csrfFrom(html), back: filtered, id: a2.id, ziel: 'stapel' } });
    assert.equal(res.headers.get('location'), filtered);
    html = await at(filtered);
    assert.equal(title(html), 'A1');
    assert.match(html, /Heute 1 von 2 gesichtet/);
    assert.match(html, new RegExp(`class="act inbox-undo">.*name="id" value="${a2.id}"`));

    html = await at('/lesen/eingang?gruppe=ohne');
    assert.equal(title(html), 'Gespeichert');
    assert.match(html, /Heute 0 von 2 gesichtet/);
    assert.ok(!/inbox-undo/.test(html), 'die Entscheidung in Tech zählt hier nicht');

    html = await at('/lesen/eingang?gruppe=quatsch');
    assert.equal(title(html), 'B1');
    assert.match(html, /Heute 1 von 5 gesichtet/);
    assert.match(html, /<a href="\/lesen\/eingang" class="chip" aria-current="true">Alle<\/a>/);
  });
});

test('Lesestapel: leftInboxSince zählt nur heutige Entscheidungen aus dem Eingang', () => {
  let t = Date.parse('2026-10-22T20:00:00.000Z');
  const store = createReadingStore({ path: ':memory:', now: () => t });
  const { doc: a } = store.addDocument({ url: 'https://a.test/a', title: 'A' });
  const { doc: b } = store.addDocument({ url: 'https://a.test/b', title: 'B' });
  const { doc: c } = store.addDocument({ url: 'https://a.test/c', title: 'C', status: 'stapel' });
  store.setStatus(a.id, 'weg'); // gestern
  t = Date.parse('2026-10-23T08:00:00.000Z');
  store.setStatus(b.id, 'stapel');
  store.setStatus(c.id, 'archiv'); // kam nicht aus dem Eingang
  const since = '2026-10-22T22:00:00.000Z';
  assert.deepEqual(store.leftInboxSince(since), { count: 1, last: { id: b.id, title: 'B', url: 'https://a.test/b' } });
  // Direkt aus dem Eingang archiviert (Leseansicht): zählt, ist aber kein Rückgängig-Ziel.
  const { doc: d } = store.addDocument({ url: 'https://a.test/d', title: 'D' });
  t += 1000;
  store.setStatus(d.id, 'archiv');
  assert.deepEqual(store.leftInboxSince(since), { count: 2, last: { id: b.id, title: 'B', url: 'https://a.test/b' } });
  store.setStatus(b.id, 'eingang');
  assert.deepEqual(store.leftInboxSince(since), { count: 1, last: null });
});
