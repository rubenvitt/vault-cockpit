import { createCalDavClient } from './caldav.js';
import { eventsInRange } from './ics.js';

/**
 * iCal-Abo: eine `.ics`-Adresse, die der Kalender als Ganzes liefert
 * (z. B. ein geteilter Fastmail-Kalender, `webcal://` geht auch). Serien löst
 * `eventsInRange` selbst auf. Optional mit Basic-Auth.
 */
export function createIcsClient({ url, username = null, password = null, tz = 'Europe/Berlin', fetch = globalThis.fetch, timeoutMs = 15_000, cacheMs = 5 * 60_000, now = () => Date.now() }) {
  const target = String(url).replace(/^webcal:/i, 'https:');
  let cached = null;

  async function load() {
    if (cached && now() - cached.at < cacheMs) return cached.text;
    const headers = { accept: 'text/calendar, */*;q=0.5' };
    if (username) headers.authorization = `Basic ${Buffer.from(`${username}:${password ?? ''}`).toString('base64')}`;
    const res = await fetch(target, { headers, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`iCal-Abruf antwortet mit HTTP ${res.status}`);
    const text = await res.text();
    if (!text.includes('BEGIN:VCALENDAR')) throw new Error('Antwort ist kein iCalendar');
    cached = { at: now(), text };
    return text;
  }

  return {
    async events(start, end) {
      return eventsInRange(await load(), start, end, tz);
    },
  };
}

/**
 * Alle eingestellten Kalender zusammen. Die Liste kommt bei jedem Abruf frisch
 * aus den Einstellungen; Clients (und ihr Cache) bleiben erhalten, solange sich
 * ein Kalender nicht ändert. Fällt einer aus, liefern die anderen weiter.
 */
export function createCalendarSources({ settings, fetch = globalThis.fetch, now = () => Date.now() }) {
  const clients = new Map();

  function clientFor(cal, tz) {
    const key = JSON.stringify([cal, tz]);
    if (!clients.has(key)) {
      const common = { url: cal.url, username: cal.username || null, password: cal.password || null, tz, fetch, now };
      clients.set(key, cal.kind === 'caldav' ? createCalDavClient({ ...common, calendars: cal.filter ?? [] }) : createIcsClient(common));
    }
    return clients.get(key);
  }

  return {
    /** Ob überhaupt ein Kalender eingestellt ist. */
    configured: () => settings.get().calendars.length > 0,

    /** Je Kalender (nach `id`): erreichbar mit Anzahl Termine oder Fehler, für die Einstellungsseite. */
    async check(start, end) {
      const { calendars, tz } = settings.get();
      const results = await Promise.allSettled(calendars.map((c) => clientFor(c, tz).events(start, end)));
      return Object.fromEntries(
        results.map((r, i) => [
          calendars[i].id,
          r.status === 'fulfilled' ? { ok: true, count: r.value.length } : { ok: false, error: r.reason?.message ?? String(r.reason) },
        ]),
      );
    },

    /** `{ events, errors }`: Termine aller Kalender im Intervall, Fehler je Kalender. */
    async events(start, end) {
      const { calendars, tz } = settings.get();
      const live = new Set(calendars.map((c) => JSON.stringify([c, tz])));
      for (const key of clients.keys()) if (!live.has(key)) clients.delete(key);

      const results = await Promise.allSettled(calendars.map((c) => clientFor(c, tz).events(start, end)));
      const events = [];
      const errors = [];
      results.forEach((r, i) => {
        const name = calendars[i].name;
        if (r.status === 'fulfilled') events.push(...r.value.map((e) => ({ ...e, calendar: name })));
        else errors.push({ calendar: name, error: r.reason?.message ?? String(r.reason) });
      });
      events.sort((a, b) => a.start - b.start || Number(b.allDay) - Number(a.allDay));
      return { events, errors };
    },
  };
}
