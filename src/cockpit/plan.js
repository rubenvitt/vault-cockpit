import { describeWeek, weekOf, parseWeekId, localDate, zonedToUtc } from './week.js';
import { areaOf } from './data.js';
import { ActionError } from './actions.js';

/**
 * Wochenplanung im Cockpit (VCP-47): Zunder-Aufgaben suchen und in die
 * angezeigte Woche holen, je Bereich der Big Rocks offene Aufgaben ohne Termin
 * zeigen, Flammen einplanen und Aufgaben wieder aus der Woche nehmen.
 *
 * Geplant wird nur in Zunder, das Cockpit hält keinen eigenen Plan. „In der
 * Woche“ heißt wie in der Wochenansicht: Phönix-Markierung der Woche
 * (Feuer-Schritt oder Flamme) oder fällig in der Woche. Dev-Projekte laufen über
 * Branch und PR und tauchen hier nicht auf (VCP-41).
 */

const OPEN = ['open', 'in_progress', 'blocked'];
const TASK_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** Kennung wie VCP-47: findet die Aufgabe direkt, auch wenn die Volltextsuche sie nicht kennt. */
const REF = /^[A-Za-z][A-Za-z0-9]{0,15}-\d{1,9}$/;
/** Ort einer neuen Flamme: `area:<id>`, `project:<id>` oder `loose`. */
const PLACE = /^(?:(area|project):([A-Za-z0-9_-]{1,64})|loose)$/;
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DUE = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2}))?$/;
const MARK = /^(feuer_schritt|flamme):(\d{4}-W\d{2})$/;
/** So viele Vorschläge je Bereich; der Rest liegt hinter „alle“. */
const SUGGEST = 5;
const MAX_RESULTS = 30;

const byDue = (a, b) => String(a.due ?? '9999').localeCompare(String(b.due ?? '9999')) || a.title.localeCompare(b.title);

/** Phönix-Markierung als Formularwert (`flamme:2026-W42`), leer ohne. */
export const markOf = (phoenix) => (phoenix?.role && phoenix?.fire ? `${phoenix.role}:${phoenix.fire}` : '');

/** Bereiche, Zuordnung Projekt → Bereich und die Dev-Projekte aus `list_structure`. */
function structureOf(areas) {
  const dev = new Set();
  const projectArea = new Map();
  for (const a of areas) {
    for (const p of a.projects ?? []) {
      projectArea.set(p.id, a.id);
      if (p.kind === 'dev') dev.add(p.id);
    }
  }
  const list = areas
    .filter((a) => a.state !== 'archived')
    .map((a) => ({ id: a.id, name: a.name }))
    .sort((a, b) => a.name.localeCompare(b.name, 'de'));
  return { list, dev, projectArea };
}

const EMPTY = { list: [], dev: new Set(), projectArea: new Map() };

/** ID des Lebensbereichs einer Aufgabe (direkt oder über ihr Projekt), sonst null. */
function areaIdOf(t, s) {
  const loc = t.location ?? {};
  if (loc.kind === 'area') return loc.id ?? null;
  if (loc.kind === 'project') return loc.area_id ?? s.projectArea.get(loc.id) ?? null;
  return null;
}

const isDev = (t, s) => (t.location?.kind === 'project' && s.dev.has(t.location.id)) || t.type === 'bug' || t.type === 'feature';

