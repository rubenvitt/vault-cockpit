import { buildIndex, openIndex } from './index.js';
import { DEFAULT_POLICY } from './policy.js';

/**
 * Hält den Index aktuell.
 *
 * Der Vault wird von Obsidian Sync fortlaufend verändert — neue und gelöschte
 * Notizen würden sonst nie im Suchindex ankommen. Ein vollständiger Neuaufbau
 * dauert bei einigen tausend Notizen nur Sekunden, deshalb genügt ein periodischer
 * Komplettaufbau; eine inkrementelle Verfolgung einzelner Dateien wäre mehr
 * Komplexität ohne spürbaren Gewinn.
 *
 * Der Notizinhalt selbst wird ohnehin immer frisch von der Platte gelesen —
 * veralten kann nur der Suchindex und der Link-Graph.
 */
export function createIndexManager({ vaultPath, dbPath, policy = DEFAULT_POLICY, intervalMinutes = 0, logger = console }) {
  let current = null;
  let builtAt = 0;
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
    lastBuiltAt: () => builtAt,
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
    refresh: (...a) => current.refresh(...a),
  };
}
