/**
 * ISO-Wochen in einer festen Zeitzone (Standard Europe/Berlin).
 *
 * Das Cockpit denkt in Wochen, nicht in Tagen. Eine Woche läuft von Montag
 * 00:00 bis Montag 00:00 Ortszeit; ihre Kennung (`2026-W42`) ist dieselbe,
 * die Zunder für Phönix-Feuer verwendet.
 */

const WEEKDAYS = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
const DAY_MS = 86_400_000;

const pad = (n) => String(n).padStart(2, '0');
const isoDate = (ms) => new Date(ms).toISOString().slice(0, 10);

const formatters = new Map();

/** Kalenderdatum und Uhrzeit eines Zeitpunkts in der Zeitzone. */
export function zonedParts(date, tz) {
  if (!formatters.has(tz)) formatters.set(tz, makeFormatter(tz));
  const parts = formatters.get(tz).formatToParts(date);
  const get = (t) => Number(parts.find((p) => p.type === t).value);
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour'), minute: get('minute'), second: get('second') };
}

function makeFormatter(tz) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

/** Versatz der Zeitzone gegenüber UTC zu einem Zeitpunkt, in Millisekunden. */
function offsetAt(ms, tz) {
  const p = zonedParts(new Date(ms), tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}

/** Ortszeit in der Zeitzone → Zeitpunkt (Date). Sommerzeitwechsel werden nachgerechnet. */
export function zonedToUtc({ year, month, day, hour = 0, minute = 0, second = 0 }, tz) {
  const wall = Date.UTC(year, month - 1, day, hour, minute, second);
  let ms = wall - offsetAt(wall, tz);
  ms = wall - offsetAt(ms, tz);
  return new Date(ms);
}

/** ISO-Jahr und -Woche eines Kalenderdatums (UTC-Mitternacht als Millisekunden). */
function isoWeekOf(dayMs) {
  const dow = (new Date(dayMs).getUTCDay() + 6) % 7; // Mo = 0
  const thursday = dayMs + (3 - dow) * DAY_MS;
  const year = new Date(thursday).getUTCFullYear();
  const week = 1 + Math.floor((thursday - Date.UTC(year, 0, 1)) / (7 * DAY_MS));
  return { year, week };
}

function mondayOf(year, week) {
  const jan4 = Date.UTC(year, 0, 4);
  const dow = (new Date(jan4).getUTCDay() + 6) % 7;
  return jan4 - dow * DAY_MS + (week - 1) * 7 * DAY_MS;
}

const weeksIn = (year) => isoWeekOf(Date.UTC(year, 11, 28)).week;

export const weekId = ({ year, week }) => `${year}-W${pad(week)}`;

/** `2026-W42` → `{year, week}`; null bei ungültiger Kennung. */
export function parseWeekId(id) {
  const m = /^(\d{4})-W(\d{2})$/.exec(String(id ?? ''));
  if (!m) return null;
  const year = Number(m[1]);
  const week = Number(m[2]);
  if (week < 1 || week > weeksIn(year)) return null;
  return { year, week };
}

/** Die Woche, in der ein Zeitpunkt in der Zeitzone liegt. */
export function weekOf(date, tz) {
  const p = zonedParts(date, tz);
  return isoWeekOf(Date.UTC(p.year, p.month - 1, p.day));
}

/**
 * Alles, was die Wochenansicht über eine Woche wissen muss: Kennung, Tage,
 * Grenzen als Zeitpunkte und die Nachbarwochen.
 */
export function describeWeek({ year, week }, tz) {
  const monday = mondayOf(year, week);
  const days = WEEKDAYS.map((label, i) => {
    const ms = monday + i * DAY_MS;
    const d = new Date(ms);
    return {
      date: isoDate(ms),
      label: `${label} ${pad(d.getUTCDate())}.${pad(d.getUTCMonth() + 1)}.`,
      start: zonedToUtc({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() }, tz),
    };
  });
  const after = new Date(monday + 7 * DAY_MS);
  const end = zonedToUtc({ year: after.getUTCFullYear(), month: after.getUTCMonth() + 1, day: after.getUTCDate() }, tz);
  days.forEach((d, i) => (d.end = i < 6 ? days[i + 1].start : end));
  return {
    id: weekId({ year, week }),
    year,
    week,
    monday: days[0].date,
    sunday: days[6].date,
    days,
    start: days[0].start,
    end,
    prev: weekId(isoWeekOf(monday - 7 * DAY_MS)),
    next: weekId(isoWeekOf(monday + 7 * DAY_MS)),
  };
}

/** Kalenderdatum (JJJJ-MM-TT) eines Zeitpunkts in der Zeitzone. */
export function localDate(date, tz) {
  const p = zonedParts(date, tz);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** Uhrzeit (HH:MM) eines Zeitpunkts in der Zeitzone. */
export function localTime(date, tz) {
  const p = zonedParts(date, tz);
  return `${pad(p.hour)}:${pad(p.minute)}`;
}

/** Kalenderdatum ± Tage, beides als JJJJ-MM-TT. */
export function addDays(date, n) {
  const [y, m, d] = date.split('-').map(Number);
  return isoDate(Date.UTC(y, m - 1, d) + n * DAY_MS);
}
