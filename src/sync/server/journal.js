import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes } from 'node:crypto';
import {
  readFileSync, writeFileSync, renameSync, unlinkSync, rmdirSync, mkdirSync, readdirSync,
  statSync, lstatSync, utimesSync, existsSync, realpathSync,
} from 'node:fs';
import { join, dirname, resolve, sep } from 'node:path';
import { mergeFile, conflictName } from './merge.js';

/**
 * Journal des eigenen Syncs (VCP-120): Der Vault-Ordner auf dem Server bleibt
 * die Wahrheit, das Journal merkt sich, welche Fassung jeder Datei die Geräte
 * schon kennen.
 *
 * - `files`: je Pfad die aktuelle Fassung (Hash, Größe, mtime) und die
 *   Änderungsnummer `seq`, die bei jeder Änderung global hochzählt. Gelöschte
 *   Dateien bleiben als Grabstein (`hash` NULL) stehen, damit Geräte das
 *   Löschen mitbekommen. `changes(since)` ist deshalb einfach „alle Zeilen mit
 *   größerem seq“, ohne eigenes Änderungsprotokoll.
 * - Blobs: jede gesehene Fassung bis `maxBlobBytes` content-adressiert unter `blobDir`. Sie sind
 *   die gemeinsame Basis für den späteren 3-Wege-Merge (VCP-122) und den
 *   Versionsverlauf (VCP-124).
 *
 * Schreiben geht mit Basis-Hash: Das Gerät sagt, welche Fassung es zuletzt
 * kannte (`null` = gab es nicht). Weicht der Stand auf dem Server ab, wird
 * nichts überschrieben (VCP-122): Der Server führt beide Fassungen per
 * 3-Wege-Merge zusammen (siehe merge.js) oder behält seine und legt die des
 * Geräts als Konfliktkopie daneben. Löschen gegen Ändern: Ändern gewinnt.
 * Vor jeder Prüfung wird die Datei auf der Platte neu angesehen, denn das
 * Cockpit selbst (Bearbeiten, Capture, Brücke) schreibt am Journal vorbei.
 *
 * Synchronisiert wird jede Datei des Vaults außer versteckten Pfaden (ein
 * Teil beginnt mit „.“: `.obsidian`, `.trash`, `.git`). Die Ausschlüsse der
 * Policy gelten bewusst nicht, sie regeln den Index, nicht welche Dateien
 * zum Vault gehören.
 */

export const MAX_FILE_BYTES = 100 * 1024 * 1024;
/** Größere Fassungen (Videos, große PDFs) kommen nicht in den Blob-Speicher, sonst liegt der Vault doppelt auf der Platte. */
export const MAX_BLOB_BYTES = 5 * 1024 * 1024;
const MAX_PATH_LENGTH = 1024;

