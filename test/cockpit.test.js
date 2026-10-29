import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeWeek, parseWeekId, weekOf, zonedToUtc, localDate } from '../src/cockpit/week.js';
import { parseCalendars, calendarData, createCalDavClient } from '../src/cockpit/caldav.js';
import { parseEvents } from '../src/cockpit/ics.js';
import { createSettingsStore } from '../src/cockpit/settings.js';
import { findFeuer, sectionParagraph } from '../src/cockpit/feuer.js';
import { createCockpit, areaOf } from '../src/cockpit/data.js';
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

test('renderWeek: vergangene Tage treten zurück, heute steht im Kopf der Termine', async () => {
  const cockpit = createCockpit({ index: fakeIndex([feuerNote()]), settings: settingsWith(), zunderFor: () => fakeZunder(TASKS), now: fixedNow, logger: quiet });
  const m = await cockpit.week();
  m.calendar = {
    ok: true,
    data: [
      { label: 'Mo 12.10.', today: false, events: [{ title: 'A', start: new Date('2026-10-12T08:00:00Z'), allDay: false }] },
      { label: 'Di 13.10.', today: true, events: [] },
      { label: 'Mi 14.10.', today: false, events: [] },
    ],
  };
  const html = renderWeek(m);
  assert.match(html, /<div class="day past">\s*<h3>Mo 12\.10\. <span class="day-count">1 Termin<\/span><\/h3>/);
  assert.match(html, /<div class="day today">/);
  assert.match(html, /<h2>Termine <span class="hint">heute frei<\/span><\/h2>/);
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
  ];
  const cockpit = createCockpit({ index: fakeIndex([feuerNote()]), settings: settingsWith(), zunderFor: () => fakeZunder(tasks), now: fixedNow, logger: quiet });
  const m = await cockpit.week();
  m.calendar = { ok: true, data: [{ label: 'Mi 14.10.', today: true, events: [{ title: 'Workshop', start: new Date('2026-10-14T12:00:00Z'), allDay: false }] }] };
  const html = renderWeek(m);
  // Datum steht nicht mehr in der Meta-Zeile, sondern als Schild hinter dem Titel.
  assert.match(html, /Helfermappe drucken<\/a> <span class="due" title="Fällig Fr 16\.10\.">Fr 16\.10\.<\/span><span class="meta">Gruppe I&amp;K<\/span>/);
  assert.match(html, /<li class="task status-open overdue"[^>]*data-title="Seite für Personalentwicklung"/);
  // Arbeitnehmer ist komplett erledigt: eine Zeile zum Aufklappen.
  assert.match(html, /<details class="rock all-done">\s*<summary><h3>Arbeitnehmer <span class="count" data-count>1\/1<\/span><\/h3><\/summary>/);
  assert.match(html, /<article class="rock">\s*<h3>Finanzen/);
  // Heute: Termin, heute Fälliges und Überfälliges aus der Woche, nichts Späteres.
  assert.match(html, /<main class="week-main today-first">/);
  const heute = html.match(/<section class="heute"[\s\S]*?<\/section>/)[0];
  assert.match(heute, /<h2>Heute <span class="hint">Mi 14\.10\.<\/span><\/h2>/);
  assert.match(heute, /14:00<\/span>\s*<span class="title">Workshop/);
  assert.match(heute, /Heute fällig/);
  assert.match(heute, /Seit Montag fällig/);
  assert.doesNotMatch(heute, /Helfermappe/);

  const other = await cockpit.week('2026-W43');
  assert.doesNotMatch(renderWeek(other), /class="heute"|today-first/);
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
