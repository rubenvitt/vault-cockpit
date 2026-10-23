import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { writePrivate } from '../cockpit/settings.js';

/**
 * Lesestapel (VCP-77): Artikel, Markierungen und Feeds in einer eigenen
 * SQLite-Datei unter `/data`. Anders als der Index lässt sie sich nicht neu
 * bauen und gehört deshalb in die Sicherung (`snapshot`, `replaceWith`).
 *
 * Status eines Dokuments: `eingang` (neu, noch nicht gesichtet), `stapel`
 * (will ich lesen), `archiv` (gelesen), `weg` (verworfen). `previous_status`
 * hält den Stand vor dem letzten Wechsel für „Rückgängig“.
 *
 * Kein WAL: Die Datei ist klein, es schreibt nur dieser Dienst, und ohne
 * `-wal`/`-shm` daneben bleibt Sichern und Zurückschreiben einfach.
 */

export const STATUSES = ['eingang', 'stapel', 'archiv', 'weg'];
export const KINDS = ['artikel', 'newsletter', 'feed', 'pdf'];
export const REVIEW_STATES = ['aktiv', 'losgelassen'];

/** Neue Fassung: Eintrag hier anhängen, `user_version` zählt mit. */
const MIGRATIONS = [
  `CREATE TABLE documents (
    id TEXT PRIMARY KEY,
    url TEXT NOT NULL,
    canonical_url TEXT,
    title TEXT,
    author TEXT,
    site TEXT,
    kind TEXT NOT NULL DEFAULT 'artikel',
    origin TEXT NOT NULL DEFAULT 'formular',
    client_id TEXT UNIQUE,
    excerpt TEXT,
    content_html TEXT,
    content_text TEXT,
    word_count INTEGER NOT NULL DEFAULT 0,
    reading_minutes INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'eingang',
    previous_status TEXT,
    progress REAL NOT NULL DEFAULT 0,
    scroll_anchor TEXT,
    topics TEXT NOT NULL DEFAULT '[]',
    saved_at TEXT NOT NULL,
    status_changed_at TEXT NOT NULL,
    read_at TEXT,
    archived_at TEXT,
    updated_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX documents_url ON documents(url);
  CREATE INDEX documents_canonical ON documents(canonical_url);
  CREATE INDEX documents_status ON documents(status, saved_at);

  CREATE TABLE highlights (
    id TEXT PRIMARY KEY,
    doc_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    quote TEXT NOT NULL,
    prefix TEXT NOT NULL DEFAULT '',
    suffix TEXT NOT NULL DEFAULT '',
    start_hint INTEGER,
    note TEXT,
    color TEXT NOT NULL DEFAULT 'gelb',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    review_box INTEGER NOT NULL DEFAULT 0,
    review_due TEXT,
    review_state TEXT NOT NULL DEFAULT 'aktiv'
  );
  CREATE INDEX highlights_doc ON highlights(doc_id);
  CREATE INDEX highlights_due ON highlights(review_state, review_due);

  CREATE TABLE feeds (
    id TEXT PRIMARY KEY,
    url TEXT NOT NULL UNIQUE,
    site_url TEXT,
    title TEXT,
    icon TEXT,
    paused INTEGER NOT NULL DEFAULT 0,
    to_stack INTEGER NOT NULL DEFAULT 0,
    keyword_filter TEXT,
    interval_minutes INTEGER NOT NULL DEFAULT 60,
    etag TEXT,
    last_modified TEXT,
    last_fetch_at TEXT,
    last_error TEXT,
    error_count INTEGER NOT NULL DEFAULT 0,
    next_fetch_at TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE feed_entries (
    feed_id TEXT NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
    guid TEXT NOT NULL,
    doc_id TEXT REFERENCES documents(id) ON DELETE SET NULL,
    PRIMARY KEY (feed_id, guid)
  );`,
];

export class ReadingError extends Error {}

const DOC_FIELDS = ['url', 'canonical_url', 'title', 'author', 'site', 'kind', 'origin', 'client_id', 'excerpt', 'content_html', 'content_text', 'word_count', 'reading_minutes', 'status', 'topics'];
const HIGHLIGHT_EDIT = ['quote', 'prefix', 'suffix', 'start_hint', 'note', 'color', 'review_box', 'review_due', 'review_state'];
const FEED_EDIT = ['url', 'site_url', 'title', 'icon', 'paused', 'to_stack', 'keyword_filter', 'interval_minutes', 'etag', 'last_modified', 'last_fetch_at', 'last_error', 'error_count', 'next_fetch_at'];

const fromRow = (row) => (row ? { ...row, topics: JSON.parse(row.topics ?? '[]') } : null);
const feedRow = (row) => (row ? { ...row, paused: Boolean(row.paused), to_stack: Boolean(row.to_stack) } : null);
// node:sqlite bindet keine Booleans.
const bindable = (v) => (typeof v === 'boolean' ? Number(v) : v === undefined ? null : v);

