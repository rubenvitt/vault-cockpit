import { createObsidianHeadlessAdapter } from './headless.js';

/**
 * Sync-Adapter: hält das Cockpit über den Sync des Vaults auf dem Laufenden.
 *
 * Jeder Adapter bietet dieselbe schmale Schnittstelle:
 * - start({ onChanges }) meldet Änderungen als { paths } oder { full: true },
 * - status() liefert den Zustand des Syncs (state, letzter Abgleich, Fehler),
 * - stop().
 *
 * Ein eigener Sync (Roadmap Schritt 5) ist nur ein weiterer Eintrag hier.
 */
const ADAPTERS = {
  'obsidian-headless': createObsidianHeadlessAdapter,
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
