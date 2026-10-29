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

/** Verlaufsabrufe je Lauf: gleichzeitig und insgesamt (ms) (VCP-61). */
const HISTORY_PARALLEL = 4;
const HISTORY_BUDGET_MS = 20_000;
/** So viele Aufgaben merkt sich der Block-Cache höchstens (VCP-117). */
const BLOCK_CACHE_MAX = 1000;
const LATE = Symbol('nach der Frist');

/**
 * Blöcke der Flammen aus dem Verlauf (`get_task_history`), geteilt von der
 * Feuer-Notiz, der Wochenansicht und dem Rückblick (VCP-118): So zeigen alle
 * dieselbe Summe, und der Verlauf einer Flamme wird nur gefragt, wenn sich ihr
 * letzter Block geändert hat, nicht bei jedem Seitenaufruf.
 *
 * `of(z, tasks, { scope, budgetMs })` liefert eine Map Aufgaben-ID → Blöcke für
 * alle Aufgaben, die schon einmal gebrannt haben. Fehlt eine (Verlauf nicht
 * abrufbar, Frist vorbei, Client ohne `taskHistory`), zählt beim Aufrufer nur
 * der letzte Block (`flameMinutes(t)` ohne Blöcke).
 */
export function createFlameBlocks({ logger = console, parallel = HISTORY_PARALLEL, budgetMs = HISTORY_BUDGET_MS } = {}) {
  // Blöcke je Flamme, gültig solange sich der letzte Block nicht ändert.
  const cache = new Map();
  // Wo der nächste Lauf je Bereich (`scope`, etwa die Woche) weiterfragt, damit eine Frist nicht immer dieselben trifft.
  const starts = new Map();
  // Zuletzt angefragter Block je Flamme: Eine späte Antwort zu einem älteren ersetzt keinen neueren Cache-Eintrag.
  const asked = new Map();

  async function of(z, tasks, { scope = '', budgetMs: budget = budgetMs } = {}) {
    const out = new Map();
    if (!z?.taskHistory) return out;
    const pending = [];
    const seen = new Set();
    for (const t of tasks) {
      if (!t.flame_started_at || seen.has(t.id)) continue;
      seen.add(t.id);
      const key = `${t.flame_started_at} ${t.flame_ended_at ?? ''}`;
      const hit = cache.get(t.id);
      if (hit?.key === key) out.set(t.id, hit.blocks);
      else {
        // Schon beim Aufnehmen merken: Ein älterer Lauf, dessen Abruf erst später startet, überschreibt nichts.
        asked.set(t.id, key);
        pending.push({ t, key });
      }
    }
    // Wenige Abrufe gleichzeitig und eine Frist für alle: Hängt Zunder, wartet
    // niemand Minuten. Was nicht drankommt, zählt diesmal nur den letzten Block.
    const deadline = Date.now() + budget;
    const start = pending.length ? (starts.get(scope) ?? 0) % pending.length : 0;
    let next = 0;
    const worker = async () => {
      while (next < pending.length && Date.now() < deadline) {
        const { t, key } = pending[(start + next++) % pending.length];
        // Die Antwort füllt den Cache auch, wenn sie erst nach der Frist kommt; ein Treffer zählt nur mit gleichem `key`.
        const fetched = Promise.resolve()
          .then(() => z.taskHistory(t.id))
          .then((entries) => {
            const blocks = flameBlocks(entries);
            if (asked.get(t.id) === key) {
              // Zuletzt geschrieben steht hinten; über der Obergrenze fällt der älteste Eintrag.
              cache.delete(t.id);
              cache.set(t.id, { key, blocks });
              if (cache.size > BLOCK_CACHE_MAX) cache.delete(cache.keys().next().value);
            }
            return blocks;
          });
        let timer;
        const timeout = new Promise((resolve) => {
          timer = setTimeout(() => resolve(LATE), Math.max(0, deadline - Date.now()));
        });
        try {
          // Gewartet wird nur bis zur Frist, nicht bis zum Zeitlimit des Clients.
          const blocks = await Promise.race([fetched, timeout]);
          if (blocks === LATE) fetched.catch(() => {});
          else out.set(t.id, blocks);
        } catch (err) {
          logger.warn?.(`Flammen: Verlauf von ${t.ref ?? t.id} nicht abrufbar, nur der letzte Block zählt — ${err.message}`);
        } finally {
          clearTimeout(timer);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(parallel, pending.length) }, worker));
    if (pending.length) starts.set(scope, (start + next) % pending.length);
    return out;
  }

  return { of };
}
