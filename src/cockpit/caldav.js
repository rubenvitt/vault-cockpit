import { eventsInRange } from './ics.js';

/**
 * Liest Termine per CalDAV (Fastmail, aber nicht darauf beschränkt).
 *
 * `url` ist das Kalender-Home des Kontos, bei Fastmail
 * `https://caldav.fastmail.com/dav/calendars/user/<adresse>/`, oder ein
 * einzelner Kalender. Die Kalender darunter werden per PROPFIND gefunden; Termine einer Woche holt ein
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
  const auth = username ? `Basic ${Buffer.from(`${username}:${password ?? ''}`).toString('base64')}` : null;
  const wanted = only.map((s) => s.trim().toLowerCase()).filter(Boolean);
  let calendarList = null;
  const cache = new Map();

  async function dav(method, target, depth, body) {
    const res = await fetch(target, {
      method,
      headers: { ...(auth ? { authorization: auth } : {}), depth: String(depth), 'content-type': 'application/xml; charset=utf-8' },
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
      .flatMap((ics) => eventsInRange(ics, start, end, tz))
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
