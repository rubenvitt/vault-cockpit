import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { maskSecrets } from '../src/health/mask.js';
import { createHealth, createRunLog } from '../src/health/collect.js';
import { renderHealth, healthAlert, when } from '../src/web/health-render.js';
import { createApp } from '../src/http/app.js';
import { createZunderClient } from '../src/capture/zunder.js';
import { createMailCapture } from '../src/capture/mail.js';
import { createZunderBridge } from '../src/capture/bridge.js';
import { createCalendarSources } from '../src/cockpit/calendars.js';
import { createSettingsStore } from '../src/cockpit/settings.js';
import { createIndexManager } from '../src/vault/manager.js';
import { createWebHttp } from '../src/web/http.js';
import { createCookieSigner } from '../src/web/session.js';

const quiet = { info() {}, warn() {}, error() {} };
const NOW = Date.parse('2026-10-18T12:00:00Z');

// --- Maskieren ---------------------------------------------------------------

test('maskSecrets: Adressen schrumpfen auf den Host, Tokens und Passwörter verschwinden', () => {
  const m = (s, o) => maskSecrets(s, o);
  assert.equal(m('iCal-Abruf https://user:geheim@cal.example/private-abc123/basic.ics fehlgeschlagen.'), 'iCal-Abruf https://cal.example/… fehlgeschlagen.');
  assert.equal(m('GET https://zunder.test/'), 'GET https://zunder.test');
  assert.equal(m('webcal://p01-caldav.icloud.com/published/2/MTIzNDU2Nzg5'), 'webcal://p01-caldav.icloud.com/…');
  assert.equal(m('Authorization: Bearer fmu1-abcdef-1234567890'), 'Authorization: Bearer •••');
  assert.equal(m('Fehler bei token=abc123def&x=1'), 'Fehler bei token=•••&x=1');
  assert.equal(m('password: hunter2 falsch'), 'password: ••• falsch');
  assert.equal(m('Zunder sagt: zt_9f8e7d6c5b4a ungültig'), 'Zunder sagt: ••• ungültig');
  assert.equal(m('Schlüssel 3f1c9a0b7e2d4c6f8a1b3c5d7e9f0a2b4c6d8e0f'), 'Schlüssel •••');
  assert.equal(m('eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJydWJlbiJ9.c2lnbmF0dXJl'), '•••');
  // Bekannte Geheimnisse aus den Einstellungen, auch ohne Präfix.
  assert.equal(m('Server spiegelt mein-geheimes-wort zurück', { secrets: ['mein-geheimes-wort', 'kurz', null] }), 'Server spiegelt ••• zurück');
  // Pfade und gewöhnliche Wörter bleiben lesbar.
  assert.equal(m('projects/Vault-Cockpit/Architektur-Entscheidungen-2026-10.md: Notiz gerade geändert'), 'projects/Vault-Cockpit/Architektur-Entscheidungen-2026-10.md: Notiz gerade geändert');
  assert.equal(m('Zunder antwortet mit HTTP 401'), 'Zunder antwortet mit HTTP 401');
  assert.equal(m('x'.repeat(500), { max: 20 }).length, 20);
  assert.equal(m(null), null);
});

test('createRunLog: letzter Erfolg, letzter Fehler, failing nur bis zum nächsten Erfolg', () => {
  let t = NOW;
  const log = createRunLog({ now: () => t });
  assert.deepEqual(log.snapshot(), { lastOkAt: null, lastErrorAt: null, lastError: null, failing: false });
  log.fail(new Error('HTTP 401'));
  assert.equal(log.snapshot().failing, true);
  t += 60_000;
  log.ok();
  const s = log.snapshot();
  assert.equal(s.failing, false);
  assert.equal(s.lastError, 'HTTP 401', 'der letzte Fehler bleibt sichtbar');
  assert.equal(s.lastOkAt, new Date(NOW + 60_000).toISOString());
  log.reset();
  assert.equal(log.snapshot().lastError, null);
});

// --- Quellen merken sich ihren letzten Lauf ----------------------------------