export class SyncPathError extends Error {}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS files (
  path     TEXT PRIMARY KEY,
  hash     TEXT,
  size     INTEGER NOT NULL DEFAULT 0,
  mtime    INTEGER NOT NULL DEFAULT 0,
  seq      INTEGER NOT NULL,
  device   TEXT
);
CREATE INDEX IF NOT EXISTS files_seq ON files(seq);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS devices (
  id         TEXT PRIMARY KEY,
  name       TEXT,
  client     TEXT,
  seen_at    INTEGER,
  pull_at    INTEGER,
  push_at    INTEGER,
  cursor     INTEGER
);
`;

const sha256 = (data) => createHash('sha256').update(data).digest('hex');

/**
 * Prüft einen Vault-relativen Pfad, wie ihn ein Gerät schickt, und gibt ihn
 * unverändert zurück. Abgelehnt: leer, absolut, `..`, leere Teile, Backslash,
 * Steuerzeichen, versteckte Teile, zu lang.
 */
export function checkSyncPath(raw) {
  if (typeof raw !== 'string' || !raw) throw new SyncPathError('Pfad fehlt');
  if (raw.length > MAX_PATH_LENGTH) throw new SyncPathError('Pfad ist zu lang');
  if (/[\u0000-\u001f\u007f\\]/.test(raw)) throw new SyncPathError('Pfad enthält unzulässige Zeichen');
  const parts = raw.split('/');
  for (const part of parts) {
    if (!part) throw new SyncPathError('Pfad hat leere Teile oder beginnt mit „/“');
    if (part === '..' || part === '.') throw new SyncPathError('Pfad darf nicht „..“ oder „.“ enthalten');
    if (part.startsWith('.')) throw new SyncPathError('Versteckte Pfade werden nicht synchronisiert');
  }
  return raw;
}

const isHidden = (rel) => rel.split('/').some((part) => part.startsWith('.'));
const toPosix = (p) => p.split(sep).join('/');

export function createSyncJournal({
  vaultPath,
  dbPath,
  blobDir,
  maxFileBytes = MAX_FILE_BYTES,
  maxBlobBytes = MAX_BLOB_BYTES,
  now = Date.now,
  logger = console,
}) {
  const root = resolve(vaultPath);
  mkdirSync(blobDir, { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(SCHEMA);

  const stmt = {
    get: db.prepare('SELECT path, hash, size, mtime, seq, device FROM files WHERE path = ?'),
    sameCase: db.prepare('SELECT path FROM files WHERE lower(path) = lower(?) AND path <> ? AND hash IS NOT NULL LIMIT 1'),
    upsert: db.prepare(`INSERT INTO files (path, hash, size, mtime, seq, device) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET hash = excluded.hash, size = excluded.size, mtime = excluded.mtime, seq = excluded.seq, device = excluded.device`),
    // Gleiche Fassung, nur neue mtime auf der Platte: kein neues seq.
    touch: db.prepare('UPDATE files SET size = ?, mtime = ? WHERE path = ?'),
    live: db.prepare('SELECT path, hash, size, mtime, seq FROM files WHERE hash IS NOT NULL ORDER BY path'),
    since: db.prepare('SELECT path, hash, size, mtime, seq, device FROM files WHERE seq > ? ORDER BY seq LIMIT ?'),
    maxSeq: db.prepare('SELECT max(seq) AS seq FROM files'),
    getMeta: db.prepare('SELECT value FROM meta WHERE key = ?'),
    setMeta: db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
    device: db.prepare(`INSERT INTO devices (id, name, client, seen_at, pull_at, push_at, cursor) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, client = coalesce(excluded.client, devices.client), seen_at = excluded.seen_at,
        pull_at = coalesce(excluded.pull_at, devices.pull_at), push_at = coalesce(excluded.push_at, devices.push_at),
        cursor = coalesce(excluded.cursor, devices.cursor)`),
    devices: db.prepare('SELECT id, name, client, seen_at, pull_at, push_at, cursor FROM devices ORDER BY seen_at DESC'),
  };

  // seq zählt nur hoch, auch über Grabsteine hinweg; `meta.seq` hält den
  // Stand, falls die höchste Zeile einmal verschwindet.
  let seq = Math.max(Number(stmt.maxSeq.get().seq ?? 0), Number(stmt.getMeta.get('seq')?.value ?? 0));
  const nextSeq = () => {
    seq += 1;
    stmt.setMeta.run('seq', String(seq));
    return seq;
  };

  const realRoot = realpathSync(root);
  const abs = (rel) => {
    const full = resolve(root, rel);
    if (!full.startsWith(root + sep)) throw new SyncPathError('Pfad liegt außerhalb des Vaults');
    // Kein Symlink im Vault darf aus ihm hinausführen: den nächsten vorhandenen Vorfahren auflösen.
    let probe = full;
    while (!existsSync(probe)) probe = dirname(probe);
    const real = realpathSync(probe);
    if (real !== realRoot && !real.startsWith(realRoot + sep)) throw new SyncPathError('Pfad liegt außerhalb des Vaults');
    // Auch nicht über einen Symlink in einen versteckten Ordner (.obsidian, .trash …).
    if (real !== realRoot && isHidden(toPosix(real.slice(realRoot.length + 1)))) throw new SyncPathError('Versteckte Pfade werden nicht synchronisiert');
    return full;
  };

  const blobPath = (hash) => join(blobDir, hash.slice(0, 2), hash.slice(2));

  function storeBlob(hash, data) {
    const target = blobPath(hash);
    if (existsSync(target)) return;
    mkdirSync(dirname(target), { recursive: true });
    const tmp = `${target}.${randomBytes(6).toString('hex')}.tmp`;
    writeFileSync(tmp, data);
    renameSync(tmp, target);
  }

  const row = (r) => (r ? { path: r.path, hash: r.hash ?? null, size: Number(r.size), mtime: Number(r.mtime), seq: Number(r.seq) } : null);

  /** Hält eine Fassung fest; gleicher Hash wie bisher zählt nicht als Änderung. */
  function record(rel, { hash, size = 0, mtime = 0, data = null, device = null }) {
    const prev = stmt.get.get(rel);
    if (prev && (prev.hash ?? null) === hash) {
      if (hash && (Number(prev.size) !== size || Number(prev.mtime) !== mtime)) stmt.touch.run(size, mtime, rel);
      return { changed: false, entry: row({ ...prev, size, mtime }) };
    }
    if (!prev && hash === null) return { changed: false, entry: null };
    if (hash && data && data.length <= maxBlobBytes) storeBlob(hash, data);
    const s = nextSeq();
    stmt.upsert.run(rel, hash, size, mtime, s, device);
    return { changed: true, entry: row({ path: rel, hash, size, mtime, seq: s }) };
  }

  /**
   * Sieht eine Datei auf der Platte neu an und gleicht das Journal ab.
   * Liest den Inhalt nur, wenn sich Größe oder mtime geändert haben.
   */
  function refresh(rel, { device = null } = {}) {
    const full = abs(rel);
    let st = null;
    try {
      st = lstatSync(full);
    } catch (err) {
      if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') throw err;
    }
    if (!st || !st.isFile()) return record(rel, { hash: null, device });
    const mtime = Math.floor(st.mtimeMs);
    const prev = stmt.get.get(rel);
    if (prev?.hash && Number(prev.size) === st.size && Number(prev.mtime) === mtime) return { changed: false, entry: row(prev) };
    if (st.size > maxFileBytes) {
      logger.warn?.(`Sync: ${rel} ist größer als ${Math.round(maxFileBytes / 1024 / 1024)} MB und wird nicht synchronisiert`);
      return { changed: false, entry: row(prev), tooLarge: true };
    }
    const data = readFileSync(full);
    return record(rel, { hash: sha256(data), size: st.size, mtime, data, device });
  }

  function readBlob(hash) {
    if (!/^[0-9a-f]{64}$/.test(String(hash))) return null;
    try {
      return readFileSync(blobPath(hash));
    } catch {
      return null;
    }
  }

  /** Schreibt atomar (Temp-Datei, dann umbenennen) und hält die neue Fassung fest. */
  function write(rel, data, { mtime = null, device = null } = {}) {
    const full = abs(rel);
    mkdirSync(dirname(full), { recursive: true });
    const tmp = join(dirname(full), `.sync-${randomBytes(6).toString('hex')}.tmp`);
    writeFileSync(tmp, data);
    if (Number.isFinite(mtime) && mtime > 0) utimesSync(tmp, new Date(), new Date(mtime));
    renameSync(tmp, full);
    const st = statSync(full);
    return record(rel, { hash: sha256(data), size: st.size, mtime: Math.floor(st.mtimeMs), data, device }).entry;
  }

  /** Freier Name für eine Konfliktkopie neben `rel`, oder null. */
  function freeConflictName(rel, deviceName) {
    const date = new Date(now()).toISOString().slice(0, 10);
    for (let n = 1; n <= 50; n += 1) {
      const candidate = conflictName(rel, deviceName, date, n);
      try {
        checkSyncPath(candidate);
        if (existsSync(abs(candidate)) || stmt.sameCase.get(candidate, candidate)) continue;
      } catch {
        return null;
      }
      return candidate;
    }
    return null;
  }

  /** Alle sichtbaren Dateien unter dem Vault (rekursiv, ohne versteckte, ohne Symlinks). */
  /** Unlesbare Unterordner landen in `unreadable` (mit „/“ am Ende); ist der Vault selbst unlesbar, bricht es ab. */
  function* walk(dir, unreadable) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      if (dir === root) throw err;
      logger.warn?.(`Sync: Ordner nicht lesbar: ${dir} (${err.message})`);
      unreadable.push(`${toPosix(dir.slice(root.length + 1))}/`);
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) yield* walk(full, unreadable);
      else if (e.isFile()) yield toPosix(full.slice(root.length + 1));
    }
  }

  return {
    /** Gleicht das ganze Journal mit der Platte ab; liefert die geänderten Pfade. */
    scan() {
      const changed = [];
      const seen = new Set();
      // Was in einem gerade unlesbaren Ordner liegt, gilt nicht als gelöscht.
      const unreadable = [];
      db.exec('BEGIN');
      try {
        for (const rel of walk(root, unreadable)) {
          seen.add(rel);
          try {
            if (refresh(rel).changed) changed.push(rel);
          } catch (err) {
            logger.warn?.(`Sync: ${rel} übersprungen (${err.message})`);
          }
        }
        for (const r of stmt.live.all()) {
          if (seen.has(r.path) || unreadable.some((p) => r.path.startsWith(p))) continue;
          if (record(r.path, { hash: null }).changed) changed.push(r.path);
        }
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
      return changed;
    },

    refresh: (rel, opts) => refresh(checkSyncPath(rel), opts).entry,

    cursor: () => seq,

    /** Aktuelle Fassung aller vorhandenen Dateien, für den ersten Abgleich eines Geräts. */
    snapshot: () => ({ cursor: seq, files: stmt.live.all().map(row) }),

    /** Alles mit seq > since, älteste zuerst; Grabsteine haben `hash: null`. */
    changes(since = 0, limit = 1000) {
      const rows = stmt.since.all(since, limit + 1).map(row);
      const more = rows.length > limit;
      const list = more ? rows.slice(0, limit) : rows;
      return { cursor: more ? list[list.length - 1].seq : seq, changes: list, more };
    },

    /** Aktueller Inhalt einer Datei samt Eintrag, oder null. */
    read(rel) {
      const entry = refresh(checkSyncPath(rel)).entry;
      if (!entry?.hash) return null;
      const data = readFileSync(abs(rel));
      // Zwischen Ansehen und Lesen geändert: dann zählt, was gelesen wurde.
      const hash = sha256(data);
      if (hash !== entry.hash) return { entry: refresh(rel).entry, data };
      return { entry, data };
    },

    /** Eine frühere Fassung über ihren Hash, oder null. */
    blob: readBlob,

    /**
     * Schreibt eine Datei. Ist `base` der aktuelle Hash (`null` = Datei gibt
     * es noch nicht), einfach so; ist der Stand schon der neue, gilt das als
     * Erfolg (wiederholter Upload). Sonst entscheidet `resolution`:
     * - `restored`: auf dem Server inzwischen gelöscht, die Änderung gewinnt;
     * - `merged`: beide Fassungen zusammengeführt, das Ergebnis liegt auf dem Server;
     * - `copy`: nicht zusammenführbar, der Server behält seine Fassung, die des
     *   Geräts liegt als Konfliktkopie (`copy`) daneben.
     */
    put(rel, data, { base = null, mtime = null, device = null, deviceName = null } = {}) {
      checkSyncPath(rel);
      if (data.length > maxFileBytes) return { ok: false, reason: 'too_large' };
      const hash = sha256(data);
      const seen = refresh(rel);
      // Liegt dort eine Datei über der Grenze, kennt das Journal sie nicht: nicht überschreiben.
      if (seen.tooLarge) return { ok: false, reason: 'too_large' };
      const current = seen.entry;
      const currentHash = current?.hash ?? null;
      if (currentHash === hash) return { ok: true, entry: current, unchanged: true };
      if (!currentHash) {
        // Auf Geräten mit Dateisystem ohne Groß-/Kleinschreibung wären das zwei Dateien am selben Ort.
        const other = stmt.sameCase.get(rel, rel);
        if (other) return { ok: false, reason: 'case', current: row(stmt.get.get(other.path)) };
        const entry = write(rel, data, { mtime, device });
        return base ? { ok: true, entry, resolution: 'restored' } : { ok: true, entry };
      }
      if (currentHash === (base || null)) return { ok: true, entry: write(rel, data, { mtime, device }) };

      // Veraltete Basis: zusammenführen oder Konfliktkopie, nie überschreiben.
      const ours = readFileSync(abs(rel));
      // Gerade eben auf der Platte geändert: das Gerät soll es noch einmal versuchen.
      if (sha256(ours) !== currentHash) return { ok: false, reason: 'conflict', current: refresh(rel).entry };
      const baseData = base ? readBlob(base) : null;
      const merged = baseData && mergeFile(rel, baseData, ours, data);
      if (merged) {
        if (sha256(merged) === currentHash) return { ok: true, entry: current, unchanged: true, resolution: 'merged' };
        return { ok: true, entry: write(rel, merged, { device }), resolution: 'merged' };
      }
      const copyRel = freeConflictName(rel, deviceName ?? device);
      if (!copyRel) return { ok: false, reason: 'conflict', current };
      const copy = write(copyRel, data, { mtime, device });
      return { ok: true, entry: current, unchanged: true, resolution: 'copy', copy };
    },

    /** Löscht eine Datei, wenn `base` der aktuelle Hash ist. Schon weg gilt als Erfolg. */
    remove(rel, { base = null, device = null } = {}) {
      checkSyncPath(rel);
      const seen = refresh(rel);
      if (seen.tooLarge) return { ok: false, reason: 'too_large' };
      const current = seen.entry;
      if (!current?.hash) return { ok: true, entry: current, unchanged: true };
      // Inzwischen geändert: Ändern gewinnt, die Datei bleibt.
      if (current.hash !== base) return { ok: true, entry: current, unchanged: true, resolution: 'kept' };
      const full = abs(rel);
      unlinkSync(full);
      // Leer gewordene Ordner aufräumen, bis zum Vault hinauf.
      for (let dir = dirname(full); dir.startsWith(root + sep); dir = dirname(dir)) {
        try {
          rmdirSync(dir);
        } catch {
          break;
        }
      }
      return { ok: true, entry: record(rel, { hash: null, device }).entry };
    },

    /** Merkt sich, dass ein Gerät da war (und ob es geholt oder geschickt hat). */
    seen({ id, name, client = null }, { pulled = false, pushed = false, cursor = null } = {}) {
      const t = now();
      stmt.device.run(id, name ?? null, client, t, pulled ? t : null, pushed ? t : null, cursor);
    },

    devices: () =>
      stmt.devices.all().map((d) => ({
        id: d.id,
        name: d.name,
        client: d.client,
        seenAt: d.seen_at ? new Date(Number(d.seen_at)).toISOString() : null,
        pullAt: d.pull_at ? new Date(Number(d.pull_at)).toISOString() : null,
        pushAt: d.push_at ? new Date(Number(d.push_at)).toISOString() : null,
        cursor: d.cursor == null ? null : Number(d.cursor),
      })),

    close: () => db.close(),
  };
}
