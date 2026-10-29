import { describeWeek, weekOf, parseWeekId, weekId, localDate, addDays } from './week.js';
import { findFeuer } from './feuer.js';
import { flameMinutes } from './flammen-notiz.js';
import { createFlameBlocks } from './flammen-bloecke.js';

const OPEN = ['open', 'in_progress', 'blocked'];

/** Name des Lebensbereichs einer Zunder-Aufgabe (Bereich bzw. Bereich ihres Projekts). */
export function areaOf(task) {
  const loc = task.location ?? {};
  if (loc.kind === 'project') return loc.area_name ?? 'Ohne Bereich';
  if (loc.kind === 'area') return loc.area_name ?? loc.name ?? 'Ohne Bereich';
  if (loc.kind === 'inbox') return 'Inbox';
  return 'Ohne Bereich';
}

/** Wie lange eine Seite höchstens auf den Verlauf der Flammen wartet (ms); danach zählt der letzte Block. */
const PAGE_HISTORY_BUDGET_MS = 5_000;

const byDue = (a, b) => String(a.due ?? '9999').localeCompare(String(b.due ?? '9999')) || a.title.localeCompare(b.title);

/**
 * Stellt die Wochenansicht zusammen: Feuer-Ziel, Flammen, Big Rocks je
 * Lebensbereich, Termine, offene Aufgaben und Inbox.
 *
 * Jede Quelle wird für sich geholt. Fällt eine aus (Zunder nicht erreichbar,
 * CalDAV-Passwort falsch), zeigt ihr Abschnitt den Fehler, der Rest bleibt.
 *
 * `flameBlocks` (`createFlameBlocks`) teilt den Verlauf der Flammen mit der
 * Feuer-Notiz, damit Seiten und Notiz dieselben Minuten zeigen (VCP-118).
 */
