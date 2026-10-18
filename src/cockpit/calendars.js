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

const titleKey = (t) => String(t ?? '').trim().toLowerCase();

/**
 * Alle eingestellten Kalender zusammen. Die Liste kommt bei jedem Abruf frisch
 * aus den Einstellungen; Clients (und ihr Cache) bleiben erhalten, solange sich
 * ein Kalender nicht ändert. Fällt einer aus, liefern die anderen weiter.
 */
export function createCalendarSources({ settings, fetch = globalThis.fetch, now = () => Date.now() }) {
  const clients = new Map();
  // Letzter Abruf je Kalender (gleicher Schlüssel wie die Clients), für die Zustandsseite.
  const seen = new Map();
  const keyOf = (cal, tz) => JSON.stringify([cal, tz]);

  function note(calendars, tz, results) {
    results.forEach((r, i) => {
      const key = keyOf(calendars[i], tz);
      const s = seen.get(key) ?? {};
      if (r.status === 'fulfilled') seen.set(key, { ...s, okAt: now(), count: r.value.length, failing: false });
      else seen.set(key, { ...s, errorAt: now(), error: r.reason?.message ?? String(r.reason), failing: true });
    });
  }

  function clientFor(cal, tz) {
    const key = keyOf(cal, tz);
    if (!clients.has(key)) {
      const common = { url: cal.url, username: cal.username || null, password: cal.password || null, tz, fetch, now };
      clients.set(key, cal.kind === 'caldav' ? createCalDavClient({ ...common, calendars: cal.filter ?? [] }) : createIcsClient(common));
    }
    return clients.get(key);
  }

  return {
    /**
     * Letzter Abruf je eingestelltem Kalender, ohne neu abzurufen: `lastOkAt`
     * mit Anzahl Termine, `lastErrorAt` mit Fehlertext, `failing`, wenn der
     * jüngste Abruf scheiterte. Ein geänderter Kalender beginnt von vorn.
     */
    status() {
      const { calendars, tz } = settings.get();
      const iso = (ms) => (ms ? new Date(ms).toISOString() : null);
      return calendars.map((c) => {
        const s = seen.get(keyOf(c, tz)) ?? {};
        return { id: c.id, name: c.name, kind: c.kind, lastOkAt: iso(s.okAt), count: s.count ?? null, lastErrorAt: iso(s.errorAt), lastError: s.error ?? null, failing: Boolean(s.failing) };
      });
    },

    /** Ob überhaupt ein Kalender eingestellt ist. */
    configured: () => settings.get().calendars.length > 0,

    /** Je Kalender (nach `id`): erreichbar mit Anzahl Termine oder Fehler, für die Einstellungsseite. */
    async check(start, end) {
      const { calendars, tz } = settings.get();
      const results = await Promise.allSettled(calendars.map((c) => clientFor(c, tz).events(start, end)));
      note(calendars, tz, results);
      return Object.fromEntries(
        results.map((r, i) => [
          calendars[i].id,
          r.status === 'fulfilled' ? { ok: true, count: r.value.length } : { ok: false, error: r.reason?.message ?? String(r.reason) },
        ]),
      );
    },

    /**
     * `{ events, errors }`: Termine aller Kalender im Intervall, Fehler je
     * Kalender. Termine, deren Titel auf der Ausblendliste steht (z. B.
     * „Blockiert“), fehlen.
     */
    async events(start, end) {
      const { calendars, tz, hiddenEvents = [] } = settings.get();
      const hidden = new Set(hiddenEvents.map(titleKey));
      const live = new Set(calendars.map((c) => keyOf(c, tz)));
      for (const key of clients.keys()) if (!live.has(key)) clients.delete(key);
      for (const key of seen.keys()) if (!live.has(key)) seen.delete(key);

      const results = await Promise.allSettled(calendars.map((c) => clientFor(c, tz).events(start, end)));
      note(calendars, tz, results);
      const events = [];
      const errors = [];
      results.forEach((r, i) => {
        const name = calendars[i].name;
        if (r.status === 'fulfilled') events.push(...r.value.filter((e) => !hidden.has(titleKey(e.title))).map((e) => ({ ...e, calendar: name })));
        else errors.push({ calendar: name, error: r.reason?.message ?? String(r.reason) });
      });
      events.sort((a, b) => a.start - b.start || Number(b.allDay) - Number(a.allDay));
      return { events, errors };
    },
  };
}

/**
 * Sicht für den Graphen: `null`-artig, solange kein Kalender eingestellt ist,
 * sonst die Termine aller Kalender. Fallen alle aus, ein Fehler; fällt nur
 * einer aus, kommen die übrigen Termine.
 */
export function calendarForGraph(sources) {
  return {
    configured: () => sources.configured(),
    async events(start, end) {
      const { events, errors } = await sources.events(start, end);
      if (errors.length && !events.length) throw new Error(errors.map((e) => `${e.calendar}: ${e.error}`).join('; '));
      return events;
    },
  };
}