export function createWeekPlanner({ settings, zunder, now = () => new Date(), logger = console }) {
  const weekFrom = (id) => {
    const { tz } = settings.get();
    const parsed = id ? parseWeekId(id) : weekOf(now(), tz);
    return parsed ? describeWeek(parsed, tz) : null;
  };
  const weekOrFail = (id) => {
    const week = parseWeekId(String(id ?? '').trim()) ? weekFrom(String(id).trim()) : null;
    if (!week) throw new ActionError(`„${id ?? ''}“ ist keine Kalenderwoche`);
    return week;
  };
  const zunderOrFail = () => {
    const z = zunder();
    if (!z) throw new ActionError('Zunder ist nicht eingerichtet (Einstellungen → Zunder)', 503);
    return z;
  };
  const checkId = (id) => {
    if (!TASK_ID.test(String(id ?? ''))) throw new ActionError('Unbekannte Aufgabe');
  };
  /** Zunder-Aufruf; Fehler dort werden 502, eine leere Antwort auch. */
  const call = async (fn) => {
    let task;
    try {
      task = await fn(zunderOrFail());
    } catch (err) {
      if (err instanceof ActionError) throw err;
      throw new ActionError(err.message, 502);
    }
    if (!task) throw new ActionError('Zunder hat die Aufgabe nicht zurückgegeben', 502);
    return task;
  };
  const summary = (task) => ({
    id: task.id,
    ref: task.ref ?? null,
    title: task.title,
    status: task.status,
    due: task.due ?? null,
    phoenix: task.phoenix ?? null,
    location: task.location ?? null,
  });

  async function settle(name, fn) {
    try {
      return { ok: true, data: await fn() };
    } catch (err) {
      logger.warn?.(`Planung: ${name} nicht verfügbar — ${err.message}`);
      return { ok: false, error: err.message };
    }
  }
  const section = (r, data) => (r.ok ? { ok: true, data } : { ok: false, error: r.error });

  /** Suchtreffer oder offene Aufgaben eines Bereichs, ohne Dev-Projekte und Abgeschlossenes. */
  async function find(z, q, area, s) {
    let hits;
    if (q) {
      const [found, direct] = await Promise.all([
        z.search(q, { limit: 60 }),
        REF.test(q) ? z.getTask(q).catch(() => null) : null,
      ]);
      hits = direct ? [direct, ...found.filter((t) => t.id !== direct.id)] : found;
      if (area) hits = hits.filter((t) => areaIdOf(t, s) === area);
    } else {
      hits = (await z.filterTasks({ area_id: area, status: OPEN, limit: 100 })).sort(byDue);
    }
    // Die Suche findet auch Erledigtes; geholt wird nur, was noch offen ist.
    return hits.filter((t) => (!t.status || OPEN.includes(t.status)) && !isDev(t, s)).slice(0, MAX_RESULTS);
  }

  return {
    /**
     * Daten der Planungsseite einer Woche (Standard: die laufende). `q` sucht
     * in Zunder, `area` (Bereichs-ID) filtert bzw. listet die offenen Aufgaben
     * eines Bereichs, `from` (Aufgaben-ID) füllt „Flamme einplanen“ vor.
     * Ungültige Woche → null.
     */
    async view(id, { q = '', area = '', from = '' } = {}) {
      const { tz } = settings.get();
      const week = weekFrom(id);
      if (!week) return null;
      const today = localDate(now(), tz);
      const query = { q: String(q ?? '').trim().slice(0, 200), area: TASK_ID.test(area ?? '') ? area : '' };
      const source = TASK_ID.test(from ?? '') ? from : '';
      const head = {
        tz,
        today,
        query,
        week: {
          id: week.id,
          year: week.year,
          week: week.week,
          monday: week.monday,
          sunday: week.sunday,
          prev: week.prev,
          next: week.next,
          current: week.monday <= today && today <= week.sunday,
          past: week.sunday < today,
          days: week.days.map((d) => ({ date: d.date, label: d.label, today: d.date === today })),
        },
      };
      const z = zunder();
      if (!z) return { ...head, ok: false, error: 'Zunder ist nicht eingerichtet', unconfigured: true };

      const dueIn = (t) => Boolean(t.due) && t.due.slice(0, 10) >= week.monday && t.due.slice(0, 10) <= week.sunday;
      const task = (t) => ({
        id: t.id,
        ref: t.ref ?? null,
        title: t.title,
        status: t.status,
        due: t.due ?? null,
        area: areaOf(t),
        project: t.location?.kind === 'project' ? (t.location.name ?? null) : null,
        phoenix: t.phoenix?.role ?? null,
        fire: t.phoenix?.fire ?? null,
        // Warum die Aufgabe in der Woche steht: Phönix-Rolle der Woche oder Fälligkeit.
        planned: t.phoenix?.fire === week.id ? t.phoenix.role : dueIn(t) ? 'faellig' : null,
        url: z.taskUrl(t.id),
      });

      const structure = await settle('Zunder (Bereiche)', () => z.listStructure());
      const s = structure.ok ? structureOf(structure.data) : EMPTY;

      const [phoenix, due, results, origin] = await Promise.all([
        settle('Zunder (Phönix)', () => z.filterTasks({ phoenix_fire: week.id, include_closed: true, limit: 200 })),
        settle('Zunder (Woche)', () => z.filterTasks({ due_after: week.monday, due_before: week.sunday, include_closed: true, limit: 300 })),
        query.q || query.area ? settle('Zunder (Suche)', () => find(z, query.q, query.area, s)) : null,
        source ? settle('Zunder (Aufgabe)', () => z.getTask(source)) : null,
      ]);

      // Wie die Wochenansicht: Flammen stehen eigens, Big Rocks sind Feuer-Schritte
      // der Woche und alles, was in der Woche fällig ist.
      const flames = phoenix.ok ? phoenix.data.filter((t) => t.phoenix?.role === 'flamme' && t.status !== 'dropped') : [];
      const rockMap = new Map();
      for (const t of [
        ...(phoenix.ok ? phoenix.data.filter((t) => t.phoenix?.role === 'feuer_schritt') : []),
        ...(due.ok ? due.data.filter((t) => t.phoenix?.role !== 'flamme') : []),
      ]) {
        if (t.status !== 'dropped' && !rockMap.has(t.id)) rockMap.set(t.id, t);
      }
      const plannedIds = new Set([...flames.map((t) => t.id), ...rockMap.keys()]);
      const groups = new Map();
      for (const t of rockMap.values()) {
        const name = areaOf(t);
        if (!groups.has(name)) groups.set(name, { area: name, areaId: areaIdOf(t, s), tasks: [] });
        groups.get(name).tasks.push(task(t));
      }
      const rocks = [...groups.values()].map((g) => ({ ...g, tasks: g.tasks.sort(byDue) })).sort((a, b) => a.area.localeCompare(b.area, 'de'));

      // Je Bereich der Big Rocks: offene Aufgaben ohne Termin, die noch nicht in der Woche stehen.
      const rockAreas = [...new Set(rocks.map((g) => g.areaId).filter(Boolean))];
      const nameOf = (aid) => s.list.find((a) => a.id === aid)?.name ?? rocks.find((g) => g.areaId === aid)?.area ?? aid;
      const suggestions = await Promise.all(
        rockAreas.map(async (aid) => {
          const r = await settle('Zunder (Bereich)', () => z.filterTasks({ area_id: aid, has_due: false, status: ['open', 'in_progress'], limit: 30 }));
          const open = r.ok ? r.data.filter((t) => !plannedIds.has(t.id) && !isDev(t, s)) : [];
          return { area: nameOf(aid), areaId: aid, ok: r.ok, error: r.error ?? null, tasks: open.slice(0, SUGGEST).map(task), more: Math.max(0, open.length - SUGGEST) };
        }),
      );
      suggestions.sort((a, b) => a.area.localeCompare(b.area, 'de'));

      return {
        ...head,
        ok: true,
        areas: structure.ok ? s.list : null,
        results: results ? section(results, results.ok ? results.data.map(task) : null) : null,
        suggestions,
        planned: {
          ok: phoenix.ok || due.ok,
          partial: !(phoenix.ok && due.ok),
          error: phoenix.ok ? (due.error ?? null) : phoenix.error,
          flames: flames.map(task).sort(byDue),
          rocks,
        },
        from: origin?.ok && origin.data ? task(origin.data) : null,
      };
    },

    /**
     * Holt eine Aufgabe in die Woche: `when` ist `schritt` (Phönix-Schritt der
     * Woche) oder ein Tag der Woche (JJJJ-MM-TT, wird die Fälligkeit). Liefert
     * die Aufgabe und `undo` mit den Feldern, die den alten Stand herstellen.
     */
    async add(id, weekIdIn, when) {
      checkId(id);
      const week = weekOrFail(weekIdIn);
      const value = String(when ?? '').trim();
      let fields;
      if (value === 'schritt') fields = { phoenix: { role: 'feuer_schritt', fire: week.id } };
      else if (week.days.some((d) => d.date === value)) fields = { due: value };
      else throw new ActionError('Bitte „Phönix-Schritt“ oder einen Tag dieser Woche wählen');
      const before = await call((z) => z.getTask(id));
      if (before.status === 'done' || before.status === 'dropped') throw new ActionError(`„${before.title}“ ist schon abgeschlossen`);
      // Schon in der Woche markiert (auch als Flamme): nichts überschreiben.
      const same = fields.phoenix ? before.phoenix?.fire === week.id : String(before.due ?? '').slice(0, 10) === value;
      if (same) return { task: summary(before), week: week.id, fields, changed: false, undo: null };
      const task = await call((z) => z.updateTask(id, fields));
      const undo = fields.phoenix ? { phoenix: markOf(before.phoenix) } : { due: before.due ?? '' };
      return { task: summary(task), week: week.id, fields, changed: true, undo };
    },

    /** Nimmt eine Aufgabe aus der Woche: entfernt ihre Phönix-Markierung (Schritt oder Flamme). */
    async remove(id) {
      checkId(id);
      const before = await call((z) => z.getTask(id));
      if (!before.phoenix) return { task: summary(before), was: null, changed: false, undo: null };
      const task = await call((z) => z.updateTask(id, { phoenix: null }));
      return { task: summary(task), was: before.phoenix, changed: true, undo: { phoenix: markOf(before.phoenix) } };
    },

    /**
     * Rückgängig für `add` und `remove`: setzt Phönix-Markierung (`flamme:2026-W42`,
     * leer = keine) und/oder Fälligkeit (Datum, Zeitpunkt, leer = keine) zurück.
     * Was fehlt (`null`), bleibt unverändert.
     */
    async restore(id, { phoenix = null, due = null } = {}) {
      checkId(id);
      const fields = {};
      if (phoenix != null) {
        const v = String(phoenix).trim();
        const m = MARK.exec(v);
        if (v && !(m && parseWeekId(m[2]))) throw new ActionError(`„${v}“ ist keine Phönix-Markierung`);
        fields.phoenix = v ? { role: m[1], fire: m[2] } : null;
      }
      if (due != null) {
        const v = String(due).trim();
        if (v && !DUE.test(v)) throw new ActionError(`„${v}“ ist kein Datum`);
        fields.due = v || null;
      }
      if (!Object.keys(fields).length) throw new ActionError('Nichts zurückzusetzen');
      return summary(await call((z) => z.updateTask(id, fields)));
    },

    /**
     * Plant eine Flamme (Deep-Work-Block) für einen Tag der Woche: neue
     * Aufgabe mit `phoenix.role = flamme`, fällig an dem Tag, mit Uhrzeit
     * (HH:MM, Zeitzone aus den Einstellungen) auf die Minute. `from` macht sie
     * zur Unteraufgabe einer bestehenden Aufgabe, sonst liegt sie in `place`
     * (`area:<id>`, `project:<id>`, Standard `loose`).
     */
    async createFlame({ week: weekIdIn, title, day, time = '', place = '', from = '' }) {
      const week = weekOrFail(weekIdIn);
      const name = String(title ?? '').trim();
      if (!name) throw new ActionError('Bitte einen Titel für die Flamme angeben');
      const date = week.days.find((d) => d.date === String(day ?? '').trim())?.date;
      if (!date) throw new ActionError('Bitte einen Tag dieser Woche wählen');
      let due = date;
      const clock = String(time ?? '').trim();
      if (clock) {
        const m = TIME.exec(clock);
        if (!m) throw new ActionError(`„${clock}“ ist keine Uhrzeit`);
        const [year, month, d] = date.split('-').map(Number);
        due = zonedToUtc({ year, month, day: d, hour: Number(m[1]), minute: Number(m[2]) }, settings.get().tz).toISOString().replace('.000Z', 'Z');
      }
      const fields = { title: name, phoenix: { role: 'flamme', fire: week.id }, due };
      const parent = String(from ?? '').trim();
      if (parent) {
        checkId(parent);
        // Unteraufgaben liegen immer an der Stelle ihrer Wurzelaufgabe.
        fields.parent_id = parent;
      } else {
        const m = PLACE.exec(String(place ?? '').trim() || 'loose');
        if (!m) throw new ActionError('Bitte einen Bereich oder ein Projekt wählen');
        fields.location = m[1] ? { kind: m[1], id: m[2] } : { kind: 'loose' };
      }
      return { task: summary(await call((z) => z.addTask(fields))), week: week.id };
    },
  };
}
