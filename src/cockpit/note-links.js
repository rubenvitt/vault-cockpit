import { readdirSync, realpathSync, lstatSync, openSync, fstatSync, closeSync, constants } from 'node:fs';
import { join, posix } from 'node:path';

/**
 * Verweise einer Notiz für die Vorschau im Cockpit: Wikilinks auf Notizen
 * (Pfad, Basename, Alias wie im Index, `#Überschrift`), eingebettete Bilder
 * (`![[bild.png]]`, `![](anhang/bild.png)`) und das Ausliefern dieser Bilder.
 *
 * Sichtbar ist nur, was das Cockpit auch als Notiz zeigen darf: Ziele in
 * vertraulichen oder ausgeschlossenen Ordnern, Readwise-Importe und alles, was
 * über einen Symlink oder `..` aus dem Vault führt, gelten als „fehlt“.
 */

/** Bildformate, die die Vorschau zeigt. SVG fehlt bewusst: es kann Script enthalten. */
export const IMAGE_TYPES = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
};

/** Anhänge, die Obsidian einbettet, die Vorschau aber nur nennt. */
const OTHER_FILES = /\.(svg|pdf|mp3|m4a|wav|ogg|webm|mp4|mov|canvas|excalidraw)$/i;

/** Größtes Bild, das das Cockpit ausliefert. */
export const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

const extOf = (p) => (/\.([a-z0-9]+)$/i.exec(p)?.[1] ?? '').toLowerCase();
const folderOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');

/**
 * Vault-relativer Pfad ohne Tricks: keine absoluten Pfade, kein `..`, keine
 * versteckten Ordner (`.obsidian`, `.trash`), keine Backslashes; sonst null.
 */
export function cleanPath(path) {
  const p = String(path ?? '');
  if (!p || p.length > 1024 || /[\0\\]/.test(p) || p.startsWith('/')) return null;
  const parts = p.split('/');
  if (parts.some((s) => !s || s === '.' || s === '..' || s.startsWith('.'))) return null;
  return p;
}

/**
 * Bilder im Vault, nach Dateiname. Die Liste entsteht beim ersten Bedarf und
 * gilt eine Minute; findet ein Bild keinen Treffer, wird sie (höchstens alle
 * zehn Sekunden) neu eingelesen, damit gerade synchronisierte Bilder auftauchen.
 */
export function createAttachments({ vaultPath, policy, ttlMs = 60_000, retryMs = 10_000, now = () => Date.now() }) {
  let cache = null;
  let builtAt = 0;
  const vaultReal = (() => {
    try {
      return realpathSync(vaultPath);
    } catch {
      return vaultPath;
    }
  })();

  /** Darf das Cockpit diesen Pfad zeigen? Gleiche Regeln wie für Notizen. */
  const allowed = (p) => !policy.isExcluded(p) && !policy.sensitivityOf(p) && policy.classify(p) === 'core';

  function scan() {
    const byName = new Map();
    const paths = new Set();
    const walk = (dir, rel) => {
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (e.name.startsWith('.')) continue;
        const p = rel ? `${rel}/${e.name}` : e.name;
        // Symlinks sind weder Datei noch Ordner und bleiben damit draußen.
        if (e.isDirectory()) {
          if (allowed(`${p}/_`)) walk(join(dir, e.name), p);
        } else if (e.isFile() && IMAGE_TYPES[extOf(e.name)] && allowed(p)) {
          paths.add(p);
          const key = e.name.toLowerCase();
          if (!byName.has(key)) byName.set(key, []);
          byName.get(key).push(p);
        }
      }
    };
    walk(vaultReal, '');
    cache = { byName, paths };
    builtAt = now();
  }

  const fresh = () => {
    if (!cache || now() - builtAt > ttlMs) scan();
    return cache;
  };
  const lookup = (fn) => {
    const hit = fn(fresh());
    if (hit || now() - builtAt < retryMs) return hit;
    scan();
    return fn(cache);
  };

  /** Bester Kandidat unter gleichnamigen Bildern: möglichst nah am Ordner der Notiz, dann kürzester Pfad. */
  function nearest(candidates, from) {
    const common = (p) => {
      const a = folderOf(p).split('/');
      const b = from.split('/');
      let i = 0;
      while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
      return i;
    };
    return [...candidates].sort((x, y) => common(y) - common(x) || x.split('/').length - y.split('/').length || x.localeCompare(y))[0] ?? null;
  }

  return {
    /**
     * Bild zu einem Verweis aus einer Notiz in `from` (Ordner): Pfad ab Vault,
     * relativ zur Notiz oder, wie in Obsidian, nur der Dateiname.
     */
    find(name, from = '') {
      const raw = String(name ?? '').trim().replace(/^\/+/, '');
      if (!IMAGE_TYPES[extOf(raw)]) return null;
      const direct = [cleanPath(raw), cleanPath(posix.normalize(posix.join(from, raw)))].filter(Boolean);
      return lookup(({ byName, paths }) => {
        for (const p of direct) if (paths.has(p)) return p;
        return nearest(byName.get(raw.split('/').pop().toLowerCase()) ?? [], from);
      });
    },

    /**
     * Bild zum Ausliefern öffnen: nur erlaubte Bildformate unterhalb des
     * Vaults, ohne Symlink auf dem Weg, nicht in vertraulichen oder
     * ausgeschlossenen Ordnern, höchstens `MAX_IMAGE_BYTES` groß. Liefert
     * `{ fd, size, type }` (Aufrufer schließt `fd`) oder null.
     */
    open(path) {
      const rel = cleanPath(path);
      const type = rel && IMAGE_TYPES[extOf(rel)];
      if (!type || !allowed(rel)) return null;
      const absolute = join(vaultReal, rel);
      let fd = null;
      try {
        // realpath deckt Symlinks in Ordnern auf, O_NOFOLLOW einen nachträglich getauschten Dateinamen.
        if (realpathSync(absolute) !== absolute || !lstatSync(absolute).isFile()) return null;
        fd = openSync(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        const st = fstatSync(fd);
        if (!st.isFile() || st.size > MAX_IMAGE_BYTES) {
          closeSync(fd);
          return null;
        }
        return { fd, size: st.size, type };
      } catch {
        if (fd !== null) closeSync(fd);
        return null;
      }
    },
  };
}

