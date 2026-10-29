import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createVaultWatcher } from './watch.js';
import { createSyncJournal } from './server/journal.js';
import { isImagePath } from '../vault/images.js';

/**
 * Sync-Adapter für den eigenen Sync (VCP-13, Schritt 5 der Roadmap): Das
 * Cockpit ist selbst der Sync-Server, die Geräte gleichen sich über
 * `/sync/v1` mit dem Vault-Ordner ab (siehe server/http.js). Kein Sidecar.
 *
 * - Änderungen: Watcher wie beim Headless-Adapter; jedes Paket gleicht
 *   zusätzlich das Journal ab, damit Geräte auch Schreibzugriffe des
 *   Cockpits selbst (Bearbeiten, Capture, Brücke) sehen. Was ein Gerät über
 *   die API schreibt, meldet `notifyWrite` gleich an den Index.
 * - Zustand: läuft, solange das Journal lesbar ist; „letzter Abgleich“ ist der
 *   letzte Kontakt eines Geräts.
 *
 * Ein voller Abgleich mit der Platte läuft beim Start und alle `rescanMs`
 * (Netz für Anhänge, die der Watcher bewusst nicht meldet).
 */
export function createCockpitSyncAdapter({
  vaultPath,
  dataDir,
  rescanMs = 5 * 60_000,
  watch,
  logger = console,
  journal: givenJournal = null,
}) {
  let journal = givenJournal;
  if (!journal) {
    mkdirSync(dataDir, { recursive: true });
    journal = createSyncJournal({ vaultPath, dbPath: join(dataDir, 'sync.db'), blobDir: join(dataDir, 'sync-blobs'), logger });
  }
  let watcher = null;
  let timer = null;
  let notify = () => {};
  let lastError = null;
  let lastScanAt = null;

  function scan() {
    try {
      const changed = journal.scan();
      lastScanAt = new Date().toISOString();
      lastError = null;
      return changed;
    } catch (err) {
      lastError = { at: new Date().toISOString(), message: `Abgleich mit dem Vault-Ordner: ${err.message}` };
      logger.error?.(`Sync: ${lastError.message}`);
      return [];
    }
  }

  return {
    name: 'cockpit',
    journal,

    start({ onChanges }) {
      notify = onChanges;
      // Der erste Lauf hasht den ganzen Vault; nicht im Start blockieren.
      setImmediate(() => {
        const t0 = Date.now();
        const changed = scan();
        logger.info?.(`Sync: Journal abgeglichen (${changed.length} Änderungen, ${Date.now() - t0} ms)`);
      });
      try {
        watcher = createVaultWatcher({
          vaultPath,
          watch,
          logger,
          onBatch: (batch) => {
            scan();
            onChanges(batch);
          },
        });
      } catch (err) {
        logger.error?.(`Vault-Beobachtung nicht möglich (${err.message}), es bleibt der periodische Neuaufbau`);
      }
      timer = setInterval(scan, rescanMs);
      timer.unref?.();
    },

    /** Ein Gerät hat über die API geschrieben oder gelöscht. */
    notifyWrite(path) {
      // Bilder auch: Der Index führt sie in `images` (VCP-114).
      if (path.toLowerCase().endsWith('.md') || isImagePath(path)) notify({ paths: [path] });
    },

    status() {
      const devices = journal.devices();
      const last = devices.map((d) => [d.pullAt, d.pushAt]).flat().filter(Boolean).sort().at(-1) ?? null;
      return {
        adapter: 'cockpit',
        watching: Boolean(watcher),
        state: lastError ? 'error' : 'synced',
        lastSyncAt: last,
        lastScanAt,
        lastError,
        cursor: journal.cursor(),
        devices,
      };
    },

    stop() {
      watcher?.stop();
      watcher = null;
      clearInterval(timer);
      timer = null;
      if (!givenJournal) journal.close();
    },
  };
}
