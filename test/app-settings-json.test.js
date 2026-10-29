import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/http/app.js';
import { createWebHttp } from '../src/web/http.js';
import { createCookieSigner } from '../src/web/session.js';
import { createSettingsStore } from '../src/cockpit/settings.js';
import { createTokenStore } from '../src/cockpit/tokens.js';
import { createBackup, open } from '../src/cockpit/backup.js';
import { loadShortcuts } from '../src/web/shortcuts.js';
import { createReadingStore } from '../src/lesen/store.js';
import { readingRoutes } from '../src/lesen/http.js';
import { FetchError } from '../src/lesen/fetch.js';
import { formOfSettings, mergeSettingsForm } from '../src/web/settings-json.js';

const quiet = { info() {}, warn() {}, error() {} };
const SECRET = 'x'.repeat(40);
const NOW = Date.parse('2026-10-25T08:30:00.000Z');
// Kleine scrypt-Kosten, damit die Tests schnell bleiben.
const cost = { N: 2 ** 10, r: 8, p: 1 };
const PASS = 'korrekt pferd batterie';
const SHORT = PASS.slice(0, 4);
const OTHER = PASS.split('').reverse().join('');

// Geheimnisse, die nie in einer Antwort auftauchen dürfen (als Konstanten, damit Secret-Scanner sie nicht für echte halten).
const ZUNDER_TOKEN = 'zt_geheim_eigen_1234';
const ENV_ZUNDER = 'zt_geheim_umgebung_5678';
const MAIL_TOKEN = 'fmu1-geheim-mail-9012';
const TTS_KEY = 'sk_geheim_elevenlabs_3456';
const ENV_TTS = 'sk_geheim_umgebung_7890';
const CAL_URL = 'https://cal.test/private/geheimer-pfad-4711/basic.ics';
const CAL_PASSWORD = 'pw-geheim-kalender';
const SECRETS = [ZUNDER_TOKEN, ENV_ZUNDER, MAIL_TOKEN, TTS_KEY, ENV_TTS, 'geheimer-pfad-4711', CAL_PASSWORD];

const ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"><title>Atom-Seite</title><link rel="self" href="https://atom.test/feed.xml"/><link href="https://atom.test/"/>
<entry><id>urn:atom:1</id><title>Erster</title><link href="https://atom.test/a/1"/><updated>2026-10-19T10:00:00Z</updated><content type="html">Kurz.</content></entry>
</feed>`;
const OPML = `<?xml version="1.0"?><opml version="2.0"><head><title>Feeds</title></head><body>
<outline text="Technik"><outline type="rss" text="Blog" xmlUrl="https://blog.test/feed"/></outline>
<outline type="rss" text="Atom-Seite" xmlUrl="https://atom.test/feed.xml"/>
</body></opml>`;

/** Fetch ohne Netz: nur die Feeds hier. */
const fakeFetch = (routes) => async (url) => {
  const r = routes[url];
  if (r === undefined) throw new FetchError(`${new URL(url).host} ist nicht erreichbar`);
  return { url, status: 200, body: r, bytes: Buffer.from(r), headers: {} };
};

/** Mit `COCKPIT_FIXTURES=<Ordner>` schreiben die Tests ihre Antworten als Fixtures für die App (`rest-*.json`). */
const keep = (name, body) => {
  const dir = process.env.COCKPIT_FIXTURES;
  if (dir) writeFileSync(join(dir, `rest-${name}.json`), `${JSON.stringify(body, null, 2)}\n`);
};

/**
 * Cockpit mit echten Dateien (Einstellungen, Tokens, Sicherung), Lesestapel mit
 * Feeds, Kalender-Attrappe und den Kurzbefehlen aus dem Repo; die App fragt mit
 * Geräte-Token, `cookie` ist eine Sitzung des Browsers.
 */
async function withSettingsApp(run, { defaults = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'app-settings-'));
  const settings = createSettingsStore({ file: join(dir, 'cockpit-settings.json'), defaults: { tz: 'Europe/Berlin', ...defaults }, logger: quiet });
  const tokens = createTokenStore({ file: join(dir, 'api-tokens.json'), logger: quiet, now: () => NOW });
  const restarts = [];
  const store = createReadingStore({ path: ':memory:' });
  // Erster Kalender erreichbar, alle weiteren nicht (mit Adresse im Fehler, die maskiert werden muss).
  const calendars = {
    check: async () => Object.fromEntries(settings.get().calendars.map((c, i) => [c.id, i === 0 ? { ok: true, count: 3 } : { ok: false, error: `401 Unauthorized bei ${c.url}` }])),
  };
  const webHttp = createWebHttp({
    cockpit: { week: async () => null },
    settings,
    tokens,
    calendars,
    shortcuts: loadShortcuts(),
    captureEnabled: () => tokens.has('capture'),
    backup: createBackup({ dir, cost, now: () => NOW }),
    restart: () => restarts.push('neu'),
    reading: readingRoutes({ store, fetchFeed: fakeFetch({ 'https://atom.test/feed.xml': ATOM }), logger: quiet }),
    oidc: {},
    sessionSecret: SECRET,
    publicUrl: 'https://vault.test',
    allowedSubjects: ['ruben'],
    logger: quiet,
    now: () => NOW,
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
  const device = tokens.create('Rubens iPhone', 'app');
  const t = Math.floor(NOW / 1000);
  const cookie = `vc_session=${createCookieSigner(SECRET).seal({ sub: 'ruben', name: 'Ruben', sid: 's1', gen: 0, iat: t, seen: t, exp: t + 3600 })}`;
  /** Wie die App: Bearer, Formular, `Accept: application/json`. `cookie: true` statt Token: wie der Browser. */
  const call = (path, { method = 'GET', form = null, body = undefined, token = device.token, cookie: withCookie = false, origin = null } = {}) =>
    fetch(base + path, {
      method,
      redirect: 'manual',
      headers: {
        'x-forwarded-host': 'vault.test',
        accept: 'application/json',
        ...(token && !withCookie ? { authorization: `Bearer ${token}` } : {}),
        ...(withCookie ? { cookie } : {}),
        ...(origin ? { origin } : {}),
        ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
      },
      body: form ? new URLSearchParams(form) : body,
    });
  const get = async (path, opts) => {
    const res = await call(path, opts);
    assert.match(res.headers.get('content-type') ?? '', /^application\/json/, path);
    assert.equal(res.headers.get('cache-control'), 'no-store', path);
    return { status: res.status, body: await res.json(), text: null, headers: res.headers };
  };
  const post = async (path, form, opts = {}) => {
    const res = await call(path, { method: 'POST', form, ...opts });
    return { status: res.status, body: await res.json(), headers: res.headers };
  };
  try {
    await run({ call, get, post, settings, tokens, device, store, restarts, dir });
  } finally {
    app.close();
    store.close?.();
    rmSync(dir, { recursive: true, force: true });
  }
}

const noSecrets = (text, what) => {
  for (const s of SECRETS) assert.ok(!text.includes(s), `${what}: enthält ${s}`);
};

/** Ein Stand mit allen Geheimnissen und zwei Kalendern. */
const FULL = {
  tz: 'Europe/Berlin',
  zunder: { url: 'https://zunder.test', token: ZUNDER_TOKEN },
  bridge: { enabled: false, tag: 'brücke' },
  mail: { token: MAIL_TOKEN, senders: ['r@example.dev', '@rubeen.dev'], pollMinutes: 10 },
  tts: { provider: 'elevenlabs', key: TTS_KEY, voice: 'Abc123' },
  episodes: { model: 'opus' },
  calendars: [
    { name: 'Privat', kind: 'caldav', url: 'https://caldav.test/dav/', username: 'ruben', password: CAL_PASSWORD, filter: ['Familie', 'Sport'] },
    { name: 'Arbeit', kind: 'ical', url: CAL_URL },
  ],
  hiddenEvents: ['Blockiert', 'Fokus'],
  session: { idleDays: 14, maxDays: 60 },
};

test('Einstellungen als JSON: nur angemeldet; HTML-Seite und ihre Formulare bleiben beim Cookie', async () => {
  await withSettingsApp(async ({ call, get, tokens }) => {
    const anon = await get('/api/einstellungen', { token: null });
    assert.equal(anon.status, 401);
    assert.equal(anon.body.error, 'unauthorized');
    assert.equal((await get('/api/einstellungen', { token: tokens.create('Raycast', 'search').token })).status, 401);
    assert.equal((await get('/api/einstellungen', { token: 'vct_unbekannt' })).status, 401);
    for (const path of ['/api/einstellungen/tokens', '/api/einstellungen/sicherung', '/api/einstellungen/kurzbefehle']) {
      assert.equal((await get(path, { token: null })).status, 401, path);
    }
    assert.equal((await call('/api/einstellungen/abmelden', { method: 'POST', form: {}, token: null })).status, 401);

    // Geräte-Token gilt nicht für die Seite und ihre Formulare.
    const page = await call('/einstellungen');
    assert.equal(page.status, 303);
    assert.equal(page.headers.get('location'), '/login?next=%2Feinstellungen');
    for (const path of ['/einstellungen', '/einstellungen/tokens', '/einstellungen/tokens/widerrufen', '/einstellungen/sicherung', '/einstellungen/abmelden']) {
      const res = await call(path, { method: 'POST', form: { name: 'x', tz: 'UTC' } });
      assert.equal(res.status, 303, path);
      assert.equal(res.headers.get('location'), '/login?next=%2Feinstellungen', path);
    }
    assert.equal((await get('/api/einstellungen', { method: 'DELETE' })).status, 405);
    assert.equal((await get('/api/einstellungen/abmelden')).status, 405);
  });
});

test('Einstellungen als JSON: Felder, Stände, Kalender, Tokens, Kurzbefehle, Sicherung; nie ein Geheimnis', async () => {
  await withSettingsApp(
    async ({ call, get, settings, device }) => {
      settings.save(FULL);
      const res = await call('/api/einstellungen');
      const text = await res.text();
      noSecrets(text, '/api/einstellungen');
      const body = JSON.parse(text);
      keep('einstellungen', body);

      assert.deepEqual(body.sections.map((s) => s.id), ['kalender', 'zunder', 'bruecke', 'feuer-notiz', 'mail', 'lesestapel', 'embeddings', 'vorlesen', 'sync', 'anzeige', 'anmeldung', 'tokens', 'kurzbefehle', 'sicherung']);
      const section = (id) => body.sections.find((s) => s.id === id);
      const fieldOf = (name) => body.sections.flatMap((s) => s.fields).find((f) => f.name === name);
      assert.deepEqual(section('kalender').state, { text: '1 von 2 nicht erreichbar', tone: 'warn' });
      assert.deepEqual(section('zunder').state, { text: 'eigener Zugang', tone: 'ok' });
      assert.deepEqual(section('sync').state, { text: 'Obsidian Sync (Sidecar)', tone: 'ok' });
      assert.deepEqual(fieldOf('sync.adapter').options.map((o) => o.value), ['', 'obsidian-headless', 'cockpit', 'none']);
      assert.deepEqual(section('bruecke').state, { text: 'aus', tone: 'off' });
      assert.deepEqual(section('mail').state, { text: 'eigener Token', tone: 'ok' });
      assert.deepEqual(section('embeddings').state, { text: 'aus, nur Volltextsuche', tone: 'off' });
      assert.deepEqual(section('vorlesen').state, { text: 'ElevenLabs', tone: 'ok' });
      assert.equal(section('anzeige').state, null);
      assert.equal(section('tokens').fields.length, 0);

      // Werte wie im Formular, Standard als Platzhalter, Geheimnisse nur als „gesetzt“.
      assert.deepEqual(fieldOf('tz'), { name: 'tz', label: 'Zeitzone', hint: null, kind: 'text', value: 'Europe/Berlin', placeholder: 'Europe/Berlin', group: null, collapsed: false });
      assert.deepEqual(fieldOf('zunder.token'), { name: 'zunder.token', label: 'API-Token', hint: 'zt_…', kind: 'secret', value: '', placeholder: 'gesetzt (leer lassen = unverändert)', group: null, collapsed: false, set: true, clear: 'zunder.clear', clearLabel: 'eigenen Zugang löschen' });
      assert.equal(fieldOf('bridge.enabled').value, 'aus');
      assert.deepEqual(fieldOf('bridge.enabled').options.map((o) => o.value), ['', 'an', 'aus']);
      assert.equal(fieldOf('bridge.enabled').options[0].label, 'Standard (an)');
      assert.equal(fieldOf('mail.senders').value, 'r@example.dev, @rubeen.dev');
      assert.equal(fieldOf('mail.pollMinutes').value, '10');
      assert.equal(fieldOf('mail.pollMinutes').group, 'Ordner und Abstand');
      assert.equal(fieldOf('tts.key').set, true);
      assert.equal(fieldOf('tts.provider').value, 'elevenlabs');
      assert.equal(fieldOf('episodes.model').value, 'opus');
      assert.equal(fieldOf('episodes.host').placeholder, 'Abc123', 'Moderation fällt auf die Stimme vom Vorlesen zurück');
      assert.equal(fieldOf('hiddenEvents').value, 'Blockiert, Fokus');
      assert.equal(fieldOf('session.idleDays').value, '14');
      assert.equal(fieldOf('session.maxDays').placeholder, '90');
      assert.ok(section('vorlesen').groups.Folgen);

      // Kalender: Adresse nur als Host, Passwort nur als gesetzt, Prüfung maskiert.
      const [privat, arbeit] = body.calendars.items;
      assert.deepEqual({ ...privat, id: undefined }, { index: 0, id: undefined, name: 'Privat', kind: 'caldav', kindLabel: 'CalDAV', host: 'caldav.test', address: 'https://caldav.test/…', auth: true, username: 'ruben', passwordSet: true, filter: ['Familie', 'Sport'], check: { ok: true, count: 3, text: '✓ 3 Termine diese Woche' } });
      assert.equal(arbeit.index, 1);
      assert.equal(arbeit.auth, false);
      assert.equal(arbeit.passwordSet, false);
      assert.deepEqual(arbeit.filter, []);
      assert.equal(arbeit.check.ok, false);
      assert.match(arbeit.check.error, /^401 Unauthorized bei https:\/\/cal\.test\/…/);
      assert.equal(body.calendars.next, 2);
      assert.equal(body.calendars.max, 20);

      assert.deepEqual(body.tokens.map((t) => [t.name, t.scope, t.scopeLabel, t.current]), [['Rubens iPhone', 'app', 'App', true]]);
      assert.equal(body.tokens[0].id, device.id);
      assert.deepEqual(body.scopes.map((s) => s.value), ['search', 'capture', 'lesestapel', 'app', 'sync']);
      assert.deepEqual(body.shortcuts.map((s) => s.file), ['/kurzbefehle/notiz.shortcut', '/kurzbefehle/sprachmemo.shortcut', '/kurzbefehle/lesestapel.shortcut']);
      assert.equal(body.captureEnabled, false);
      assert.equal(body.backup.empty, false);
      assert.equal(body.backup.minPassphrase, 12);
      assert.ok(body.backup.files.some((f) => f.name === 'cockpit-settings.json' && f.present));
      assert.equal(body.signOutEverywhere.action, '/api/einstellungen/abmelden');

      // Ohne eigene Werte: Standard aus der Umgebung als Platzhalter und Stand, ihre Geheimnisse nicht.
      settings.save({});
      const plain = await call('/api/einstellungen');
      const plainText = await plain.text();
      noSecrets(plainText, 'Standard aus der Umgebung');
      const env = JSON.parse(plainText);
      keep('einstellungen-standard', env);
      assert.deepEqual(env.sections.find((s) => s.id === 'zunder').state, { text: 'aus der Umgebung (https://zunder.env)', tone: 'ok' });
      assert.deepEqual(env.sections.find((s) => s.id === 'vorlesen').state, { text: 'ElevenLabs, Key aus der Umgebung', tone: 'ok' });
      const envField = (name) => env.sections.flatMap((s) => s.fields).find((f) => f.name === name);
      assert.deepEqual([envField('zunder.token').set, envField('zunder.token').clear], [false, null]);
      assert.equal(envField('tts.key').placeholder, 'aus der Umgebung');
      assert.equal(envField('zunder.url').placeholder, 'https://zunder.env');
      assert.equal(envField('hiddenEvents').value, 'Blockiert');
      assert.deepEqual(env.calendars.items, []);
      assert.deepEqual(env.sections.find((s) => s.id === 'kalender').state, { text: 'keine', tone: 'off' });
      assert.equal((await get('/api/einstellungen')).status, 200);
    },
    { defaults: { zunderUrl: 'https://zunder.env', zunderToken: ENV_ZUNDER, elevenlabsKey: ENV_TTS } },
  );
});

test('Einstellungen speichern: einzelne Felder, Geheimnisse bleiben, löschen nur mit Haken, Kalender anlegen und entfernen', async () => {
  await withSettingsApp(async ({ post, settings }) => {
    settings.save(FULL);
    const before = structuredClone(settings.stored());

    // Ohne Felder ändert sich nichts.
    const same = await post('/api/einstellungen', {});
    assert.deepEqual(same.body, { ok: true, message: 'Gespeichert.' });
    keep('einstellungen-gespeichert', same.body);
    assert.deepEqual(settings.stored(), before);

    // Ein Feld: nur das ändert sich, Tokens, Passwörter und Kalenderadressen bleiben.
    assert.equal((await post('/api/einstellungen', { tz: 'UTC', 'zunder.token': '', 'cal.0.password': '' })).status, 200);
    assert.equal(settings.stored().tz, 'UTC');
    assert.deepEqual({ ...settings.stored(), tz: before.tz }, before);

    // Haken „0“ heißt aus, „1“ löscht den eigenen Token.
    await post('/api/einstellungen', { 'zunder.clear': '0', 'mail.clear': '' });
    assert.equal(settings.stored().zunder.token, ZUNDER_TOKEN);
    assert.equal(settings.stored().mail.token, MAIL_TOKEN);
    await post('/api/einstellungen', { 'mail.clear': '1', 'tts.key': 'sk_neu_0000' });
    assert.equal(settings.stored().mail.token, null);
    assert.equal(settings.stored().tts.key, 'sk_neu_0000');

    // Auswahl zurück auf Standard, Liste leeren.
    await post('/api/einstellungen', { 'bridge.enabled': '', hiddenEvents: '', 'mail.senders': 'neu@example.dev' });
    assert.equal(settings.stored().bridge.enabled, null);
    assert.deepEqual(settings.stored().hiddenEvents, []);
    assert.deepEqual(settings.stored().mail.senders, ['neu@example.dev']);

    // Neuer Kalender unter `calendars.next`, ein iCal-Abo ohne „Mit Anmeldung“ verliert Benutzer und Passwort.
    await post('/api/einstellungen', { 'cal.2.name': 'Feiertage', 'cal.2.kind': 'ical', 'cal.2.url': 'webcal://feiertage.test/de.ics' });
    assert.deepEqual(settings.stored().calendars.map((c) => [c.name, c.url]), [['Privat', 'https://caldav.test/dav/'], ['Arbeit', CAL_URL], ['Feiertage', 'https://feiertage.test/de.ics']]);
    await post('/api/einstellungen', { 'cal.1.auth': '1', 'cal.1.username': 'r', 'cal.1.password': 'pw' });
    assert.deepEqual([settings.stored().calendars[1].username, settings.stored().calendars[1].password], ['r', 'pw']);
    await post('/api/einstellungen', { 'cal.1.auth': '0' });
    assert.deepEqual([settings.stored().calendars[1].username, settings.stored().calendars[1].password], [null, null]);
    await post('/api/einstellungen', { 'cal.0.remove': '1' });
    assert.deepEqual(settings.stored().calendars.map((c) => c.name), ['Arbeit', 'Feiertage']);
    assert.equal(settings.stored().calendars[0].url, CAL_URL);
  });
});

test('Einstellungen speichern: Fehler mit Feld, nichts gespeichert; mit Sitzung nur mit CSRF und von dieser Seite', async () => {
  await withSettingsApp(async ({ call, get, post, settings }) => {
    settings.save(FULL);
    const before = structuredClone(settings.stored());
    const cases = [
      [{ tz: 'Mars/Olympus' }, 'tz', /Unbekannte Zeitzone/],
      [{ 'zunder.url': 'ftp://zunder.test' }, 'zunder.url', /https:\/\//],
      [{ 'mail.pollMinutes': '0' }, 'mail.pollMinutes', /zwischen 1 und 1440/],
      [{ 'mail.senders': 'kein absender' }, 'mail.senders', /Absender/],
      [{ 'tts.voice': 'nicht gültig!' }, 'tts.voice', /Voice-ID/],
      [{ 'session.idleDays': '30', 'session.maxDays': '7' }, 'session.maxDays', /längste Sitzung/],
      [{ 'cal.1.url': 'kaputt' }, 'cal.1.url', /keine gültige Adresse/],
      [{ 'cal.1.name': 'Privat' }, 'cal.1.name', /doppelt/],
      [{ 'cal.2.name': 'Neu' }, 'cal.2.url', /braucht eine Adresse/],
      [{ 'cal.0.remove': '1', 'cal.1.url': 'kaputt' }, 'cal.1.url', /keine gültige Adresse/],
      [{ 'zunder.tokn': 'x' }, 'zunder.tokn', /Unbekanntes Feld/],
    ];
    for (const [form, field, message] of cases) {
      const r = await post('/api/einstellungen', form);
      assert.equal(r.status, 400, field);
      assert.equal(r.body.error, 'invalid', field);
      assert.equal(r.body.field, field);
      assert.match(r.body.message, message, field);
    }
    keep('einstellungen-fehler', (await post('/api/einstellungen', { tz: 'Mars/Olympus' })).body);
    assert.deepEqual(settings.stored(), before);

    // Browser-Sitzung: CSRF wie die Seite, fremde Herkunft nie.
    const noCsrf = await post('/api/einstellungen', { tz: 'UTC' }, { cookie: true });
    assert.equal(noCsrf.status, 403);
    assert.equal(noCsrf.body.error, 'csrf');
    const { csrf } = (await get('/api/sitzung', { cookie: true })).body;
    assert.equal((await post('/api/einstellungen', { tz: 'UTC', csrf }, { cookie: true, origin: 'https://evil.test' })).status, 403);
    assert.equal(settings.stored().tz, 'Europe/Berlin');
    assert.equal((await post('/api/einstellungen', { tz: 'UTC', csrf }, { cookie: true })).status, 200);
    assert.equal(settings.stored().tz, 'UTC');
    // Geräte-Token: kein CSRF, aber auch keine fremde Herkunft.
    assert.equal((await call('/api/einstellungen', { method: 'POST', form: { tz: 'UTC' }, origin: 'https://evil.test' })).status, 403);
  });
});

test('Zusammengeführtes Formular: der gespeicherte Stand ergibt sich selbst, Haken aus heißt weglassen', () => {
  const settings = createSettingsStore({ logger: quiet });
  settings.save(FULL);
  const f = formOfSettings(settings.stored());
  assert.equal(f.get('zunder.token'), null, 'Geheimnisse nie im Formular');
  assert.equal(f.get('cal.0.password'), null);
  assert.equal(f.get('cal.1.url'), null);
  assert.equal(f.has('hiddenEvents'), false);
  assert.equal(f.get('cal.0.auth'), '1');
  assert.equal(f.has('cal.1.auth'), false);
  const merged = mergeSettingsForm(settings.stored(), new URLSearchParams({ 'cal.0.auth': 'false', tz: 'UTC', csrf: 'x' }));
  assert.equal(merged.has('cal.0.auth'), false);
  assert.equal(merged.get('tz'), 'UTC');
  assert.equal(merged.has('csrf'), false);
  assert.throws(() => mergeSettingsForm(settings.stored(), new URLSearchParams({ 'cal.x.name': 'a' })), (err) => err.field === 'cal.x.name');
});

test('Zusammengeführtes Formular: Ingest-Einstellungen überstehen das Speichern eines anderen Felds', () => {
  const settings = createSettingsStore({ logger: quiet });
  settings.save({ ...FULL, ingest: { nightly: false, hour: 5, model: 'opus', limit: 7 } });
  const f = formOfSettings(settings.stored());
  assert.equal(f.get('ingest.nightly'), 'aus');
  assert.equal(f.get('ingest.hour'), '5');
  const merged = mergeSettingsForm(settings.stored(), new URLSearchParams({ tz: 'UTC' }));
  assert.equal(merged.get('ingest.model'), 'opus');
  assert.equal(merged.get('ingest.limit'), '7');
  assert.equal(mergeSettingsForm(settings.stored(), new URLSearchParams({ 'ingest.hour': '6' })).get('ingest.hour'), '6');
});

test('Überall abmelden als JSON: Browser-Sitzungen enden, der Geräte-Token gilt weiter', async () => {
  await withSettingsApp(async ({ get, post, settings }) => {
    const { csrf } = (await get('/api/sitzung', { cookie: true })).body;
    assert.equal((await post('/api/einstellungen/abmelden', {}, { cookie: true })).status, 403);
    const r = await post('/api/einstellungen/abmelden', { csrf }, { cookie: true });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('set-cookie'), /vc_session=;/);
    assert.equal(settings.stored().session.generation, 1);
    assert.equal((await get('/api/einstellungen', { cookie: true })).status, 401);

    const app = await post('/api/einstellungen/abmelden', {});
    assert.equal(app.status, 200);
    assert.equal(app.headers.get('set-cookie'), null);
    assert.match(app.body.message, /^Überall abgemeldet/);
    keep('einstellungen-abmelden', app.body);
    assert.equal(settings.stored().session.generation, 2);
    assert.equal((await get('/api/einstellungen')).status, 200);
  });
});

test('API-Tokens als JSON: Liste ohne Hash, Klartext nur beim Anlegen, Fehler mit Feld, Widerruf auch des eigenen', async () => {
  await withSettingsApp(async ({ call, get, post, tokens, device }) => {
    const list = await get('/api/einstellungen/tokens');
    keep('tokens', list.body);
    assert.deepEqual(list.body.tokens, [{ id: device.id, name: 'Rubens iPhone', scope: 'app', scopeLabel: 'App', createdAt: '2026-10-25T08:30:00.000Z', current: true }]);
    assert.equal(list.body.scopes.length, 5);

    const created = await post('/api/einstellungen/tokens', { name: 'Raycast', scope: 'search' });
    assert.equal(created.status, 200);
    keep('token-neu', { ...created.body, token: { ...created.body.token, token: 'vct_beispiel_nur_einmal_sichtbar' } });
    assert.match(created.body.token.token, /^vct_/);
    assert.deepEqual({ ...created.body.token, token: undefined, id: undefined }, { token: undefined, id: undefined, name: 'Raycast', scope: 'search', scopeLabel: 'Suche', createdAt: '2026-10-25T08:30:00.000Z' });
    assert.match(created.body.message, /^Suche-Token „Raycast“ angelegt/);
    assert.equal(created.body.tokens.length, 2);
    assert.ok(tokens.verify(created.body.token.token, 'search'));
    // Der Klartext steht danach nirgends mehr.
    const again = await (await call('/api/einstellungen/tokens')).text();
    assert.ok(!again.includes(created.body.token.token));
    assert.ok(!(await (await call('/api/einstellungen')).text()).includes(created.body.token.token));
    assert.ok(!again.includes('hash'));

    // Standard-Recht wie das Formular: Suche.
    assert.equal((await post('/api/einstellungen/tokens', { name: 'Ohne Recht' })).body.token.scope, 'search');
    const noName = await post('/api/einstellungen/tokens', { name: '  ', scope: 'capture' });
    assert.deepEqual([noName.status, noName.body.error, noName.body.field], [400, 'invalid', 'name']);
    keep('token-fehler', noName.body);
    const badScope = await post('/api/einstellungen/tokens', { name: 'x', scope: 'admin' });
    assert.deepEqual([badScope.status, badScope.body.field], [400, 'scope']);

    const unknown = await post('/api/einstellungen/tokens/widerrufen', { id: 'gibts-nicht' });
    assert.deepEqual([unknown.status, unknown.body.error], [404, 'not_found']);
    const revoked = await post('/api/einstellungen/tokens/widerrufen', { id: created.body.token.id });
    assert.equal(revoked.status, 200);
    keep('token-widerrufen', revoked.body);
    assert.deepEqual([revoked.body.ok, revoked.body.self, revoked.body.message], [true, false, 'Token widerrufen.']);
    assert.equal(tokens.verify(created.body.token.token, 'search'), false);

    // Mit Sitzung nur mit CSRF.
    assert.equal((await post('/api/einstellungen/tokens', { name: 'Browser' }, { cookie: true })).status, 403);

    const self = await post('/api/einstellungen/tokens/widerrufen', { id: device.id });
    assert.deepEqual([self.status, self.body.self], [200, true]);
    assert.equal((await get('/api/einstellungen/tokens')).status, 401);
  });
});

/** Datei-Upload wie das Formular. */
const upload = (fields, file) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  if (file !== undefined) fd.append('datei', new Blob([file], { type: 'application/json' }), 'cockpit-sicherung.json');
  return fd;
};

test('Sicherung als JSON: Stand, Datei herunterladen mit Geräte-Token, Fehler mit Feld', async () => {
  await withSettingsApp(async ({ call, get, post, settings }) => {
    const status = await get('/api/einstellungen/sicherung');
    assert.equal(status.body.empty, false, 'der Geräte-Token zählt als eingerichtet');
    assert.deepEqual(status.body.files.map((f) => [f.name, f.present]), [['cockpit-settings.json', false], ['api-tokens.json', true], ['capture-state.json', false], ['session-secret', false], ['credentials-key', false], ['lesestapel.db', false]]);
    keep('sicherung', status.body);

    settings.save(FULL);
    const short = await post('/api/einstellungen/sicherung', { passphrase: SHORT, passphrase2: SHORT });
    assert.deepEqual([short.status, short.body.error, short.body.field], [400, 'invalid', 'passphrase']);
    assert.match(short.body.message, /mindestens 12/);
    keep('sicherung-fehler', short.body);
    const mismatch = await post('/api/einstellungen/sicherung', { passphrase: PASS, passphrase2: OTHER });
    assert.deepEqual([mismatch.status, mismatch.body.field], [400, 'passphrase2']);
    assert.match(mismatch.body.message, /stimmen nicht überein/);
    assert.equal((await post('/api/einstellungen/sicherung', { passphrase: PASS, passphrase2: PASS }, { cookie: true })).status, 403);

    const res = await call('/api/einstellungen/sicherung', { method: 'POST', form: { passphrase: PASS, passphrase2: PASS } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(res.headers.get('content-disposition'), 'attachment; filename="cockpit-sicherung-2026-10-25.json"');
    const text = await res.text();
    noSecrets(text, 'Sicherung');
    const inner = await open(text, PASS);
    assert.deepEqual(Object.keys(inner.files).sort(), ['api-tokens.json', 'cockpit-settings.json']);
  });
});

test('Wiederherstellen als JSON: Datei mit Geräte-Token hochladen, ersetzen nur mit Haken, danach Neustart', async () => {
  let file;
  await withSettingsApp(async ({ call, settings }) => {
    settings.save({ tz: 'UTC', zunder: { url: 'https://zunder.test', token: ZUNDER_TOKEN } });
    file = await (await call('/api/einstellungen/sicherung', { method: 'POST', form: { passphrase: PASS, passphrase2: PASS } })).text();
  });
  await withSettingsApp(async ({ call, settings, restarts }) => {
    const route = '/api/einstellungen/sicherung/wiederherstellen';
    const send = async (fields, data, opts = {}) => {
      const res = await call(route, { method: 'POST', body: upload(fields, data), ...opts });
      return { status: res.status, body: await res.json(), headers: res.headers };
    };
    const wrong = await send({ passphrase: `${PASS} x`, ersetzen: '1' }, file);
    assert.deepEqual([wrong.status, wrong.body.error], [400, 'invalid']);
    assert.match(wrong.body.message, /Passphrase falsch/);
    const none = await send({ passphrase: PASS });
    assert.match(none.body.message, /Sicherungsdatei wählen/);
    // Der Geräte-Token macht das Cockpit „eingerichtet“: ohne Haken nichts.
    const keepIt = await send({ passphrase: PASS }, file);
    assert.equal(keepIt.status, 400);
    assert.match(keepIt.body.message, /Vorhandenes ersetzen/);
    const urlencoded = await call(route, { method: 'POST', form: { passphrase: PASS } });
    assert.equal(urlencoded.status, 415);
    assert.equal((await send({ passphrase: PASS, ersetzen: '1' }, file, { cookie: true })).status, 403);
    assert.equal(restarts.length, 0);

    const ok = await send({ passphrase: PASS, ersetzen: '1' }, file);
    assert.equal(ok.status, 200);
    keep('sicherung-wiederhergestellt', ok.body);
    assert.deepEqual({ ...ok.body, message: undefined }, { ok: true, message: undefined, title: 'Sicherung wiederhergestellt', createdAt: '2026-10-25T08:30:00.000Z', files: ['cockpit-settings.json', 'api-tokens.json'], skipped: [], restart: true, relogin: false, tokensReplaced: true });
    assert.match(ok.body.message, /2 Dateien aus der Sicherung/);
    assert.equal(ok.headers.get('set-cookie'), null);
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(restarts, ['neu']);
    assert.equal(settings.stored().tz, null, 'der neue Stand gilt erst nach dem Neustart');
  });
});

test('Kurzbefehle: Liste als JSON, Dateien mit Geräte-Token; abgelehnter Token 401, ohne Anmeldung zum Login', async () => {
  await withSettingsApp(async ({ call, get, tokens }) => {
    const list = await get('/api/einstellungen/kurzbefehle');
    keep('kurzbefehle', list.body);
    assert.deepEqual(list.body.shortcuts.map((s) => [s.slug, s.file]), [['notiz', '/kurzbefehle/notiz.shortcut'], ['sprachmemo', '/kurzbefehle/sprachmemo.shortcut'], ['lesestapel', '/kurzbefehle/lesestapel.shortcut']]);
    assert.equal(list.body.shortcuts[0].title, 'Notiz ins Cockpit');
    assert.ok(list.body.shortcuts[2].text.includes('Lesestapel'));
    assert.equal(list.body.captureEnabled, false);
    tokens.create('Kurzbefehl', 'capture');
    assert.equal((await get('/api/einstellungen/kurzbefehle')).body.captureEnabled, true);

    const file = await call('/kurzbefehle/notiz.shortcut');
    assert.equal(file.status, 200);
    assert.equal(file.headers.get('content-type'), 'application/octet-stream');
    assert.match(file.headers.get('content-disposition'), /^attachment; filename="notiz\.shortcut"/);
    assert.deepEqual(Buffer.from(await file.arrayBuffer()), loadShortcuts()[0].data);
    assert.equal((await call('/kurzbefehle/notiz.shortcut', { token: 'vct_falsch' })).status, 401);
    assert.equal((await call('/kurzbefehle/notiz.shortcut', { token: tokens.create('Suche', 'search').token })).status, 401);
    const anon = await call('/kurzbefehle/notiz.shortcut', { token: null });
    assert.equal(anon.status, 303);
    assert.equal(anon.headers.get('location'), '/login?next=%2Feinstellungen');
  });
});

test('Feeds als JSON: Gruppen mit Feeds, ohne Gruppe, Zustand; Aktionen und OPML mit Geräte-Token', async () => {
  await withSettingsApp(async ({ call, get, post, store }) => {
    assert.equal((await get('/api/lesen/feeds', { token: null })).status, 401);
    const empty = await get('/api/lesen/feeds');
    assert.deepEqual(empty.body.groups, []);
    assert.deepEqual(empty.body.ungrouped, []);
    assert.deepEqual(empty.body.limits, { minInterval: 5, maxInterval: 1440, defaultInterval: 30, maxOpmlBytes: 2 * 1024 * 1024 });
    assert.deepEqual(empty.body.bulk, { action: '/aktion/lesen/feeds/auswahl', actions: ['gruppe', 'pausieren', 'fortsetzen', 'stapel-an', 'stapel-aus', 'abstand', 'entfernen'], newGroup: 'neu' });
    keep('lesen-feeds-leer', empty.body);

    const group = await post('/aktion/lesen/gruppe/anlegen', { name: 'Technik' });
    assert.deepEqual(group.body, { ok: true, message: 'Gruppe angelegt: Technik' });
    keep('aktion-lesen-gruppe-anlegen', group.body);
    await post('/aktion/lesen/gruppe/anlegen', { name: 'Kultur' });
    const [technik, kultur] = store.listGroups();
    const sub = await post('/aktion/lesen/feed/abonnieren', { url: 'https://atom.test/feed.xml', gruppe: technik.id });
    assert.deepEqual(sub.body, { ok: true, message: 'Abonniert: Atom-Seite' });
    keep('aktion-lesen-feed-abonnieren', sub.body);
    const gone = await post('/aktion/lesen/feed/abonnieren', { url: 'https://leer.test/feed' });
    assert.equal(gone.status, 502);
    assert.equal(gone.body.error, 'action_failed');

    // OPML-Import als Datei mit Geräte-Token: Ordner werden Gruppen.
    const fd = new FormData();
    fd.append('datei', new Blob([OPML], { type: 'text/x-opml' }), 'feeds.opml');
    const imp = await call('/aktion/lesen/feeds/import', { method: 'POST', body: fd });
    assert.equal(imp.status, 200);
    const impBody = await imp.json();
    assert.deepEqual(impBody, { ok: true, message: '1 Feed importiert, 1 schon abonniert' });
    keep('aktion-lesen-feeds-import', impBody);

    const atom = store.listFeeds().find((f) => f.url === 'https://atom.test/feed.xml');
    const blog = store.listFeeds().find((f) => f.url === 'https://blog.test/feed');
    const change = await post('/aktion/lesen/feed/aendern', { id: atom.id, pausiert: '1', stapel: '1', filter: 'swift, ios', intervall: '2', gruppe: '' });
    assert.deepEqual(change.body, { ok: true, message: 'Gespeichert: Atom-Seite' });
    keep('aktion-lesen-feed-aendern', change.body);
    await post('/aktion/lesen/gruppe/aendern', { id: technik.id, name: 'Technik', stapel: '1' });
    store.updateFeed(blog.id, { last_fetch_at: new Date(Date.now() - 5 * 60_000).toISOString(), error_count: 2, last_error: 'HTTP 500 bei https://blog.test/feed?token=geheimer-pfad-4711' });
    // Ein Feed, der läuft, mit Icon und einem neuen Eintrag im Eingang.
    const feuilleton = store.addFeed({ url: 'https://kultur.test/rss', title: 'Feuilleton', site_url: 'https://kultur.test/', icon: 'data:image/png;base64,iVBORw0KGgo=', interval_minutes: 60, group_id: kultur.id, last_fetch_at: new Date(Date.now() - 3 * 60_000).toISOString() }).feed;
    store.addDocument({ url: 'https://kultur.test/1', title: 'Neu im Feuilleton', origin: `feed:${feuilleton.id}` });
    const moved = await post('/aktion/lesen/gruppe/verschieben', { id: kultur.id, richtung: 'hoch' });
    assert.deepEqual(moved.body, { ok: true, message: 'Verschoben: Kultur' });
    assert.equal((await post('/aktion/lesen/gruppe/verschieben', { id: kultur.id, richtung: 'seitwärts' })).status, 400);

    const res = await call('/api/lesen/feeds');
    const text = await res.text();
    noSecrets(text, '/api/lesen/feeds');
    const body = JSON.parse(text);
    keep('lesen-feeds', body);
    assert.deepEqual(body.groups.map((g) => [g.name, g.position, g.canMoveUp, g.canMoveDown, g.toStack, g.flags, g.inbox, g.feeds.length]), [
      ['Kultur', 0, false, true, false, null, 1, 1],
      ['Technik', 1, true, false, true, 'direkt auf den Stapel', 0, 1],
    ]);
    assert.equal(body.total, 3);
    const [k] = body.groups[0].feeds;
    assert.deepEqual([k.state, k.icon, k.siteUrl, k.meta], ['ok', 'data:image/png;base64,iVBORw0KGgo=', 'https://kultur.test/', 'kultur.test · alle 60 min']);
    assert.match(k.status, /^abgerufen \d\d\.\d\d\. \d\d:\d\d · vor 3 min$/);
    const [b] = body.groups[1].feeds;
    assert.equal(b.id, blog.id);
    assert.deepEqual([b.state, b.groupToStack, b.errorCount], ['error', true, 2]);
    assert.equal(b.status, 'Fehler (2×): HTTP 500 bei https://blog.test/…');
    assert.equal(b.meta, 'blog.test · alle 30 min · direkt auf den Stapel (Gruppe)');
    const [a] = body.ungrouped;
    assert.deepEqual(
      { ...a, nextFetchAt: undefined },
      { id: atom.id, url: 'https://atom.test/feed.xml', host: 'atom.test', siteUrl: 'https://atom.test/', title: 'Atom-Seite', icon: null, letter: 'A', paused: true, toStack: true, keywordFilter: 'swift, ios', hasAuth: false, intervalMinutes: 5, groupId: null, groupPaused: false, groupToStack: false, lastFetchAt: null, nextFetchAt: undefined, errorCount: 0, lastError: null, state: 'paused', status: 'pausiert', meta: 'atom.test · alle 5 min · direkt auf den Stapel · nur „swift, ios“' },
    );

    // OPML-Export mit Geräte-Token; die Seite `/lesen/feeds.opml` bleibt beim Cookie.
    const opml = await call('/api/lesen/feeds.opml');
    assert.equal(opml.status, 200);
    assert.equal(opml.headers.get('content-disposition'), 'attachment; filename="feeds.opml"');
    assert.match(await opml.text(), /xmlUrl="https:\/\/blog\.test\/feed"/);
    assert.equal((await call('/lesen/feeds.opml')).status, 303);
    assert.equal((await call('/api/lesen/feeds.opml', { token: null })).status, 401);

    // Sammeln (VCP-110) wie die App: wiederholte `feed`-Felder, Entfernen nur mit `bestaetigt`.
    const picked = await post(body.bulk.action, [['tun', 'pausieren'], ['feed', atom.id], ['feed', blog.id], ['feed', atom.id]]);
    assert.deepEqual(picked.body, { ok: true, message: '2 Feeds pausiert' });
    keep('aktion-lesen-feeds-auswahl', picked.body);
    assert.equal(store.getFeed(blog.id).paused, true);
    const asks = await post(body.bulk.action, [['tun', 'entfernen'], ['feed', blog.id]]);
    assert.equal(asks.status, 200);
    assert.equal(asks.body.redirect, `/lesen/feeds/entfernen?feed=${blog.id}`);
    assert.ok(store.getFeed(blog.id), 'ohne Bestätigung bleibt der Feed');
    await post(body.bulk.action, [['tun', 'fortsetzen'], ['feed', blog.id]]);

    const del = await post('/aktion/lesen/gruppe/entfernen', { id: technik.id });
    assert.deepEqual(del.body, { ok: true, message: 'Gruppe gelöscht: Technik. Ihre Feeds bleiben, jetzt ohne Gruppe.' });
    const rm = await post('/aktion/lesen/feed/entfernen', { id: atom.id });
    assert.equal(rm.status, 200);
    assert.deepEqual((await get('/api/lesen/feeds')).body.ungrouped.map((f) => f.title), ['Blog']);
    const missing = await post('/aktion/lesen/feed/entfernen', { id: atom.id });
    assert.deepEqual([missing.status, missing.body.error], [404, 'action_failed']);
  });
});
