import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeWeek, parseWeekId, weekOf, zonedToUtc, localDate } from '../src/cockpit/week.js';
import { parseCalendars, calendarData, createCalDavClient } from '../src/cockpit/caldav.js';
import { parseEvents } from '../src/cockpit/ics.js';
import { createSettingsStore } from '../src/cockpit/settings.js';
import { findFeuer, sectionParagraph } from '../src/cockpit/feuer.js';
import { createCockpit, areaOf } from '../src/cockpit/data.js';
import { createFlameBlocks } from '../src/cockpit/flammen-bloecke.js';
import { flameRows, burnedSince, burnedInWeek } from '../src/cockpit/flammen-notiz.js';
import { renderWeek, inline, dueTag } from '../src/web/render.js';
import { noteOrigin } from '../src/web/note-render.js';
import { buildIndex, openIndex } from '../src/vault/index.js';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TZ = 'Europe/Berlin';
const quiet = { info() {}, warn() {}, error() {} };

// --- Wochen ---------------------------------------------------------------

test('describeWeek: KW 42/2026 läuft Mo 12.10. bis So 18.10., Grenzen in Ortszeit', () => {
  const w = describeWeek({ year: 2026, week: 42 }, TZ);
  assert.equal(w.id, '2026-W42');
  assert.equal(w.monday, '2026-10-12');
  assert.equal(w.sunday, '2026-10-18');
  assert.equal(w.start.toISOString(), '2026-10-11T22:00:00.000Z');
  assert.equal(w.end.toISOString(), '2026-10-18T22:00:00.000Z');
  assert.equal(w.days[0].label, 'Mo 12.10.');
  assert.equal(w.prev, '2026-W41');
  assert.equal(w.next, '2026-W43');
});

test('describeWeek: Umstellung auf Winterzeit (So 25.10.2026) hat einen 25-Stunden-Tag', () => {
  const w = describeWeek({ year: 2026, week: 43 }, TZ);
  const sunday = w.days[6];
  assert.equal(sunday.start.toISOString(), '2026-10-24T22:00:00.000Z');
  assert.equal(sunday.end.toISOString(), '2026-10-25T23:00:00.000Z');
});

test('Wochen über den Jahreswechsel und ungültige Kennungen', () => {
  assert.equal(describeWeek({ year: 2026, week: 1 }, TZ).prev, '2025-W52');
  assert.equal(describeWeek({ year: 2026, week: 53 }, TZ).next, '2027-W01');
  assert.deepEqual(parseWeekId('2026-W53'), { year: 2026, week: 53 });
  assert.equal(parseWeekId('2025-W53'), null);
  assert.equal(parseWeekId('2026-W00'), null);
  assert.equal(parseWeekId('2026-42'), null);
  // So 23:30 Ortszeit gehört noch zu KW 42, Mo 00:30 schon zu KW 43.
  assert.deepEqual(weekOf(new Date('2026-10-18T21:30:00Z'), TZ), { year: 2026, week: 42 });
  assert.deepEqual(weekOf(new Date('2026-10-18T22:30:00Z'), TZ), { year: 2026, week: 43 });
  assert.equal(localDate(zonedToUtc({ year: 2026, month: 3, day: 29, hour: 2, minute: 30 }, TZ), TZ), '2026-03-29');
});

// --- CalDAV ---------------------------------------------------------------

const PROPFIND = `<?xml version="1.0" encoding="UTF-8"?>
<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:response><D:href>/dav/calendars/user/r@example.com/</D:href>
    <D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop></D:propstat></D:response>
  <D:response><D:href>/dav/calendars/user/r@example.com/Default/</D:href>
    <D:propstat><D:prop><D:displayname>Privat &amp; Arbeit</D:displayname>
      <D:resourcetype><D:collection/><C:calendar/></D:resourcetype>
      <C:supported-calendar-component-set><C:comp name="VEVENT"/></C:supported-calendar-component-set></D:prop></D:propstat></D:response>
  <D:response><D:href>/dav/calendars/user/r@example.com/tasks/</D:href>
    <D:propstat><D:prop><D:displayname>Erinnerungen</D:displayname>
      <D:resourcetype><D:collection/><C:calendar/></D:resourcetype>
      <C:supported-calendar-component-set><C:comp name="VTODO"/></C:supported-calendar-component-set></D:prop></D:propstat></D:response>
  <D:response><D:href>/dav/calendars/user/r@example.com/Inbox/</D:href>
    <D:propstat><D:prop><D:resourcetype><D:collection/><C:schedule-inbox/></D:resourcetype></D:prop></D:propstat></D:response>
</D:multistatus>`;

