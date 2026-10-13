import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eventsInRange } from '../src/cockpit/ics.js';
import { describeWeek } from '../src/cockpit/week.js';

const TZ = 'Europe/Berlin';
const W42 = describeWeek({ year: 2026, week: 42 }, TZ); // Mo 12.10. – So 18.10.2026
const W44 = describeWeek({ year: 2026, week: 44 }, TZ); // nach der Zeitumstellung

const cal = (...events) => ['BEGIN:VCALENDAR', ...events.flatMap((e) => ['BEGIN:VEVENT', ...e, 'END:VEVENT']), 'END:VCALENDAR'].join('\r\n');
const local = (d) =>
  new Intl.DateTimeFormat('sv-SE', { timeZone: TZ, dateStyle: 'short', timeStyle: 'short' }).format(d);
const starts = (evs) => evs.map((e) => local(e.start));

test('Wöchentlich an mehreren Tagen, Uhrzeit bleibt über die Zeitumstellung gleich', () => {
  const ics = cal(['UID:daily', 'SUMMARY:Daily', 'DTSTART;TZID=Europe/Berlin:20260907T084500', 'DTEND;TZID=Europe/Berlin:20260907T090000', 'RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR']);
  assert.deepEqual(starts(eventsInRange(ics, W42.start, W42.end, TZ)), ['2026-10-12 08:45', '2026-10-14 08:45', '2026-10-16 08:45']);
  const after = eventsInRange(ics, W44.start, W44.end, TZ);
  assert.deepEqual(starts(after), ['2026-10-26 08:45', '2026-10-28 08:45', '2026-10-30 08:45']);
  assert.equal(after[0].start.toISOString(), '2026-10-26T07:45:00.000Z');
  assert.equal(after[0].end - after[0].start, 15 * 60_000);
});

test('INTERVAL, COUNT und UNTIL begrenzen die Serie', () => {
  const every2 = cal(['UID:a', 'SUMMARY:Jour fixe', 'DTSTART;TZID=Europe/Berlin:20260928T100000', 'DURATION:PT1H', 'RRULE:FREQ=WEEKLY;INTERVAL=2']);
  assert.deepEqual(starts(eventsInRange(every2, W42.start, W42.end, TZ)), ['2026-10-12 10:00']);
  assert.deepEqual(starts(eventsInRange(every2, describeWeek({ year: 2026, week: 43 }, TZ).start, describeWeek({ year: 2026, week: 43 }, TZ).end, TZ)), []);

  const count = cal(['UID:b', 'SUMMARY:Kurs', 'DTSTART;TZID=Europe/Berlin:20261001T180000', 'RRULE:FREQ=DAILY;COUNT=13']);
  assert.deepEqual(starts(eventsInRange(count, W42.start, W42.end, TZ)), ['2026-10-12 18:00', '2026-10-13 18:00']);

  const until = cal(['UID:c', 'SUMMARY:Bis Mittwoch', 'DTSTART;TZID=Europe/Berlin:20261001T070000', 'RRULE:FREQ=DAILY;UNTIL=20261014T050000Z']);
  assert.deepEqual(starts(eventsInRange(until, W42.start, W42.end, TZ)), ['2026-10-12 07:00', '2026-10-13 07:00', '2026-10-14 07:00']);
});

test('EXDATE fällt weg, RECURRENCE-ID verschiebt oder sagt einzelne Termine ab', () => {
  const ics = cal(
    ['UID:s', 'SUMMARY:Standup', 'DTSTART;TZID=Europe/Berlin:20261005T093000', 'DTEND;TZID=Europe/Berlin:20261005T094500', 'RRULE:FREQ=DAILY', 'EXDATE;TZID=Europe/Berlin:20261013T093000,20261015T093000'],
    ['UID:s', 'RECURRENCE-ID;TZID=Europe/Berlin:20261014T093000', 'SUMMARY:Standup (verschoben)', 'DTSTART;TZID=Europe/Berlin:20261014T111500', 'DTEND;TZID=Europe/Berlin:20261014T113000'],
    ['UID:s', 'RECURRENCE-ID;TZID=Europe/Berlin:20261016T093000', 'STATUS:CANCELLED', 'SUMMARY:Standup', 'DTSTART;TZID=Europe/Berlin:20261016T093000'],
  );
  const evs = eventsInRange(ics, W42.start, W42.end, TZ);
  assert.deepEqual(
    evs.map((e) => `${local(e.start)} ${e.title}`),
    ['2026-10-12 09:30 Standup', '2026-10-14 11:15 Standup (verschoben)', '2026-10-17 09:30 Standup', '2026-10-18 09:30 Standup'],
  );
});

