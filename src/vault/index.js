import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { parseNote } from './markdown.js';
import { DEFAULT_POLICY } from './policy.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS notes (
  path TEXT PRIMARY KEY,
  title TEXT,
  class TEXT NOT NULL,
  sensitivity TEXT,
  type TEXT,
  status TEXT,
  created TEXT,
  updated TEXT,
  folder TEXT,
  basename TEXT,
  frontmatter TEXT NOT NULL,
  size INTEGER NOT NULL,
  mtime INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS notes_class ON notes(class);
CREATE INDEX IF NOT EXISTS notes_folder ON notes(folder);
CREATE INDEX IF NOT EXISTS notes_basename ON notes(basename);

CREATE TABLE IF NOT EXISTS note_tags (path TEXT NOT NULL, tag TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS note_tags_tag ON note_tags(tag);
CREATE INDEX IF NOT EXISTS note_tags_path ON note_tags(path);

CREATE TABLE IF NOT EXISTS links (
  source TEXT NOT NULL,
  target_raw TEXT NOT NULL,
  target_path TEXT,
  alias TEXT
);
CREATE INDEX IF NOT EXISTS links_source ON links(source);
CREATE INDEX IF NOT EXISTS links_target ON links(target_path);

CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
  path UNINDEXED,
  title,
  body,
  tokenize = 'unicode61 remove_diacritics 2'
);
`;

const toPosix = (p) => p.split(sep).join('/');

function* walk(dir, root) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full, root);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      yield toPosix(relative(root, full));
    }
  }
}

function prepareStatements(db) {
  return {
    insertNote: db.prepare(
      `INSERT INTO notes (path, title, class, sensitivity, type, status, created, updated,
         folder, basename, frontmatter, size, mtime)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ),
    insertTag: db.prepare('INSERT INTO note_tags (path, tag) VALUES (?, ?)'),
    insertLink: db.prepare('INSERT INTO links (source, target_raw, target_path, alias) VALUES (?,?,?,?)'),
    insertFts: db.prepare('INSERT INTO notes_fts (path, title, body) VALUES (?,?,?)'),
  };
}

/** Eine Notiz von der Platte lesen und in alle Tabellen eintragen. */
function insertNoteFile(stmts, { vaultPath, policy }, relPath, raw) {
  const note = parseNote(raw);
  const st = statSync(join(vaultPath, relPath));
  const folder = relPath.includes('/') ? relPath.slice(0, relPath.lastIndexOf('/')) : '';
  const basename = relPath.slice(relPath.lastIndexOf('/') + 1).replace(/\.md$/i, '');
  const noteClass = policy.classify(relPath);

  stmts.insertNote.run(
    relPath,
    note.title,
    noteClass,
    policy.sensitivityOf(relPath),
    typeof note.frontmatter.type === 'string' ? note.frontmatter.type : null,
    typeof note.frontmatter.status === 'string' ? note.frontmatter.status : null,
    note.dates.created,
    note.dates.updated,
    folder,
    basename,
    JSON.stringify(note.frontmatter),
    st.size,
    Math.floor(st.mtimeMs),
  );

  for (const tag of new Set([...note.tags, ...note.inlineTags])) stmts.insertTag.run(relPath, tag);
  // Readwise nutzt [[…]] als Metadaten-Syntax ([[technologie]], [[favorite]], [[1]]),
  // nicht als Verweis. Diese Links würden den Graphen mit Phantom-Knoten fluten.
  if (noteClass !== 'readwise') {
    for (const link of note.links) stmts.insertLink.run(relPath, link.target, null, link.alias);
  }

  stmts.insertFts.run(relPath, note.title ?? basename, note.body);
}