test('Zunder-Client meldet Zugang an den Merkzettel: HTTP-Fehler zählt, fachliche Ablehnung nicht', async () => {
  const log = createRunLog();
  let reply = () => new Response('nein', { status: 401 });
  const client = createZunderClient({ url: 'https://zunder.test', token: 'zt_x', monitor: log, fetch: async () => reply() });
  await assert.rejects(client.listStructure(), /HTTP 401/);
  assert.equal(log.snapshot().failing, true);
  assert.match(log.snapshot().lastError, /HTTP 401/);

  reply = () => Response.json({ jsonrpc: '2.0', id: 1, result: { isError: true, content: [{ text: 'Aufgabe nicht gefunden' }] } });
  await assert.rejects(client.getTask('x'), /lehnt ab/);
  assert.equal(log.snapshot().failing, false, 'Zunder hat den Token angenommen');

  reply = () => {
    throw new TypeError('fetch failed');
  };
  await assert.rejects(client.listStructure());
  assert.equal(log.snapshot().failing, true);
});

/** JMAP-Attrappe: Ordner „Vault“ und „Archive“, wahlweise ein kaputter Server. */
function fakeJmap(emails, { down = () => false } = {}) {
  return async (url, init) => {
    if (down()) return new Response('', { status: 503 });
    if (url.endsWith('/session')) return Response.json({ apiUrl: 'https://jmap.test/api', primaryAccounts: { 'urn:ietf:params:jmap:mail': 'acc1' } });
    const { methodCalls } = JSON.parse(init.body);
    return Response.json({
      methodResponses: methodCalls.map(([name, args, tag]) => {
        if (name === 'Mailbox/get') return [name, { list: [{ id: 'v', name: 'Vault' }, { id: 'a', name: 'Archive' }] }, tag];
        if (name === 'Email/query') return [name, { ids: emails.map((e) => e.id) }, tag];
        if (name === 'Email/get') return [name, { list: emails }, tag];
        return [name, { updated: args.update }, tag];
      }),
    });
  };
}
const email = (id, subject) => ({ id, messageId: [id], from: [{ email: 'r@x.test' }], subject, textBody: [], bodyValues: {} });

test('Mail-Abruf: Zustand mit letztem Erfolg und letztem Fehler, liegengebliebene Mails zählen als Fehler', async () => {
  let down = false;
  const make = (router, emails = []) =>
    createMailCapture({ token: 't', sessionUrl: 'https://jmap.test/session', allowedSenders: ['r@x.test'], router, fetch: fakeJmap(emails, { down: () => down }), logger: quiet });

  const capture = make({ route: async () => {} });
  assert.equal(capture.status().state, 'idle');
  await capture.runOnce();
  assert.equal(capture.status().state, 'ok');
  assert.ok(capture.status().lastOkAt);

  down = true;
  await capture.runOnce();
  const s = capture.status();
  assert.equal(s.state, 'error');
  assert.match(s.lastError, /HTTP 503/);
  assert.ok(s.lastErrorAt);
  assert.ok(s.lastOkAt, 'der letzte Erfolg bleibt');

  down = false;
  const stuck = make({ route: async () => { throw new Error('Zunder antwortet mit HTTP 502'); } }, [email('m1', '! Aufgabe')]);
  await stuck.runOnce();
  assert.equal(stuck.status().state, 'error');
  assert.match(stuck.status().lastError, /1 Mail bleibt liegen: Zunder antwortet mit HTTP 502/);
});