export function createCockpit({ index, settings, zunderFor, calendars = null, flameBlocks = null, now = () => new Date(), logger = console }) {
  flameBlocks ??= createFlameBlocks({ logger });
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

  const blocksOf = (zunder, tasks, scope) => flameBlocks.of(zunder, tasks, { scope, budgetMs: PAGE_HISTORY_BUDGET_MS });

  /**
   * Flammen-Minuten einer Aufgabe in der Woche: jeder Block zählt in der Woche,
   * in der er begonnen hat. Ohne Verlauf nur der letzte Block (VCP-118).
   */
  const minutesIn = (t, blocks, week, tz) => {
    const list = blocks?.length ? blocks : t.flame_started_at && t.flame_ended_at ? [{ start: t.flame_started_at, end: t.flame_ended_at }] : [];
    return list
      .filter((b) => {
        const day = localDate(new Date(b.start), tz);
        return day >= week.monday && day <= week.sunday;
      })
      .reduce((sum, b) => sum + (flameMinutes(t, [b]) ?? 0), 0);
  };

  return {
    /**
     * Wochenrückblick: je Lebensbereich erledigt gegen geplant (Big Rocks und
     * Flammen der Woche), was außerdem erledigt wurde, und die Flammen-Zeit je
     * Bereich. Geplant heißt wie in der Wochenansicht: in der Woche fällig oder
     * Phönix-Markierung der Woche. Ungültige Kennung → null.
     */
    async review(id) {
      const config = settings.get();
      const { tz } = config;
      const zunder = zunderOf(config.zunder);
      const parsed = id ? parseWeekId(id) : weekOf(now(), tz);
      if (!parsed) return null;
      const week = describeWeek(parsed, tz);
      const today = localDate(now(), tz);
      const head = {
        tz,
        week: { id: week.id, year: week.year, week: week.week, monday: week.monday, sunday: week.sunday, prev: week.prev, next: week.next, current: week.monday <= today && today <= week.sunday },
      };
      if (!zunder) return { ...head, ok: false, error: 'Zunder ist nicht eingerichtet', unconfigured: true };
      const task = make(zunder);
      let phoenix, due, closed;
      try {
        [phoenix, due, closed] = await Promise.all([
          zunder.filterTasks({ phoenix_fire: week.id, include_closed: true, limit: 300 }),
          zunder.filterTasks({ due_after: week.monday, due_before: week.sunday, include_closed: true, limit: 500 }),
          zunder.filterTasks({ status: ['done'], closed_after: week.monday, closed_before: week.sunday, limit: 500 }),
        ]);
      } catch (err) {
        logger.warn?.(`Cockpit: Rückblick nicht verfügbar — ${err.message}`);
        return { ...head, ok: false, error: err.message };
      }

      const planned = new Map();
      for (const t of [...phoenix, ...due]) if (t.status !== 'dropped') planned.set(t.id, t);
      const extra = closed.filter((t) => !planned.has(t.id));
      // Flammen-Zeit: jeder Block, der in dieser Woche begonnen hat.
      const candidates = [...new Map([...planned.values(), ...closed].map((t) => [t.id, t])).values()];
      const blocks = await blocksOf(zunder, candidates, `rueckblick ${week.id}`);
      const flamed = new Map();
      for (const t of candidates) {
        const minutes = minutesIn(t, blocks.get(t.id), week, tz);
        if (minutes) flamed.set(t.id, { t, minutes });
      }

      const areas = new Map();
      const area = (name) => {
        if (!areas.has(name)) areas.set(name, { area: name, planned: 0, done: 0, extra: 0, minutes: 0, open: [] });
        return areas.get(name);
      };
      for (const t of planned.values()) {
        const a = area(areaOf(t));
        a.planned += 1;
        if (t.status === 'done') a.done += 1;
        else a.open.push(task(t));
      }
      for (const t of extra) area(areaOf(t)).extra += 1;
      for (const { t, minutes } of flamed.values()) area(areaOf(t)).minutes += minutes;

      const list = [...areas.values()].sort((a, b) => b.planned - a.planned || b.minutes - a.minutes || a.area.localeCompare(b.area, 'de'));
      for (const a of list) a.open.sort(byDue);
      const sum = (k) => list.reduce((n, a) => n + a[k], 0);
      return {
        ...head,
        ok: true,
        areas: list,
        totals: { planned: sum('planned'), done: sum('done'), extra: sum('extra'), minutes: sum('minutes') },
        flames: [...flamed.values()].filter(({ t }) => t.phoenix?.role === 'flamme').map(({ t, minutes }) => ({ ...task(t), minutes })),
      };
    },

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

      // Bereiche und Projekte, einmal je Aufruf: für die Dev-Projekte (VCP-41)
      // und die Ziele von „Zuordnen“. Fehlt sie, bleibt die Aufgabenliste ungefiltert.
      const areas = zunder ? settle('Zunder (Bereiche)', () => zunder.listStructure()) : null;

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
              // Dev-Aufgaben laufen über Branch und PR, nicht über die Woche (VCP-41).
              const s = await areas;
              const dev = new Set(s.ok ? s.data.flatMap((a) => (a.projects ?? []).filter((p) => p.kind === 'dev').map((p) => p.id)) : []);
              return [...running, ...overdue].filter((t) => !(t.location?.kind === 'project' && dev.has(t.location.id)));
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
      // Gezählt werden alle Blöcke, wie in der Feuer-Notiz (VCP-118).
      const flameTasks = phoenix.ok ? phoenix.data.filter((t) => t.phoenix?.role === 'flamme' && t.status !== 'dropped') : [];
      const blocks = flameTasks.length ? await blocksOf(zunder, flameTasks, week.id) : new Map();
      const flames = phoenix.ok
        ? flameTasks
            .map((t) => ({
              ...task(t),
              startedAt: t.flame_started_at ?? null,
              endedAt: t.flame_ended_at ?? null,
              running: Boolean(t.flame_running),
              minutes: flameMinutes(t, blocks.get(t.id) ?? null),
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
          ? await areas.then((s) =>
              s.ok
                ? {
                    ok: true,
                    data: s.data
                      .filter((a) => a.state !== 'archived')
                      .map((a) => ({
                        id: a.id,
                        name: a.name,
                        projects: (a.projects ?? []).filter((p) => !p.status || p.status === 'active').map((p) => ({ id: p.id, name: p.name })),
                      }))
                      .sort((a, b) => a.name.localeCompare(b.name, 'de')),
                  }
                : s,
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
        week: { id: week.id, year: week.year, week: week.week, monday: week.monday, sunday: week.sunday, prev: week.prev, next: week.next, current, past: week.sunday < today },
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