const ICS = [
  'BEGIN:VCALENDAR',
  'BEGIN:VTIMEZONE',
  'TZID:Europe/Berlin',
  'END:VTIMEZONE',
  'BEGIN:VEVENT',
  'UID:1',
  'SUMMARY:SAS-Workshop\\, Berlin',
  'DTSTART;TZID=Europe/Berlin:20261014T140000',
  'DTEND;TZID=Europe/Berlin:20261014T173000',
  'LOCATION:Maritim\\; Raum 2',
  'BEGIN:VALARM',
  'SUMMARY:Alarm darf den Titel nicht überschreiben',
  'END:VALARM',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:2',
  'SUMMARY:Mini-Aschezeit mit einem sehr langen Titel, der in der Datei umgebrochen',
  '  wird',
  'DTSTART;VALUE=DATE:20261017',
  'DTEND;VALUE=DATE:20261019',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:3',
  'SUMMARY:Abgesagt',
  'STATUS:CANCELLED',
  'DTSTART:20261015T080000Z',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:4',
  'SUMMARY:Daily',
  'DTSTART:20261015T064500Z',
  'DURATION:PT15M',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

test('parseCalendars: nur Kalender mit VEVENT, Namen dekodiert, URLs absolut', () => {
  const cals = parseCalendars(PROPFIND, 'https://caldav.example.com/dav/calendars/user/r@example.com/');
  assert.deepEqual(cals, [{ href: 'https://caldav.example.com/dav/calendars/user/r@example.com/Default/', name: 'Privat & Arbeit' }]);
});

test('parseEvents: Zeitzonen, ganztägig, Faltung, Escapes, Absagen, DURATION', () => {
  const evs = parseEvents(ICS, TZ);
  assert.equal(evs.length, 3);
  const [ws, daily, frei] = evs;
  assert.equal(ws.title, 'SAS-Workshop, Berlin');
  assert.equal(ws.location, 'Maritim; Raum 2');
  assert.equal(ws.start.toISOString(), '2026-10-14T12:00:00.000Z');
  assert.equal(ws.end.toISOString(), '2026-10-14T15:30:00.000Z');
  assert.equal(frei.allDay, true);
  assert.equal(frei.title, 'Mini-Aschezeit mit einem sehr langen Titel, der in der Datei umgebrochen wird');
  assert.equal(frei.start.toISOString(), '2026-10-16T22:00:00.000Z');
  assert.equal(frei.end.toISOString(), '2026-10-18T22:00:00.000Z');
  assert.equal(daily.end.toISOString(), '2026-10-15T07:00:00.000Z');
});

test('CalDAV-Client: findet Kalender, fragt die Woche ab, cacht', async () => {
  const calls = [];
  const report = `<d:multistatus xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav"><d:response>
    <d:href>/x/1.ics</d:href><d:propstat><d:prop><cal:calendar-data>${ICS.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</cal:calendar-data></d:prop></d:propstat>
  </d:response></d:multistatus>`;
  const fetch = async (url, init) => {
    calls.push({ url, method: init.method, body: init.body, auth: init.headers.authorization });
    return new Response(init.method === 'PROPFIND' ? PROPFIND : report, { status: 207 });
  };
  const client = createCalDavClient({ url: 'https://caldav.example.com/dav/calendars/user/r@example.com', username: 'r@example.com', password: 'pw', fetch, tz: TZ });
  const w = describeWeek({ year: 2026, week: 42 }, TZ);
  const evs = await client.events(w.start, w.end);
  assert.equal(evs.length, 3);
  assert.equal(evs[0].calendar, 'Privat & Arbeit');
  assert.equal(calls[0].url, 'https://caldav.example.com/dav/calendars/user/r@example.com/');
  assert.equal(calls[0].auth, `Basic ${Buffer.from('r@example.com:pw').toString('base64')}`);
  assert.match(calls[1].body, /start="20261011T220000Z" end="20261018T220000Z"/);
  await client.events(w.start, w.end);
  assert.equal(calls.length, 2);
});

test('CalDAV-Client: Fehler werden gemeldet', async () => {
  const client = createCalDavClient({ url: 'https://x', username: 'a', password: 'b', fetch: async () => new Response('', { status: 401 }) });
  await assert.rejects(client.events(new Date(0), new Date(1)), /HTTP 401/);
});

test('calendarData liest auch CDATA', () => {
  assert.deepEqual(calendarData('<C:calendar-data><![CDATA[BEGIN:VCALENDAR]]></C:calendar-data>'), ['BEGIN:VCALENDAR']);
});

// --- Feuer-Notiz ----------------------------------------------------------

const FEUER = `---
type: 1-wochen-feuer
zeitraum: "12.10.2026 – 18.10.2026"
status: aktiv
---

# Feuer W3

## Feuer-Ziel

**Am Mi 14.10. um 14:00 hältst du den Workshop**
mit fertigen Folien.

*Alignment:* Ziel 1.

## Erster Zug

💻 Laptop auf.
`;

function fakeIndex(notes = [], folder = []) {
  return {
    notesOfType: (type) => notes.filter((n) => n.type === type),
    getNote: (path) => ({ content: notes.find((n) => n.path === path)?.content ?? null }),
    listFolder: () => folder,
  };
}

const feuerNote = (over = {}) => ({
  path: 'phoenix/Feuer W3.md',
  title: 'Feuer W3 - 2026-Q4',
  type: '1-wochen-feuer',
  status: 'aktiv',
  frontmatter: { zeitraum: '12.10.2026 – 18.10.2026', alignment: 'Ziel 1 · Sichtbar werden' },
  content: FEUER,
  ...over,
});

test('sectionParagraph: erster Absatz unter der Überschrift, Zeilen verbunden', () => {
  assert.equal(sectionParagraph(FEUER, 'Feuer-Ziel'), '**Am Mi 14.10. um 14:00 hältst du den Workshop** mit fertigen Folien.');
  assert.equal(sectionParagraph(FEUER, 'Gibt es nicht'), null);
});

test('findFeuer: passende Woche über zeitraum, sonst aktive Notiz nur für die laufende Woche', () => {
  const w42 = describeWeek({ year: 2026, week: 42 }, TZ);
  const w43 = describeWeek({ year: 2026, week: 43 }, TZ);
  const index = fakeIndex([feuerNote()]);
  const f = findFeuer(index, w42);
  assert.equal(f.goal, '**Am Mi 14.10. um 14:00 hältst du den Workshop** mit fertigen Folien.');
  assert.equal(f.firstMove, '💻 Laptop auf.');
  assert.equal(f.alignment, 'Ziel 1 · Sichtbar werden');
  assert.equal(findFeuer(index, w43), null);
  assert.equal(findFeuer(index, w43, { current: true }).path, 'phoenix/Feuer W3.md');
});

test('findFeuer mit echtem Index: notesOfType liefert Frontmatter, Inhalt kommt von der Platte', () => {
  const root = mkdtempSync(join(tmpdir(), 'vault-feuer-'));
  try {
    mkdirSync(join(root, 'phoenix'));
    writeFileSync(join(root, 'phoenix', 'Feuer W3.md'), FEUER);
    writeFileSync(join(root, 'phoenix', 'Anderes.md'), '---\ntype: notiz\n---\n# x\n');
    const { db } = buildIndex({ vaultPath: root, dbPath: ':memory:', logger: quiet });
    const index = openIndex(db, { vaultPath: root });
    assert.deepEqual(index.notesOfType('1-wochen-feuer').map((n) => [n.path, n.frontmatter.zeitraum]), [
      ['phoenix/Feuer W3.md', '12.10.2026 – 18.10.2026'],
    ]);
    const f = findFeuer(index, describeWeek({ year: 2026, week: 42 }, TZ));
    assert.match(f.goal, /hältst du den Workshop/);
    index.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- Wochenmodell ---------------------------------------------------------

const loc = (area, project = null) =>
  project ? { kind: 'project', id: 'p', name: project, area_id: 'a', area_name: area } : { kind: 'area', id: 'a', name: area };

function fakeZunder(tasks, { fail = null } = {}) {
  const calls = [];
  return {
    calls,
    taskUrl: (id) => `https://zunder.test/#/aufgabe/${id}`,
    async filterTasks(f) {
      calls.push(f);
      if (fail && fail(f)) throw new Error('Zunder antwortet mit HTTP 502');
      return tasks.filter((t) => {
        if (f.flame_running) return Boolean(t.flame_running);
        if (f.closed_after) return f.status.includes(t.status) && t.closed && t.closed >= f.closed_after && t.closed <= f.closed_before;
        if (f.phoenix_fire) return t.phoenix?.fire === f.phoenix_fire;
        if (f.location === 'inbox') return t.location.kind === 'inbox' && f.status.includes(t.status);
        if (f.due_after) return t.due && t.due.slice(0, 10) >= f.due_after && t.due.slice(0, 10) <= f.due_before;
        if (f.due_before) return t.due && t.due.slice(0, 10) <= f.due_before && f.status.includes(t.status);
        if (f.status) return f.status.includes(t.status);
        return true;
      });
    },
    async listStructure() {
      return [
        { id: 'a2', name: 'Zuhause', state: 'active', projects: [{ id: 'p9', name: 'Alt', status: 'done' }] },
        { id: 'a1', name: 'Arbeitnehmer', state: 'active', projects: [{ id: 'p1', name: 'Odoo', status: 'active' }] },
        { id: 'a3', name: 'Weg', state: 'archived', projects: [] },
        { id: 'a4', name: 'Programmieren', state: 'active', projects: [{ id: 'pdev', name: 'Vault Cockpit', status: 'active', kind: 'dev' }] },
      ];
    },
  };
}

const TASKS = [
  { id: 'f1', title: 'Flamme Folien', status: 'done', due: '2026-10-12T15:00:00+02:00', location: loc('Phönix-Progression', 'Phönix Hub'), phoenix: { fire: '2026-W42', role: 'flamme' }, flame_started_at: '2026-10-12T13:00:00Z', flame_ended_at: '2026-10-12T14:30:00Z' },
  { id: 's1', title: 'Workshop halten', status: 'open', due: null, location: loc('Berufliche Weiterentwicklung'), phoenix: { fire: '2026-W42', role: 'feuer_schritt' } },
  { id: 'd1', title: 'Helfermappe drucken', status: 'open', due: '2026-10-16', location: loc('Ehrenamt (DRK Bereitschaft)', 'Gruppe I&K') },
  { id: 'd2', title: 'Odoo W3', status: 'done', due: '2026-10-16', location: loc('Arbeitnehmer') },
  { id: 'x1', title: 'Verworfen', status: 'dropped', due: '2026-10-15', location: loc('Arbeitnehmer') },
  { id: 'o1', title: 'Seite für Personalentwicklung', status: 'open', due: '2026-07-05', location: loc('Arbeitnehmer') },
  { id: 'p1', title: 'Zunder läuft', status: 'in_progress', due: null, location: loc('Programmieren', 'Zunder') },
  { id: 'v1', title: 'Dev läuft', status: 'in_progress', due: null, location: { ...loc('Programmieren', 'Vault Cockpit'), id: 'pdev' } },
  { id: 'v2', title: 'Dev überfällig', status: 'open', due: '2026-10-01', location: { ...loc('Programmieren', 'Vault Cockpit'), id: 'pdev' } },
  { id: 'i1', title: 'Neu erfasst', status: 'open', due: null, location: { kind: 'inbox' } },
];

const fixedNow = () => new Date('2026-10-14T10:00:00Z');

/** Einstellungen wie im Betrieb: Zunder aus der Umgebung, sonst Standard. */
const settingsWith = ({ zunder = true, vaultName = null } = {}) =>
  createSettingsStore({
    defaults: { tz: TZ, inboxFolder: 'inbox', vaultName, ...(zunder ? { zunderUrl: 'https://zunder.test', zunderToken: 'zt_x' } : {}) },
    logger: quiet,
  });
const calendarsFrom = (fn) => ({ configured: () => true, events: fn });

test('areaOf: Bereich direkt, über das Projekt oder Inbox', () => {
  assert.equal(areaOf({ location: loc('Sport') }), 'Sport');
  assert.equal(areaOf({ location: loc('Ehrenamt', 'IDA') }), 'Ehrenamt');
  assert.equal(areaOf({ location: { kind: 'inbox' } }), 'Inbox');
  assert.equal(areaOf({}), 'Ohne Bereich');
});

test('Wochenmodell: Big Rocks je Bereich, Flammen mit gemessener Zeit, Aufgaben ohne Dopplung', async () => {
  const zunder = fakeZunder(TASKS);
  const calendars = calendarsFrom(async () => ({ events: parseEvents(ICS, TZ), errors: [] }));
  const cockpit = createCockpit({ index: fakeIndex([feuerNote()], [{ path: 'inbox/a.md', title: 'A' }]), settings: settingsWith(), zunderFor: () => zunder, calendars, now: fixedNow, logger: quiet });
  const m = await cockpit.week();
  assert.equal(m.week.id, '2026-W42');
  assert.equal(m.week.current, true);
  assert.equal(m.feuer.data.path, 'phoenix/Feuer W3.md');

  assert.deepEqual(m.flames.data.map((f) => [f.id, f.minutes]), [['f1', 90]]);

  assert.deepEqual(
    m.rocks.data.map((g) => [g.area, g.tasks.map((t) => t.id), g.done]),
    [
      ['Arbeitnehmer', ['d2'], 1],
      ['Berufliche Weiterentwicklung', ['s1'], 0],
      ['Ehrenamt (DRK Bereitschaft)', ['d1'], 0],
    ],
  );
  assert.equal(m.rocks.data[2].tasks[0].project, 'Gruppe I&K');

  // Aufgaben aus Dev-Projekten (v1, v2) stehen nicht unter „in Arbeit und überfällig“ (VCP-41).
  assert.deepEqual(m.tasks.data.map((t) => [t.id, t.overdue]), [['o1', true], ['p1', false]]);
  assert.deepEqual(m.inbox.zunder.data.map((t) => t.id), ['i1']);
  // Ziele für „Zuordnen“: sortiert, ohne archivierte Bereiche und abgeschlossene Projekte.
  assert.deepEqual(m.inbox.targets, [
    { id: 'a1', name: 'Arbeitnehmer', projects: [{ id: 'p1', name: 'Odoo' }] },
    { id: 'a4', name: 'Programmieren', projects: [{ id: 'pdev', name: 'Vault Cockpit' }] },
    { id: 'a2', name: 'Zuhause', projects: [] },
  ]);
  assert.deepEqual(m.inbox.vault.data, [{ path: 'inbox/a.md', title: 'A' }]);

  const wed = m.calendar.data.find((d) => d.date === '2026-10-14');
  assert.equal(wed.today, true);
  assert.deepEqual(wed.events.map((e) => e.title), ['SAS-Workshop, Berlin']);
  const sat = m.calendar.data.find((d) => d.date === '2026-10-17');
  const sun = m.calendar.data.find((d) => d.date === '2026-10-18');
  assert.equal(sat.events.length, 1);
  assert.equal(sun.events.length, 1);
  assert.equal(m.calendar.data.find((d) => d.date === '2026-10-16').events.length, 0);

  assert.ok(zunder.calls.some((c) => c.phoenix_fire === '2026-W42'));
  assert.ok(zunder.calls.some((c) => c.due_after === '2026-10-12' && c.due_before === '2026-10-18'));
  assert.ok(zunder.calls.some((c) => c.due_before === '2026-10-13'));
});

test('Wochenmodell: eine ausgefallene Quelle trifft nur ihren Abschnitt', async () => {
  const zunder = fakeZunder(TASKS, { fail: (f) => Boolean(f.phoenix_fire) });
  const calendars = calendarsFrom(async () => { throw new Error('CalDAV PROPFIND antwortet mit HTTP 401'); });
  const cockpit = createCockpit({ index: fakeIndex([]), settings: settingsWith(), zunderFor: () => zunder, calendars, now: fixedNow, logger: quiet });
  const m = await cockpit.week('2026-W42');
  assert.equal(m.flames.ok, false);
  assert.equal(m.rocks.ok, true);
  assert.equal(m.rocks.partial, true);
  assert.equal(m.calendar.ok, false);
  assert.match(m.calendar.error, /401/);
  assert.equal(m.feuer.data, null);
  assert.equal(m.tasks.ok, true);
});

test('Wochenmodell: ohne Zunder und Kalender als „nicht eingerichtet“, ungültige Woche → null', async () => {
  const cockpit = createCockpit({ index: fakeIndex([]), settings: settingsWith({ zunder: false }), zunderFor: () => assert.fail('kein Zunder'), now: fixedNow, logger: quiet });
  const m = await cockpit.week('2026-W44');
  assert.equal(m.week.current, false);
  assert.equal(m.rocks.ok, false);
  assert.equal(m.rocks.unconfigured, true);
  assert.equal(m.calendar.unconfigured, true);
  assert.equal(await cockpit.week('2026-W99'), null);
});

// --- HTML -----------------------------------------------------------------

test('renderWeek: escaped Inhalte, Feuer-Ziel mit Markdown, Navigation', async () => {
  const zunder = fakeZunder([...TASKS, { id: 'evil', title: '<script>alert(1)</script>', status: 'open', due: '2026-10-15', location: loc('Sport') }]);
  const cockpit = createCockpit({ index: fakeIndex([feuerNote()]), settings: settingsWith({ vaultName: 'RNotes' }), zunderFor: () => zunder, now: fixedNow, logger: quiet });
  const html = renderWeek(await cockpit.week());
  assert.ok(!html.includes('<script>'));
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /<strong>Am Mi 14\.10\. um 14:00 hältst du den Workshop<\/strong>/);
  assert.match(html, /href="\/\?woche=2026-W41"/);
  assert.match(html, /obsidian:\/\/open\?vault=RNotes&amp;file=phoenix%2FFeuer%20W3/);
  assert.match(html, /Kalender ist nicht eingerichtet · <a href="\/einstellungen">/);
  assert.match(html, /90 min/);
});

test('renderWeek: vergangene Tage eingeklappt in einer Zeile, heute steht im Kopf der Termine', async () => {
  const cockpit = createCockpit({ index: fakeIndex([feuerNote()]), settings: settingsWith(), zunderFor: () => fakeZunder(TASKS), now: fixedNow, logger: quiet });
  const m = await cockpit.week();
  m.calendar = {
    ok: true,
    data: [
      { label: 'Mo 12.10.', today: false, events: [{ title: 'A', start: new Date('2026-10-12T08:00:00Z'), allDay: false }] },
      { label: 'Di 13.10.', today: false, events: [] },
      { label: 'Mi 14.10.', today: true, events: [] },
      { label: 'Do 15.10.', today: false, events: [] },
    ],
  };
  const html = renderWeek(m);
  // Mo und Di sind vorbei: eine Zeile mit der Zahl, aufgeklappt stehen die Tage mit ihren Terminen da.
  const past = html.match(/<details class="days-past more-items" data-keep="tage-vorbei">[\s\S]*?<\/details>/)[0];
  assert.match(past, /<summary>Mo–Di <span class="hint">vorbei · 1 Termin<\/span><\/summary>/);
  assert.match(past, /<div class="day past">\s*<h3>Mo 12\.10\.<\/h3>[\s\S]*?<span class="title">A<\/span>/);
  assert.doesNotMatch(past, /Mi 14\.10\./);
  // Heute und die kommenden Tage stehen danach als Spalten.
  const rest = html.slice(html.indexOf('</details>', html.indexOf('data-keep="tage-vorbei"')));
  assert.match(rest, /<div class="week"><div class="day today">\s*<h3>Mi 14\.10\.<\/h3>/);
  assert.match(rest, /<div class="day">\s*<h3>Do 15\.10\.<\/h3>/);
  assert.match(html, /<h2>Termine <span class="hint">heute frei<\/span><\/h2>/);

  // Ein einzelner vergangener Tag steht ohne Bereich da; hat heute Termine, bekommt der Tag die Zahl
  // für schmale Bildschirme mit (dort zeigt „Heute“ die Termine schon oben).
  m.calendar.data = [
    { label: 'Mo 12.10.', today: false, events: [] },
    { label: 'Di 13.10.', today: true, events: [{ title: 'B', start: new Date('2026-10-13T08:00:00Z'), allDay: false }, { title: 'C', start: new Date('2026-10-13T09:00:00Z'), allDay: false }] },
  ];
  const tue = renderWeek(m);
  assert.match(tue, /<summary>Mo <span class="hint">vorbei · keine Termine<\/span><\/summary>/);
  assert.match(tue, /<h3>Di 13\.10\. <span class="day-count">2 Termine, siehe Heute<\/span><\/h3>/);

  // Eine andere Woche hat keinen heutigen Tag: alle sieben stehen nebeneinander, nichts ist eingeklappt.
  const other = renderWeek({ ...m, calendar: { ok: true, data: m.calendar.data.map((d) => ({ ...d, today: false })) } });
  assert.doesNotMatch(other, /days-past|day-count|class="day (past|today)"/);
});

test('dueTag: Heute und Morgen als Wort, überfällig nur offen, ohne Fälligkeit leer', () => {
  const today = '2026-10-14';
  assert.deepEqual(dueTag({ due: null, status: 'open' }, TZ, today), { html: '', tone: '' });
  assert.match(dueTag({ due: '2026-10-14', status: 'open' }, TZ, today).html, /class="due today"[^>]*>Heute</);
  assert.match(dueTag({ due: '2026-10-15T09:30:00+02:00', status: 'open' }, TZ, today).html, />Morgen 09:30</);
  const late = dueTag({ due: '2026-10-12', status: 'open' }, TZ, today);
  assert.equal(late.tone, 'overdue');
  assert.match(late.html, /title="Überfällig seit Mo 12\.10\."/);
  assert.equal(dueTag({ due: '2026-10-12', status: 'done' }, TZ, today).tone, '');
  // Ohne heutiges Datum zählt das Feld aus den Daten.
  assert.equal(dueTag({ due: '2026-07-05', status: 'open', overdue: true }, TZ).tone, 'overdue');
});

test('renderWeek: Fälligkeit als Schild, erledigte Bereiche eingeklappt, Heute für die laufende Woche', async () => {
  const tasks = [
    ...TASKS,
    { id: 'h1', title: 'Heute fällig', status: 'open', due: '2026-10-14', location: loc('Finanzen') },
    { id: 'h2', title: 'Seit Montag fällig', status: 'open', due: '2026-10-12', location: loc('Finanzen') },
    { id: 'h3', title: 'Alter Schritt', status: 'open', due: '2026-10-01', location: loc('Finanzen'), phoenix: { fire: '2026-W42', role: 'feuer_schritt' } },
  ];
  const cockpit = createCockpit({ index: fakeIndex([feuerNote()]), settings: settingsWith(), zunderFor: () => fakeZunder(tasks), now: fixedNow, logger: quiet });
  const m = await cockpit.week();
  m.calendar = { ok: true, data: [{ label: 'Mi 14.10.', today: true, events: [{ title: 'Workshop', start: new Date('2026-10-14T12:00:00Z'), allDay: false }] }] };
  const html = renderWeek(m);
  // Datum steht nicht mehr in der Meta-Zeile, sondern als Schild hinter dem Titel.
  assert.match(html, /Helfermappe drucken<\/a> <span class="due" title="Fällig Fr 16\.10\.">Fr 16\.10\.<\/span> <span class="meta">Gruppe I&amp;K<\/span>/);
  assert.match(html, /<li class="task status-open overdue"[^>]*data-title="Seite für Personalentwicklung"/);
  // Arbeitnehmer ist komplett erledigt: eine Zeile zum Aufklappen (ohne `open`).
  assert.match(html, /<details class="rock all-done" data-keep="rock:Arbeitnehmer">\s*<summary><h3>Arbeitnehmer <span class="count" data-count>1\/1<\/span><\/h3>\s*<progress class="rock-progress" value="1" max="1" aria-hidden="true"><\/progress><\/summary>/);
  // Finanzen ist offen und hat einen offenen Phönix-Schritt: bleibt auch schmal aufgeklappt.
  assert.match(html, /<details class="rock" data-keep="rock:Finanzen" open>\s*<summary><h3>Finanzen <span class="count" data-count>0\/3<\/span><\/h3>/);
  // Ehrenamt ist nur fällig: offen, aber schmal klappt cockpit.js es zu (`data-fold`).
  assert.match(html, /<details class="rock" data-keep="rock:Ehrenamt \(DRK Bereitschaft\)" open data-fold>/);
  // Im Bereich steht der bewusst gewählte Phönix-Schritt vorn und trägt das Schild.
  const finanzen = html.match(/<details class="rock" data-keep="rock:Finanzen"[\s\S]*?<\/ul>\s*<\/details>/)[0];
  assert.deepEqual([...finanzen.matchAll(/<li class="task[^>]*data-title="([^"]+)"/g)].map((x) => x[1]), ['Alter Schritt', 'Seit Montag fällig', 'Heute fällig']);
  assert.match(finanzen, /Alter Schritt<\/a> <span class="step" title="Phönix-Schritt KW 42">Schritt<\/span> <span class="due overdue"/);
  assert.equal((finanzen.match(/class="step"/g) ?? []).length, 1);
  // Zwei Spalten, die Reihenfolge der Bereiche bleibt: erst links, dann rechts.
  assert.equal((html.match(/<div class="rocks-col">/g) ?? []).length, 2);
  assert.deepEqual([...html.matchAll(/data-keep="rock:([^"]+)"/g)].map((x) => x[1]), m.rocks.data.map((g) => g.area.replaceAll('&', '&amp;')));
  // Heute: Termin, heute Fälliges und Überfälliges aus der Woche, nichts Späteres.
  assert.match(html, /<main class="week-main today-first">/);
  const heute = html.match(/<section class="heute"[\s\S]*?<\/section>/)[0];
  assert.match(heute, /<h2>Heute <span class="hint">Mi 14\.10\.<\/span><\/h2>/);
  assert.match(heute, /14:00<\/span>\s*<span class="title">Workshop/);
  assert.match(heute, /Heute fällig/);
  assert.match(heute, /Seit Montag fällig/);
  assert.doesNotMatch(heute, /Helfermappe/);
  // Älter als die Woche (Phönix-Schritt mit altem Datum) gehört nicht zu Heute.
  assert.match(html, /Alter Schritt/);
  assert.doesNotMatch(heute, /Alter Schritt/);

  const other = await cockpit.week('2026-W43');
  assert.doesNotMatch(renderWeek(other), /class="heute"|today-first/);
});

test('Wochenmodell: Bereiche in der eigenen Rangfolge (areaOrder), der Rest alphabetisch dahinter', async () => {
  const settings = settingsWith();
  // Schreibweise und Leerzeichen am Rand zählen nicht; ein unbekannter Name stört nicht.
  settings.save({ ...settings.stored(), areaOrder: [' ehrenamt (drk bereitschaft) ', 'Gibt es nicht', 'Berufliche Weiterentwicklung'] });
  const cockpit = createCockpit({ index: fakeIndex([feuerNote()]), settings, zunderFor: () => fakeZunder([...TASKS, { id: 'z1', title: 'Zuletzt', status: 'open', due: '2026-10-15', location: loc('Zuhause') }]), now: fixedNow, logger: quiet });
  const ranked = (await cockpit.week()).rocks.data.map((g) => g.area);
  assert.deepEqual(ranked, ['Ehrenamt (DRK Bereitschaft)', 'Berufliche Weiterentwicklung', 'Arbeitnehmer', 'Zuhause']);
  // Leer: wie bisher alphabetisch.
  settings.save({ ...settings.stored(), areaOrder: [] });
  assert.deepEqual((await cockpit.week()).rocks.data.map((g) => g.area), ['Arbeitnehmer', 'Berufliche Weiterentwicklung', 'Ehrenamt (DRK Bereitschaft)', 'Zuhause']);
});

test('renderWeek: Phönix-Schritt vor früher Fälligem; Aufgaben und Inbox zeigen fünf, der Rest steckt hinter „weitere“', async () => {
  const tasks = [
    ...TASKS,
    { id: 'b1', title: 'Früh fällig', status: 'open', due: '2026-10-12', location: loc('Berufliche Weiterentwicklung') },
    ...Array.from({ length: 8 }, (_, i) => ({ id: `u${i}`, title: `Überfällig ${i}`, status: 'open', due: `2026-09-0${i + 1}`, location: loc('Sport') })),
    ...Array.from({ length: 5 }, (_, i) => ({ id: `n${i}`, title: `Inbox ${i}`, status: 'open', due: null, location: { kind: 'inbox' } })),
  ];
  const notes = Array.from({ length: 9 }, (_, i) => ({ path: `inbox/Notiz ${i}.md`, title: `Notiz ${i}` }));
  const cockpit = createCockpit({ index: fakeIndex([feuerNote()], notes), settings: settingsWith(), zunderFor: () => fakeZunder(tasks), now: fixedNow, logger: quiet });
  const m = await cockpit.week();
  // Das Modell sortiert nach Fälligkeit (der Schritt ohne Datum zuletzt); nur die Darstellung zieht ihn nach vorn.
  assert.deepEqual(m.rocks.data.find((g) => g.area === 'Berufliche Weiterentwicklung').tasks.map((t) => t.id), ['b1', 's1']);
  const html = renderWeek(m);
  const area = html.match(/data-keep="rock:Berufliche Weiterentwicklung"[\s\S]*?<\/details>/)[0];
  assert.deepEqual([...area.matchAll(/data-id="([^"]+)"/g)].map((x) => x[1]), ['s1', 'b1']);

  // Aufgaben: 10 (o1 und acht überfällige, p1 in Arbeit), fünf sichtbar, fünf hinter „weitere“; die Zahl bleibt in der Überschrift.
  const section = html.match(/<section class="tasks">[\s\S]*?<\/section>/)[0];
  assert.match(section, /<span class="count-badge">10<\/span>/);
  const [shown, hidden] = section.split('<details class="more-items" data-keep="aufgaben-mehr"><summary>5 weitere</summary>');
  assert.equal((shown.match(/<li class="task/g) ?? []).length, 5);
  assert.equal((hidden.match(/<li class="task/g) ?? []).length, 5);

  // Inbox: Vault und Zunder getrennt, beide Teile einer Liste tragen `data-list` (daran hängen cockpit.js und offline.js).
  const inbox = html.match(/<section id="inbox"[\s\S]*?<\/section>/)[0];
  assert.match(inbox, /<span class="count-badge" data-inbox-count>15<\/span>/);
  const vault = inbox.match(/<ul data-list="vault-inbox">([\s\S]*?)<\/ul><details class="more-items" data-keep="vault-inbox-mehr"><summary>4 weitere<\/summary><ul data-list="vault-inbox">([\s\S]*?)<\/ul><\/details>/);
  assert.equal((vault[1].match(/<li class="note"/g) ?? []).length, 5);
  assert.equal((vault[2].match(/<li class="note"/g) ?? []).length, 4);
  // Sechs Einträge bleiben ganz sichtbar: „1 weitere“ wäre so hoch wie der Eintrag selbst.
  const zunder = inbox.slice(inbox.indexOf('<h3>Zunder</h3>'));
  assert.equal((zunder.match(/<li class="task/g) ?? []).length, 6);
  assert.doesNotMatch(zunder, /more-items/);
});

test('renderWeek: Blättern nennt die KW im aria-label, schmal bleiben die Pfeile und „Heute“', async () => {
  const cockpit = createCockpit({ index: fakeIndex([]), settings: settingsWith(), zunderFor: () => fakeZunder(TASKS), now: fixedNow, logger: quiet });
  const now = renderWeek(await cockpit.week());
  assert.match(now, /<a href="\/\?woche=2026-W41" rel="prev" class="pager-step" aria-label="Vorige Woche, KW 41"><span aria-hidden="true">‹<\/span> <span class="pager-kw">KW 41<\/span><\/a>/);
  assert.match(now, /<span class="pager-now" aria-current="date">Diese Woche<\/span>/);
  assert.match(now, /<a href="\/\?woche=2026-W43" rel="next" class="pager-step" aria-label="Nächste Woche, KW 43"><span class="pager-kw">KW 43<\/span> <span aria-hidden="true">›<\/span><\/a>/);
  const next = renderWeek(await cockpit.week('2026-W43'));
  assert.match(next, /<a href="\/" class="pager-now" aria-label="Diese Woche"><span class="pager-kw">Diese Woche<\/span><span class="pager-short" aria-hidden="true">Heute<\/span><\/a>/);
});

test('noteOrigin: Zurück zur Herkunft aus Adresse oder Referer, nie nach außen', () => {
  const o = 'https://cockpit.test';
  assert.deepEqual(noteOrigin(null, 'https://cockpit.test/?woche=2026-W42', o), { path: '/?woche=2026-W42', href: '/?woche=2026-W42#inbox', label: 'Zur Inbox' });
  assert.deepEqual(noteOrigin('/graph?pfad=a.md', 'https://cockpit.test/', o), { path: '/graph?pfad=a.md', href: '/graph?pfad=a.md', label: 'Zum Graphen' });
  assert.equal(noteOrigin(null, 'https://cockpit.test/lesen/stapel', o).label, 'Zurück');
  assert.equal(noteOrigin(null, 'https://cockpit.test/notiz?pfad=b.md', o), null);
  assert.equal(noteOrigin(null, 'https://evil.test/graph', o), null);
  assert.equal(noteOrigin('//evil.test/x', null, o), null);
  assert.equal(noteOrigin(null, 'kaputt', o), null);
  // Normalisiert zu `//evil.test`: kein Link nach außen.
  assert.equal(noteOrigin('/x/..//evil.test', null, o), null);
  assert.equal(noteOrigin(null, 'https://cockpit.test/x/..//evil.test', o), null);
  assert.equal(noteOrigin(null, null, o), null);
});

test('inline: Wikilinks, Code, Betonung, Escaping', () => {
  assert.equal(inline('[[Ziel|Sichtbar]] und [[Notiz]]'), 'Sichtbar und Notiz');
  assert.equal(inline('*kursiv* **fett** `x<y`'), '<em>kursiv</em> <strong>fett</strong> <code>x&lt;y</code>');
});

test('Wochenmodell: laufende Flamme kommt oben an, auch aus einer anderen Woche', async () => {
  const tasks = [
    ...TASKS,
    { id: 'b1', title: 'Alt', status: 'in_progress', due: null, location: loc('Programmieren'), flame_running: true, flame_started_at: '2026-10-13T06:00:00Z' },
    { id: 'b2', title: 'Neu', status: 'in_progress', due: null, location: loc('Programmieren'), flame_running: true, flame_started_at: '2026-10-13T08:00:00Z' },
  ];
  const cockpit = createCockpit({ index: fakeIndex([]), settings: settingsWith(), zunderFor: () => fakeZunder(tasks), now: fixedNow, logger: quiet });
  const m = await cockpit.week('2026-W40');
  assert.equal(m.burning.id, 'b2');
  assert.equal(m.burning.startedAt, '2026-10-13T08:00:00Z');
  assert.equal(m.burning.running, true);
  const none = await createCockpit({ index: fakeIndex([]), settings: settingsWith(), zunderFor: () => fakeZunder(TASKS), now: fixedNow, logger: quiet }).week();
  assert.equal(none.burning, null);
});

test('Rückblick: je Bereich erledigt gegen geplant, außerdem Erledigtes und Flammen-Zeit', async () => {
  const tasks = [
    ...TASKS,
    { id: 'e1', title: 'Nebenbei', status: 'done', due: null, closed: '2026-10-13', location: loc('Arbeitnehmer'), flame_started_at: '2026-10-13T08:00:00Z', flame_ended_at: '2026-10-13T08:45:00Z' },
    { id: 'e2', title: 'Odoo W3', status: 'done', due: '2026-10-16', closed: '2026-10-14', location: loc('Arbeitnehmer') },
  ].map((t) => (t.id === 'd2' ? { ...t, closed: '2026-10-14' } : t));
  const cockpit = createCockpit({ index: fakeIndex([]), settings: settingsWith(), zunderFor: () => fakeZunder(tasks), now: fixedNow, logger: quiet });
  const r = await cockpit.review('2026-W42');
  assert.equal(r.ok, true);
  const by = Object.fromEntries(r.areas.map((a) => [a.area, a]));
  // Arbeitnehmer: d2 + e2 geplant und erledigt, x1 verworfen zählt nicht; e1 außerdem erledigt, 45 min Flamme.
  assert.deepEqual([by.Arbeitnehmer.planned, by.Arbeitnehmer.done, by.Arbeitnehmer.extra, by.Arbeitnehmer.minutes], [2, 2, 1, 45]);
  assert.deepEqual([by['Phönix-Progression'].planned, by['Phönix-Progression'].done, by['Phönix-Progression'].minutes], [1, 1, 90]);
  assert.deepEqual(by['Ehrenamt (DRK Bereitschaft)'].open.map((t) => t.id), ['d1']);
  assert.deepEqual(r.totals, { planned: 5, done: 3, extra: 1, minutes: 135 });
  assert.deepEqual(r.flames.map((f) => [f.id, f.minutes]), [['f1', 90]]);
  assert.equal(await cockpit.review('2026-W99'), null);

  const off = createCockpit({ index: fakeIndex([]), settings: settingsWith({ zunder: false }), zunderFor: () => assert.fail(), now: fixedNow, logger: quiet });
  assert.equal((await off.review()).unconfigured, true);
});

test('Zweimal gebrannte Flamme: Wochenansicht, Rückblick und Feuer-Notiz zeigen dieselbe Summe, Verlauf geteilt (VCP-118)', async () => {
  const twice = {
    id: 'f2', title: 'Flamme Steuer', status: 'done', due: '2026-10-13', location: loc('Finanzen'), phoenix: { fire: '2026-W42', role: 'flamme' },
    flame_started_at: '2026-10-13T13:00:00Z', flame_ended_at: '2026-10-13T14:30:00Z',
  };
  const history = [
    { seq: 1, field: 'flame_started_at', value: '2026-10-12T08:00:00Z' },
    { seq: 2, field: 'flame_ended_at', value: '2026-10-12T08:30:00Z' },
    { seq: 3, field: 'flame_started_at', value: '2026-10-13T13:00:00Z' },
    { seq: 4, field: 'flame_ended_at', value: null },
    { seq: 5, field: 'flame_ended_at', value: '2026-10-13T14:30:00Z' },
  ];
  const asked = [];
  const zunder = { ...fakeZunder([...TASKS, twice]), async taskHistory(id) { asked.push(id); return id === 'f2' ? history : []; } };
  const blocks = createFlameBlocks({ logger: quiet });
  const cockpit = createCockpit({ index: fakeIndex([]), settings: settingsWith(), zunderFor: () => zunder, flameBlocks: blocks, now: fixedNow, logger: quiet });

  const week = await cockpit.week('2026-W42');
  assert.equal(week.flames.data.find((f) => f.id === 'f2').minutes, 120);
  const review = await cockpit.review('2026-W42');
  assert.equal(review.flames.find((f) => f.id === 'f2').minutes, 120);
  assert.equal(review.areas.find((a) => a.area === 'Finanzen').minutes, 120);
  const note = flameRows([twice], { tz: TZ, blocks: await blocks.of(zunder, [twice], { scope: '2026-W42' }) });
  assert.equal(note[0].measured, '120');
  // Der Verlauf je Flamme nur einmal, solange sich ihr letzter Block nicht ändert.
  assert.deepEqual(asked.filter((id) => id === 'f2'), ['f2']);

  // Rückblick: ein Block der Vorwoche zählt dort, nicht hier.
  const spread = { ...twice, id: 'f3', flame_started_at: '2026-10-13T13:00:00Z', flame_ended_at: '2026-10-13T14:00:00Z' };
  const spreadHistory = [
    { seq: 1, field: 'flame_started_at', value: '2026-10-09T08:00:00Z' },
    { seq: 2, field: 'flame_ended_at', value: '2026-10-09T08:40:00Z' },
    { seq: 3, field: 'flame_started_at', value: '2026-10-13T13:00:00Z' },
    { seq: 4, field: 'flame_ended_at', value: '2026-10-13T14:00:00Z' },
  ];
  const z2 = { ...fakeZunder([spread].map((t) => ({ ...t, phoenix: { fire: '2026-W41', role: 'flamme' }, closed: '2026-10-13' }))), async taskHistory() { return spreadHistory; } };
  const c2 = createCockpit({ index: fakeIndex([]), settings: settingsWith(), zunderFor: () => z2, now: fixedNow, logger: quiet });
  assert.deepEqual((await c2.review('2026-W42')).flames.map((f) => [f.id, f.minutes]), [['f3', 60]]);
  assert.deepEqual((await c2.review('2026-W41')).flames.map((f) => [f.id, f.minutes]), [['f3', 40]]);

  // Verlauf ausgefallen: weiter der letzte Block.
  const broken = { ...fakeZunder([...TASKS, twice]), async taskHistory() { throw new Error('HTTP 500'); } };
  const c3 = createCockpit({ index: fakeIndex([]), settings: settingsWith(), zunderFor: () => broken, now: fixedNow, logger: quiet });
  assert.equal((await c3.week('2026-W42')).flames.data.find((f) => f.id === 'f2').minutes, 90);
  assert.equal((await c3.review('2026-W42')).flames.find((f) => f.id === 'f2').minutes, 90);
});

test('Rückblick: ungeplant gebrannte Aufgabe zählt in ihren Bereich, dieselbe Summe wie die Feuer-Notiz (VCP-127)', async () => {
  // Offen, ohne Fälligkeit, ohne Flammen-Markierung: weder geplant noch erledigt.
  const unplanned = {
    id: 'u1', title: 'Rücken üben', status: 'open', due: null, location: loc('Gesundheit'), phoenix: null,
    flame_started_at: '2026-10-14T10:00:00Z', flame_ended_at: '2026-10-14T10:45:00Z', updated_at: '2026-10-14T10:45:00Z',
  };
  // Läuft seit dieser Woche: zählt noch nicht.
  const running = { id: 'u2', title: 'Lesen', status: 'in_progress', due: null, location: loc('Gesundheit'), flame_running: true, flame_started_at: '2026-10-15T07:00:00Z', updated_at: '2026-10-15T07:00:00Z' };
  const history = [
    { seq: 1, field: 'flame_started_at', value: '2026-10-09T08:00:00Z' },
    { seq: 2, field: 'flame_ended_at', value: '2026-10-09T08:40:00Z' },
    { seq: 3, field: 'flame_started_at', value: '2026-10-13T08:00:00Z' },
    { seq: 4, field: 'flame_ended_at', value: '2026-10-13T08:30:00Z' },
    { seq: 5, field: 'flame_started_at', value: '2026-10-14T10:00:00Z' },
    { seq: 6, field: 'flame_ended_at', value: '2026-10-14T10:45:00Z' },
  ];
  const zunder = { ...fakeZunder([...TASKS, unplanned, running]), async taskHistory(id) { return id === 'u1' ? history : []; } };
  const blocks = createFlameBlocks({ logger: quiet });
  const cockpit = createCockpit({ index: fakeIndex([]), settings: settingsWith(), zunderFor: () => zunder, flameBlocks: blocks, now: fixedNow, logger: quiet });

  const review = await cockpit.review('2026-W42');
  const health = review.areas.find((a) => a.area === 'Gesundheit');
  // Der Block der Vorwoche zählt nicht, 30 + 45 min schon.
  assert.deepEqual([health.planned, health.done, health.extra, health.minutes], [0, 0, 0, 75]);
  assert.equal(review.totals.minutes, 90 + 75);
  assert.equal(review.flames.some((f) => f.id === 'u1'), false);

  // Feuer-Notiz: derselbe Weg (burnedSince, Block-Dienst, burnedInWeek).
  const week = describeWeek({ year: 2026, week: 42 }, TZ);
  const others = await burnedSince(zunder, week);
  const all = await blocks.of(zunder, others, { scope: week.id });
  const extra = burnedInWeek(others, all, week);
  const note = flameRows([], { tz: TZ, blocks: extra.blocks, burned: extra.burned });
  assert.equal(note.find((r) => r.title === 'Rücken üben').measured, String(health.minutes));

  // Suche fällt aus: Rückblick bleibt, ohne die ungeplante Zeit.
  const failing = { ...zunder, async filterTasks(f) { if (f.order_by === 'updated') throw new Error('HTTP 502'); return zunder.filterTasks(f); } };
  const c2 = createCockpit({ index: fakeIndex([]), settings: settingsWith(), zunderFor: () => failing, now: fixedNow, logger: quiet });
  const r2 = await c2.review('2026-W42');
  assert.equal(r2.ok, true);
  assert.equal(r2.areas.some((a) => a.area === 'Gesundheit'), false);
});

test('Flammen-Verlauf: eine Seite wartet nur bis zur Frist, die späte Antwort landet im Cache (VCP-118)', async () => {
  const t = { id: 'f2', flame_started_at: '2026-10-13T13:00:00Z', flame_ended_at: '2026-10-13T14:30:00Z' };
  let answer;
  const z = { taskHistory: () => new Promise((resolve) => (answer = resolve)) };
  const blocks = createFlameBlocks({ logger: quiet });
  const started = Date.now();
  assert.equal((await blocks.of(z, [t], { budgetMs: 30 })).size, 0);
  assert.ok(Date.now() - started < 1000);
  answer([
    { seq: 1, field: 'flame_started_at', value: '2026-10-13T13:00:00Z' },
    { seq: 2, field: 'flame_ended_at', value: '2026-10-13T14:30:00Z' },
  ]);
  await new Promise((r) => setImmediate(r));
  const asked = { taskHistory: () => assert.fail('aus dem Cache') };
  assert.deepEqual((await blocks.of(asked, [t])).get('f2'), [{ start: '2026-10-13T13:00:00Z', end: '2026-10-13T14:30:00Z' }]);
});

test('Flammen-Verlauf: eine späte Antwort zu einem älteren Block ersetzt keinen neueren Cache-Eintrag (VCP-118)', async () => {
  const old = { id: 'f2', flame_started_at: '2026-10-13T13:00:00Z', flame_ended_at: null };
  const now = { ...old, flame_ended_at: '2026-10-13T14:30:00Z' };
  const done = [
    { seq: 1, field: 'flame_started_at', value: '2026-10-13T13:00:00Z' },
    { seq: 2, field: 'flame_ended_at', value: '2026-10-13T14:30:00Z' },
  ];
  let slow;
  const blocks = createFlameBlocks({ logger: quiet });
  await blocks.of({ taskHistory: () => new Promise((resolve) => (slow = resolve)) }, [old], { budgetMs: 10 });
  assert.equal((await blocks.of({ taskHistory: async () => done }, [now])).get('f2').length, 1);
  slow([{ seq: 1, field: 'flame_started_at', value: '2026-10-13T13:00:00Z' }]);
  await new Promise((r) => setImmediate(r));
  assert.equal((await blocks.of({ taskHistory: () => assert.fail('aus dem Cache') }, [now])).get('f2').length, 1);
});

test('Flammen-Verlauf: ein älterer Lauf, dessen Abruf erst später startet, überschreibt keinen neueren Cache-Eintrag (VCP-118)', async () => {
  const old = { id: 'f2', flame_started_at: '2026-10-13T13:00:00Z', flame_ended_at: null };
  const other = { id: 'f1', flame_started_at: '2026-10-12T08:00:00Z', flame_ended_at: '2026-10-12T08:30:00Z' };
  const now = { ...old, flame_ended_at: '2026-10-13T14:30:00Z' };
  const done = [
    { seq: 1, field: 'flame_started_at', value: '2026-10-13T13:00:00Z' },
    { seq: 2, field: 'flame_ended_at', value: '2026-10-13T14:30:00Z' },
  ];
  let release;
  const gate = new Promise((r) => (release = r));
  const blocks = createFlameBlocks({ logger: quiet, parallel: 1 });
  // Älterer Lauf: f1 hält den einzigen Platz, f2 wartet in der Schlange.
  const older = blocks.of({ taskHistory: async (id) => (id === 'f1' ? (await gate, []) : [{ seq: 1, field: 'flame_started_at', value: '2026-10-13T13:00:00Z' }]) }, [other, old], { scope: 'a' });
  assert.equal((await blocks.of({ taskHistory: async () => done }, [now], { scope: 'b' })).get('f2').length, 1);
  release();
  await older;
  assert.equal((await blocks.of({ taskHistory: () => assert.fail('aus dem Cache') }, [now])).get('f2').length, 1);
});
