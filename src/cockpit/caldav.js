import { zonedToUtc } from './week.js';

/**
 * Liest Termine per CalDAV (Fastmail, aber nicht darauf beschränkt).
 *
 * `url` ist das Kalender-Home des Kontos, bei Fastmail
 * `https://caldav.fastmail.com/dav/calendars/user/<adresse>/`. Die Kalender
 * darunter werden per PROPFIND gefunden; Termine einer Woche holt ein
 * `calendar-query` mit `expand`, damit der Server Serientermine selbst auflöst.
 * Nur lesend; geschrieben wird nie.
 */
export function createCalDavClient({
  url,
  username,
  password,
  calendars: only = [],
  tz = 'Europe/Berlin',
  fetch = globalThis.fetch,
  timeoutMs = 15_000,
  cacheMs = 5 * 60_000,
  now = () => Date.now(),
}) {
  const home = String(url).endsWith('/') ? String(url) : `${url}/`;
  const auth = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
  const wanted = only.map((s) => s.trim().toLowerCase()).filter(Boolean);
  let calendarList = null;
  const cache = new Map();

  async function dav(method, target, depth, body) {
    const res = await fetch(target, {
      method,
      headers: { authorization: auth, depth: String(depth), 'content-type': 'application/xml; charset=utf-8' },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status !== 207) throw new Error(`CalDAV ${method} antwortet mit HTTP ${res.status}`);
    return res.text();
  }

  async function listCalendars() {
    if (calendarList && now() - calendarList.at < 60 * 60_000) return calendarList.items;
    const xml = await dav(
      'PROPFIND',
      home,
      1,
      `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop><d:displayname/><d:resourcetype/><c:supported-calendar-component-set/></d:prop>
</d:propfind>`,
    );
    const items = parseCalendars(xml, home).filter(
      (c) => !wanted.length || wanted.includes(c.name.toLowerCase()),
    );
    calendarList = { at: now(), items };
    return items;
  }

  async function eventsOf(calendar, start, end) {
    const range = `start="${davTime(start)}" end="${davTime(end)}"`;
    const xml = await dav(
      'REPORT',
      calendar.href,
      1,
      `<?xml version="1.0" encoding="utf-8"?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop><c:calendar-data><c:expand ${range}/></c:calendar-data></d:prop>
  <c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:time-range ${range}/></c:comp-filter></c:comp-filter></c:filter>
</c:calendar-query>`,
    );
    return calendarData(xml)
      .flatMap((ics) => parseEvents(ics, tz))
      .filter((e) => e.start < end && e.end > start)
      .map((e) => ({ ...e, calendar: calendar.name }));
  }

  return {
    /** Termine, die das Intervall [start, end) berühren, nach Beginn sortiert. */
    async events(start, end) {
      const key = `${start.getTime()}-${end.getTime()}`;
      const hit = cache.get(key);
      if (hit && now() - hit.at < cacheMs) return hit.events;
      const calendars = await listCalendars();
      const lists = await Promise.all(calendars.map((c) => eventsOf(c, start, end)));
      const events = lists.flat().sort((a, b) => a.start - b.start || Number(b.allDay) - Number(a.allDay));
      cache.set(key, { at: now(), events });
      for (const [k, v] of cache) if (now() - v.at >= cacheMs) cache.delete(k);
      return events;
    },
  };
}

const davTime = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

const tag = (name) => new RegExp(`<(?:[\\w-]+:)?${name}\\b[^>]*?(?:/>|>([\\s\\S]*?)</(?:[\\w-]+:)?${name}>)`, 'g');

function decodeXml(s) {
  return String(s ?? '')
    .replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/, '$1')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Kalender-Sammlungen aus einer PROPFIND-Antwort; Aufgabenlisten ohne VEVENT fallen weg. */
export function parseCalendars(xml, base) {
  const out = [];
  for (const [response] of xml.matchAll(tag('response'))) {
    const href = [...response.matchAll(tag('href'))][0]?.[1];
    const types = [...response.matchAll(tag('resourcetype'))][0]?.[1] ?? '';
    if (!href || !/<(?:[\w-]+:)?calendar\s*\/?>/.test(types)) continue;
    const comps = [...response.matchAll(tag('supported-calendar-component-set'))][0]?.[1];
    if (comps && !/name="VEVENT"/i.test(comps)) continue;
    const name = decodeXml([...response.matchAll(tag('displayname'))][0]?.[1] ?? '').trim();
    const target = new URL(decodeXml(href).trim(), base).href;
    out.push({ href: target, name: name || decodeURIComponent(target.replace(/\/$/, '').split('/').pop()) });
  }
  return out;
}

/** Die iCalendar-Texte einer REPORT-Antwort. */
export function calendarData(xml) {
  return [...xml.matchAll(tag('calendar-data'))].map((m) => decodeXml((m[1] ?? '').trim())).filter(Boolean);
}

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

function validZone(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function parseDate(prop, tz) {
  const v = prop.value.trim();
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(v);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, z] = m;
  const parts = { year: +y, month: +mo, day: +d, hour: +(h ?? 0), minute: +(mi ?? 0), second: +(s ?? 0) };
  if (prop.params.VALUE === 'DATE' || h === undefined) {
    return { date: zonedToUtc(parts, tz), allDay: true };
  }
  if (z) return { date: new Date(Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second)), allDay: false };
  const zone = prop.params.TZID && validZone(prop.params.TZID) ? prop.params.TZID : tz;
  return { date: zonedToUtc(parts, zone), allDay: false };
}

function parseDuration(v) {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(String(v ?? '').trim());
  if (!m) return 0;
  const [, sign, w, d, h, mi, s] = m;
  const ms = ((+(w ?? 0) * 7 + +(d ?? 0)) * 86_400 + +(h ?? 0) * 3600 + +(mi ?? 0) * 60 + +(s ?? 0)) * 1000;
  return sign === '-' ? -ms : ms;
}

/** VEVENTs eines iCalendar-Texts; abgesagte Termine fallen weg. */
export function parseEvents(ics, tz = 'Europe/Berlin') {
  const lines = String(ics).replace(/\r?\n[ \t]/g, '').split(/\r?\n/);
  const events = [];
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
    if (line.startsWith('BEGIN:')) depth += 1;
    else if (line.startsWith('END:') && depth > 0) depth -= 1;
    else if (line === 'END:VEVENT') {
      const ev = toEvent(current, tz);
      if (ev) events.push(ev);
      current = null;
    } else if (depth === 0) {
      const prop = parseLine(line);
      if (prop && !(prop.name in current)) current[prop.name] = prop;
    }
  }
  return events;
}

function toEvent(props, tz) {
  if (props.STATUS?.value.trim().toUpperCase() === 'CANCELLED') return null;
  const start = props.DTSTART && parseDate(props.DTSTART, tz);
  if (!start) return null;
  let end = props.DTEND && parseDate(props.DTEND, tz);
  let endDate = end?.date;
  if (!endDate) {
    const dur = props.DURATION ? parseDuration(props.DURATION.value) : 0;
    endDate = new Date(start.date.getTime() + (dur || (start.allDay ? 86_400_000 : 0)));
  }
  return {
    title: props.SUMMARY ? unescapeText(props.SUMMARY.value).trim() || '(ohne Titel)' : '(ohne Titel)',
    start: start.date,
    end: endDate,
    allDay: start.allDay,
    location: props.LOCATION ? unescapeText(props.LOCATION.value).trim() || null : null,
  };
}
