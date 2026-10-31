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
 * (will ich lesen), `archiv` (gelesen, Notiz im Vault), `abgelegt` (ungelesen
 * mit Volltext im Vault, VCP-96), `weg` (verworfen; mit `read_at` „fertig,
 * weg“ nach dem Lesen, ohne vor dem Lesen). `previous_status` hält den Stand vor
 * dem letzten Wechsel für „Rückgängig“. `heard_at` sagt, wann der Text zuletzt
 * gehört wurde (`markHeard`), unabhängig vom Status.
 *
 * Kein WAL: Die Datei ist klein, es schreibt nur dieser Dienst, und ohne
 * `-wal`/`-shm` daneben bleibt Sichern und Zurückschreiben einfach.
 */

export const STATUSES = ['eingang', 'stapel', 'archiv', 'abgelegt', 'weg'];
export const KINDS = ['artikel', 'newsletter', 'feed', 'pdf'];
export const REVIEW_STATES = ['aktiv', 'losgelassen'];

/** Neue Fassung: Eintrag hier anhängen, `user_version` zählt mit. */
export const MIGRATIONS = [
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
  // Feed-Gruppen (VCP-97): ein Feed in höchstens einer, gelöschte Gruppe lässt ihn ohne.
  `CREATE TABLE feed_groups (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    position INTEGER NOT NULL,
    paused INTEGER NOT NULL DEFAULT 0,
    to_stack INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  ALTER TABLE feeds ADD COLUMN group_id TEXT REFERENCES feed_groups(id) ON DELETE SET NULL;`,
  // Diskussion zum Feed-Eintrag (Hacker News, Reddit), neben dem Artikel unter `url`.
  `ALTER TABLE documents ADD COLUMN comments_url TEXT;`,
  // Gehört (Folgen): wann der Text zuletzt in einer Folge vorkam, für `gehoert:` in der Notiz.
  `ALTER TABLE documents ADD COLUMN heard_at TEXT;`,
  // Ingest ins Wiki (src/lesen/ingest.js): Entwurf je Dokument, `draft` und `applied` als JSON.
  `CREATE TABLE ingests (
    doc_id TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'wartet',
    origin TEXT NOT NULL DEFAULT 'knopf',
    draft TEXT,
    error TEXT,
    applied TEXT,
    model TEXT,
    requested_at TEXT NOT NULL,
    drafted_at TEXT,
    applied_at TEXT,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX ingests_status ON ingests(status, updated_at);`,
  // Zugangsdaten privater Feeds, verschlüsselt (src/cockpit/secret-box.js); nie in `url`.
  `ALTER TABLE feeds ADD COLUMN auth TEXT;`,
  // Wiedersehen (VCP-85): wann zuletzt entschieden und der Stand davor (JSON) für ein dauerhaftes Rückgängig.
  `ALTER TABLE highlights ADD COLUMN reviewed_at TEXT;
  ALTER TABLE highlights ADD COLUMN review_prev TEXT;`,
  // Lesestapel → Vault (VCP-85): Vorgemerktes übersteht einen Absturz, Fehlversuche zählen für den Backoff.
  `CREATE TABLE export_pending (
    doc_id TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
    attempts INTEGER NOT NULL DEFAULT 0,
    next_at TEXT,
    last_error TEXT,
    updated_at TEXT NOT NULL
  );`,
  // Feed-Pflege (VCP-86): wann zuletzt ein Icon gesucht wurde; Einträge, die der Stichwort-Filter aussortiert hat.
  `ALTER TABLE feeds ADD COLUMN icon_checked_at TEXT;
  ALTER TABLE feed_entries ADD COLUMN filtered INTEGER NOT NULL DEFAULT 0;`,
  // Vorsortieren (VCP-136): Urteil des Entscheidungsmodells je Feed-Eintrag mit voller
  // Verteilung und Version; `decision` ist, was Ruben im Eingang tatsächlich gewählt hat.
  `CREATE TABLE triage (
    doc_id TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
    model TEXT,
    choice TEXT,
    probabilities TEXT,
    confidence REAL,
    near REAL,
    near_max INTEGER,
    near_probabilities TEXT,
    rank REAL,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    judged_at TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    decision TEXT,
    decided_at TEXT
  );`,
];

/** Zustände eines Ingest-Entwurfs (src/lesen/ingest.js). */
export const INGEST_STATUSES = ['wartet', 'entwirft', 'bereit', 'fehler', 'uebernommen', 'verworfen'];
const INGEST_EDIT = ['status', 'origin', 'draft', 'error', 'applied', 'model', 'requested_at', 'drafted_at', 'applied_at'];

export class ReadingError extends Error {}