test('Zunder-Brücke merkt sich je Richtung den letzten Lauf und Fehler', async () => {
  const notes = {
    'a.md': { content: '- [ ] Angebot #zunder\n', class: 'core', sensitivity: null, tags: ['zunder'] },
    'b.md': { content: '- [ ] Alt [↗ Zunder](https://zunder.test/#/aufgabe/t9)\n', class: 'core', sensitivity: null, tags: [] },
  };
  const index = { getNote: (p) => notes[p], pathsWithTag: () => ['a.md'], pathsContaining: () => ['b.md'] };
  const store = new Map();
  const state = { get: (k) => store.get(k), set: (k, v) => store.set(k, v), delete: (k) => store.delete(k), keys: (p) => [...store.keys()].filter((k) => k.startsWith(p)) };
  let broken = true;
  const zunder = {
    taskUrl: (id) => `https://zunder.test/#/aufgabe/${id}`,
    createTask: async () => {
      if (broken) throw new Error('Zunder antwortet mit HTTP 500');
      return { id: 't1', ref: null, url: 'https://zunder.test/#/aufgabe/t1' };
    },
    getTask: async () => {
      if (broken) throw new Error('fetch failed');
      return { status: 'open' };
    },
  };
  const editor = { replace: () => {} };
  let t = NOW;
  const bridge = createZunderBridge({ index, editor, zunder, state, logger: quiet, now: () => t });
  assert.deepEqual(bridge.status().transfer, { okAt: null, errorAt: null, error: null, failing: false });

  await bridge.scanAll();
  await bridge.syncBack();
  let s = bridge.status();
  assert.equal(s.transfer.failing, true);
  assert.match(s.transfer.error, /a\.md: Zunder antwortet mit HTTP 500/);
  assert.equal(s.sync.failing, true);
  assert.match(s.sync.error, /Status von t9 nicht abrufbar: fetch failed/);
  assert.equal(s.sync.errorAt, new Date(NOW).toISOString());

  broken = false;
  t += 60_000;
  await bridge.scanAll();
  await bridge.syncBack();
  s = bridge.status();
  assert.equal(s.transfer.failing, false);
  assert.equal(s.sync.failing, false);
  assert.equal(s.sync.okAt, new Date(NOW + 60_000).toISOString());
  assert.match(s.sync.error, /fetch failed/, 'der letzte Fehler bleibt stehen');
});

test('Kalender merken sich den letzten Abruf je Kalender', async () => {
  const settings = createSettingsStore({ logger: quiet });
  settings.save({
    calendars: [
      { name: 'Privat', kind: 'ical', url: 'https://cal.test/geheim-123/privat.ics' },
      { name: 'Arbeit', kind: 'ical', url: 'https://cal.test/arbeit.ics' },
    ],
  });
  const ics = 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n';
  const fetch = async (url) => (String(url).includes('arbeit') ? new Response('', { status: 403 }) : new Response(ics));
  const sources = createCalendarSources({ settings, fetch, now: () => NOW });
  assert.deepEqual(sources.status().map((c) => c.lastOkAt), [null, null]);
  await sources.events(new Date(NOW), new Date(NOW + 86_400_000));
  const [privat, arbeit] = sources.status();
  assert.equal(privat.failing, false);
  assert.equal(privat.count, 0);
  assert.equal(privat.lastOkAt, new Date(NOW).toISOString());
  assert.equal(arbeit.failing, true);
  assert.match(arbeit.lastError, /HTTP 403/);
});