test('Monatlich: n-ter Wochentag, letzter Wochentag, Monatstag mit Lücken', () => {
  const second = cal(['UID:m1', 'SUMMARY:Stammtisch', 'DTSTART;TZID=Europe/Berlin:20260112T190000', 'RRULE:FREQ=MONTHLY;BYDAY=2MO']);
  assert.deepEqual(starts(eventsInRange(second, W42.start, W42.end, TZ)), ['2026-10-12 19:00']);

  const last = cal(['UID:m2', 'SUMMARY:Monatsabschluss', 'DTSTART;TZID=Europe/Berlin:20260130T150000', 'RRULE:FREQ=MONTHLY;BYDAY=-1FR']);
  const oct = { start: new Date('2026-10-01T00:00:00Z'), end: new Date('2026-11-01T00:00:00Z') };
  assert.deepEqual(starts(eventsInRange(last, oct.start, oct.end, TZ)), ['2026-10-30 15:00']);

  const thirtyFirst = cal(['UID:m3', 'SUMMARY:Ultimo', 'DTSTART;VALUE=DATE:20260131', 'RRULE:FREQ=MONTHLY']);
  const year = eventsInRange(thirtyFirst, new Date('2026-01-01T00:00:00Z'), new Date('2027-01-01T00:00:00Z'), TZ);
  assert.deepEqual(year.map((e) => local(e.start).slice(5, 10)), ['01-31', '03-31', '05-31', '07-31', '08-31', '10-31', '12-31']);
});

test('Jährlich ganztägig (Geburtstag), über Jahre zurück', () => {
  const ics = cal(['UID:y', 'SUMMARY:Geburtstag', 'DTSTART;VALUE=DATE:19900415', 'DTEND;VALUE=DATE:19900416', 'RRULE:FREQ=YEARLY']);
  const evs = eventsInRange(ics, new Date('2026-04-13T00:00:00Z'), new Date('2026-04-20T00:00:00Z'), TZ);
  assert.equal(evs.length, 1);
  assert.equal(evs[0].allDay, true);
  assert.equal(evs[0].start.toISOString(), '2026-04-14T22:00:00.000Z');
  assert.equal(evs[0].end.toISOString(), '2026-04-15T22:00:00.000Z');
});

test('Andere Zeitzone und UTC-Serie werden korrekt umgerechnet', () => {
  const ny = cal(['UID:ny', 'SUMMARY:Call NY', 'DTSTART;TZID=America/New_York:20261005T090000', 'DURATION:PT30M', 'RRULE:FREQ=WEEKLY']);
  assert.deepEqual(starts(eventsInRange(ny, W42.start, W42.end, TZ)), ['2026-10-12 15:00']);
  const utc = cal(['UID:u', 'SUMMARY:UTC', 'DTSTART:20261005T060000Z', 'RRULE:FREQ=WEEKLY;BYDAY=TU']);
  assert.deepEqual(starts(eventsInRange(utc, W42.start, W42.end, TZ)), ['2026-10-13 08:00']);
});

test('Nicht unterstützte Regeln zeigen nur den ersten Termin, RDATE ergänzt', () => {
  const setpos = cal(['UID:sp', 'SUMMARY:Letzter Werktag', 'DTSTART;TZID=Europe/Berlin:20261012T100000', 'RRULE:FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1']);
  assert.deepEqual(starts(eventsInRange(setpos, W42.start, W42.end, TZ)), ['2026-10-12 10:00']);
  const rdate = cal(['UID:rd', 'SUMMARY:Extra', 'DTSTART;TZID=Europe/Berlin:20261001T100000', 'DURATION:PT1H', 'RRULE:FREQ=MONTHLY;COUNT=2', 'RDATE;TZID=Europe/Berlin:20261015T100000']);
  assert.deepEqual(starts(eventsInRange(rdate, W42.start, W42.end, TZ)), ['2026-10-15 10:00']);
});

test('Lange tägliche Serie bleibt schnell', () => {
  const ics = cal(['UID:old', 'SUMMARY:Seit 2010', 'DTSTART;TZID=Europe/Berlin:20100101T070000', 'RRULE:FREQ=DAILY']);
  const t = performance.now();
  assert.equal(eventsInRange(ics, W42.start, W42.end, TZ).length, 7);
  assert.ok(performance.now() - t < 500);
});
