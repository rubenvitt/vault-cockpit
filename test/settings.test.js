import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSettingsStore, validateSettings, loadOrCreateSecret, SettingsError } from '../src/cockpit/settings.js';
import { createIcsClient, createCalendarSources, calendarForGraph } from '../src/cockpit/calendars.js';
import { describeWeek } from '../src/cockpit/week.js';

const quiet = { info() {}, warn() {}, error() {} };
const TZ = 'Europe/Berlin';
const W42 = describeWeek({ year: 2026, week: 42 }, TZ);
const ICS = ['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:1', 'SUMMARY:Daily', 'DTSTART;TZID=Europe/Berlin:20261001T084500', 'DURATION:PT15M', 'RRULE:FREQ=DAILY', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');

function withDir(run) {
  const dir = mkdtempSync(join(tmpdir(), 'cockpit-settings-'));
  try {
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('Einstellungen: leere Felder fallen auf die Umgebung zurück', () => {
  const s = createSettingsStore({ defaults: { tz: TZ, inboxFolder: '00-inbox', zunderUrl: 'https://z.test', zunderToken: 'zt_env' }, logger: quiet });
  const g = s.get();
  assert.equal(g.tz, TZ);
  assert.equal(g.inboxFolder, '00-inbox');
  assert.deepEqual(g.zunder, { url: 'https://z.test', token: 'zt_env', source: 'umgebung' });
  assert.deepEqual(g.calendars, []);

  s.save({ tz: 'America/New_York', inboxFolder: '/eingang/', zunder: { url: 'https://eigen.test', token: 'zt_eigen' }, calendars: [] });
  const h = s.get();
  assert.equal(h.tz, 'America/New_York');
  assert.equal(h.inboxFolder, 'eingang');
  assert.equal(h.zunder.source, 'einstellungen');
  assert.equal(h.version, 1);
});

test('Einstellungen: onChange meldet jedes Speichern', () => {
  const s = createSettingsStore({ logger: quiet });
  const seen = [];
  const off = s.onChange(() => seen.push(s.get().zunder?.token ?? null));
  s.save({ zunder: { url: 'https://z.test', token: 'zt_eins' }, calendars: [] });
  s.save({ zunder: { url: 'https://z.test', token: 'zt_zwei' }, calendars: [] });
  off();
  s.save({ calendars: [] });
  assert.deepEqual(seen, ['zt_eins', 'zt_zwei']);
});

test('Einstellungen: Prüfung von Zeitzone, Pfad, Adressen und Kalendern', () => {
  const ok = validateSettings({ calendars: [{ name: 'Privat', kind: 'ical', url: 'webcal://p.example/x.ics' }] });
  assert.equal(ok.calendars[0].url, 'https://p.example/x.ics');
  assert.match(ok.calendars[0].id, /^[\w-]+$/);
  const bad = [
    [{ tz: 'Mars/Olympus' }, /Zeitzone/],
    [{ inboxFolder: '../etc' }, /Pfad im Vault/],
    [{ zunder: { url: 'ftp://x' } }, /https/],
    [{ calendars: [{ name: '', kind: 'ical', url: 'https://a' }] }, /Namen/],
    [{ calendars: [{ name: 'A', kind: 'ical', url: '' }] }, /Adresse/],
    [{ calendars: [{ name: 'A', kind: 'exchange', url: 'https://a' }] }, /iCal oder CalDAV/],
    [{ calendars: [{ name: 'A', kind: 'ical', url: 'https://a', password: 'x' }] }, /Benutzer/],
    [{ calendars: [{ name: 'A', kind: 'ical', url: 'https://a' }, { name: 'a', kind: 'ical', url: 'https://b' }] }, /doppelt/],
  ];
  for (const [input, msg] of bad) assert.throws(() => validateSettings(input), (e) => e instanceof SettingsError && msg.test(e.message));
});

test('Einstellungen: Datei nur für den Dienst lesbar, Stand übersteht einen Neustart', () =>
  withDir((dir) => {
    const file = join(dir, 'sub', 'cockpit-settings.json');
    const a = createSettingsStore({ file, logger: quiet });
    a.save({ calendars: [{ name: 'Arbeit', kind: 'caldav', url: 'https://dav.example/', username: 'u', password: 'geheim', filter: ['Team', ' '] }] });
    assert.equal(statSync(file).mode & 0o777, 0o600);
    const b = createSettingsStore({ file, logger: quiet });
    assert.deepEqual(b.get().calendars.map((c) => [c.name, c.password, c.filter]), [['Arbeit', 'geheim', ['Team']]]);
    writeFileSync(file, '{kaputt');
    assert.deepEqual(createSettingsStore({ file, logger: quiet }).get().calendars, []);
  }));

test('Session-Secret: aus der Umgebung, sonst einmal erzeugt und wiederverwendet', () =>
  withDir((dir) => {
    const file = join(dir, 'session-secret');
    assert.equal(loadOrCreateSecret(file, 'x'.repeat(40)), 'x'.repeat(40));
    const first = loadOrCreateSecret(file);
    assert.ok(first.length >= 32);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(loadOrCreateSecret(file), first);
    assert.equal(readFileSync(file, 'utf8').trim(), first);
  }));

test('iCal-Abo: webcal wird https, Basic-Auth, Cache, Fehler', async () => {
  const calls = [];
  let t = 0;
  const fetch = async (url, init) => {
    calls.push({ url, auth: init.headers.authorization });
    return new Response(ICS, { status: 200 });
  };
  const c = createIcsClient({ url: 'webcal://cal.example/privat.ics', username: 'u', password: 'p', fetch, now: () => t, tz: TZ });
  assert.equal((await c.events(W42.start, W42.end)).length, 7);
  await c.events(W42.start, W42.end);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://cal.example/privat.ics');
  assert.equal(calls[0].auth, `Basic ${Buffer.from('u:p').toString('base64')}`);
  t = 6 * 60_000;
  await c.events(W42.start, W42.end);
  assert.equal(calls.length, 2);

  const notFound = createIcsClient({ url: 'https://x', fetch: async () => new Response('', { status: 404 }) });
  await assert.rejects(notFound.events(W42.start, W42.end), /HTTP 404/);
  const html = createIcsClient({ url: 'https://x', fetch: async () => new Response('<html>', { status: 200 }) });
  await assert.rejects(html.events(W42.start, W42.end), /kein iCalendar/);
});

test('Mehrere Kalender: Termine zusammen, ein Ausfall trifft nur seinen Kalender', async () => {
  const settings = createSettingsStore({ defaults: { tz: TZ }, logger: quiet });
  settings.save({
    calendars: [
      { name: 'Privat', kind: 'ical', url: 'https://ok.example/a.ics' },
      { name: 'Arbeit', kind: 'ical', url: 'https://kaputt.example/b.ics' },
    ],
  });
  const fetch = async (url) => (String(url).includes('kaputt') ? new Response('', { status: 401 }) : new Response(ICS));
  const sources = createCalendarSources({ settings, fetch });
  const { events, errors } = await sources.events(W42.start, W42.end);
  assert.equal(events.length, 7);
  assert.equal(events[0].calendar, 'Privat');
  assert.deepEqual(errors, [{ calendar: 'Arbeit', error: 'iCal-Abruf antwortet mit HTTP 401' }]);

  const checks = await sources.check(W42.start, W42.end);
  const [privat, arbeit] = settings.get().calendars;
  assert.deepEqual(checks[privat.id], { ok: true, count: 7 });
  assert.equal(checks[arbeit.id].ok, false);
});

test('Kalender für den Graphen: aus ohne Kalender, Fehler nur wenn alle ausfallen', async () => {
  const settings = createSettingsStore({ defaults: { tz: TZ }, logger: quiet });
  let down = false;
  const fetch = async (url) => (down || String(url).includes('kaputt') ? new Response('', { status: 500 }) : new Response(ICS));
  const cal = calendarForGraph(createCalendarSources({ settings, fetch, now: () => (down ? 1e12 : 0) }));
  assert.equal(cal.configured(), false);
  settings.save({ calendars: [{ name: 'Privat', kind: 'ical', url: 'https://ok.example/a.ics' }, { name: 'Arbeit', kind: 'ical', url: 'https://kaputt.example/b.ics' }] });
  assert.equal(cal.configured(), true);
  assert.equal((await cal.events(W42.start, W42.end)).length, 7);
  down = true;
  await assert.rejects(cal.events(W42.start, W42.end), /Privat: .*HTTP 500.*Arbeit/);
});

test('Ausgeblendete Termine: „Blockiert“ fehlt standardmäßig, eigene Liste ersetzt den Standard', async () => {
  const blocks = ['BEGIN:VCALENDAR',
    'BEGIN:VEVENT', 'UID:a', 'SUMMARY: blockiert ', 'DTSTART;TZID=Europe/Berlin:20261013T090000', 'DURATION:PT1H', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:b', 'SUMMARY:Zahnarzt', 'DTSTART;TZID=Europe/Berlin:20261013T110000', 'DURATION:PT1H', 'END:VEVENT',
    'END:VCALENDAR'].join('\r\n');
  const settings = createSettingsStore({ defaults: { tz: TZ }, logger: quiet });
  const fetch = async () => new Response(blocks);
  const sources = createCalendarSources({ settings, fetch, now: () => 0 });
  const titles = async () => (await sources.events(W42.start, W42.end)).events.map((e) => e.title);
  const cal = [{ name: 'Privat', kind: 'ical', url: 'https://ok.example/a.ics' }];

  settings.save({ calendars: cal });
  assert.deepEqual(settings.get().hiddenEvents, ['Blockiert']);
  assert.deepEqual(await titles(), ['Zahnarzt']);

  settings.save({ calendars: cal, hiddenEvents: [' Zahnarzt ', ''] });
  assert.deepEqual(settings.stored().hiddenEvents, ['Zahnarzt']);
  assert.deepEqual((await titles()).map((t) => t.trim()), ['blockiert']);

  settings.save({ calendars: cal, hiddenEvents: [] });
  assert.equal((await titles()).length, 2);
});
