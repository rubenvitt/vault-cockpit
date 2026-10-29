import { findFeuer } from './feuer.js';
import { describeWeek, parseWeekId, weekOf, localDate, localTime } from './week.js';
import { sectionBlock, planSection, writeSection } from '../vault/generated-section.js';

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
 * Die Mechanik (Prüfsumme im Endmarker, Abbruch bei Handarbeit im Bereich
 * oder gleichzeitiger Änderung) steckt in src/vault/generated-section.js, die
 * Marker sind dieselben wie vorher. Fehlen sie, kommen sie ans Ende des
 * Abschnitts „## Flammen“; was dort steht (etwa die leere Vorlagen-Tabelle),
 * bleibt stehen. Ohne Feuer-Notiz der Woche, ohne diesen
 * Abschnitt oder in einem vertraulichen Ordner wird nichts geschrieben, und
 * auch nur, wenn sich der Inhalt tatsächlich ändert (sonst erzeugte jedes
 * Intervall einen Sync-Vorgang). Geschrieben wird über den Editor; ändert der
 * Sync die Notiz gleichzeitig, bricht er ab.
 */

export const START_MARKER = 'cockpit:flammen:start';
export const END_MARKER = 'cockpit:flammen:ende';

const NAME = 'flammen';
const LABEL = 'aus Zunder, das Cockpit schreibt bis zum Endmarker neu';
const DAY_NAMES = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
const STATUS = { open: 'offen', in_progress: 'in Arbeit', blocked: 'blockiert', review: 'im Review', done: 'erledigt' };

const pad = (n) => String(n).padStart(2, '0');

/** „Mo 12.10.“ zu einem Kalenderdatum JJJJ-MM-TT. */
function dayLabel(date) {
  const [y, m, d] = date.split('-').map(Number);
  const dow = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
  return `${DAY_NAMES[dow]} ${pad(d)}.${pad(m)}.`;
}

/** Text für eine Tabellenzelle: einzeilig, `|` und eckige Klammern maskiert. */
const cell = (text) => String(text ?? '').replace(/\s+/g, ' ').trim().replace(/([|[\]\\])/g, '\\$1');

const spanMinutes = (start, end) => Math.max(0, Math.round((Date.parse(end) - Date.parse(start)) / 60_000));

/**
 * Gemessene Minuten einer Flamme, `null` ohne abgeschlossenen Block. Zunder
 * liefert an der Aufgabe nur den letzten Block; mit `blocks` (aus dem Verlauf,
 * `flameBlocks`) zählt die Summe aller (VCP-61). Die einzige Stelle, die
 * Flammen-Minuten rechnet; der Rückblick (`data.js`) nutzt sie auch (VCP-59).
 */
export function flameMinutes(t, blocks = null) {
  if (blocks?.length) return blocks.reduce((sum, b) => sum + spanMinutes(b.start, b.end), 0);
  if (!t.flame_started_at || !t.flame_ended_at) return null;
  return spanMinutes(t.flame_started_at, t.flame_ended_at);
}

/**
 * Abgeschlossene Blöcke einer Flamme aus dem Verlauf der Aufgabe
 * (`get_task_history`): Jeder Start setzt `flame_started_at` und leert
 * `flame_ended_at`, jeder Stopp setzt `flame_ended_at`. `[{ start, end }]`.
 */
export function flameBlocks(entries) {
  const blocks = [];
  let start = null;
  for (const e of [...(entries ?? [])].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))) {
    if (e.field === 'flame_started_at') start = typeof e.value === 'string' ? e.value : null;
    else if (e.field === 'flame_ended_at' && typeof e.value === 'string' && start) {
      if (!Number.isNaN(Date.parse(start)) && !Number.isNaN(Date.parse(e.value))) blocks.push({ start, end: e.value });
      start = null;
    }
  }
  return blocks;
}

/**
 * Zeilen der Tabelle aus Zunder-Aufgaben (Flammen der Woche). Zunder kennt
 * keine geplante Dauer, „geplant“ ist deshalb der geplante Tag (`due`, mit
 * Uhrzeit, wenn es eine gibt). „Tag“ ist der Tag, an dem die Flamme gebrannt
 * hat, sonst der geplante.
 */