test('Index-Manager merkt sich einen fehlgeschlagenen Aufbau', () => {
  const root = mkdtempSync(join(tmpdir(), 'vault-health-'));
  const index = createIndexManager({ vaultPath: root, dbPath: ':memory:', logger: quiet });
  try {
    assert.equal(index.lastError(), null);
    rmSync(root, { recursive: true, force: true });
    assert.throws(() => index.rebuild());
    assert.equal(index.lastError().failing, true);
    assert.ok(index.lastError().message);
  } finally {
    index.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

// --- Zusammenstellung --------------------------------------------------------

/** Alle Dienste als Attrappen; `over` überschreibt einzelne. */
function setup(over = {}) {
  const settings = createSettingsStore({
    defaults: { zunderUrl: 'https://zunder.test', zunderToken: 'zt_geheim123456', mailToken: 'fmu1-geheim-mail', mailSenders: ['r@x.test'], embedUrl: 'http://ollama:11434' },
    logger: quiet,
  });
  const access = createRunLog({ now: () => NOW });
  access.ok();
  const iso = (ms) => new Date(ms).toISOString();
  const parts = {
    settings,
    sync: { status: () => ({ adapter: 'obsidian-headless', state: 'synced', watching: true, lastSyncAt: iso(NOW - 60_000), heartbeatAt: iso(NOW - 5_000), lastError: null }) },
    index: { stats: () => ({ total: 120, byClass: { core: 100 } }), lastBuiltAt: () => NOW - 600_000, lastChangedAt: () => NOW - 30_000, lastError: () => null, embeddablePaths: () => new Array(100) },
    semantic: () => ({ status: () => ({ model: 'bge-m3', state: 'idle', notes: 100, chunks: 400, pending: 0, lastRunAt: iso(NOW - 120_000), lastError: null, lastErrorAt: null }) }),
    mail: () => ({ state: 'ok', mailbox: 'Vault', lastPollAt: iso(NOW - 60_000), lastOkAt: iso(NOW - 60_000), lastProcessed: 2, lastError: null, lastErrorAt: null }),
    bridge: {
      enabled: () => true,
      active: () => true,
      tag: 'zunder',
      status: () => ({ transfer: { okAt: iso(NOW - 60_000), errorAt: null, error: null, failing: false }, sync: { okAt: iso(NOW - 60_000), errorAt: null, error: null, failing: false } }),
    },
    zunderAccess: access,
    zunder: () => null,
    calendars: { status: () => [], check: async () => ({}) },
    now: () => NOW,
    ...over,
  };
  return { ...parts, health: createHealth(parts) };
}

test('Zustand: alles läuft, kein Hinweis, /health ohne degraded', () => {
  const { health } = setup();
  const list = health.services();
  assert.deepEqual(list.map((s) => s.id), ['sync', 'index', 'embeddings', 'mail', 'bridge', 'zunder', 'calendars']);
  assert.deepEqual(Object.fromEntries(list.map((s) => [s.id, s.state])), {
    sync: 'ok', index: 'ok', embeddings: 'ok', mail: 'ok', bridge: 'ok', zunder: 'ok', calendars: 'off',
  });
  assert.deepEqual(health.failing(), []);
  assert.equal(health.degraded(), false);
  assert.match(list.find((s) => s.id === 'embeddings').facts.find((f) => f.label === 'Fortschritt').value, /100 von 100 Notizen \(100 %\)/);
});

test('Zustand: Sync stale und Mail-Fehler werden rot, mit Zeitpunkt und Text', () => {
  const at = new Date(NOW - 300_000).toISOString();
  const { health } = setup({
    sync: { status: () => ({ adapter: 'obsidian-headless', state: 'stale', reason: 'Sidecar meldet sich nicht mehr', watching: true, lastSyncAt: null, heartbeatAt: at, lastError: null }) },
    mail: () => ({ state: 'error', mailbox: 'Vault', lastPollAt: at, lastOkAt: null, lastProcessed: 0, lastError: 'JMAP: HTTP 401 für https://api.fastmail.com/jmap/session?access_token=fmu1-geheim-mail', lastErrorAt: at }),
  });
  const byId = Object.fromEntries(health.services().map((s) => [s.id, s]));
  assert.equal(byId.sync.state, 'error');
  assert.equal(byId.sync.lastErrorAt, at);
  assert.equal(byId.sync.lastError, 'Sidecar meldet sich nicht mehr');
  assert.equal(byId.mail.state, 'error');
  assert.equal(byId.mail.lastErrorAt, at);
  assert.equal(byId.mail.lastError, 'JMAP: HTTP 401 für https://api.fastmail.com/…');
  assert.deepEqual(health.failing().map((f) => f.name), ['Sync', 'Mail-Abruf']);
  assert.equal(health.degraded(), true);

  // Sync mit eigenem Fehlertext aus dem Sidecar.
  const err = setup({ sync: { status: () => ({ state: 'error', watching: true, lastSyncAt: at, lastError: { at, message: 'Sync error: Vault not found' } }) } }).health;
  const sync = err.services()[0];
  assert.equal(sync.state, 'error');
  assert.equal(sync.lastError, 'Sync error: Vault not found');
});

test('Zustand: Zunder lehnt den Token ab, Fehlertext ohne Token', () => {
  const access = createRunLog({ now: () => NOW });
  access.fail(new Error('Zunder antwortet mit HTTP 401 (Token zt_geheim123456 unbekannt)'));
  const { health } = setup({ zunderAccess: access });
  const z = health.services().find((s) => s.id === 'zunder');
  assert.equal(z.state, 'error');
  assert.equal(z.summary, 'Zunder lehnt den Token ab');
  assert.doesNotMatch(z.lastError, /geheim/);
  assert.deepEqual(z.facts.map((f) => f.value), ['zunder.test', 'Umgebung']);
});

test('Zustand: Feuer-Notiz rot, wenn der letzte Lauf scheiterte; aus, wenn abgeschaltet', () => {
  const at = new Date(NOW - 60_000).toISOString();
  const status = { lastRun: at, lastOkAt: null, lastError: { at, message: 'Feuer-Notiz von Hand geändert' }, lastWrite: null };
  const { health, settings } = setup({ flameNote: { status: () => status } });
  const note = () => health.services().find((s) => s.id === 'flame-note');
  assert.deepEqual(health.services().map((s) => s.id), ['sync', 'index', 'embeddings', 'mail', 'bridge', 'flame-note', 'zunder', 'calendars']);
  assert.equal(note().state, 'error');
  assert.equal(note().lastError, 'Feuer-Notiz von Hand geändert');
  assert.deepEqual(health.failing().map((f) => f.name), ['Feuer-Notiz']);

  // Der nächste Lauf klappt: wieder grün, der alte Fehler bleibt sichtbar.
  const later = new Date(NOW).toISOString();
  Object.assign(status, { lastRun: later, lastOkAt: later, lastWrite: { at: later, path: 'feuer/W42.md', week: '2026-W42' } });
  assert.equal(note().state, 'ok');
  assert.equal(note().lastErrorAt, at);
  assert.deepEqual(note().facts, [{ label: 'Zuletzt geschrieben', value: 'feuer/W42.md (2026-W42)' }]);

  settings.save({ flameNote: { enabled: false } });
  assert.deepEqual([note().state, note().summary], ['off', 'aus']);
});

test('Zustand: aus, wenn nicht eingerichtet; unbekannt vor dem ersten Lauf', () => {
  const settings = createSettingsStore({ logger: quiet });
  const { health } = setup({
    settings,
    sync: { status: () => ({ adapter: 'none', state: 'disabled', watching: false }) },
    zunderAccess: createRunLog(),
    bridge: { enabled: () => true, active: () => false, tag: 'zunder', status: () => ({}) },
    semantic: () => null,
    mail: () => null,
  });
  const states = Object.fromEntries(health.services().map((s) => [s.id, [s.state, s.summary]]));
  assert.deepEqual(states.sync, ['off', 'aus']);
  assert.deepEqual(states.embeddings, ['off', 'aus, nur Volltextsuche']);
  assert.deepEqual(states.mail, ['off', 'nicht eingerichtet']);
  assert.deepEqual(states.bridge, ['off', 'ruht, kein Zunder-Zugang']);
  assert.deepEqual(states.zunder, ['off', 'nicht eingerichtet']);
  assert.equal(health.degraded(), false);

  const fresh = setup({ zunderAccess: createRunLog() }).health;
  assert.deepEqual(fresh.services().find((s) => s.id === 'zunder').state, 'unknown');
});

test('Zustand: Kalender je Teil, Adresse mit Geheimnis wird maskiert; check() prüft Zunder und Kalender frisch', async () => {
  const settings = createSettingsStore({ defaults: { zunderUrl: 'https://zunder.test', zunderToken: 'zt_geheim123456' }, logger: quiet });
  settings.save({ calendars: [{ name: 'Privat', kind: 'caldav', url: 'https://dav.test/cal/', username: 'r', password: 'app-passwort-99' }] });
  const at = new Date(NOW).toISOString();
  const probes = [];
  const { health } = setup({
    settings,
    calendars: {
      status: () => [{ id: 'c1', name: 'Privat', kind: 'caldav', lastOkAt: null, lastErrorAt: at, lastError: 'CalDAV PROPFIND mit app-passwort-99 abgelehnt', failing: true }],
      check: async (start, end) => probes.push(['kalender', start < end]),
    },
    zunder: () => ({ listStructure: async () => probes.push(['zunder']) }),
  });
  const services = await health.check();
  assert.deepEqual(probes, [['zunder'], ['kalender', true]]);
  const cal = services.find((s) => s.id === 'calendars');
  assert.equal(cal.state, 'error');
  assert.equal(cal.items[0].lastError, 'CalDAV PROPFIND mit ••• abgelehnt');
  assert.equal(cal.lastError, 'Privat: CalDAV PROPFIND mit ••• abgelehnt');
});

// --- Darstellung -------------------------------------------------------------

test('Zustandsseite: Dienst, Zeitpunkt und Fehlertext, alles escaped', () => {
  const at = new Date(NOW - 300_000).toISOString();
  const { health } = setup({
    mail: () => ({ state: 'error', mailbox: 'Vault', lastPollAt: at, lastOkAt: null, lastProcessed: 0, lastError: 'Ordner "<Vault>" nicht gefunden', lastErrorAt: at }),
  });
  const html = renderHealth(health.services(), { tz: 'Europe/Berlin', now: NOW, user: 'Ruben' });
  assert.match(html, /<h1>Zustand<\/h1>/);
  assert.match(html, /Ein Dienst meldet einen Fehler: <a href="#dienst-mail">Mail-Abruf<\/a>/);
  assert.match(html, /<section class="svc state-error" id="dienst-mail">/);
  assert.match(html, /Ordner &quot;&lt;Vault&gt;&quot; nicht gefunden/);
  assert.match(html, /<time datetime="2026-10-18T11:55:00\.000Z">18\.10\. 13:55 · vor 5 min<\/time>/);
  assert.doesNotMatch(html, /fmu1-geheim-mail|zt_geheim/);
  // Nur eigene Skripte aus /static (z. B. der Offline-Puffer), nichts eingebettet.
  assert.doesNotMatch(html, /<script(?! src="\/static\/)/);

  const fine = renderHealth(setup().health.services(), { now: NOW });
  assert.match(fine, /Alle eingerichteten Dienste laufen/);
});

test('Kopfzeilen-Hinweis und Zeitangaben', () => {
  assert.equal(healthAlert([]), '');
  const html = healthAlert([{ id: 'sync', name: 'Sync' }, { id: 'mail', name: 'Mail-Abruf' }]);
  assert.match(html, /href="\/zustand"/);
  assert.match(html, /Störung: Sync, Mail-Abruf/);
  assert.equal(when(null, 'Europe/Berlin', NOW), '–');
  assert.equal(when(new Date(NOW - 3 * 3_600_000).toISOString(), 'Europe/Berlin', NOW), '18.10. 11:00 · vor 3 h');
  assert.equal(when(new Date(NOW - 3 * 86_400_000).toISOString(), 'Europe/Berlin', NOW), '15.10. 14:00 · vor 3 Tagen');
});

// --- /health -----------------------------------------------------------------

test('/health: ok, degraded mit 200, mit ?strict 503, ohne Details', async () => {
  let bad = false;
  const app = createApp({
    config: { publicUrl: 'https://vault.test', resource: 'https://vault.test/mcp', issuer: 'https://id.test', supportedScopes: [], allowedHosts: ['vault.test'] },
    verifyToken: async () => ({}),
    mcpHandler: async () => {},
    degraded: () => {
      if (bad === 'wirft') throw new Error('kaputt');
      return bad;
    },
    logger: quiet,
  });
  app.listen(0, '127.0.0.1');
  await new Promise((r) => app.once('listening', r));
  const base = `http://127.0.0.1:${app.address().port}`;
  try {
    let res = await fetch(`${base}/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: 'ok' });
    assert.equal((await fetch(`${base}/health?strict=1`)).status, 200);

    bad = true;
    res = await fetch(`${base}/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: 'degraded' });
    res = await fetch(`${base}/health?strict=1`);
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { status: 'degraded' });

    bad = 'wirft';
    assert.deepEqual(await (await fetch(`${base}/health`)).json(), { status: 'degraded' });
  } finally {
    app.close();
  }
});

// --- Web-Cockpit: Seite /zustand und Hinweis in der Wochenansicht ------------

const week = {
  tz: 'Europe/Berlin',
  vaultName: null,
  week: { id: '2026-W42', year: 2026, week: 42, monday: '2026-10-12', sunday: '2026-10-18', prev: '2026-W41', next: '2026-W43', current: true },
  feuer: { ok: true, data: null },
  burning: null,
  flames: { ok: true, data: [] },
  rocks: { ok: true, data: [] },
  calendar: { ok: true, data: [] },
  tasks: { ok: true, data: [] },
  inbox: { vault: { ok: true, data: [] }, zunder: { ok: true, data: [] }, folder: 'inbox' },
};

/** Web-Cockpit mit einer fertigen Sitzung (signiertes Cookie), ohne Login-Runde. */
async function withWeb(health, run) {
  const SECRET = 'x'.repeat(40);
  const webHttp = createWebHttp({
    cockpit: { week: async () => week },
    settings: createSettingsStore({ logger: quiet }),
    health,
    oidc: { start: async () => ({ url: 'https://id.test/authorize', pending: {} }) },
    sessionSecret: SECRET,
    publicUrl: 'https://vault.test',
    allowedSubjects: ['ruben'],
    logger: quiet,
  });
  const app = createApp({
    config: { publicUrl: 'https://vault.test', resource: 'https://vault.test/mcp', issuer: 'https://id.test', supportedScopes: [], allowedHosts: ['vault.test'], trustProxy: true },
    verifyToken: async () => ({}),
    mcpHandler: async () => {},
    webHttp,
    logger: quiet,
  });
  app.listen(0, '127.0.0.1');
  await new Promise((r) => app.once('listening', r));
  const base = `http://127.0.0.1:${app.address().port}`;
  const t = Math.floor(Date.now() / 1000);
  const session = createCookieSigner(SECRET).seal({ sub: 'ruben', name: 'Ruben', sid: 's1', gen: 0, iat: t, seen: t, exp: t + 3600 });
  const call = (path, { login = true } = {}) =>
    fetch(base + path, { redirect: 'manual', headers: { 'x-forwarded-host': 'vault.test', ...(login ? { cookie: `vc_session=${session}` } : {}) } });
  try {
    await run(call);
  } finally {
    app.close();
  }
}

test('Web: /zustand nur angemeldet, Wochenansicht zeigt den Hinweis nur bei Fehlern', async () => {
  let syncState = 'synced';
  const at = new Date().toISOString();
  const { health } = setup({
    sync: { status: () => ({ state: syncState, watching: true, lastSyncAt: at, heartbeatAt: at, reason: 'Sidecar meldet sich nicht mehr', lastError: null }) },
  });
  await withWeb(health, async (call) => {
    const anon = await call('/zustand', { login: false });
    assert.equal(anon.status, 303);
    assert.equal(anon.headers.get('location'), '/login?next=%2Fzustand');

    let page = await (await call('/')).text();
    assert.doesNotMatch(page, /health-alert/);

    syncState = 'stale';
    page = await (await call('/')).text();
    assert.match(page, /<a href="\/zustand" class="health-alert" title="Störung: Sync">/);

    const res = await call('/zustand');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-security-policy'), /default-src 'none'/);
    const html = await res.text();
    assert.match(html, /<section class="svc state-error" id="dienst-sync">/);
    assert.match(html, /Sidecar meldet sich nicht mehr/);
    assert.doesNotMatch(html, /zt_geheim123456|fmu1-geheim-mail/);

    const settingsPage = await (await call('/einstellungen')).text();
    assert.match(settingsPage, /href="\/zustand"/);
  });
});
