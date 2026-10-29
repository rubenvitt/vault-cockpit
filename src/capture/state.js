import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Kleiner, dauerhafter Merkzettel (JSON-Datei unter /data).
 *
 * Hält fest, welche Eingänge schon zu einer Zunder-Aufgabe geführt haben. Damit
 * entsteht keine zweite Aufgabe, wenn nach dem Anlegen der nächste Schritt
 * scheitert (Mail verschieben, Rücklink in die Notiz schreiben) und derselbe
 * Eingang später noch einmal ankommt. Ohne Pfad lebt er nur im Speicher.
 */
export function createStateStore(file = null) {
  let data = {};
  if (file) {
    try {
      data = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      data = {};
    }
  }

  function save() {
    if (!file) return;
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    renameSync(tmp, file);
  }

  return {
    get: (key) => data[key] ?? null,
    /** Alle Schlüssel mit diesem Anfang. */
    keys: (prefix = '') => Object.keys(data).filter((k) => k.startsWith(prefix)),
    set(key, value) {
      data[key] = value;
      save();
    },
    delete(key) {
      if (!(key in data)) return;
      delete data[key];
      save();
    },
    /** Der ganze Stand als JSON, für die Sicherung. */
    snapshot: () => Buffer.from(JSON.stringify(data, null, 2)),
    /**
     * Stand aus einer Sicherung übernehmen: im Speicher und in der Datei.
     * Sonst schriebe der nächste Durchgang der Brücke bis zum Neustart den
     * alten Stand aus dem Speicher über den zurückgespielten (VCP-59).
     */
    replaceWith(buf) {
      const next = JSON.parse(Buffer.from(buf).toString('utf8'));
      if (!next || typeof next !== 'object' || Array.isArray(next)) throw new Error('Merkzettel: kein JSON-Objekt');
      data = next;
      save();
    },
  };
}
