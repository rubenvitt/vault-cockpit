import { createObsidianHeadlessAdapter } from './headless.js';
import { createCockpitSyncAdapter } from './cockpit.js';

/**
 * Sync-Adapter: hält das Cockpit über den Sync des Vaults auf dem Laufenden.
 *
 * Jeder Adapter bietet dieselbe schmale Schnittstelle:
 * - start({ onChanges }) meldet Änderungen als { paths } oder { full: true },
 * - status() liefert den Zustand des Syncs (state, letzter Abgleich, Fehler),
 * - stop().
 *
 * `cockpit` ist der eigene Sync (Roadmap Schritt 5, VCP-13): Das Cockpit ist
 * selbst der Server, der Adapter bringt dafür sein Journal mit (`journal`).
 */
const ADAPTERS = {
  'obsidian-headless': createObsidianHeadlessAdapter,
  cockpit: createCockpitSyncAdapter,
  none: () => ({
    name: 'none',
    start() {},
    status: () => ({ adapter: 'none', state: 'disabled', watching: false }),
    stop() {},
  }),
};

export function createSyncAdapter({ kind = 'obsidian-headless', ...options }) {
  const create = ADAPTERS[kind];
  if (!create) throw new Error(`Unbekannter Sync-Adapter "${kind}" (möglich: ${Object.keys(ADAPTERS).join(', ')})`);
  return create(options);
}

/**
 * Umschaltbarer Sync: Welcher Adapter läuft, steht in den Einstellungen
 * (Einstellungen → Sync), nicht im Deployment. `switchTo` stoppt den
 * laufenden Adapter und startet den neuen mit denselben Empfängern, ohne
 * Neustart. Schlägt der neue fehl, läuft der alte weiter.
 */
export function createSyncSwitch({ kind, logger = console, ...options }) {
  let current = createSyncAdapter({ kind, logger, ...options });
  let handlers = null;
  return {
    get name() {
      return current.name;
    },
    /** Journal des eigenen Syncs, sonst null. */
    get journal() {
      return current.journal ?? null;
    },
    start(h) {
      handlers = h;
      current.start(h);
    },
    status: () => current.status(),
    notifyWrite: (path) => current.notifyWrite?.(path),
    /** `true`, wenn gewechselt wurde. */
    switchTo(next) {
      if (next === current.name) return false;
      const adapter = createSyncAdapter({ kind: next, logger, ...options });
      current.stop();
      current = adapter;
      if (handlers) current.start(handlers);
      logger.info?.(`Sync: gewechselt auf ${next}`);
      return true;
    },
    stop: () => current.stop(),
  };
}