const DOC_FIELDS = ['url', 'canonical_url', 'comments_url', 'title', 'author', 'site', 'kind', 'origin', 'client_id', 'excerpt', 'content_html', 'content_text', 'word_count', 'reading_minutes', 'status', 'topics'];
const HIGHLIGHT_EDIT = ['quote', 'prefix', 'suffix', 'start_hint', 'note', 'color', 'review_box', 'review_due', 'review_state', 'reviewed_at', 'review_prev'];
const FEED_EDIT = ['url', 'site_url', 'title', 'icon', 'paused', 'to_stack', 'keyword_filter', 'interval_minutes', 'etag', 'last_modified', 'last_fetch_at', 'last_error', 'error_count', 'next_fetch_at', 'group_id', 'icon_checked_at'];
const GROUP_EDIT = ['name', 'paused', 'to_stack'];
/** Filter `group` für `list`/`counts`: Gruppen-ID oder `ohne` (nicht aus einem Feed: Gespeichertes, Mail). */
export const NO_FEED = 'ohne';

const fromRow = (row) => (row ? { ...row, topics: JSON.parse(row.topics ?? '[]') } : null);
// Die verschlüsselten Zugangsdaten verlassen den Store nie, nur `has_auth` sagt, ob es welche gibt.
const withoutAuth = ({ auth, ...row }) => row;
/**
 * Feed mit den Einstellungen seiner Gruppe (`group_paused`, `group_to_stack`).
 * Es gilt Feed ODER Gruppe: `false` am Feed heißt „nichts Eigenes gesetzt“.
 */
const feedRow = (row) => (row ? { ...withoutAuth(row), has_auth: Boolean(row.auth), paused: Boolean(row.paused), to_stack: Boolean(row.to_stack), group_paused: Boolean(row.group_paused), group_to_stack: Boolean(row.group_to_stack) } : null);
const parseJson = (v) => (v == null ? null : JSON.parse(v));
const ingestRow = (row) => (row ? { ...row, draft: parseJson(row.draft), applied: parseJson(row.applied) } : null);
const triageRow = (row) => (row ? { ...row, probabilities: parseJson(row.probabilities), near_probabilities: parseJson(row.near_probabilities) } : null);
const groupRow = (row) => (row ? { ...row, paused: Boolean(row.paused), to_stack: Boolean(row.to_stack) } : null);
const FEED_SELECT = 'SELECT f.*, g.paused AS group_paused, g.to_stack AS group_to_stack FROM feeds f LEFT JOIN feed_groups g ON g.id = f.group_id';
/** WHERE-Teil für den Gruppenfilter über `origin` (Dokumente kennen nur ihren Feed). */
const groupWhere = (group) =>
  group == null ? ['1', []] : group === NO_FEED ? ["origin NOT LIKE 'feed:%'", []] : ["origin IN (SELECT 'feed:' || id FROM feeds WHERE group_id = ?)", [String(group)]];
const titleKey = (t) => String(t ?? '').toLocaleLowerCase('de').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
/** Gleicher Artikel nach dem Titel? Fehlt einer, zählt die Adresse allein; „Titel“ passt auch zu „Titel – Seite“. */
const sameTitle = (a, b) => {
  const [x, y] = [titleKey(a), titleKey(b)];
  return !x || !y || x === y || x.startsWith(`${y} `) || y.startsWith(`${x} `);
};
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
 * `now` liefert die Zeit für die Zeitstempel (ISO-Text). `secrets`
 * (`createSecretBox`) verschlüsselt Zugangsdaten von Feeds; ohne lassen sich
 * keine speichern.
 */
