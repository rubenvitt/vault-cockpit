import { watch as fsWatch, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import { isImagePath } from '../vault/images.js';

const toPosix = (p) => p.split(sep).join('/');

/**
 * Beobachtet den Vault-Ordner und meldet geänderte Notizen gebündelt.
 *
 * Ein Sync schreibt oft viele Dateien kurz hintereinander. Ereignisse werden
 * deshalb gesammelt, bis debounceMs lang Ruhe ist (spätestens nach maxWaitMs),
 * und dann als ein Paket gemeldet: { paths } mit Vault-relativen Pfaden von
 * Notizen und Bildern (die der Index in `images` führt),
 * oder { full: true }, wenn sich einzelne Pfade nicht sicher ableiten lassen
 * (Ordner angelegt, umbenannt oder gelöscht, Ereignis ohne Dateinamen, sehr
 * viele Änderungen auf einmal). Dann ist ein Komplettaufbau billiger und sicher.
 *
 * Versteckte Pfade (.obsidian, .trash, .sync.lock) zählen nicht.
 */
export function createVaultWatcher({
  vaultPath,
  onBatch,
  debounceMs = 1500,
  maxWaitMs = 10_000,
  maxBatch = 500,
  watch = fsWatch,
  logger = console,
}) {
  let paths = new Set();
  let full = false;
  let quietTimer = null;
  let firstEventAt = 0;

  function flush() {
    clearTimeout(quietTimer);
    quietTimer = null;
    firstEventAt = 0;
    const batch = full || paths.size > maxBatch ? { full: true } : { paths: [...paths] };
    paths = new Set();
    full = false;
    try {
      onBatch(batch);
    } catch (err) {
      logger.error?.('Verarbeitung von Vault-Änderungen fehlgeschlagen:', err.message);
    }
  }

  function schedule() {
    const now = Date.now();
    if (!firstEventAt) firstEventAt = now;
    clearTimeout(quietTimer);
    const wait = Math.max(0, Math.min(debounceMs, firstEventAt + maxWaitMs - now));
    quietTimer = setTimeout(flush, wait);
    quietTimer.unref?.();
  }

  const isDirectory = (rel) => {
    try {
      return statSync(join(vaultPath, rel)).isDirectory();
    } catch {
      return false;
    }
  };

  function onEvent(_type, filename) {
    if (filename == null) {
      full = true;
      return schedule();
    }
    const rel = toPosix(String(filename));
    if (rel.split('/').some((part) => part.startsWith('.'))) return;
    // Ein Ordner, der wie eine Notiz oder ein Bild heißt (`skizzen.png/`), gilt als Ordner.
    if ((rel.toLowerCase().endsWith('.md') || isImagePath(rel)) && !isDirectory(rel)) {
      paths.add(rel);
      return schedule();
    }
    // Weder Notiz noch Bild: andere Anhänge sind egal, Ordner nicht. Ein angelegter,
    // umbenannter oder gelöschter Ordner verschiebt Notizen, ohne dass für
    // jede einzelne ein Ereignis kommt.
    let isFile = false;
    try {
      isFile = statSync(join(vaultPath, rel)).isFile();
    } catch {
      isFile = false;
    }
    if (isFile) return;
    full = true;
    schedule();
  }

  const watcher = watch(vaultPath, { recursive: true, persistent: false }, onEvent);
  watcher.on?.('error', (err) => {
    logger.error?.(`Vault-Beobachtung ausgefallen (${err.message}), es bleibt der periodische Neuaufbau`);
  });

  return {
    stop() {
      clearTimeout(quietTimer);
      watcher.close();
    },
  };
}
