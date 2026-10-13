import { zonedToUtc } from './week.js';

/**
 * iCalendar (RFC 5545) lesen: VEVENTs, Zeitzonen, ganztägige Termine und
 * Serientermine.
 *
 * Ein iCal-Abo liefert Serien als Muster (RRULE), nicht als einzelne Termine;
 * `eventsInRange` löst sie für ein Zeitfenster selbst auf. Abgedeckt ist, was
 * Kalender-Apps praktisch erzeugen: DAILY/WEEKLY/MONTHLY/YEARLY mit INTERVAL,
 * COUNT, UNTIL, BYDAY (auch „2. Montag“, „letzter Freitag“), BYMONTHDAY,
 * BYMONTH, dazu EXDATE, RDATE und geänderte Einzeltermine (RECURRENCE-ID).
 * BYSETPOS, BYWEEKNO, BYYEARDAY und stündliche Regeln werden nicht aufgelöst;
 * solche Serien erscheinen nur mit ihrem ersten Termin.
 */

const DAY_MS = 86_400_000;
const WEEKDAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];
const MAX_STEPS = 20_000;

const unescapeText = (v) => v.replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1');

function parseLine(line) {
  const colon = line.search(/:(?=(?:[^"]*"[^"]*")*[^"]*$)/);
  if (colon === -1) return null;
  const [name, ...params] = line.slice(0, colon).split(';');
  const p = {};
  for (const kv of params) {
    const i = kv.indexOf('=');
    if (i > 0) p[kv.slice(0, i).toUpperCase()] = kv.slice(i + 1).replace(/^"|"$/g, '');
  }
  return { name: name.toUpperCase(), params: p, value: line.slice(colon + 1) };
}

/** Die VEVENTs als Eigenschaftslisten (Name → alle Vorkommen); VALARM & Co. fallen weg. */
export function parseVevents(ics) {
  const lines = String(ics).replace(/\r?\n[ \t]/g, '').split(/\r?\n/);
  const out = [];
  let depth = 0;
  let current = null;
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (line === 'BEGIN:VEVENT') {
      current = {};
      depth = 0;
      continue;
    }
    if (!current) continue;
    if (line === 'END:VEVENT' && depth === 0) {
      out.push(current);
      current = null;
    } else if (line.startsWith('BEGIN:')) depth += 1;
    else if (line.startsWith('END:') && depth > 0) depth -= 1;
    else if (depth === 0) {
      const prop = parseLine(line);
      if (prop) (current[prop.name] ??= []).push(prop);
    }
  }
  return out;
}

function validZone(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Ein Datumswert als Wandzeit plus Zone. `zone` ist `UTC` bei `…Z`, sonst die
 * TZID oder die Standardzone; ganztägige Werte rechnen in der Standardzone.
 */
function parseValue(value, params, tz) {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(String(value).trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, s, z] = m;
  const allDay = params.VALUE === 'DATE' || h === undefined;
  const zone = allDay ? tz : z ? 'UTC' : params.TZID && validZone(params.TZID) ? params.TZID : tz;
  return {
    allDay,
    zone,
    wall: { year: +y, month: +mo, day: +d, hour: +(h ?? 0), minute: +(mi ?? 0), second: +(s ?? 0) },
  };
}

const instant = (v) => (v.zone === 'UTC' ? new Date(Date.UTC(v.wall.year, v.wall.month - 1, v.wall.day, v.wall.hour, v.wall.minute, v.wall.second)) : zonedToUtc(v.wall, v.zone));

function parseDuration(v) {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(String(v ?? '').trim());
  if (!m) return 0;
  const [, sign, w, d, h, mi, s] = m;
  const ms = ((+(w ?? 0) * 7 + +(d ?? 0)) * 86_400 + +(h ?? 0) * 3600 + +(mi ?? 0) * 60 + +(s ?? 0)) * 1000;
  return sign === '-' ? -ms : ms;
}

/** Alle Zeitpunkte aus EXDATE- bzw. RDATE-Zeilen (auch Komma-Listen). */
function dateList(props, tz) {
  const out = [];
  for (const p of props ?? []) {
    for (const v of p.value.split(',')) {
      const parsed = parseValue(v, p.params, tz);
      if (parsed) out.push(instant(parsed).getTime());
    }
  }
  return out;
}

function baseEvent(props, tz) {
  const first = (n) => props[n]?.[0];
  if (first('STATUS')?.value.trim().toUpperCase() === 'CANCELLED') return { cancelled: true };
  const startProp = first('DTSTART');
  const start = startProp && parseValue(startProp.value, startProp.params, tz);
  if (!start) return null;
  const startAt = instant(start);
  const endProp = first('DTEND');
  const end = endProp && parseValue(endProp.value, endProp.params, tz);
  let durationMs;
  if (end) durationMs = instant(end).getTime() - startAt.getTime();
  else if (first('DURATION')) durationMs = parseDuration(first('DURATION').value);
  else durationMs = start.allDay ? DAY_MS : 0;
  const summary = first('SUMMARY') ? unescapeText(first('SUMMARY').value).trim() : '';
  const location = first('LOCATION') ? unescapeText(first('LOCATION').value).trim() : '';
  return {
    uid: first('UID')?.value.trim() ?? null,
    title: summary || '(ohne Titel)',
    location: location || null,
    allDay: start.allDay,
    start,
    startAt,
    durationMs: Math.max(0, durationMs),
    // Ganztägige Termine: Länge in Tagen, damit Sommerzeitwechsel nichts verschieben.
    days: start.allDay ? Math.max(1, Math.round(durationMs / DAY_MS)) : null,
  };
}

function occurrence(ev, wall) {
  const start = instant({ ...ev.start, wall });
  let end;
  if (ev.allDay) {
    const d = new Date(Date.UTC(wall.year, wall.month - 1, wall.day) + ev.days * DAY_MS);
    end = instant({ ...ev.start, wall: { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), hour: 0, minute: 0, second: 0 } });
  } else {
    end = new Date(start.getTime() + ev.durationMs);
  }
  return { title: ev.title, start, end, allDay: ev.allDay, location: ev.location };
}

function parseRule(value) {
  const rule = {};
  for (const part of String(value).split(';')) {
    const [k, v] = part.split('=');
    if (k && v !== undefined) rule[k.toUpperCase()] = v;
  }
  const list = (k) => (rule[k] ? rule[k].split(',').map((s) => s.trim()).filter(Boolean) : null);
  const byday = list('BYDAY')?.map((s) => {
    const m = /^([+-]?\d{1,2})?(MO|TU|WE|TH|FR|SA|SU)$/.exec(s.toUpperCase());
    return m ? { n: m[1] ? Number(m[1]) : 0, wd: WEEKDAYS.indexOf(m[2]) } : null;
  });
  return {
    freq: String(rule.FREQ ?? '').toUpperCase(),
    interval: Math.max(1, Number(rule.INTERVAL ?? 1) || 1),
    count: rule.COUNT ? Number(rule.COUNT) : null,
    until: rule.UNTIL ?? null,
    byday: byday?.every(Boolean) ? byday : byday ? [] : null,
    bymonthday: list('BYMONTHDAY')?.map(Number).filter((n) => n && Math.abs(n) <= 31) ?? null,
    bymonth: list('BYMONTH')?.map(Number).filter((n) => n >= 1 && n <= 12) ?? null,
    unsupported: Boolean(rule.BYSETPOS || rule.BYWEEKNO || rule.BYYEARDAY || rule.BYHOUR || rule.BYMINUTE),
  };
}

const utcDay = (y, m, d) => Date.UTC(y, m - 1, d);
const dow = (ms) => (new Date(ms).getUTCDay() + 6) % 7; // Mo = 0
const daysIn = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** Tage eines Monats (UTC-Millisekunden) nach BYDAY/BYMONTHDAY. */
function monthDays(y, m, rule, startDay) {
  const n = daysIn(y, m);
  let days;
  if (rule.bymonthday) {
    days = rule.bymonthday.map((d) => (d > 0 ? d : n + 1 + d)).filter((d) => d >= 1 && d <= n);
    if (rule.byday) days = days.filter((d) => rule.byday.some((b) => b.wd === dow(utcDay(y, m, d))));
  } else if (rule.byday) {
    days = [];
    for (const b of rule.byday) {
      const matching = [];
      for (let d = 1; d <= n; d++) if (dow(utcDay(y, m, d)) === b.wd) matching.push(d);
      if (!b.n) days.push(...matching);
      else {
        const pick = b.n > 0 ? matching[b.n - 1] : matching[matching.length + b.n];
        if (pick) days.push(pick);
      }
    }
  } else {
    days = startDay <= n ? [startDay] : [];
  }
  return [...new Set(days)].sort((a, b) => a - b).map((d) => utcDay(y, m, d));
}

/**
 * Wandzeit-Daten einer Serie, aufsteigend, ab DTSTART. `stop(dayMs)` beendet
 * die Erzeugung, sobald ein Tag hinter dem gesuchten Fenster liegt.
 */
function* candidateDays(rule, s) {
  const startDay = utcDay(s.year, s.month, s.day);
  if (rule.freq === 'DAILY') {
    for (let k = 0; k < MAX_STEPS; k++) {
      const day = startDay + k * rule.interval * DAY_MS;
      const d = new Date(day);
      if (rule.bymonth && !rule.bymonth.includes(d.getUTCMonth() + 1)) continue;
      if (rule.byday && !rule.byday.some((b) => b.wd === dow(day))) continue;
      yield day;
    }
  }
  if (rule.freq === 'WEEKLY') {
    const weekStart = startDay - dow(startDay) * DAY_MS;
    const wds = rule.byday?.length ? [...new Set(rule.byday.map((b) => b.wd))].sort() : [dow(startDay)];
    for (let k = 0; k < MAX_STEPS; k++) {
      for (const wd of wds) yield weekStart + (k * rule.interval * 7 + wd) * DAY_MS;
    }
  }
  if (rule.freq === 'MONTHLY') {
    for (let k = 0; k < MAX_STEPS; k++) {
      const total = s.month - 1 + k * rule.interval;
      const y = s.year + Math.floor(total / 12);
      const m = (total % 12) + 1;
      if (rule.bymonth && !rule.bymonth.includes(m)) continue;
      yield* monthDays(y, m, rule, s.day);
    }
  }
  if (rule.freq === 'YEARLY') {
    const months = rule.bymonth ?? [s.month];
    for (let k = 0; k < MAX_STEPS; k++) {
      const y = s.year + k * rule.interval;
      for (const m of [...months].sort((a, b) => a - b)) {
        const r = rule.byday || rule.bymonthday ? rule : { ...rule, bymonthday: [s.day] };
        yield* monthDays(y, m, r, s.day);
      }
    }
  }
}

function expand(ev, rule, props, tz, rangeStart, rangeEnd) {
  const out = [];
  const s = ev.start.wall;
  const until = rule.until ? parseValue(rule.until, {}, ev.start.zone === 'UTC' ? 'UTC' : ev.start.zone) : null;
  const untilAt = until ? (until.allDay ? instant(until).getTime() + DAY_MS - 1 : instant(until).getTime()) : Infinity;
  const exdates = new Set(dateList(props.EXDATE, tz));
  const startMs = ev.startAt.getTime();
  let count = 0;
  let steps = 0;
  for (const day of candidateDays(rule, s)) {
    if (++steps > MAX_STEPS) break;
    // Weit vor dem Fenster muss nur COUNT mitzählen; ohne COUNT reicht ein Sprung.
    if (rule.count === null && day + ev.durationMs + ((ev.days ?? 1) + 2) * DAY_MS < rangeStart.getTime()) continue;
    const d = new Date(day);
    const wall = { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), hour: s.hour, minute: s.minute, second: s.second };
    const occ = occurrence(ev, wall);
    const t = occ.start.getTime();
    if (t < startMs) continue;
    if (t > untilAt) break;
    if (rule.count !== null && count >= rule.count) break;
    count += 1;
    if (occ.start >= rangeEnd) break;
    if (!exdates.has(t) && occ.end > rangeStart) out.push(occ);
  }
  for (const t of dateList(props.RDATE, tz)) {
    if (exdates.has(t)) continue;
    const occ = { title: ev.title, start: new Date(t), end: new Date(t + (ev.allDay ? ev.days * DAY_MS : ev.durationMs)), allDay: ev.allDay, location: ev.location };
    if (occ.start < rangeEnd && occ.end > rangeStart) out.push(occ);
  }
  return out;
}

/**
 * Termine eines iCalendar-Texts, die das Intervall [rangeStart, rangeEnd)
 * berühren. Serien werden aufgelöst, geänderte und abgesagte Einzeltermine
 * ersetzen die Serie an ihrer Stelle.
 */
export function eventsInRange(ics, rangeStart, rangeEnd, tz = 'Europe/Berlin') {
  const byUid = new Map();
  const loose = [];
  for (const props of parseVevents(ics)) {
    const uid = props.UID?.[0]?.value.trim();
    if (!uid) {
      loose.push(props);
      continue;
    }
    if (!byUid.has(uid)) byUid.set(uid, { master: null, overrides: [] });
    const g = byUid.get(uid);
    if (props['RECURRENCE-ID']) g.overrides.push(props);
    else g.master = props;
  }

  const out = [];
  const inRange = (o) => o.start < rangeEnd && o.end > rangeStart;
  const single = (props) => {
    const ev = baseEvent(props, tz);
    if (!ev || ev.cancelled) return;
    const occ = occurrence(ev, ev.start.wall);
    if (inRange(occ)) out.push(occ);
  };

  for (const props of loose) single(props);
  for (const { master, overrides } of byUid.values()) {
    const replaced = new Set();
    for (const o of overrides) {
      const rid = o['RECURRENCE-ID'][0];
      const v = parseValue(rid.value, rid.params, tz);
      if (v) replaced.add(instant(v).getTime());
      single(o);
    }
    if (!master) continue;
    const ev = baseEvent(master, tz);
    if (!ev || ev.cancelled) continue;
    const rrule = master.RRULE?.[0];
    const rule = rrule ? parseRule(rrule.value) : null;
    if (!rule || !['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(rule.freq) || rule.unsupported) {
      if (!replaced.has(ev.startAt.getTime())) single(master);
      continue;
    }
    for (const occ of expand(ev, rule, master, tz, rangeStart, rangeEnd)) {
      if (!replaced.has(occ.start.getTime())) out.push(occ);
    }
  }
  return out.sort((a, b) => a.start - b.start || Number(b.allDay) - Number(a.allDay));
}

/** Alle Termine ohne Serienauflösung (jeder VEVENT einmal), für Tests und Vorschauen. */
export function parseEvents(ics, tz = 'Europe/Berlin') {
  return eventsInRange(ics.replace(/\r?\nRRULE:[^\r\n]*/g, ''), new Date(-8.64e15), new Date(8.64e15), tz);
}

