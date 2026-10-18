import { readFileSync, realpathSync } from 'node:fs';
import { join, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { findFeuer } from './feuer.js';
import { describeWeek, parseWeekId, weekOf, localDate, localTime } from './week.js';

/**
 * Flammen der Woche in der Feuer-Notiz (Timing-Anreicherung, VCP-52).
 *
 * Zunder misst die Flammen (mit Timing, falls angebunden); das Cockpit trägt
 * sie in den Abschnitt „## Flammen“ der Feuer-Notiz der Woche ein, damit der
 * Rückblick in Obsidian und Claude über MCP die Zahlen sehen. Erfasst wird
 * nichts doppelt: Die Tabelle entsteht bei jedem Lauf neu aus Zunder.
 *
 * Geschrieben wird nur zwischen zwei Kommentar-Markern:
 *
 *   <!-- cockpit:flammen:start · … -->
 *   | Tag | Flamme | geplant | gemessen (min) | Status |
 *   …
 *   <!-- cockpit:flammen:ende 1a2b3c4d -->
 *
 * Der Endmarker trägt eine Prüfsumme des Inhalts. Passt sie nicht mehr, hat
 * jemand im Bereich von Hand geschrieben; dann bleibt die Notiz unberührt, bis
 * der Bereich zwischen den Markern geleert wird. Fehlen die Marker, kommen sie
 * ans Ende des Abschnitts „## Flammen“; was dort steht (etwa die leere
 * Vorlagen-Tabelle), bleibt stehen. Ohne Feuer-Notiz der Woche, ohne diesen
 * Abschnitt oder in einem vertraulichen Ordner wird nichts geschrieben, und
 * auch nur, wenn sich der Inhalt tatsächlich ändert (sonst erzeugte jedes
 * Intervall einen Sync-Vorgang). Geschrieben wird über den Editor; ändert der
 * Sync die Notiz gleichzeitig, bricht er ab.
 */

export const START_MARKER = 'cockpit:flammen:start';
export const END_MARKER = 'cockpit:flammen:ende';

const START_LINE = /^[ \t]*<!--\s*cockpit:flammen:start\b.*$/gm;
const END_LINE = /^[ \t]*<!--\s*cockpit:flammen:ende\b(?:[ \t]+([0-9a-f]{8}))?.*$/gm;
const SECTION = /^##[ \t]+Flammen[ \t]*#*[ \t]*$/m;
const DAY_NAMES = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
const STATUS = { open: 'offen', in_progress: 'in Arbeit', blocked: 'blockiert', review: 'im Review', done: 'erledigt' };

const checksum = (text) => createHash('sha256').update(text).digest('hex').slice(0, 8);
const pad = (n) => String(n).padStart(2, '0');

/** „Mo 12.10.“ zu einem Kalenderdatum JJJJ-MM-TT. */
function dayLabel(date) {
  const [y, m, d] = date.split('-').map(Number);
  const dow = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
  return `${DAY_NAMES[dow]} ${pad(d)}.${pad(m)}.`;
}

/** Text für eine Tabellenzelle: einzeilig, `|` und eckige Klammern maskiert. */
const cell = (text) => String(text ?? '').replace(/\s+/g, ' ').trim().replace(/([|[\]\\])/g, '\\$1');

/** Gemessene Minuten eines abgeschlossenen Blocks, sonst null. */
export function flameMinutes(t) {
  if (!t.flame_started_at || !t.flame_ended_at) return null;
  return Math.max(0, Math.round((Date.parse(t.flame_ended_at) - Date.parse(t.flame_started_at)) / 60_000));
}

/**
 * Zeilen der Tabelle aus Zunder-Aufgaben (Flammen der Woche). Zunder kennt
 * keine geplante Dauer, „geplant“ ist deshalb der geplante Tag (`due`, mit
 * Uhrzeit, wenn es eine gibt). „Tag“ ist der Tag, an dem die Flamme gebrannt
 * hat, sonst der geplante.
 */
export function flameRows(tasks, { tz, taskUrl = null }) {
  return tasks
    .filter((t) => t.phoenix?.role === 'flamme' && t.status !== 'dropped')
    .map((t) => {
      const due = t.due ? String(t.due) : null;
      const dueDate = due ? (due.length > 10 ? localDate(new Date(due), tz) : due.slice(0, 10)) : null;
      const planned = dueDate ? `${dayLabel(dueDate)}${due.length > 10 ? ` ${localTime(new Date(due), tz)}` : ''}` : '–';
      const startDate = t.flame_started_at ? localDate(new Date(t.flame_started_at), tz) : null;
      const day = startDate ?? dueDate;
      const minutes = flameMinutes(t);
      const running = Boolean(t.flame_running);
      const url = taskUrl ? taskUrl(t.id) : null;
      return {
        sort: `${day ?? '9999'} ${due ?? '9999'} ${t.title}`,
        day: day ? dayLabel(day) : '–',
        title: url ? `[${cell(t.title)}](${url})` : cell(t.title),
        planned,
        measured: running ? 'läuft' : minutes === null ? '–' : String(minutes),
        status: running ? 'brennt' : (STATUS[t.status] ?? cell(t.status)),
      };
    })
    .sort((a, b) => a.sort.localeCompare(b.sort, 'de'));
}

/** Inhalt zwischen den Markern (ohne Marker), Zeilen mit `\n`. */
export function renderFlameTable(rows) {
  if (!rows.length) return 'Keine Flammen für diese Woche in Zunder.';
  return [
    '| Tag | Flamme | geplant | gemessen (min) | Status |',
    '|-----|--------|---------|----------------|--------|',
    ...rows.map((r) => `| ${r.day} | ${r.title} | ${r.planned} | ${r.measured} | ${r.status} |`),
  ].join('\n');
}

/** Der ganze Bereich mit Markern; `eol` wie in der Notiz. */
export function flameBlock(inner, eol = '\n') {
  return [`<!-- ${START_MARKER} · aus Zunder, das Cockpit schreibt bis zum Endmarker neu -->`, inner, `<!-- ${END_MARKER} ${checksum(inner)} -->`].join('\n').replaceAll('\n', eol);
}

/**
 * Was mit der Notiz zu tun ist, damit der Bereich `inner` enthält:
 * `{ action: 'keep' }` (schon aktuell), `{ action: 'replace', oldText, newText }`,
 * `{ action: 'insert', text }` (ans Ende von „## Flammen“) oder
 * `{ action: 'skip', reason }`. `hasRows`: Ohne Flammen werden keine neuen
 * Marker angelegt.
 */
export function planFlameUpdate(content, inner, { hasRows = true } = {}) {
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const starts = [...content.matchAll(START_LINE)];
  const ends = [...content.matchAll(END_LINE)];
  if (!starts.length && !ends.length) {
    if (!hasRows) return { action: 'keep' };
    if (!SECTION.test(content)) return { action: 'skip', reason: 'Die Feuer-Notiz hat keinen Abschnitt „## Flammen“' };
    // Leerzeile davor, damit der Kommentar nicht an einer Tabelle klebt.
    return { action: 'insert', text: `${eol}${flameBlock(inner, eol)}` };
  }
  if (starts.length !== 1 || ends.length !== 1 || ends[0].index < starts[0].index) {
    return { action: 'skip', reason: 'Die Marker des Flammen-Bereichs fehlen zur Hälfte oder stehen doppelt; bitte in Obsidian aufräumen' };
  }
  const from = starts[0].index;
  const to = ends[0].index + ends[0][0].length;
  const current = content.slice(from + starts[0][0].length, ends[0].index).replace(/\r\n/g, '\n').trim();
  if (current && ends[0][1] !== checksum(current)) {
    return { action: 'skip', reason: 'Im Flammen-Bereich wurde von Hand geschrieben; das Cockpit lässt ihn stehen (zum Neuschreiben den Bereich zwischen den Markern leeren)' };
  }
  if (current === inner) return { action: 'keep' };
  return { action: 'replace', oldText: content.slice(from, to), newText: flameBlock(inner, eol) };
}

/**
 * Hintergrunddienst: `update(weekId?)` trägt die Flammen einer Woche (Standard:
 * die laufende) ein, `afterFlame(task)` nach Start oder Stopp einer Flamme im Cockpit, `round()`
 * im Reindex-Intervall. Läufe hintereinander, nie gleichzeitig. `status()`
 * liefert letzten Lauf, letzten erfolgreichen Lauf, letzten Fehler und
 * letzten Schreibvorgang.
 *
 * `zunder` ist eine Funktion, die den aktuellen Client liefert (oder null);
 * `settings.get().flameNote.enabled` schaltet ab.
 */
export function createFlameNote({ vaultPath, index, editor, policy, settings, zunder, now = () => new Date(), logger = console }) {
  const vaultReal = realpathSync(vaultPath);
  const status = { lastRun: null, lastOkAt: null, lastError: null, lastWrite: null };
  let queue = Promise.resolve();

  async function run(id) {
    const config = settings.get();
    if (!config.flameNote?.enabled) return { state: 'aus' };
    const z = zunder();
    if (!z) return { state: 'ruht', reason: 'Zunder ist nicht eingerichtet' };
    const parsed = id ? parseWeekId(id) : weekOf(now(), config.tz);
    if (!parsed) return { state: 'übersprungen', reason: `„${id}“ ist keine Kalenderwoche` };
    const week = describeWeek(parsed, config.tz);
    // Nur die Notiz, deren Zeitraum zur Woche passt; „status: aktiv“ allein reicht zum Schreiben nicht.
    const feuer = findFeuer(index, week);
    if (!feuer) return { state: 'übersprungen', reason: `Keine Feuer-Notiz für ${week.id}`, week: week.id };
    const { path } = feuer;
    const row = index.getNote(path);
    if (policy.isExcluded(path) || policy.sensitivityOf(path) || !row || row.sensitivity || row.class !== 'core') {
      return { state: 'übersprungen', reason: 'Die Feuer-Notiz liegt in einem vertraulichen oder ausgeschlossenen Ordner', week: week.id };
    }

    const tasks = await z.filterTasks({ phoenix_fire: week.id, include_closed: true, limit: 200 });
    const rows = flameRows(tasks, { tz: config.tz, taskUrl: z.taskUrl });
    const inner = renderFlameTable(rows);

    // Ab hier synchron: frisch lesen, planen, über den Editor schreiben.
    const absolute = join(vaultPath, path);
    if (!realpathSync(absolute).startsWith(vaultReal + sep)) throw new Error(`„${path}“ zeigt aus dem Vault heraus`);
    const plan = planFlameUpdate(readFileSync(absolute, 'utf8'), inner, { hasRows: rows.length > 0 });
    if (plan.action === 'keep') return { state: 'aktuell', path, week: week.id };
    if (plan.action === 'skip') throw new Error(`${path}: ${plan.reason}`);
    if (plan.action === 'replace') editor.replace({ path, oldText: plan.oldText, newText: plan.newText });
    else editor.append({ path, heading: 'Flammen', text: plan.text });
    status.lastWrite = { at: now().toISOString(), path, week: week.id };
    logger.info?.(`Feuer-Notiz: Flammen in ${path} aktualisiert (${rows.length})`);
    return { state: 'geschrieben', path, week: week.id, rows: rows.length };
  }

  function update(id = null) {
    const next = queue.then(async () => {
      status.lastRun = now().toISOString();
      try {
        const result = await run(id);
        status.lastOkAt = status.lastRun;
        return result;
      } catch (err) {
        status.lastError = { at: status.lastRun, message: err.message };
        logger.warn?.(`Feuer-Notiz: Flammen nicht eingetragen — ${err.message}`);
        return { state: 'fehler', error: err.message };
      }
    });
    queue = next;
    return next;
  }

  return {
    update,

    /**
     * Nach Start oder Stopp im Cockpit: die Woche der Flamme, sonst die laufende.
     * Ein Start beendet in Zunder die Flamme davor, deren Zeit kommt so auch an.
     */
    afterFlame(task) {
      const fire = task?.phoenix?.role === 'flamme' ? task.phoenix.fire : null;
      return update(fire && parseWeekId(fire) ? fire : null);
    },

    /**
     * Reindex-Intervall: die laufende Woche und die davor, damit auch eine
     * Flamme, die erst nach dem Wochenwechsel in Zunder gestoppt wurde, ankommt.
     */
    async round() {
      const tz = settings.get().tz;
      const current = describeWeek(weekOf(now(), tz), tz);
      return [await update(current.prev), await update(current.id)];
    },

    status: () => ({ ...status }),
  };
}
