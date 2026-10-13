import { describeWeek, weekOf, parseWeekId, weekId, localDate, addDays } from './week.js';
import { findFeuer } from './feuer.js';

const OPEN = ['open', 'in_progress', 'blocked'];

/** Name des Lebensbereichs einer Zunder-Aufgabe (Bereich bzw. Bereich ihres Projekts). */
export function areaOf(task) {
  const loc = task.location ?? {};
  if (loc.kind === 'project') return loc.area_name ?? 'Ohne Bereich';
  if (loc.kind === 'area') return loc.area_name ?? loc.name ?? 'Ohne Bereich';
  if (loc.kind === 'inbox') return 'Inbox';
  return 'Ohne Bereich';
}

const byDue = (a, b) => String(a.due ?? '9999').localeCompare(String(b.due ?? '9999')) || a.title.localeCompare(b.title);

/**
 * Stellt die Wochenansicht zusammen: Feuer-Ziel, Flammen, Big Rocks je
 * Lebensbereich, Termine, offene Aufgaben und Inbox.
 *
 * Jede Quelle wird für sich geholt. Fällt eine aus (Zunder nicht erreichbar,
 * CalDAV-Passwort falsch), zeigt ihr Abschnitt den Fehler, der Rest bleibt.
 */
export function createCockpit({ index, settings, zunderFor, calendars = null, now = () => new Date(), logger = console }) {
  // Zunder-Client je Zugang wiederverwenden; ändert sich der Zugang in den
  // Einstellungen, entsteht ein neuer.
  let zunderCache = { key: null, client: null };
  const zunderOf = (cfg) => {
    if (!cfg) return null;
    const key = `${cfg.url}\n${cfg.token}`;
    if (zunderCache.key !== key) zunderCache = { key, client: zunderFor(cfg) };
    return zunderCache.client;
  };

  const make = (zunder) => (t) => ({
    id: t.id,
    ref: t.ref ?? null,
    title: t.title,
    status: t.status,
    due: t.due ?? null,
    area: areaOf(t),
    project: t.location?.kind === 'project' ? (t.location.name ?? null) : null,
    phoenix: t.phoenix?.role ?? null,
    fire: t.phoenix?.fire ?? null,
    running: Boolean(t.flame_running),
    url: zunder.taskUrl(t.id),
  });

  async function settle(name, fn) {
    try {
      return { ok: true, data: await fn() };
    } catch (err) {
      logger.warn?.(`Cockpit: ${name} nicht verfügbar — ${err.message}`);
      return { ok: false, error: err.message };
    }
  }

  const notConfigured = (what) => ({ ok: false, error: `${what} ist nicht eingerichtet`, unconfigured: true });

  return {
    /** Zunder-Client für den aktuellen Zugang aus den Einstellungen, sonst null. */
    zunder: () => zunderOf(settings.get().zunder),

    /** Kennung der laufenden Woche. */
    currentWeekId: () => weekId(weekOf(now(), settings.get().tz)),

    /** Daten einer Woche (`2026-W42`, Standard: die laufende). Ungültige Kennung → null. */
    async week(id) {
      const config = settings.get();
      const { tz, inboxFolder: captureFolder } = config;
      const zunder = zunderOf(config.zunder);
      const task = zunder ? make(zunder) : null;
      const parsed = id ? parseWeekId(id) : weekOf(now(), tz);
      if (!parsed) return null;
      const week = describeWeek(parsed, tz);
      const today = localDate(now(), tz);
      const current = week.monday <= today && today <= week.sunday;

      const feuer = await settle('Feuer-Notiz', () => findFeuer(index, week, { current }));

      const [phoenix, due, open, zInbox, events, inbox, burning] = await Promise.all([
        zunder
          ? settle('Zunder (Phönix)', () => zunder.filterTasks({ phoenix_fire: week.id, include_closed: true, limit: 200 }))
          : notConfigured('Zunder'),
        zunder
          ? settle('Zunder (Woche)', () =>
              zunder.filterTasks({ due_after: week.monday, due_before: week.sunday, include_closed: true, limit: 300 }),
            )
          : notConfigured('Zunder'),
        zunder
          ? settle('Zunder (offen)', async () => {
              const [running, overdue] = await Promise.all([
                zunder.filterTasks({ status: ['in_progress'], limit: 100 }),
                zunder.filterTasks({ status: OPEN, due_before: addDays(today, -1), limit: 100 }),
              ]);
              return [...running, ...overdue];
            })
          : notConfigured('Zunder'),
        zunder
          ? settle('Zunder (Inbox)', () => zunder.filterTasks({ location: 'inbox', status: OPEN, limit: 50 }))
          : notConfigured('Zunder'),
        calendars?.configured() ? settle('Kalender', () => calendars.events(week.start, week.end)) : notConfigured('Kalender'),
        settle('Vault-Inbox', () => index.listFolder(captureFolder, { limit: 50 })),
        // Die gerade laufende Flamme, egal in welcher Woche sie geplant war.
        zunder ? settle('Zunder (Flamme)', () => zunder.filterTasks({ flame_running: true, limit: 5 })) : notConfigured('Zunder'),
      ]);

      // Flammen: Deep-Work-Blöcke der Woche. Geplant ist `due`, gemessen haben
      // Zunder und Timing — die Zeiten kommen von dort, nicht aus dem Vault.
      const flames = phoenix.ok
        ? phoenix.data
            .filter((t) => t.phoenix?.role === 'flamme' && t.status !== 'dropped')
            .map((t) => ({
              ...task(t),
              startedAt: t.flame_started_at ?? null,
              endedAt: t.flame_ended_at ?? null,
              running: Boolean(t.flame_running),
              minutes:
                t.flame_started_at && t.flame_ended_at
                  ? Math.round((Date.parse(t.flame_ended_at) - Date.parse(t.flame_started_at)) / 60_000)
                  : null,
            }))
            .sort(byDue)
        : null;

      // Big Rocks (entschieden 13.10.2026): fällig in der Woche oder Phönix-Schritt
      // der Woche, gruppiert nach Lebensbereich. Flammen stehen eigens oben.
      let rocks = null;
      const rockIds = new Set();
      if (phoenix.ok || due.ok) {
        const seen = new Map();
        const candidates = [
          ...(phoenix.ok ? phoenix.data.filter((t) => t.phoenix?.role === 'feuer_schritt') : []),
          ...(due.ok ? due.data.filter((t) => t.phoenix?.role !== 'flamme') : []),
        ];
        for (const t of candidates) if (t.status !== 'dropped' && !seen.has(t.id)) seen.set(t.id, task(t));
        const groups = new Map();
        for (const t of seen.values()) {
          rockIds.add(t.id);
          if (!groups.has(t.area)) groups.set(t.area, []);
          groups.get(t.area).push(t);
        }
        rocks = [...groups.entries()]
          .map(([area, tasks]) => ({ area, tasks: tasks.sort(byDue), done: tasks.filter((t) => t.status === 'done').length }))
          .sort((a, b) => a.area.localeCompare(b.area, 'de'));
      }

      const openTasks = open.ok
        ? [...new Map(open.data.map((t) => [t.id, task(t)])).values()]
            .filter((t) => !rockIds.has(t.id))
            .map((t) => ({ ...t, overdue: Boolean(t.due && t.due.slice(0, 10) < today) }))
            .sort(byDue)
        : null;

      const days = week.days.map((d) => ({
        date: d.date,
        label: d.label,
        today: d.date === today,
        events: events.ok ? events.data.events.filter((e) => e.start < d.end && e.end > d.start) : [],
      }));

      // Ziele für „Zuordnen“ in der Zunder-Inbox; nur nötig, wenn dort etwas liegt.
      const structure =
        zunder && zInbox.ok && zInbox.data.length
          ? await settle('Zunder (Bereiche)', async () =>
              (await zunder.listStructure())
                .filter((a) => a.state !== 'archived')
                .map((a) => ({
                  id: a.id,
                  name: a.name,
                  projects: (a.projects ?? []).filter((p) => !p.status || p.status === 'active').map((p) => ({ id: p.id, name: p.name })),
                }))
                .sort((a, b) => a.name.localeCompare(b.name, 'de')),
            )
          : { ok: true, data: [] };

      const live = burning.ok
        ? (burning.data
            .filter((t) => t.flame_running)
            .sort((a, b) => String(b.flame_started_at).localeCompare(String(a.flame_started_at)))
            .map((t) => ({ ...task(t), startedAt: t.flame_started_at ?? null }))[0] ?? null)
        : null;

      const section = (r, data) => (r.ok ? { ok: true, data } : { ok: false, error: r.error, unconfigured: Boolean(r.unconfigured) });

      return {
        tz,
        vaultName: config.vaultName,
        week: { id: week.id, year: week.year, week: week.week, monday: week.monday, sunday: week.sunday, prev: week.prev, next: week.next, current },
        today,
        feuer: section(feuer, feuer.data),
        burning: live,
        flames: section(phoenix, flames),
        rocks: phoenix.ok || due.ok ? { ok: true, data: rocks, partial: !(phoenix.ok && due.ok) } : section(phoenix),
        calendar: events.ok ? { ok: true, data: days, errors: events.data.errors } : section(events),
        tasks: section(open, openTasks),
        inbox: {
          vault: section(inbox, inbox.data),
          zunder: section(zInbox, zInbox.ok ? zInbox.data.map(task).sort(byDue) : null),
          targets: structure.ok ? structure.data : null,
          folder: captureFolder,
        },
      };
    },
  };
}
