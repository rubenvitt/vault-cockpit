import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chunkNote, hashText } from './chunks.js';
import { dot, normalize } from './embedder.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS vectors (
  path TEXT NOT NULL,
  idx INTEGER NOT NULL,
  hash TEXT NOT NULL,
  heading TEXT,
  vec BLOB NOT NULL,
  PRIMARY KEY (path, idx)
);
`;

const toBlob = (vec) => Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
const fromBlob = (buf) => new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));

/**
 * Semantischer Index: Embeddings je Notizabschnitt, neben dem Volltextindex.
 *
 * Eigene Datenbankdatei, weil der Volltextindex bei jedem Komplettaufbau neu
 * entsteht, Embeddings aber teuer sind: Ein Abschnitt wird nur neu eingebettet,
 * wenn sich sein Text geändert hat (Hash). Wechselt das Modell, verfallen alle
 * Vektoren.
 *
 * Eingebettet werden nur eigene Notizen (Klasse `core`), auch vertrauliche;
 * diese filtert die Suche wie beim Volltext erst beim Ausliefern. Die Vektoren
 * liegen zusätzlich im Speicher, gesucht wird per Skalarprodukt über alle
 * Abschnitte. Bei einigen zehntausend Abschnitten sind das Millisekunden.
 *
 * Abgleiche laufen nacheinander im Hintergrund (`schedule`). Fällt der
 * Embedding-Server aus, bleibt der letzte Stand nutzbar und der Fehler steht im
 * Status.
 */
export function createSemanticIndex({ dbPath, vaultPath, index, embedder, batchSize = 16, logger = console, now = () => Date.now() }) {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(SCHEMA);

  const stored = db.prepare("SELECT value FROM meta WHERE key = 'model'").get()?.value;
  if (stored !== embedder.model) {
    db.exec('DELETE FROM vectors');
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('model', ?)").run(embedder.model);
  }

  /** path → { chunks: [{ hash, heading, vec }], centroid } */
  const notes = new Map();
  for (const row of db.prepare('SELECT path, idx, hash, heading, vec FROM vectors ORDER BY path, idx').all()) {
    if (!notes.has(row.path)) notes.set(row.path, { chunks: [] });
    notes.get(row.path).chunks.push({ hash: row.hash, heading: row.heading, vec: fromBlob(row.vec) });
  }
  for (const entry of notes.values()) entry.centroid = centroidOf(entry.chunks);

  const deletePath = db.prepare('DELETE FROM vectors WHERE path = ?');
  const insert = db.prepare('INSERT INTO vectors (path, idx, hash, heading, vec) VALUES (?,?,?,?,?)');

  const status = { state: 'idle', pending: 0, lastRunAt: null, lastError: null, lastErrorAt: null };
  let queue = Promise.resolve();
  let fullPending = false;
  const pendingPaths = new Set();
  const queryCache = new Map();

  function drop(path) {
    if (!notes.has(path)) return;
    deletePath.run(path);
    notes.delete(path);
  }

  /** Eine Notiz abgleichen: unveränderte Abschnitte behalten, neue einbetten. */
  async function syncNote(path) {
    let raw;
    try {
      raw = readFileSync(join(vaultPath, path), 'utf8');
    } catch {
      drop(path);
      return 0;
    }
    const chunks = chunkNote(raw, { title: path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/i, '') });
    const hashes = chunks.map((c) => hashText(c.text));
    const before = notes.get(path)?.chunks ?? [];
    if (before.length === hashes.length && before.every((c, i) => c.hash === hashes[i])) return 0;

    const known = new Map(before.map((c) => [c.hash, c.vec]));
    const missing = chunks.map((c, i) => ({ c, i })).filter(({ i }) => !known.has(hashes[i]));
    for (let start = 0; start < missing.length; start += batchSize) {
      const batch = missing.slice(start, start + batchSize);
      const vecs = await embedder.embed(batch.map(({ c }) => c.text));
      batch.forEach(({ i }, k) => known.set(hashes[i], vecs[k]));
    }

    const next = chunks.map((c, i) => ({ hash: hashes[i], heading: c.heading, vec: known.get(hashes[i]) }));
    db.exec('BEGIN');
    try {
      deletePath.run(path);
      next.forEach((c, i) => insert.run(path, i, c.hash, c.heading, toBlob(c.vec)));
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    notes.set(path, { chunks: next, centroid: centroidOf(next) });
    return missing.length;
  }

  async function run(paths) {
    status.state = 'running';
    let embedded = 0;
    try {
      const wanted = new Set(index.embeddablePaths());
      const targets = paths ?? [...wanted];
      if (!paths) for (const p of [...notes.keys()]) if (!wanted.has(p)) drop(p);
      status.pending = targets.length;
      for (const path of targets) {
        if (wanted.has(path)) embedded += await syncNote(path);
        else drop(path);
        status.pending -= 1;
      }
      status.state = 'idle';
      status.lastRunAt = now();
      // `lastError` bleibt als letzter Fehler stehen; ob es gerade hakt, sagt `state`.
      if (embedded) logger.info?.(`Embeddings: ${embedded} Abschnitte neu eingebettet (${notes.size} Notizen)`);
    } catch (err) {
      status.state = 'error';
      status.lastError = err.message;
      status.lastErrorAt = now();
      logger.warn?.(`Embeddings fehlgeschlagen: ${err.message}`);
    } finally {
      status.pending = 0;
    }
  }

  /**
   * Abgleich einplanen: ohne Pfade alles, sonst nur diese. Aufrufe, die
   * eintreffen, während ein Lauf läuft, werden zu einem Folgelauf gebündelt.
   */
  function schedule(paths = null) {
    if (paths === null) fullPending = true;
    else for (const p of paths) pendingPaths.add(p);
    queue = queue.then(async () => {
      if (!fullPending && !pendingPaths.size) return;
      const full = fullPending;
      const batch = [...pendingPaths];
      fullPending = false;
      pendingPaths.clear();
      await run(full ? null : batch);
    });
    return queue;
  }

  async function embedQuery(text) {
    const key = String(text).trim();
    if (queryCache.has(key)) return queryCache.get(key);
    const [vec] = await embedder.embed([key]);
    queryCache.set(key, vec);
    if (queryCache.size > 100) queryCache.delete(queryCache.keys().next().value);
    return vec;
  }

  return {
    model: embedder.model,
    schedule,
    embedQuery,

    /** Notizen nach bestem Abschnitt, ähnlichste zuerst. `allow(path)` filtert. */
    searchVector(vec, { limit = 50, allow = () => true } = {}) {
      const hits = [];
      for (const [path, entry] of notes) {
        if (!allow(path)) continue;
        let best = -Infinity;
        let heading = null;
        for (const c of entry.chunks) {
          const s = dot(vec, c.vec);
          if (s > best) {
            best = s;
            heading = c.heading;
          }
        }
        hits.push({ path, score: best, heading });
      }
      return hits.sort((a, b) => b.score - a.score).slice(0, limit);
    },

    /** Notizen, die einer Notiz inhaltlich ähneln (Schwerpunkt gegen Schwerpunkt). */
    similarTo(path, { limit = 10, allow = () => true, minScore = 0 } = {}) {
      const self = notes.get(path);
      if (!self) return null;
      const hits = [];
      for (const [other, entry] of notes) {
        if (other === path || !allow(other)) continue;
        const score = dot(self.centroid, entry.centroid);
        if (score >= minScore) hits.push({ path: other, score });
      }
      return hits.sort((a, b) => b.score - a.score).slice(0, limit);
    },

    has: (path) => notes.has(path),

    status() {
      let chunks = 0;
      for (const e of notes.values()) chunks += e.chunks.length;
      const iso = (ms) => (ms ? new Date(ms).toISOString() : null);
      return {
        model: embedder.model,
        state: status.state,
        notes: notes.size,
        chunks,
        pending: status.pending,
        lastRunAt: iso(status.lastRunAt),
        lastError: status.lastError,
        lastErrorAt: iso(status.lastErrorAt),
      };
    },

    /** Wartet, bis alle eingeplanten Läufe durch sind (Tests, Herunterfahren). */
    idle: () => queue,

    close() {
      db.close();
    },
  };
}

function centroidOf(chunks) {
  if (!chunks.length) return new Float32Array(0);
  const out = new Float32Array(chunks[0].vec.length);
  for (const c of chunks) for (let i = 0; i < out.length; i += 1) out[i] += c.vec[i];
  return normalize(out);
}