export function buildIndex({ vaultPath, dbPath, persist, policy = DEFAULT_POLICY, logger = console, onProgress }) {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(SCHEMA);
  db.exec('DELETE FROM notes; DELETE FROM note_tags; DELETE FROM links; DELETE FROM notes_fts;');

  const stmts = prepareStatements(db);

  let count = 0;
  db.exec('BEGIN');
  for (const relPath of walk(vaultPath, vaultPath)) {
    if (policy.isExcluded(relPath)) continue;

    let raw;
    try {
      raw = readFileSync(join(vaultPath, relPath), 'utf8');
    } catch (err) {
      logger.warn?.(`übersprungen (nicht lesbar): ${relPath} — ${err.message}`);
      continue;
    }

    insertNoteFile(stmts, { vaultPath, policy }, relPath, raw);
    count += 1;
    if (onProgress && count % 500 === 0) onProgress(count);
  }
  db.exec('COMMIT');

  resolveLinks(db);
  db.exec('ANALYZE');

  logger.info?.(`Index aufgebaut: ${count} Notizen`);
  if (persist) persist(db, vaultPath);
  return { db, count };
}

/**
 * Löst Wikilink-Ziele auf Pfade auf: erst exakter Pfad, dann eindeutiger Basename.
 * Mehrdeutige Basenamen (etwa SKILL.md in jedem Skill-Ordner) bleiben bewusst unaufgelöst,
 * statt willkürlich auf eine der Kandidatendateien zu zeigen.
 */
function resolveLinks(db, { source = null } = {}) {
  const byBasename = new Map();
  for (const row of db.prepare('SELECT path, basename FROM notes').all()) {
    const key = row.basename.toLowerCase();
    if (!byBasename.has(key)) byBasename.set(key, []);
    byBasename.get(key).push(row.path);
  }
  const byPath = new Set(db.prepare('SELECT path FROM notes').all().map((r) => r.path));

  const update = db.prepare('UPDATE links SET target_path = ? WHERE rowid = ?');
  db.exec('BEGIN');
  const pending = source
    ? db.prepare('SELECT rowid, target_raw FROM links WHERE source = ?').all(source)
    : db.prepare('SELECT rowid, target_raw FROM links').all();
  for (const link of pending) {
    const raw = link.target_raw;
    const asPath = raw.endsWith('.md') ? raw : `${raw}.md`;
    if (byPath.has(asPath)) {
      update.run(asPath, link.rowid);
      continue;
    }
    const candidates = byBasename.get(raw.toLowerCase().replace(/\.md$/, '')) ?? [];
    if (candidates.length === 1) update.run(candidates[0], link.rowid);
  }
  db.exec('COMMIT');
}

