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
