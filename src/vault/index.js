import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync, statSync, lstatSync, realpathSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { parseNote } from './markdown.js';
import { DEFAULT_POLICY } from './policy.js';
import { isImagePath } from './images.js';

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

-- Bilder im Vault (VCP-114), damit eingebettete Bilder ohne Gang über den Vault
-- gefunden werden. name ist der Dateiname klein geschrieben, wie Obsidian ihn sucht.
CREATE TABLE IF NOT EXISTS images (
  path TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  folder TEXT,
  size INTEGER NOT NULL,
  mtime INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS images_name ON images(name);

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
    } else if (entry.isFile() && (entry.name.toLowerCase().endsWith('.md') || isImagePath(entry.name))) {
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
    insertImage: db.prepare('INSERT INTO images (path, name, folder, size, mtime) VALUES (?,?,?,?,?)'),
  };
}

/** Ein Bild in die Tabelle `images` eintragen; false, wenn es nicht (mehr) lesbar ist. */
function insertImageFile(stmts, { vaultPath }, relPath) {
  let st;
  try {
    // lstat: ein Symlink ist kein Bild im Vault (wie beim Gang über den Vault).
    st = lstatSync(join(vaultPath, relPath));
  } catch {
    return false;
  }
  if (!st.isFile()) return false;
  const slash = relPath.lastIndexOf('/');
  stmts.insertImage.run(relPath, relPath.slice(slash + 1).toLowerCase(), slash >= 0 ? relPath.slice(0, slash) : '', st.size, Math.floor(st.mtimeMs));
  return true;
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
  db.exec('DELETE FROM notes; DELETE FROM note_tags; DELETE FROM links; DELETE FROM notes_fts; DELETE FROM images;');

  const stmts = prepareStatements(db);

  let count = 0;
  let images = 0;
  db.exec('BEGIN');
  for (const relPath of walk(vaultPath, vaultPath)) {
    if (policy.isExcluded(relPath)) continue;
    if (isImagePath(relPath)) {
      if (insertImageFile(stmts, { vaultPath }, relPath)) images += 1;
      continue;
    }

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

  logger.info?.(`Index aufgebaut: ${count} Notizen, ${images} Bilder`);
  if (persist) persist(db, vaultPath);
  return { db, count };
}

/** Aliase aus dem Frontmatter (`aliases` oder `alias`, Liste oder einzelner Wert). */
function aliasesOf(frontmatter) {
  const raw = frontmatter?.aliases ?? frontmatter?.alias;
  const list = Array.isArray(raw) ? raw : raw == null ? [] : [raw];
  return list.map((a) => String(a).trim()).filter(Boolean);
}

/** Nachschlagetabellen für die Link-Auflösung: Pfade, Basenamen und Aliase (klein geschrieben). */
function linkMaps(db) {
  const byPath = new Set();
  const byBasename = new Map();
  const byAlias = new Map();
  const add = (map, key, path) => {
    if (!map.has(key)) map.set(key, []);
    if (!map.get(key).includes(path)) map.get(key).push(path);
  };
  for (const row of db.prepare('SELECT path, basename, frontmatter FROM notes').all()) {
    byPath.add(row.path);
    add(byBasename, row.basename.toLowerCase(), row.path);
    if (!row.frontmatter.includes('alias')) continue;
    for (const alias of aliasesOf(JSON.parse(row.frontmatter))) add(byAlias, alias.toLowerCase(), row.path);
  }
  return { byPath, byBasename, byAlias };
}

/** Ein Linkziel (ohne `#Überschrift` und `|Anzeige`) auf einen Pfad auflösen, sonst null. */
function resolveWith({ byPath, byBasename, byAlias }, raw) {
  const target = String(raw ?? '').trim();
  if (!target) return null;
  const asPath = target.endsWith('.md') ? target : `${target}.md`;
  if (byPath.has(asPath)) return asPath;
  const candidates = byBasename.get(target.toLowerCase().replace(/\.md$/, '')) ?? [];
  if (candidates.length === 1) return candidates[0];
  if (candidates.length) return null;
  const aliased = byAlias.get(target.toLowerCase()) ?? [];
  return aliased.length === 1 ? aliased[0] : null;
}

/**
 * Löst Wikilink-Ziele auf Pfade auf: erst exakter Pfad, dann eindeutiger
 * Basename, dann eindeutiger Alias aus dem Frontmatter (`aliases`).
 * Mehrdeutige Basenamen (etwa SKILL.md in jedem Skill-Ordner) bleiben bewusst unaufgelöst,
 * statt willkürlich auf eine der Kandidatendateien zu zeigen.
 */
function resolveLinks(db, { source = null } = {}) {
  const maps = linkMaps(db);
  const update = db.prepare('UPDATE links SET target_path = ? WHERE rowid = ?');
  db.exec('BEGIN');
  const pending = source
    ? db.prepare('SELECT rowid, target_raw FROM links WHERE source = ?').all(source)
    : db.prepare('SELECT rowid, target_raw FROM links').all();
  for (const link of pending) {
    const path = resolveWith(maps, link.target_raw);
    if (path) update.run(path, link.rowid);
  }
  db.exec('COMMIT');
}

/** FTS5-Sonderzeichen entschärfen und die Anfrage als Phrase/Präfix aufbauen. */
function toMatchQuery(query, { any = false } = {}) {
  const terms = String(query)
    .split(/\s+/)
    .map((t) => t.replace(/["*()^:]/g, '').trim())
    .filter(Boolean);
  if (terms.length === 0) return null;
  return terms.map((t) => `"${t}"`).join(any ? ' OR ' : ' AND ');
}

export function openIndex(dbOrPath, { vaultPath = process.env.VAULT_PATH ?? '/vault', policy = DEFAULT_POLICY } = {}) {
  const db = typeof dbOrPath === 'string' ? new DatabaseSync(dbOrPath, { readOnly: false }) : dbOrPath;
  // Nachschlagetabellen für resolveLink, neu gebaut nach jeder Änderung am Index.
  let maps = null;

  /**
   * Gilt für ein einzeln gemeldetes Bild dasselbe wie beim Gang über den
   * Vault? Nicht ausgeschlossen, kein versteckter Ordner, kein Symlink auf dem Weg.
   */
  function eligibleImage(relPath) {
    if (policy.isExcluded(relPath) || relPath.split('/').some((part) => !part || part.startsWith('.') || part === '..')) return false;
    try {
      return realpathSync(join(vaultPath, relPath)) === join(realpathSync(vaultPath), relPath);
    } catch {
      return false;
    }
  }

  /** Ein Bild neu eintragen oder entfernen; Notizen und Links bleiben unberührt. */
  function refreshImage(relPath) {
    const existed = Boolean(db.prepare('SELECT 1 FROM images WHERE path = ?').get(relPath));
    db.prepare('DELETE FROM images WHERE path = ?').run(relPath);
    const exists = eligibleImage(relPath) && insertImageFile(prepareStatements(db), { vaultPath }, relPath);
    return { existed, exists, image: true };
  }

  return {
    db,

    search(query, opts = {}) {
      const {
        include = ['core'],
        includeSensitive = false,
        tag = null,
        folder = null,
        type = null,
        paths = null,
        limit = 10,
        offset = 0,
        any = false,
      } = opts;

      const match = toMatchQuery(query, { any });
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
      // Nur diese Pfade (z. B. die Synthesen, die die Filter von /wissen erfüllen).
      if (paths) {
        where.push('n.path IN (SELECT value FROM json_each(?))');
        params.push(JSON.stringify([...paths]));
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

    /** Ordner mit eigenen, nicht vertraulichen Notizen (für „Ablegen“). */
    folders() {
      return db
        .prepare(`SELECT DISTINCT folder FROM notes WHERE folder != '' AND class = 'core' AND sensitivity IS NULL ORDER BY folder`)
        .all()
        .map((r) => r.folder);
    },

    /** Pfade eigener, nicht vertraulicher Notizen mit diesem Tag (auch inline). */
    pathsWithTag(tag) {
      return db
        .prepare(
          `SELECT DISTINCT n.path FROM note_tags t JOIN notes n ON n.path = t.path
            WHERE t.tag = ? AND n.class = 'core' AND n.sensitivity IS NULL
            ORDER BY n.path`,
        )
        .all(tag)
        .map((r) => r.path);
    },

    /** Pfade eigener, nicht vertraulicher Notizen, deren Text diese Zeichenfolge enthält. */
    pathsContaining(text) {
      return db
        .prepare(
          `SELECT n.path FROM notes_fts f JOIN notes n ON n.path = f.path
            WHERE instr(f.body, ?) > 0 AND n.class = 'core' AND n.sensitivity IS NULL
            ORDER BY n.path`,
        )
        .all(String(text))
        .map((r) => r.path);
    },

    /** Eigene, nicht vertrauliche Notizen mit diesem Frontmatter-`type`, samt Frontmatter. */
    notesOfType(type) {
      return db
        .prepare(
          `SELECT path, title, status, updated, frontmatter FROM notes
            WHERE type = ? AND class = 'core' AND sensitivity IS NULL
            ORDER BY path`,
        )
        .all(type)
        .map((r) => ({ ...r, frontmatter: JSON.parse(r.frontmatter) }));
    },

    /** Pfade, die die Filter der Suche erfüllen (ohne Suchbegriff), für die Vektorsuche. */
    filterPaths({ include = ['core'], includeSensitive = false, tag = null, folder = null, type = null, paths = null } = {}) {
      const where = [`class IN (${include.map(() => '?').join(',')})`];
      const params = [...include];
      if (!includeSensitive) where.push('sensitivity IS NULL');
      if (folder) {
        where.push('(folder = ? OR folder LIKE ?)');
        params.push(folder, `${folder}/%`);
      }
      if (type) {
        where.push('type = ?');
        params.push(type);
      }
      if (tag) {
        where.push('EXISTS (SELECT 1 FROM note_tags t WHERE t.path = notes.path AND t.tag = ?)');
        params.push(tag);
      }
      if (paths) {
        where.push('path IN (SELECT value FROM json_each(?))');
        params.push(JSON.stringify([...paths]));
      }
      return new Set(db.prepare(`SELECT path FROM notes WHERE ${where.join(' AND ')}`).all(...params).map((r) => r.path));
    },

    /**
     * Alle eigenen, nicht vertraulichen Notizen mit ihren aufgelösten Wikilinks
     * untereinander, für den Graphen über den ganzen Vault: `notes` nach Pfad
     * sortiert, `links` als Paare `[source, target]` ohne Selbstlinks.
     */
    wholeGraph() {
      const notes = db
        .prepare("SELECT path, title, basename, folder, type FROM notes WHERE class = 'core' AND sensitivity IS NULL ORDER BY path")
        .all();
      const links = db
        .prepare(
          `SELECT DISTINCT l.source AS s, l.target_path AS t
             FROM links l
             JOIN notes a ON a.path = l.source
             JOIN notes b ON b.path = l.target_path
            WHERE l.source != l.target_path
              AND a.class = 'core' AND a.sensitivity IS NULL
              AND b.class = 'core' AND b.sensitivity IS NULL
            ORDER BY l.source, l.target_path`,
        )
        .all()
        .map((r) => [r.s, r.t]);
      return { notes, links };
    },

    /** Eigene Notizen, die eingebettet werden (auch vertrauliche, gefiltert wird beim Ausliefern). */
    embeddablePaths() {
      return db.prepare("SELECT path FROM notes WHERE class = 'core' ORDER BY path").all().map((r) => r.path);
    },

    /** Linkziel wie bei der Link-Auflösung des Index auf einen Pfad auflösen (Pfad, Basename, Alias), sonst null. */
    resolveLink(target) {
      maps ??= linkMaps(db);
      return resolveWith(maps, target);
    },

    /** Tags (Frontmatter und inline) mehrerer Notizen, als Map path → Tags. */
    tagsOf(paths) {
      const out = new Map();
      const stmt = db.prepare('SELECT tag FROM note_tags WHERE path = ? ORDER BY tag');
      for (const p of new Set(paths)) out.set(p, [...new Set(stmt.all(p).map((r) => r.tag))]);
      return out;
    },

    /** Wie viele Notizen diesen Basename tragen (ohne `.md`, Groß-/Kleinschreibung egal), wie bei der Link-Auflösung. */
    basenameCount(basename) {
      const key = String(basename ?? '').toLowerCase();
      return db.prepare('SELECT basename FROM notes').all().filter((r) => r.basename.toLowerCase() === key).length;
    },

    /** Metadaten mehrerer Notizen ohne Inhalt, als Map path → Zeile. */
    describe(paths) {
      const out = new Map();
      const stmt = db.prepare('SELECT path, title, class, sensitivity, type, status, updated, created, basename FROM notes WHERE path = ?');
      for (const p of new Set(paths)) {
        const row = stmt.get(p);
        if (row) out.set(p, row);
      }
      return out;
    },

    /** Pfade der Bilder mit diesem Dateinamen (Groß-/Kleinschreibung egal), sortiert. */
    imagesNamed(name) {
      return db
        .prepare('SELECT path FROM images WHERE name = ? ORDER BY path')
        .all(String(name ?? '').toLowerCase())
        .map((r) => r.path);
    },

    /** Steht genau dieser Pfad als Bild im Index? */
    hasImage(path) {
      return Boolean(db.prepare('SELECT 1 FROM images WHERE path = ?').get(String(path ?? '')));
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
     * Backlinks anderer Notizen auf eine neu entstandene Datei löst erst
     * relinkAll() oder der nächste Komplettaufbau auf.
     *
     * Liefert, ob die Notiz vorher bzw. nachher im Index stand. Ändert sich
     * das, ist eine Datei entstanden oder verschwunden.
     */
    refresh(path) {
      const relPath = String(path ?? '');
      if (isImagePath(relPath)) return refreshImage(relPath);
      const existed = Boolean(db.prepare('SELECT 1 FROM notes WHERE path = ?').get(relPath));
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
      maps = null;
      const exists = Boolean(db.prepare('SELECT 1 FROM notes WHERE path = ?').get(relPath));
      return { existed, exists };
    },

    /**
     * Alle Linkziele neu auflösen. Nötig, wenn Dateien entstanden oder
     * verschwunden sind: Links anderer Notizen zeigen dann auf ein neues Ziel,
     * werden mehrdeutig oder laufen ins Leere.
     */
    relinkAll() {
      db.exec('UPDATE links SET target_path = NULL');
      resolveLinks(db);
      maps = null;
    },

    close() {
      db.close();
    },
  };
}