export function flameRows(tasks, { tz, taskUrl = null, blocks = null }) {
  return tasks
    .filter((t) => t.phoenix?.role === 'flamme' && t.status !== 'dropped')
    .map((t) => {
      const due = t.due ? String(t.due) : null;
      const dueDate = due ? (due.length > 10 ? localDate(new Date(due), tz) : due.slice(0, 10)) : null;
      const planned = dueDate ? `${dayLabel(dueDate)}${due.length > 10 ? ` ${localTime(new Date(due), tz)}` : ''}` : '–';
      // Der Tag des ersten Blocks, nicht des letzten.
      const first = blocks?.get(t.id)?.[0]?.start ?? t.flame_started_at;
      const startDate = first ? localDate(new Date(first), tz) : null;
      const day = startDate ?? dueDate;
      const minutes = flameMinutes(t, blocks?.get(t.id) ?? null);
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
export const flameBlock = (inner, eol = '\n') => sectionBlock(NAME, inner, { label: LABEL, eol });

/**
 * Was mit der Notiz zu tun ist, damit der Bereich `inner` enthält (siehe
 * `planSection`): neue Marker ans Ende von „## Flammen“, ohne den Abschnitt
 * `skip`. `hasRows`: Ohne Flammen werden keine neuen Marker angelegt.
 */
export function planFlameUpdate(content, inner, { hasRows = true } = {}) {
  return planSection(content, NAME, inner, { label: LABEL, heading: 'Flammen', create: hasRows });
}

/** Verlaufsabrufe je Lauf: gleichzeitig und insgesamt (ms) (VCP-61). */
const HISTORY_PARALLEL = 4;
const HISTORY_BUDGET_MS = 20_000;

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
  const status = { lastRun: null, lastOkAt: null, lastError: null, lastWrite: null };
  let queue = Promise.resolve();
  // Blöcke je Flamme, gültig solange sich der letzte Block nicht ändert: Nicht jedes Intervall fragt den Verlauf.
  const blockCache = new Map();
  // Dieselbe Warnung (etwa Handarbeit im Bereich einer Notiz) nur einmal ins Log, nicht jedes Intervall.
  let lastWarning = null;

  /** Alle Blöcke der Flammen, die schon einmal gebrannt haben; ohne Verlauf bleibt es beim letzten Block. */
  async function blocksOf(z, tasks) {
    const out = new Map();
    if (!z.taskHistory) return out;
    const pending = [];
    for (const t of tasks) {
      if (t.phoenix?.role !== 'flamme' || !t.flame_started_at) continue;
      const key = `${t.flame_started_at} ${t.flame_ended_at ?? ''}`;
      const hit = blockCache.get(t.id);
      if (hit?.key === key) out.set(t.id, hit.blocks);
      else pending.push({ t, key });
    }
    // Wenige Abrufe gleichzeitig und eine Frist für alle: Hängt Zunder, wartet die
    // Notiz nicht Minuten. Was nicht drankommt, zählt diesmal nur den letzten Block.
    const deadline = Date.now() + HISTORY_BUDGET_MS;
    let next = 0;
    const worker = async () => {
      while (next < pending.length && Date.now() < deadline) {
        const { t, key } = pending[next++];
        try {
          const blocks = flameBlocks(await z.taskHistory(t.id));
          blockCache.set(t.id, { key, blocks });
          out.set(t.id, blocks);
        } catch (err) {
          logger.warn?.(`Feuer-Notiz: Verlauf von ${t.ref ?? t.id} nicht abrufbar, nur der letzte Block zählt — ${err.message}`);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(HISTORY_PARALLEL, pending.length) }, worker));
    return out;
  }

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
    const rows = flameRows(tasks, { tz: config.tz, taskUrl: z.taskUrl, blocks: await blocksOf(z, tasks) });
    const inner = renderFlameTable(rows);

    // Ab hier synchron: frisch lesen, planen, über den Editor schreiben.
    const written = writeSection({ vaultPath, editor, path, name: NAME, inner, label: LABEL, heading: 'Flammen', create: rows.length > 0 });
    if (written.state === 'aktuell') return { state: 'aktuell', path, week: week.id };
    if (written.state === 'übersprungen') throw new Error(`${path}: ${written.reason}`);
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
        lastWarning = null;
        return result;
      } catch (err) {
        status.lastError = { at: status.lastRun, message: err.message };
        if (err.message !== lastWarning) logger.warn?.(`Feuer-Notiz: Flammen nicht eingetragen — ${err.message}`);
        lastWarning = err.message;
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
