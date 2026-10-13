import { buildIndex, openIndex } from './index.js';
import { DEFAULT_POLICY } from './policy.js';

/**
 * Hält den Index aktuell.
 *
 * Der Vault wird vom Sync fortlaufend verändert. Meldet der Sync-Adapter
 * geänderte Dateien, liest applyChanges() nur diese neu ein. Der periodische
 * Komplettaufbau bleibt als Netz für alles, was der Adapter nicht sieht
 * (verpasste Ereignisse, umbenannte Ordner, Neustarts).
 *
 * Der Notizinhalt selbst wird ohnehin immer frisch von der Platte gelesen —
 * veralten kann nur der Suchindex und der Link-Graph.
 */
export function createIndexManager({ vaultPath, dbPath, policy = DEFAULT_POLICY, intervalMinutes = 0, logger = console }) {
  let current = null;
  let builtAt = 0;
  let changedAt = 0;
  let timer = null;

  function rebuild() {
    const started = Date.now();
    const previous = current;
    const { db, count } = buildIndex({ vaultPath, dbPath, policy, logger: { info: () => {}, warn: logger.warn } });
    current = openIndex(db, { vaultPath, policy });
    builtAt = Date.now();
    if (previous && previous.db !== db) {
      try {
        previous.close();
      } catch {
        /* der alte Handle ist bereits geschlossen */
      }
    }
    logger.info?.(`Index neu aufgebaut: ${count} Notizen in ${((builtAt - started) / 1000).toFixed(1)} s`);
    return count;
  }

  /**
   * Geänderte Notizen (Vault-relative Pfade) einzeln neu einlesen. Ist dabei
   * eine Datei entstanden oder verschwunden, werden alle Linkziele neu
   * aufgelöst, damit Backlinks stimmen.
   */
  function applyChanges(paths) {
    let presenceChanged = false;
    for (const path of new Set(paths)) {
      const { existed, exists } = current.refresh(path);
      if (existed !== exists) presenceChanged = true;
    }
    if (presenceChanged) current.relinkAll();
    changedAt = Date.now();
  }

  rebuild();

  if (intervalMinutes > 0) {
    timer = setInterval(() => {
      try {
        rebuild();
      } catch (err) {
        logger.error?.('Neuaufbau des Index fehlgeschlagen:', err.message);
      }
    }, intervalMinutes * 60_000);
    timer.unref?.();
  }

  return {
    rebuild,
    applyChanges,
    lastBuiltAt: () => builtAt,
    lastChangedAt: () => changedAt,
    stop() {
      if (timer) clearInterval(timer);
      current?.close();
    },
    // Fassade: die Tool-Schicht hält keine Referenz auf einen konkreten Index,
    // sondern greift immer auf den gerade gültigen zu.
    search: (...a) => current.search(...a),
    getNote: (...a) => current.getNote(...a),
    backlinks: (...a) => current.backlinks(...a),
    outgoingLinks: (...a) => current.outgoingLinks(...a),
    listFolder: (...a) => current.listFolder(...a),
    stats: (...a) => current.stats(...a),
    pathsWithTag: (...a) => current.pathsWithTag(...a),
    notesOfType: (...a) => current.notesOfType(...a),
    refresh: (...a) => current.refresh(...a),
  };
}