/** So tief werden Notizen in Notizen eingebettet (`![[A]]` in `![[B]]`). */
export const MAX_EMBED_DEPTH = 2;
/** Höchstens so viele eingebettete Notizen je Seite, und so viel Text je Einbettung. */
const MAX_EMBEDS = 20;
const MAX_EMBED_CHARS = 50_000;

/**
 * Text unter einer Überschrift bis zur nächsten gleicher oder höherer Ebene
 * (wie Obsidian bei `![[Notiz#Überschrift]]`), ohne die Überschrift; null,
 * wenn es sie nicht gibt. Codeblöcke zählen nicht.
 */
export function sectionOf(body, heading) {
  const want = String(heading ?? '').trim().toLowerCase();
  const lines = String(body ?? '').split(/\r?\n/);
  let fence = null;
  let start = -1;
  let level = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const f = /^\s*(```|~~~)/.exec(lines[i]);
    if (f) {
      fence = fence === null ? f[1] : fence === f[1] ? null : fence;
      continue;
    }
    if (fence) continue;
    const h = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(lines[i]);
    if (!h) continue;
    if (start >= 0 && h[1].length <= level) return lines.slice(start, i).join('\n');
    if (start < 0 && h[2].trim().toLowerCase() === want) {
      start = i + 1;
      level = h[1].length;
    }
  }
  return start >= 0 ? lines.slice(start).join('\n') : null;
}

/**
 * Auflöser für die Verweise einer Notiz, wie ihn `renderMarkdown` erwartet.
 * `visible(path)` liefert die Zeile einer Notiz, die das Cockpit zeigen darf.
 *
 * - `wikilink(target, { embed })` → `{ kind: 'note', path, title, self }`,
 *   `{ kind: 'image', path }`, `{ kind: 'file' }` (nur in Obsidian) oder null (fehlt)
 * - `image(src)` → `{ kind: 'image', path }` oder null für Markdown-Bilder
 * - `embed(path, heading)` → `{ body, links }` für eine eingebettete Notiz
 *   (`![[Notiz]]`, VCP-63): ihr Text ohne Frontmatter (mit `heading` nur dieser
 *   Abschnitt) und der Auflöser für Verweise darin. Null ohne `read`, für die
 *   eigene Notiz, im Kreis, ab `MAX_EMBED_DEPTH` und nach `MAX_EMBEDS` je Seite.
 *   `read(path)` liefert den Text nur für Notizen, die das Cockpit zeigen darf;
 *   vertrauliche bleiben damit ein Link.
 */
export function createLinkResolver({ index, visible, attachments = null, read = null }, notePath, { depth = 0, seen = [notePath], budget = { left: MAX_EMBEDS } } = {}) {
  const from = folderOf(notePath);
  const titleOf = (row) => row.title ?? row.path.split('/').pop().replace(/\.md$/i, '');
  const asImage = (name) => {
    const path = attachments?.find(name, from);
    return path ? { kind: 'image', path } : null;
  };

  return {
    wikilink(target) {
      const t = String(target ?? '').trim();
      if (!t) return { kind: 'note', path: notePath, title: null, self: true };
      if (IMAGE_TYPES[extOf(t)]) return asImage(t);
      if (OTHER_FILES.test(t)) return { kind: 'file' };
      const path = index.resolveLink(t);
      const row = path ? visible(path) : null;
      return row ? { kind: 'note', path: row.path, title: titleOf(row), self: row.path === notePath } : null;
    },

    image(src) {
      let s = String(src ?? '').trim().replace(/^<|>$/g, '');
      try {
        s = decodeURIComponent(s);
      } catch {
        return null;
      }
      return asImage(s.split(/[?#]/)[0]);
    },

    embed(path, heading = null) {
      if (!read || depth >= MAX_EMBED_DEPTH || seen.includes(path) || budget.left <= 0) return null;
      const text = read(path);
      if (text == null) return null;
      const body = heading ? sectionOf(text, heading) : text;
      if (body == null) return null;
      budget.left -= 1;
      return {
        body: body.length > MAX_EMBED_CHARS ? `${body.slice(0, MAX_EMBED_CHARS)}\n\n…` : body,
        links: createLinkResolver({ index, visible, attachments, read }, path, { depth: depth + 1, seen: [...seen, path], budget }),
      };
    },

    /** Markdown-Link auf eine Notiz (`[Text](Ordner/Notiz.md)`), relativ zur Notiz oder ab Vault. */
    markdownLink(href) {
      let s = String(href ?? '').trim().replace(/^<|>$/g, '');
      try {
        s = decodeURIComponent(s);
      } catch {
        return null;
      }
      const [target, anchor = null] = s.split('#');
      if (!/\.md$/i.test(target)) return null;
      for (const p of [cleanPath(posix.normalize(posix.join(from, target))), cleanPath(target.replace(/^\/+/, ''))]) {
        const row = p ? visible(p) : null;
        if (row) return { kind: 'note', path: row.path, title: titleOf(row), self: row.path === notePath, anchor };
      }
      return null;
    },
  };
}
