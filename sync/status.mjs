import { renameSync, writeFileSync } from 'node:fs';

/**
 * Zustand des Sync-Clients, abgeleitet aus seiner Ausgabe.
 *
 * `ob sync --continuous` hat keine Status-Schnittstelle, schreibt aber
 * verlässliche Zeilen wie „Fully synced“, „Disconnected from server“ oder
 * „Sync error: …“. Daraus entsteht der Zustand, den der Sidecar als JSON-Datei
 * für den Sync-Adapter des Cockpits ablegt (src/sync/headless.js).
 *
 * state: starting | connecting | syncing | synced | disconnected | error | stopped
 */
export function createStatusTracker({ clientVersion = null, now = () => new Date() } = {}) {
  const iso = () => now().toISOString();
  const status = {
    adapter: 'obsidian-headless',
    clientVersion,
    state: 'starting',
    startedAt: iso(),
    lastSyncAt: null,
    lastActivityAt: null,
    lastError: null,
    heartbeatAt: iso(),
  };

  return {
    /** Eine Ausgabezeile des Clients auswerten. Liefert true, wenn sich der Zustand geändert hat. */
    onLine(line, { stderr = false } = {}) {
      const text = String(line).trim();
      if (!text) return false;
      const before = JSON.stringify(status);

      if (text.startsWith('Fully synced')) {
        status.state = 'synced';
        status.lastSyncAt = iso();
      } else if (text.startsWith('Connecting') || text.startsWith('Waiting to connect')) {
        status.state = 'connecting';
      } else if (text.startsWith('Disconnected from server')) {
        status.state = 'disconnected';
      } else if (stderr || /^(Sync error|Sync failed|Merge failed)/.test(text)) {
        // Fehler schreibt der Client nach stderr. Dateinamen in normalen
        // Zeilen („Uploading file error-log.md“) zählen bewusst nicht.
        status.state = 'error';
        status.lastError = { at: iso(), message: text.slice(0, 500) };
      } else {
        // Uploading, Downloading, Merging … — der Client arbeitet.
        status.state = 'syncing';
        status.lastActivityAt = iso();
      }
      return JSON.stringify(status) !== before;
    },

    onExit(code, signal) {
      status.state = 'stopped';
      if (code) status.lastError = { at: iso(), message: `Sync-Client beendet mit Code ${code}` };
      else if (signal && signal !== 'SIGTERM') status.lastError = { at: iso(), message: `Sync-Client beendet durch ${signal}` };
    },

    heartbeat() {
      status.heartbeatAt = iso();
    },

    snapshot: () => ({ ...status }),
  };
}

/** Atomar schreiben, damit das Cockpit nie eine halbe Datei liest. */
export function writeStatusFile(file, snapshot) {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(snapshot, null, 2)}\n`);
  renameSync(tmp, file);
}