export function createReadingStore({ path, now = () => Date.now(), secrets = null }) {
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

  const inTransaction = (run) => {
    db.exec('BEGIN');
    try {
      const r = run();
      db.exec('COMMIT');
      return r;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  };

  const get = (id) => fromRow(db.prepare('SELECT * FROM documents WHERE id = ?').get(String(id ?? '')));
  const getHighlight = (id) => db.prepare('SELECT * FROM highlights WHERE id = ?').get(String(id ?? '')) ?? null;
  const getFeed = (id) => feedRow(db.prepare(`${FEED_SELECT} WHERE f.id = ?`).get(String(id ?? '')));
  /** Zugangsdaten setzen (`{ user, password }`) oder mit `null` löschen; verschlüsselt, an den Feed gebunden. */
  const setFeedAuth = (id, auth) => {
    let sealed = null;
    if (auth) {
      if (!secrets) throw new ReadingError('Zugangsdaten lassen sich hier nicht speichern');
      sealed = secrets.seal({ user: String(auth.user ?? ''), password: String(auth.password ?? '') }, `feed:${id}`);
    }
    db.prepare('UPDATE feeds SET auth = ? WHERE id = ?').run(sealed, String(id));
  };
  const getGroup = (id) => groupRow(db.prepare('SELECT * FROM feed_groups WHERE id = ?').get(String(id ?? '')));
  const listGroups = () => db.prepare('SELECT * FROM feed_groups ORDER BY position, name').all().map(groupRow);
  const groupName = (name) => {
    const n = String(name ?? '').replace(/\s+/g, ' ').trim();
    if (!n) throw new ReadingError('Name der Gruppe fehlt');
    return n;
  };
  // NOCASE in SQLite kennt nur ASCII; „Ökologie“ und „ökologie“ sollen dieselbe Gruppe sein.
  const groupByName = (name, exceptId = null) => listGroups().find((g) => g.id !== exceptId && g.name.toLocaleLowerCase('de') === name.toLocaleLowerCase('de')) ?? null;
  /** `group_id` im Patch: leer heißt ohne Gruppe, eine unbekannte ist ein Fehler (statt Fremdschlüssel-Fehler). */
  const withGroup = (patch) => {
    if (!patch || !('group_id' in patch)) return patch;
    const groupId = patch.group_id || null;
    if (groupId && !getGroup(groupId)) throw new ReadingError('Diese Gruppe gibt es nicht');
    return { ...patch, group_id: groupId };
  };
  /**
   * Was eine Änderung am Feed nebenbei mitbringt: Ein geänderter
   * Stichwort-Filter vergisst die aussortierten Einträge, damit der nächste
   * Abruf sie neu prüft (soweit sie noch im Feed stehen). Wieder eingeschaltet
   * ist ein Feed gleich dran, alte Fehler zählen nicht mehr (sonst pausierte
   * ein automatisch pausierter Feed beim nächsten Fehler sofort wieder).
   */
  const feedPatch = (feed, patch) => {
    if (!patch) return patch;
    if ('keyword_filter' in patch && (patch.keyword_filter || null) !== (feed.keyword_filter || null)) {
      db.prepare('DELETE FROM feed_entries WHERE feed_id = ? AND filtered = 1').run(feed.id);
      // Ohne ETag und Last-Modified kommt der Feed beim nächsten Abruf ganz, auch wenn er sich nicht geändert hat.
      patch = { etag: null, last_modified: null, ...patch };
    }
    if (patch.paused === false && feed.paused) return { last_error: null, error_count: 0, next_fetch_at: null, ...patch };
    return patch;
  };
  const must = (row, what) => {
    if (!row) throw new ReadingError(`${what} gibt es nicht`);
    return row;
  };

  /**
   * Schon gespeichert? Erst per `client_id`, dann per Adresse (auch als
   * kanonische eines vorhandenen). Über die eigene kanonische Adresse nur, wenn
   * die Titel zusammenpassen: Manche Websites geben vielen Artikeln dieselbe
   * Canonical (die Startseite, eine Rubrik), die dürfen nicht verschmelzen.
   */
  const findExisting = ({ client_id: clientId, url, canonical_url: canonical, title = null }) => {
    if (clientId) {
      const row = db.prepare('SELECT * FROM documents WHERE client_id = ?').get(clientId);
      if (row) return fromRow(row);
    }
    if (url) {
      const row = db.prepare('SELECT * FROM documents WHERE url = ? OR canonical_url = ? ORDER BY url = ? DESC LIMIT 1').get(url, url, url);
      if (row) return fromRow(row);
    }
    if (!canonical || canonical === url) return null;
    const rows = db.prepare('SELECT * FROM documents WHERE url = ? OR canonical_url = ? ORDER BY url = ? DESC').all(canonical, canonical, canonical);
    return fromRow(rows.find((r) => sameTitle(r.title, title)) ?? null);
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

    /**
     * Neueste zuerst; ohne `status` alle außer `weg`. Ohne Inhalt (`content_*`), der kommt mit `get`.
     * `group`: nur aus Feeds dieser Gruppe, `NO_FEED` nur nicht aus Feeds.
     */
    list({ status = null, group = null, limit = 100, offset = 0, triage = false } = {}) {
      const cols = 'id, url, canonical_url, comments_url, title, author, site, kind, origin, excerpt, word_count, reading_minutes, status, previous_status, progress, scroll_anchor, topics, saved_at, status_changed_at, read_at, archived_at, heard_at, updated_at';
      const [where, args] = groupWhere(group);
      // Vorsortiert (VCP-136): Ohne Urteil zuerst (selbst Gespeichertes, noch nicht beurteilt), dann nach Rang.
      const order = triage
        ? "(SELECT t.rank FROM triage t WHERE t.doc_id = documents.id AND t.judged_at IS NOT NULL) IS NOT NULL, (SELECT t.rank FROM triage t WHERE t.doc_id = documents.id) DESC, saved_at DESC, rowid DESC"
        : 'saved_at DESC, rowid DESC';
      const rows = status
        ? db.prepare(`SELECT ${cols} FROM documents WHERE status = ? AND ${where} ORDER BY ${order} LIMIT ? OFFSET ?`).all(status, ...args, limit, offset)
        : db.prepare(`SELECT ${cols} FROM documents WHERE status != 'weg' AND ${where} ORDER BY saved_at DESC, rowid DESC LIMIT ? OFFSET ?`).all(...args, limit, offset);
      return rows.map(fromRow);
    },

    /** Anzahl je Status, z. B. für Zähler in der Navigation; `group` wie bei `list`. */
    counts({ group = null } = {}) {
      const out = Object.fromEntries(STATUSES.map((s) => [s, 0]));
      const [where, args] = groupWhere(group);
      for (const r of db.prepare(`SELECT status, COUNT(*) AS n FROM documents WHERE ${where} GROUP BY status`).all(...args)) out[r.status] = r.n;
      return out;
    },

    /**
     * Neuer Status; `previous` ist der alte (für „Rückgängig“ einfach
     * `setStatus(id, previous)`). `archiv` setzt `archived_at`; `read` (Standard
     * bei `archiv`) setzt `read_at`, wenn es noch fehlt, auch ohne Statuswechsel.
     */
    setStatus(id, status, { read = status === 'archiv' } = {}) {
      if (!STATUSES.includes(status)) throw new ReadingError(`Unbekannter Status ${status}`);
      const doc = must(get(id), 'Dieses Dokument');
      const t = iso();
      if (read && !doc.read_at) db.prepare('UPDATE documents SET read_at = ?, updated_at = ? WHERE id = ?').run(t, t, doc.id);
      if (doc.status === status) return { doc: get(doc.id), previous: doc.status, changed: false };
      db.prepare(
        `UPDATE documents SET previous_status = status, status = ?, status_changed_at = ?, updated_at = ?,
           archived_at = CASE WHEN ? = 'archiv' THEN ? ELSE archived_at END
         WHERE id = ?`,
      ).run(status, t, t, status, t, doc.id);
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
    leftInboxSince(since, { group = null } = {}) {
      const [inGroup, args] = groupWhere(group);
      const where = `previous_status = 'eingang' AND status != 'eingang' AND status_changed_at >= ? AND ${inGroup}`;
      const { n } = db.prepare(`SELECT COUNT(*) AS n FROM documents WHERE ${where}`).get(since, ...args);
      // Zurücklegen geht nur von Stapel, Weg und Abgelegt aus (src/lesen/inbox.js).
      const last = db.prepare(`SELECT id, title, url FROM documents WHERE ${where} AND status IN ('stapel', 'weg', 'abgelegt') ORDER BY status_changed_at DESC, rowid DESC LIMIT 1`).get(since, ...args);
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
    /**
     * Feed-Einträge mit Kurztext (unter `maxWords` Wörtern) ohne Kommentar-Link
     * im Eingang oder auf dem Stapel, ohne Markierungen: Kandidaten für das
     * nachträgliche Auflösen (`resolveOld` in feeds.js).
     */
    listFeedStubs(maxWords) {
      return db
        .prepare(`SELECT * FROM documents WHERE origin LIKE 'feed:%' AND status IN ('eingang', 'stapel') AND comments_url IS NULL AND word_count < ?
          AND NOT EXISTS (SELECT 1 FROM highlights h WHERE h.doc_id = documents.id) ORDER BY saved_at`)
        .all(maxWords)
        .map(fromRow);
    },

    updateDocument(id, patch) {
      must(get(id), 'Dieses Dokument');
      const p = { ...patch, updated_at: iso() };
      if (p.topics) p.topics = JSON.stringify(p.topics);
      update('documents', id, p, ['url', 'canonical_url', 'comments_url', 'title', 'author', 'site', 'kind', 'excerpt', 'content_html', 'content_text', 'word_count', 'reading_minutes', 'topics', 'updated_at']);
      return get(id);
    },

    /**
     * Gehört (Folgen): setzt `heard_at` auf `at` (Standard jetzt); ein älterer
     * Wert weicht dem neueren, ein neuerer bleibt. Unbekannte IDs fallen weg;
     * liefert die Dokumente.
     */
    markHeard(ids, at = null) {
      const when = new Date(at ?? now());
      if (Number.isNaN(when.getTime())) throw new ReadingError('Ungültiger Zeitpunkt für „gehört“');
      const t = when.toISOString();
      const known = [...new Set(ids.map(String))].filter((id) => get(id));
      const set = db.prepare('UPDATE documents SET heard_at = ?, updated_at = ? WHERE id = ? AND (heard_at IS NULL OR heard_at < ?)');
      inTransaction(() => known.forEach((id) => set.run(t, iso(), id, t)));
      return known.map(get);
    },

    deleteDocument: (id) => db.prepare('DELETE FROM documents WHERE id = ?').run(String(id ?? '')).changes > 0,

    /**
     * Aufräumen (VCP-86): löscht Verworfenes, das seit vor `before` (ISO) auf
     * `weg` steht und nie (zu Ende) gelesen oder gehört wurde und keine Markierung hat.
     * „Fertig, weg“ nach dem Lesen (`read_at`) bleibt samt Markierungen.
     * Feed-Einträge bleiben bekannt (`feed_entries.doc_id` wird leer), kommen
     * also nicht wieder. Liefert die Zahl gelöschter Dokumente.
     */
    purgeDiscarded(before) {
      return db
        .prepare(`DELETE FROM documents WHERE status = 'weg' AND status_changed_at < ? AND read_at IS NULL AND heard_at IS NULL AND progress < 1
          AND NOT EXISTS (SELECT 1 FROM highlights h WHERE h.doc_id = documents.id)
          AND NOT EXISTS (SELECT 1 FROM ingests i WHERE i.doc_id = documents.id AND i.status NOT IN ('uebernommen', 'verworfen'))`)
        .run(String(before)).changes;
    },

    // --- Markierungen ---------------------------------------------------------

    /**
     * `{ doc_id, quote, prefix, suffix, start_hint, note, color }`; Anker = Zitat mit Umgebung.
     * `id` optional: die ID vom Gerät (Offline-Puffer), sonst eine neue.
     */
    addHighlight(fields) {
      must(get(fields?.doc_id), 'Dieses Dokument');
      if (!fields.quote) throw new ReadingError('Zitat fehlt');
      const t = iso();
      const id = fields.id ?? randomUUID();
      // Wiedersehen (src/lesen/review.js): erstmals einen Tag später fällig.
      const due = new Date(Date.parse(t) + 24 * 60 * 60 * 1000).toISOString();
      db.prepare('INSERT INTO highlights (id, doc_id, quote, prefix, suffix, start_hint, note, color, created_at, updated_at, review_due) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(
        id, fields.doc_id, fields.quote, fields.prefix ?? '', fields.suffix ?? '', fields.start_hint ?? null, fields.note ?? null, fields.color ?? 'gelb', t, t, due,
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

    // --- Export in den Vault (src/lesen/vault-export.js) -------------------------

    /** Dokument vormerken; eine neue Änderung setzt die Fehlversuche zurück. */
    markExportPending(docId) {
      if (!get(docId)) return;
      db.prepare('INSERT INTO export_pending (doc_id, attempts, next_at, last_error, updated_at) VALUES (?, 0, NULL, NULL, ?) ON CONFLICT(doc_id) DO UPDATE SET attempts = 0, next_at = NULL, last_error = NULL, updated_at = excluded.updated_at').run(String(docId), iso());
    },
    /** Vorgemerkte Dokumente in der Reihenfolge des Vormerkens: `{ doc_id, attempts, next_at, last_error, updated_at }`. */
    listExportPending: () => db.prepare('SELECT * FROM export_pending ORDER BY rowid').all(),
    /** Fehlversuch festhalten: `next_at` ist der nächste Versuch (ISO). */
    exportFailed(docId, { error, nextAt }) {
      db.prepare('UPDATE export_pending SET attempts = attempts + 1, next_at = ?, last_error = ?, updated_at = ? WHERE doc_id = ?').run(nextAt, String(error ?? ''), iso(), String(docId));
    },
    exportDone: (docId) => db.prepare('DELETE FROM export_pending WHERE doc_id = ?').run(String(docId)).changes > 0,

    // --- Feeds ----------------------------------------------------------------

    /**
     * Idempotent per Adresse. `auth` (`{ user, password }`) speichert
     * Zugangsdaten, bei einem schon abonnierten Feed ersetzen sie dessen.
     */
    addFeed(fields) {
      if (!fields?.url) throw new ReadingError('Adresse fehlt');
      const existing = db.prepare('SELECT * FROM feeds WHERE url = ?').get(fields.url);
      if (existing) {
        if (fields.auth) setFeedAuth(existing.id, fields.auth);
        return { feed: getFeed(existing.id), duplicate: true };
      }
      const checked = withGroup(fields);
      const id = randomUUID();
      inTransaction(() => {
        db.prepare('INSERT INTO feeds (id, url, created_at) VALUES (?, ?, ?)').run(id, fields.url, iso());
        update('feeds', id, checked, FEED_EDIT.filter((k) => k !== 'url'));
        if (fields.auth) setFeedAuth(id, fields.auth);
      });
      return { feed: getFeed(id), duplicate: false };
    },
    getFeed,
    setFeedAuth,
    /**
     * Zugangsdaten eines Feeds im Klartext (`{ user, password }`), nur für
     * den Abruf; `null` ohne. Lassen sie sich nicht öffnen (Datenbank ohne
     * ihren Schlüssel zurückgespielt): `ReadingError`.
     */
    feedAuth(id) {
      const row = db.prepare('SELECT auth FROM feeds WHERE id = ?').get(String(id ?? ''));
      if (!row?.auth) return null;
      const auth = secrets?.open(row.auth, `feed:${id}`);
      if (!auth) throw new ReadingError('Die gespeicherten Zugangsdaten lassen sich nicht entschlüsseln, bitte in den Einstellungen des Feeds neu eingeben');
      return auth;
    },
    /** Alle Feeds, nach Titel; mit `group` nur die dieser Gruppe, `NO_FEED` heißt hier: ohne Gruppe. */
    listFeeds({ group } = {}) {
      const where = group === undefined ? '' : group === NO_FEED || group === null ? 'WHERE f.group_id IS NULL' : 'WHERE f.group_id = ?';
      const args = where.includes('?') ? [String(group)] : [];
      return db.prepare(`${FEED_SELECT} ${where} ORDER BY f.title COLLATE NOCASE, f.url`).all(...args).map(feedRow);
    },
    updateFeed(id, patch) {
      const feed = must(getFeed(id), 'Diesen Feed');
      inTransaction(() => update('feeds', id, feedPatch(feed, withGroup(patch)), FEED_EDIT));
      return getFeed(id);
    },
    deleteFeed: (id) => db.prepare('DELETE FROM feeds WHERE id = ?').run(String(id ?? '')).changes > 0,
    /**
     * Dieselbe Änderung für viele Feeds in einem Schritt (VCP-110), alles oder nichts.
     * Unbekannte IDs fallen weg; liefert die geänderten Feeds.
     */
    updateFeeds(ids, patch) {
      const checked = withGroup(patch);
      const known = [...new Set(ids.map(String))].filter((id) => getFeed(id));
      inTransaction(() => known.forEach((id) => update('feeds', id, feedPatch(getFeed(id), checked), FEED_EDIT)));
      return known.map(getFeed);
    },
    /** Entfernt viele Feeds auf einmal; liefert die Zahl der entfernten. */
    deleteFeeds(ids) {
      const del = db.prepare('DELETE FROM feeds WHERE id = ?');
      return inTransaction(() => [...new Set(ids.map(String))].reduce((n, id) => n + del.run(id).changes, 0));
    },
    // --- Feed-Gruppen (VCP-97) --------------------------------------------------

    /** Neue Gruppe ans Ende; idempotent per Name (ohne Groß/klein), `duplicate` sagt, ob es sie schon gab. */
    addGroup(fields) {
      const name = groupName(fields?.name);
      const existing = groupByName(name);
      if (existing) return { group: existing, duplicate: true };
      const id = randomUUID();
      const { p } = db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM feed_groups').get();
      db.prepare('INSERT INTO feed_groups (id, name, position, created_at) VALUES (?, ?, ?, ?)').run(id, name, p, iso());
      update('feed_groups', id, fields, GROUP_EDIT.filter((k) => k !== 'name'));
      return { group: getGroup(id), duplicate: false };
    },
    getGroup,
    /** In ihrer Reihenfolge (`position`). */
    listGroups,
    /** Name, `paused`, `to_stack`; ein Name, den schon eine andere Gruppe trägt, gibt `ReadingError`. */
    updateGroup(id, patch) {
      must(getGroup(id), 'Diese Gruppe');
      const p = { ...patch };
      if ('name' in p) {
        p.name = groupName(p.name);
        if (groupByName(p.name, String(id))) throw new ReadingError(`Eine Gruppe „${p.name}“ gibt es schon`);
      }
      update('feed_groups', id, p, GROUP_EDIT);
      return getGroup(id);
    },
    /** Feeds der Gruppe bleiben, dann ohne Gruppe. */
    deleteGroup: (id) => db.prepare('DELETE FROM feed_groups WHERE id = ?').run(String(id ?? '')).changes > 0,
    /** Eine Stelle nach oben (`-1`) oder unten (`1`): tauscht mit der Nachbarin; am Rand ändert sich nichts. */
    moveGroup(id, delta) {
      const groups = listGroups();
      const i = groups.findIndex((g) => g.id === String(id ?? ''));
      if (i < 0) throw new ReadingError('Diese Gruppe gibt es nicht');
      const j = i + Math.sign(Number(delta) || 0);
      if (j === i || j < 0 || j >= groups.length) return groups;
      [groups[i], groups[j]] = [groups[j], groups[i]];
      // Neu durchnummerieren, damit gleiche Positionen (etwa nach Wiederherstellen) nicht stören.
      db.exec('BEGIN');
      try {
        groups.forEach((g, k) => db.prepare('UPDATE feed_groups SET position = ? WHERE id = ?').run(k, g.id));
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
      return listGroups();
    },
    /** Neue Einträge im Eingang je Gruppe: `{ [groupId]: n }`, Gruppen ohne Einträge fehlen. */
    inboxByGroup() {
      const rows = db
        .prepare("SELECT f.group_id AS g, COUNT(*) AS n FROM documents d JOIN feeds f ON d.origin = 'feed:' || f.id WHERE d.status = 'eingang' AND f.group_id IS NOT NULL GROUP BY f.group_id")
        .all();
      return Object.fromEntries(rows.map((r) => [r.g, r.n]));
    },

    /**
     * Merkt sich einen Feed-Eintrag; `false`, wenn er schon bekannt war.
     * `filtered`: vom Stichwort-Filter aussortiert, ein geänderter Filter prüft ihn neu.
     */
    rememberEntry(feedId, guid, docId = null, { filtered = false } = {}) {
      return db.prepare('INSERT OR IGNORE INTO feed_entries (feed_id, guid, doc_id, filtered) VALUES (?, ?, ?, ?)').run(feedId, guid, docId, filtered ? 1 : 0).changes > 0;
    },
    /** Alle bekannten Einträge eines Feeds (GUID bzw. Adresse) als Set; leer heißt: noch nie abgerufen. */
    knownEntries: (feedId) => new Set(db.prepare('SELECT guid FROM feed_entries WHERE feed_id = ?').all(String(feedId ?? '')).map((r) => r.guid)),

    // --- Ingest ins Wiki ---------------------------------------------------------

    /** Entwurf zum Dokument oder null; `draft` und `applied` als Objekte. */
    getIngest: (docId) => ingestRow(db.prepare('SELECT * FROM ingests WHERE doc_id = ?').get(String(docId ?? ''))),
    /**
     * Legt den Eintrag an oder ändert ihn: nur die erlaubten Felder aus `patch`,
     * `draft`/`applied` als Objekt (oder null). Liefert den neuen Stand.
     */
    saveIngest(docId, patch) {
      const id = String(docId ?? '');
      must(get(id), 'Dieses Dokument');
      if (patch.status && !INGEST_STATUSES.includes(patch.status)) throw new ReadingError(`Unbekannter Ingest-Status ${patch.status}`);
      const t = iso();
      const p = { ...patch };
      for (const k of ['draft', 'applied']) if (k in p && p[k] !== null && typeof p[k] !== 'string') p[k] = JSON.stringify(p[k]);
      if (!db.prepare('SELECT 1 FROM ingests WHERE doc_id = ?').get(id)) {
        db.prepare('INSERT INTO ingests (doc_id, requested_at, updated_at) VALUES (?, ?, ?)').run(id, p.requested_at ?? t, t);
      }
      const keys = Object.keys(p).filter((k) => INGEST_EDIT.includes(k));
      db.prepare(`UPDATE ingests SET ${[...keys.map((k) => `${k} = ?`), 'updated_at = ?'].join(', ')} WHERE doc_id = ?`).run(...keys.map((k) => bindable(p[k])), t, id);
      return ingestRow(db.prepare('SELECT * FROM ingests WHERE doc_id = ?').get(id));
    },
    /** Neueste zuerst, mit `status` nur diese; samt Titel, Adresse, Quelle, Lesezeit und Status des Dokuments (`doc_*`). */
    listIngests({ status = null, limit = 500 } = {}) {
      const statuses = status == null ? null : [status].flat().map(String);
      const where = statuses ? `WHERE i.status IN (${statuses.map(() => '?').join(', ')})` : '';
      return db
        .prepare(
          `SELECT i.*, d.title AS doc_title, d.url AS doc_url, d.site AS doc_site, d.reading_minutes AS doc_reading_minutes, d.status AS doc_status
             FROM ingests i JOIN documents d ON d.id = i.doc_id ${where} ORDER BY i.updated_at DESC, i.rowid DESC LIMIT ?`,
        )
        .all(...(statuses ?? []), limit)
        .map(ingestRow);
    },
    /** Anzahl je Ingest-Status. */
    ingestCounts() {
      const out = Object.fromEntries(INGEST_STATUSES.map((s) => [s, 0]));
      for (const r of db.prepare('SELECT status, COUNT(*) AS n FROM ingests GROUP BY status').all()) out[r.status] = r.n;
      return out;
    },
    /** Status je Dokument als Map, eine Abfrage (für die Abzeichen im Stapel). */
    ingestStatuses(docIds) {
      const ids = [...new Set([...(docIds ?? [])].map(String))];
      if (!ids.length) return new Map();
      const rows = db.prepare('SELECT doc_id, status FROM ingests WHERE doc_id IN (SELECT value FROM json_each(?))').all(JSON.stringify(ids));
      return new Map(rows.map((r) => [r.doc_id, r.status]));
    },

    // --- Vorsortieren (VCP-136) ----------------------------------------------

    /** Urteil zum Dokument oder null; Verteilungen als Objekte. */
    getTriage: (docId) => triageRow(db.prepare('SELECT * FROM triage WHERE doc_id = ?').get(String(docId ?? ''))),
    /** Feed-Einträge im Eingang ohne Urteil, älteste zuerst; nach `maxAttempts` Fehlern nicht mehr. */
    pendingTriage({ limit = 20, maxAttempts = 3 } = {}) {
      return db
        // Feeds mit Zugangsdaten sind privat: ihre Einträge gehen nie an Jev.
        .prepare(`SELECT d.* FROM documents d LEFT JOIN triage t ON t.doc_id = d.id
          JOIN feeds f ON f.id = substr(d.origin, 6) AND f.auth IS NULL
          WHERE d.status = 'eingang' AND d.origin LIKE 'feed:%' AND (t.doc_id IS NULL OR (t.judged_at IS NULL AND t.attempts < ?))
          ORDER BY d.saved_at, d.rowid LIMIT ?`)
        .all(maxAttempts, limit)
        .map(fromRow);
    },
    /** Urteil speichern (überschreibt ein früheres, die Entscheidung bleibt). */
    saveTriage(docId, row) {
      const id = String(docId ?? '');
      must(get(id), 'Dieses Dokument');
      const json = (v) => (v == null ? null : JSON.stringify(v));
      db.prepare(`INSERT INTO triage (doc_id, model, choice, probabilities, confidence, near, near_max, near_probabilities, rank, input_tokens, judged_at, error)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,NULL)
        ON CONFLICT(doc_id) DO UPDATE SET model = excluded.model, choice = excluded.choice, probabilities = excluded.probabilities, confidence = excluded.confidence,
          near = excluded.near, near_max = excluded.near_max, near_probabilities = excluded.near_probabilities, rank = excluded.rank,
          input_tokens = triage.input_tokens + excluded.input_tokens, judged_at = excluded.judged_at, error = NULL`).run(
        id, row.model ?? null, row.choice ?? null, json(row.probabilities), row.confidence ?? null, row.near ?? null, row.near_max ?? null, json(row.near_probabilities), row.rank ?? null, row.input_tokens ?? 0, row.judged_at ?? iso(),
      );
      return triageRow(db.prepare('SELECT * FROM triage WHERE doc_id = ?').get(id));
    },
    /** Gescheiterter Versuch: zählt mit, damit ein kaputter Eintrag nicht ewig angefragt wird. */
    saveTriageError(docId, error) {
      const id = String(docId ?? '');
      if (!get(id)) return;
      db.prepare(`INSERT INTO triage (doc_id, attempts, error) VALUES (?, 1, ?)
        ON CONFLICT(doc_id) DO UPDATE SET attempts = triage.attempts + 1, error = excluded.error`).run(id, String(error).slice(0, 500));
    },
    /** Rubens Entscheidung im Eingang als Label (`lesen`, `stapel`, `weg`); `null` (Rückgängig) nimmt sie zurück. */
    setTriageDecision(docId, decision) {
      db.prepare('UPDATE triage SET decision = ?, decided_at = ? WHERE doc_id = ? AND judged_at IS NOT NULL').run(decision ?? null, decision ? iso() : null, String(docId ?? ''));
    },
    /** Urteile je Dokument als Map, eine Abfrage. */
    triageFor(docIds) {
      const ids = [...new Set([...(docIds ?? [])].map(String))];
      if (!ids.length) return new Map();
      const rows = db.prepare('SELECT * FROM triage WHERE judged_at IS NOT NULL AND doc_id IN (SELECT value FROM json_each(?))').all(JSON.stringify(ids));
      return new Map(rows.map((r) => [r.doc_id, triageRow(r)]));
    },
    /** Folgequote: Wie oft passt die Entscheidung zum Vorschlag? „unklar“ zählt nicht mit. */
    triageStats() {
      const r = db.prepare(`SELECT
          COUNT(*) FILTER (WHERE judged_at IS NOT NULL) AS judged,
          COUNT(*) FILTER (WHERE decision IS NOT NULL AND choice != 'unklar') AS decided,
          COUNT(*) FILTER (WHERE decision IS NOT NULL AND choice != 'unklar' AND decision = choice) AS followed,
          COUNT(*) FILTER (WHERE choice = 'unklar') AS unclear,
          COALESCE(SUM(input_tokens), 0) AS input_tokens
        FROM triage`).get();
      return { judged: r.judged, decided: r.decided, followed: r.followed, unclear: r.unclear, input_tokens: r.input_tokens };
    },
    /** Titel der zuletzt behaltenen Texte (Stapel, gelesen, abgelegt), als Kontext fürs Vorsortieren. */
    recentKeptTitles(limit = 12) {
      return db
        // Ohne Einträge aus Feeds mit Zugangsdaten: auch ihre Titel bleiben privat. Ist der
        // Feed gelöscht, weiß man das nicht mehr, also bleiben auch diese Titel draußen.
        .prepare(`SELECT d.title FROM documents d LEFT JOIN feeds f ON d.origin LIKE 'feed:%' AND f.id = substr(d.origin, 6)
          WHERE d.status IN ('stapel', 'archiv', 'abgelegt') AND d.title IS NOT NULL
            AND (d.origin IS NULL OR d.origin NOT LIKE 'feed:%' OR (f.id IS NOT NULL AND f.auth IS NULL))
          ORDER BY d.status_changed_at DESC, d.rowid DESC LIMIT ?`)
        .all(limit)
        .map((r) => r.title);
    },

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
