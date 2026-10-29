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
 *
 * Schattenbetrieb (`shadow`, VCP-133): Neben einem anderen Sync läuft der
 * eigene nur lesend mit (Journal, `/sync/v1` zum Vergleichen), damit Geräte
 * Abweichungen melden können, bevor umgestellt wird. Ist der eigene Sync
 * selbst eingestellt, ist der Schatten überflüssig.
 */
export function createSyncSwitch({ kind, shadow = false, logger = console, ...options }) {
  let current = createSyncAdapter({ kind, logger, ...options });
  let handlers = null;
  let wantShadow = shadow;
  let shade = null;

  function arrange() {
    const need = wantShadow && current.name !== 'cockpit';
    if (need && !shade) {
      try {
        shade = createCockpitSyncAdapter({ ...options, logger, readOnly: true });
        if (handlers) shade.start({ onChanges: () => {} });
        logger.info?.('Sync: Schattenbetrieb an');
      } catch (err) {
        shade = null;
        logger.error?.(`Sync: Schattenbetrieb nicht möglich: ${err.message}`);
      }
    } else if (!need && shade) {
      shade.stop();
      shade = null;
      logger.info?.('Sync: Schattenbetrieb aus');
    }
  }
  arrange();

  return {
    get name() {
      return current.name;
    },
    /** Journal des eigenen Syncs (im Schattenbetrieb nur lesend), sonst null. */
    get journal() {
      return current.journal ?? shade?.journal ?? null;
    },
    start(h) {
      handlers = h;
      current.start(h);
      shade?.start({ onChanges: () => {} });
    },
    status: () => {
      const s = current.status();
      return shade ? { ...s, shadow: shade.status().shadow } : s;
    },
    notifyWrite: (path) => current.notifyWrite?.(path),
    /** `true`, wenn gewechselt wurde. */
    switchTo(next, { shadow: nextShadow = wantShadow } = {}) {
      wantShadow = nextShadow;
      if (next === current.name) {
        arrange();
        return false;
      }
      // Der eigene Sync übernimmt das Journal des Schattens: erst den Schatten schließen.
      if (next === 'cockpit' && shade) {
        shade.stop();
        shade = null;
      }
      let adapter;
      try {
        adapter = createSyncAdapter({ kind: next, logger, ...options });
      } catch (err) {
        arrange();
        throw err;
      }
      current.stop();
      current = adapter;
      if (handlers) current.start(handlers);
      logger.info?.(`Sync: gewechselt auf ${next}`);
      arrange();
      return true;
    },
    stop: () => {
      current.stop();
      shade?.stop();
      shade = null;
    },
  };
}