/** FTS5-Sonderzeichen entschärfen und die Anfrage als Phrase/Präfix aufbauen. */
function toMatchQuery(query) {
  const terms = String(query)
    .split(/\s+/)
    .map((t) => t.replace(/["*()^:]/g, '').trim())
    .filter(Boolean);
  if (terms.length === 0) return null;
  return terms.map((t) => `"${t}"`).join(' AND ');
}

export function openIndex(dbOrPath, { vaultPath = process.env.VAULT_PATH ?? '/vault', policy = DEFAULT_POLICY } = {}) {
  const db = typeof dbOrPath === 'string' ? new DatabaseSync(dbOrPath, { readOnly: false }) : dbOrPath;

  return {
    db,

    search(query, opts = {}) {
      const {
        include = ['core'],
        includeSensitive = false,
        tag = null,
        folder = null,
        type = null,
        limit = 10,
        offset = 0,
      } = opts;

      const match = toMatchQuery(query);
      if (!match) return { results: [], total: 0, hasMore: false };

      const where = ['notes_fts MATCH ?'];
      const params = [match];

      where.push(`n.class IN (${include.map(() => '?').join(',')})`);
      params.push(...include);

      if (!includeSensitive) where.push('n.sensitivity IS NULL');
      if (folder) {
        where.push('(n.folder = ? OR n.folder LIKE ?)');
        params.push(folder, `${folder}/%`);
      }
      if (type) {
        where.push('n.type = ?');
        params.push(type);
      }
      if (tag) {
        where.push('EXISTS (SELECT 1 FROM note_tags t WHERE t.path = n.path AND t.tag = ?)');
        params.push(tag);
      }

      const clause = where.join(' AND ');
      const total = db
        .prepare(`SELECT COUNT(*) c FROM notes_fts JOIN notes n ON n.path = notes_fts.path WHERE ${clause}`)
        .get(...params).c;

      const rows = db
        .prepare(
          `SELECT n.path, n.title, n.class, n.sensitivity, n.type, n.status, n.updated, n.created,
                  snippet(notes_fts, 2, '«', '»', ' … ', 16) AS snippet,
                  bm25(notes_fts, 1.0, 6.0, 1.0) AS rank
             FROM notes_fts JOIN notes n ON n.path = notes_fts.path
            WHERE ${clause}
            ORDER BY rank
            LIMIT ? OFFSET ?`,
        )
        .all(...params, limit, offset);

      return { results: rows, total, hasMore: offset + rows.length < total };
    },

    getNote(path) {
      const row = db.prepare('SELECT * FROM notes WHERE path = ?').get(path);
      if (!row) return null;
      const tags = db.prepare('SELECT tag FROM note_tags WHERE path = ?').all(path).map((r) => r.tag);
      // Inhalt kommt frisch von der Platte: der Vault wird von Obsidian Sync
      // fortlaufend verändert, ein mitgespeicherter Inhalt wäre sofort veraltet.
      let content = null;
      try {
        content = readFileSync(join(vaultPath, path), 'utf8');
      } catch {
        content = null;
      }
      return { ...row, frontmatter: JSON.parse(row.frontmatter), tags, content };
    },

    backlinks(path) {
      return db
        .prepare(
          `SELECT DISTINCT l.source AS path, n.title
             FROM links l JOIN notes n ON n.path = l.source
            WHERE l.target_path = ?
            ORDER BY n.title`,
        )
        .all(path);
    },

    outgoingLinks(path) {
      return db
        .prepare(
          `SELECT DISTINCT l.target_path AS path, n.title
             FROM links l JOIN notes n ON n.path = l.target_path
            WHERE l.source = ?
            ORDER BY n.title`,
        )
        .all(path);
    },

    listFolder(prefix = '', { limit = 100 } = {}) {
      return db
        .prepare(
          `SELECT path, title, type, updated FROM notes
            WHERE (? = '' OR folder = ? OR folder LIKE ?) AND sensitivity IS NULL
            ORDER BY path LIMIT ?`,
        )
        .all(prefix, prefix, `${prefix}/%`, limit);
    },

    stats() {
      const byClass = {};
      for (const r of db.prepare('SELECT class, COUNT(*) c FROM notes GROUP BY class').all()) {
        byClass[r.class] = r.c;
      }
      const total = db.prepare('SELECT COUNT(*) c FROM notes').get().c;
      const tags = db.prepare('SELECT COUNT(DISTINCT tag) c FROM note_tags').get().c;
      const resolved = db.prepare('SELECT COUNT(*) c FROM links WHERE target_path IS NOT NULL').get().c;
      const links = db.prepare('SELECT COUNT(*) c FROM links').get().c;
      return { total, byClass, distinctTags: tags, links, resolvedLinks: resolved };
    },

    /**
     * Eine einzelne Notiz neu einlesen, etwa direkt nach einer Bearbeitung.
     * Der Komplettaufbau läuft weiter periodisch; das hier hält nur Suche,
     * Frontmatter und ausgehende Links der gerade geänderten Notiz aktuell.
     * Backlinks anderer Notizen auf eine neu entstandene Datei löst erst der
     * nächste Komplettaufbau auf.
     */
    refresh(path) {
      const relPath = String(path ?? '');
      let raw = null;
      try {
        raw = readFileSync(join(vaultPath, relPath), 'utf8');
      } catch {
        raw = null;
      }
      db.exec('BEGIN');
      try {
        for (const table of ['notes', 'note_tags', 'notes_fts']) {
          db.prepare(`DELETE FROM ${table} WHERE path = ?`).run(relPath);
        }
        db.prepare('DELETE FROM links WHERE source = ?').run(relPath);
        if (raw !== null && !policy.isExcluded(relPath)) {
          insertNoteFile(prepareStatements(db), { vaultPath, policy }, relPath, raw);
        }
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
      resolveLinks(db, { source: relPath });
    },

    close() {
      db.close();
    },
  };
}
