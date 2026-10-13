import { readFileSync } from 'node:fs';
import { createVaultWatcher } from './watch.js';

/**
 * Sync-Adapter für Obsidian Headless (`ob sync --continuous`) im Sidecar.
 *
 * Der Sync selbst läuft nicht im Cockpit, sondern im Container `vault-sync`.
 * Der Adapter sieht nur dessen Wirkung und Zustand:
 * - Änderungen: über die Dateien im gemeinsamen Vault-Ordner.
 * - Zustand: über die Statusdatei, die der Sidecar laufend schreibt
 *   (siehe sync/status.mjs). Ohne Statusdatei bleibt der Zustand unbekannt,
 *   die Änderungserkennung funktioniert trotzdem — etwa solange der Sync noch
 *   als Host-Dienst läuft.
 */
export function createObsidianHeadlessAdapter({
  vaultPath,
  statusFile = null,
  staleAfterMs = 120_000,
  watch,
  now = Date.now,
  logger = console,
}) {
  let watcher = null;

  return {
    name: 'obsidian-headless',

    start({ onChanges }) {
      try {
        watcher = createVaultWatcher({ vaultPath, onBatch: onChanges, watch, logger });
      } catch (err) {
        logger.error?.(`Vault-Beobachtung nicht möglich (${err.message}), es bleibt der periodische Neuaufbau`);
      }
    },

    status() {
      const base = { adapter: 'obsidian-headless', watching: Boolean(watcher) };
      if (!statusFile) return { ...base, state: 'unknown', reason: 'keine Statusdatei konfiguriert (SYNC_STATUS_FILE)' };

      let reported;
      try {
        reported = JSON.parse(readFileSync(statusFile, 'utf8'));
      } catch (err) {
        const reason = err.code === 'ENOENT' ? 'Sidecar hat noch keinen Status geschrieben' : `Statusdatei unlesbar: ${err.message}`;
        return { ...base, state: 'unknown', reason };
      }

      const heartbeat = Date.parse(reported.heartbeatAt ?? '');
      const stale = !Number.isFinite(heartbeat) || now() - heartbeat > staleAfterMs;
      return {
        ...base,
        state: stale && reported.state !== 'stopped' ? 'stale' : reported.state,
        ...(stale && reported.state !== 'stopped' ? { reason: 'Sidecar meldet sich nicht mehr' } : {}),
        clientVersion: reported.clientVersion ?? null,
        startedAt: reported.startedAt ?? null,
        lastSyncAt: reported.lastSyncAt ?? null,
        lastActivityAt: reported.lastActivityAt ?? null,
        lastError: reported.lastError ?? null,
        heartbeatAt: reported.heartbeatAt ?? null,
      };
    },

    stop() {
      watcher?.stop();
      watcher = null;
    },
  };
}