function migrate(db) {
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (version > MIGRATIONS.length) throw new ReadingError(`lesestapel.db hat Fassung ${version}, dieses Cockpit kennt nur ${MIGRATIONS.length}`);
  for (let v = version; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN');
    db.exec(MIGRATIONS[v]);
    db.exec(`PRAGMA user_version = ${v + 1}`);
    db.exec('COMMIT');
  }
}

/**
 * `path`: SQLite-Datei (`/data/lesestapel.db`, in Tests auch `:memory:`).
 * `now` liefert die Zeit für die Zeitstempel (ISO-Text).
 */
export function createReadingStore({ path, now = () => Date.now() }) {
  let db;
  const open = () => {
    db = new DatabaseSync(path);
    db.exec('PRAGMA foreign_keys = ON');
    migrate(db);
  };
  open();
  const iso = () => new Date(now()).toISOString();

  /** UPDATE nur der erlaubten Felder, die in `patch` stehen. */
  const update = (table, id, patch, allowed) => {
    const keys = Object.keys(patch).filter((k) => allowed.includes(k));
    if (!keys.length) return;
    db.prepare(`UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => bindable(patch[k])), id);
  };

  const get = (id) => fromRow(db.prepare('SELECT * FROM documents WHERE id = ?').get(String(id ?? '')));
  const getHighlight = (id) => db.prepare('SELECT * FROM highlights WHERE id = ?').get(String(id ?? '')) ?? null;
  const getFeed = (id) => feedRow(db.prepare('SELECT * FROM feeds WHERE id = ?').get(String(id ?? '')));
  const must = (row, what) => {
    if (!row) throw new ReadingError(`${what} gibt es nicht`);
    return row;
  };

  /** Schon gespeichert? Erst per `client_id`, dann per Adresse (auch kanonisch). */
  const findExisting = ({ client_id: clientId, url, canonical_url: canonical }) => {
    if (clientId) {
      const row = db.prepare('SELECT * FROM documents WHERE client_id = ?').get(clientId);
      if (row) return fromRow(row);
    }
    const urls = [url, canonical].filter(Boolean);
    if (!urls.length) return null;
    const marks = urls.map(() => '?').join(', ');
    return fromRow(db.prepare(`SELECT * FROM documents WHERE url IN (${marks}) OR canonical_url IN (${marks}) LIMIT 1`).get(...urls, ...urls));
  };

  return {
    /**
     * Legt ein Dokument an, idempotent: Dieselbe `client_id` oder dieselbe
     * Adresse liefert das vorhandene mit `duplicate: true`, unverändert.
     * Felder wie in der Tabelle (`url` Pflicht, `topics` als Array).
     */
    addDocument(fields) {
      if (!fields?.url) throw new ReadingError('Adresse fehlt');
      const existing = findExisting(fields);
      if (existing) return { doc: existing, duplicate: true };
      const status = fields.status ?? 'eingang';
      if (!STATUSES.includes(status)) throw new ReadingError(`Unbekannter Status ${status}`);
      if (fields.kind && !KINDS.includes(fields.kind)) throw new ReadingError(`Unbekannte Art ${fields.kind}`);
      const t = iso();
      const row = { ...Object.fromEntries(DOC_FIELDS.map((k) => [k, fields[k] ?? null])), kind: fields.kind ?? 'artikel', origin: fields.origin ?? 'formular', status, word_count: fields.word_count ?? 0, reading_minutes: fields.reading_minutes ?? 0, topics: JSON.stringify(fields.topics ?? []) };
      const id = randomUUID();
      const cols = ['id', ...DOC_FIELDS, 'saved_at', 'status_changed_at', 'updated_at'];
      db.prepare(`INSERT INTO documents (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(id, ...DOC_FIELDS.map((k) => bindable(row[k])), t, t, t);
      return { doc: get(id), duplicate: false };
    },

    get,
    /** Vorhandenes Dokument zu `{ client_id, url, canonical_url }` oder `null`. */
    find: findExisting,

    /** Neueste zuerst; ohne `status` alle außer `weg`. Ohne Inhalt (`content_*`), der kommt mit `get`. */
    list({ status = null, limit = 100, offset = 0 } = {}) {
      const cols = 'id, url, canonical_url, title, author, site, kind, origin, excerpt, word_count, reading_minutes, status, previous_status, progress, scroll_anchor, topics, saved_at, status_changed_at, read_at, archived_at, updated_at';
      const rows = status
        ? db.prepare(`SELECT ${cols} FROM documents WHERE status = ? ORDER BY saved_at DESC, rowid DESC LIMIT ? OFFSET ?`).all(status, limit, offset)
        : db.prepare(`SELECT ${cols} FROM documents WHERE status != 'weg' ORDER BY saved_at DESC, rowid DESC LIMIT ? OFFSET ?`).all(limit, offset);
      return rows.map(fromRow);
    },

    /** Anzahl je Status, z. B. für Zähler in der Navigation. */
    counts() {
      const out = Object.fromEntries(STATUSES.map((s) => [s, 0]));
      for (const r of db.prepare('SELECT status, COUNT(*) AS n FROM documents GROUP BY status').all()) out[r.status] = r.n;
      return out;
    },

    /**
     * Neuer Status; `previous` ist der alte (für „Rückgängig“ einfach
     * `setStatus(id, previous)`). `archiv` setzt `archived_at`, das erste
     * Archivieren auch `read_at`.
     */
    setStatus(id, status) {
      if (!STATUSES.includes(status)) throw new ReadingError(`Unbekannter Status ${status}`);
      const doc = must(get(id), 'Dieses Dokument');
      if (doc.status === status) return { doc, previous: doc.status, changed: false };
      const t = iso();
      db.prepare(
        `UPDATE documents SET previous_status = status, status = ?, status_changed_at = ?, updated_at = ?,
           archived_at = CASE WHEN ? = 'archiv' THEN ? ELSE archived_at END,
           read_at = CASE WHEN ? = 'archiv' AND read_at IS NULL THEN ? ELSE read_at END
         WHERE id = ?`,
      ).run(status, t, t, status, t, status, t, doc.id);
      return { doc: get(doc.id), previous: doc.status, changed: true };
    },

    /**
     * Entscheidungen im Eingang seit `since` (ISO): wie viele Dokumente ihn
     * verlassen haben und welches zuletzt. Ein Rückgängig setzt
     * `previous_status` um, damit zählt es nicht mehr.
     * shortcut: Wer „Jetzt lesen“ noch am selben Tag archiviert, fällt aus der
     * Zählung (`previous_status` ist dann `stapel`); bei Bedarf ein eigenes Feld
     * `triaged_at` per Migration.
     */
    leftInboxSince(since) {
      const where = "previous_status = 'eingang' AND status != 'eingang' AND status_changed_at >= ?";
      const { n } = db.prepare(`SELECT COUNT(*) AS n FROM documents WHERE ${where}`).get(since);
      // Zurücklegen geht nur von Stapel und Weg aus (src/lesen/inbox.js).
      const last = db.prepare(`SELECT id, title, url FROM documents WHERE ${where} AND status IN ('stapel', 'weg') ORDER BY status_changed_at DESC, rowid DESC LIMIT 1`).get(since);
      return { count: n, last: last ? { ...last } : null };
    },

    /** Lesefortschritt 0..1, optional mit Anker zum Weiterlesen. */
    setProgress(id, progress, scrollAnchor = undefined) {
      const p = Number(progress);
      if (!Number.isFinite(p)) throw new ReadingError('Fortschritt muss eine Zahl sein');
      const doc = must(get(id), 'Dieses Dokument');
      const patch = { progress: Math.min(1, Math.max(0, p)), updated_at: iso() };
      if (scrollAnchor !== undefined) patch.scroll_anchor = scrollAnchor;
      update('documents', doc.id, patch, ['progress', 'scroll_anchor', 'updated_at']);
      return get(doc.id);
    },

    /** Weitere Felder ändern (Titel, Themen, Inhalt nach erneutem Holen …). */
    updateDocument(id, patch) {
      must(get(id), 'Dieses Dokument');
      const p = { ...patch, updated_at: iso() };
      if (p.topics) p.topics = JSON.stringify(p.topics);
      update('documents', id, p, ['canonical_url', 'title', 'author', 'site', 'kind', 'excerpt', 'content_html', 'content_text', 'word_count', 'reading_minutes', 'topics', 'updated_at']);
      return get(id);
    },

    deleteDocument: (id) => db.prepare('DELETE FROM documents WHERE id = ?').run(String(id ?? '')).changes > 0,

    // --- Markierungen ---------------------------------------------------------

    /** `{ doc_id, quote, prefix, suffix, start_hint, note, color }`; Anker = Zitat mit Umgebung. */
    addHighlight(fields) {
      must(get(fields?.doc_id), 'Dieses Dokument');
      if (!fields.quote) throw new ReadingError('Zitat fehlt');
      const t = iso();
      const id = randomUUID();
      db.prepare('INSERT INTO highlights (id, doc_id, quote, prefix, suffix, start_hint, note, color, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run(
        id, fields.doc_id, fields.quote, fields.prefix ?? '', fields.suffix ?? '', fields.start_hint ?? null, fields.note ?? null, fields.color ?? 'gelb', t, t,
      );
      return getHighlight(id);
    },
    getHighlight,
    /**
     * Mit `docId` die eines Dokuments in Lesereihenfolge, sonst alle neuesten
     * zuerst samt Titel, Adresse, Quelle (`doc_site`) und Themen (`doc_topics`);
     * `site` und `topic` filtern danach.
     */
    listHighlights({ docId = null, site = null, topic = null, limit = 200 } = {}) {
      if (docId) return db.prepare('SELECT * FROM highlights WHERE doc_id = ? ORDER BY start_hint, created_at').all(docId);
      return db
        .prepare(
          `SELECT h.*, d.title AS doc_title, d.url AS doc_url, d.site AS doc_site, d.topics AS doc_topics FROM highlights h JOIN documents d ON d.id = h.doc_id
           WHERE (? IS NULL OR d.site = ?) AND (? IS NULL OR EXISTS (SELECT 1 FROM json_each(d.topics) WHERE value = ?))
           ORDER BY h.created_at DESC, h.rowid DESC LIMIT ?`,
        )
        .all(site, site, topic, topic, limit)
        .map((h) => ({ ...h, doc_topics: JSON.parse(h.doc_topics ?? '[]') }));
    },
    /** Quellen und Themen der Dokumente mit Markierungen, für die Filter unter „Markiert“. */
    highlightFacets() {
      const rows = db.prepare('SELECT DISTINCT d.site, d.topics FROM highlights h JOIN documents d ON d.id = h.doc_id').all();
      const sorted = (values) => [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b, 'de'));
      return { sites: sorted(rows.map((r) => r.site)), topics: sorted(rows.flatMap((r) => JSON.parse(r.topics ?? '[]'))) };
    },
    updateHighlight(id, patch) {
      must(getHighlight(id), 'Diese Markierung');
      if (patch.review_state && !REVIEW_STATES.includes(patch.review_state)) throw new ReadingError(`Unbekannter Zustand ${patch.review_state}`);
      update('highlights', id, { ...patch, updated_at: iso() }, [...HIGHLIGHT_EDIT, 'updated_at']);
      return getHighlight(id);
    },
    deleteHighlight: (id) => db.prepare('DELETE FROM highlights WHERE id = ?').run(String(id ?? '')).changes > 0,

    // --- Feeds ----------------------------------------------------------------

    /** Idempotent per Adresse. */
    addFeed(fields) {
      if (!fields?.url) throw new ReadingError('Adresse fehlt');
      const existing = db.prepare('SELECT * FROM feeds WHERE url = ?').get(fields.url);
      if (existing) return { feed: feedRow(existing), duplicate: true };
      const id = randomUUID();
      db.prepare('INSERT INTO feeds (id, url, created_at) VALUES (?, ?, ?)').run(id, fields.url, iso());
      update('feeds', id, fields, FEED_EDIT.filter((k) => k !== 'url'));
      return { feed: getFeed(id), duplicate: false };
    },
    getFeed,
    listFeeds: () => db.prepare('SELECT * FROM feeds ORDER BY title COLLATE NOCASE, url').all().map(feedRow),
    updateFeed(id, patch) {
      must(getFeed(id), 'Diesen Feed');
      update('feeds', id, patch, FEED_EDIT);
      return getFeed(id);
    },
    deleteFeed: (id) => db.prepare('DELETE FROM feeds WHERE id = ?').run(String(id ?? '')).changes > 0,
    /** Merkt sich einen Feed-Eintrag; `false`, wenn er schon bekannt war. */
    rememberEntry(feedId, guid, docId = null) {
      return db.prepare('INSERT OR IGNORE INTO feed_entries (feed_id, guid, doc_id) VALUES (?, ?, ?)').run(feedId, guid, docId).changes > 0;
    },
    /** Alle bekannten Einträge eines Feeds (GUID bzw. Adresse) als Set; leer heißt: noch nie abgerufen. */
    knownEntries: (feedId) => new Set(db.prepare('SELECT guid FROM feed_entries WHERE feed_id = ?').all(String(feedId ?? '')).map((r) => r.guid)),

    // --- Sicherung ------------------------------------------------------------

    /** Konsistente Kopie der Datenbank als Buffer (`VACUUM INTO`, auch bei laufendem Dienst). */
    snapshot() {
      const dir = mkdtempSync(join(tmpdir(), 'lesestapel-'));
      try {
        const file = join(dir, 'lesestapel.db');
        db.prepare('VACUUM INTO ?').run(file);
        return readFileSync(file);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },

    /** Ersetzt die Datei durch `buf` (aus einer Sicherung) und öffnet sie neu. */
    replaceWith(buf) {
      db.close();
      try {
        writePrivate(path, buf);
        for (const ext of ['-journal', '-wal', '-shm']) rmSync(`${path}${ext}`, { force: true });
      } finally {
        open();
      }
    },

    close: () => db.close(),
  };
}
