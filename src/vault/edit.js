import { readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { join, sep } from 'node:path';
import { KEY_ALIASES } from './markdown.js';

// Tabulator ist erlaubt, Zeilenumbrüche und andere Steuerzeichen nicht.
const CTRL_OR_NEWLINE = /[\u0000-\u0008\u000a-\u001f]/;
const KEY = /^[A-Za-zÄÖÜäöüß0-9_-]+$/;
const HEADING = /^(#{1,6})\s+(.+?)(?:\s+#+)?\s*$/;
const FENCE = /^\s*(```|~~~)/;

/**
 * Bearbeiten bestehender Notizen.
 *
 * Bewusst keine Operation "Datei komplett überschreiben": Jede Änderung ist
 * lokal (Textstelle ersetzen, Text anhängen, Frontmatter-Feld setzen), damit ein
 * Fehler nie den Rest einer Notiz mitreißt.
 *
 * Editierbar ist nur, was im Index steht, nicht vertraulich ist und nicht zu
 * Readwise gehört. Damit gelten Ausschlüsse der Policy, die Beschränkung auf
 * .md-Dateien und der Schutz gegen Pfad-Traversal automatisch auch hier.
 */
export function createEditor({ vaultPath, index }) {
  const vaultReal = realpathSync(vaultPath);

  function resolveTarget(path) {
    const relPath = String(path ?? '');
    const row = index.getNote(relPath);
    if (!row || row.content === null) {
      throw new Error(`Notiz "${relPath}" wurde nicht gefunden. Mit vault_search den korrekten Pfad ermitteln.`);
    }
    if (row.sensitivity) throw new Error(`"${relPath}" liegt in einem vertraulichen Ordner und kann nicht bearbeitet werden.`);
    if (row.class !== 'core') throw new Error(`"${relPath}" ist ein importierter Text und kann nicht bearbeitet werden.`);

    const absolute = join(vaultPath, relPath);
    // Ein Symlink, der seit dem letzten Indexaufbau untergeschoben wurde, darf
    // nicht aus dem Vault herausführen.
    if (!realpathSync(absolute).startsWith(vaultReal + sep)) {
      throw new Error(`"${relPath}" zeigt aus dem Vault heraus`);
    }
    return { relPath, absolute };
  }

  /** Lesen, ändern, und nur schreiben, wenn die Datei zwischendurch niemand angefasst hat. */
  function modify(path, change) {
    const { relPath, absolute } = resolveTarget(path);
    const before = readFileSync(absolute, 'utf8');
    const { content, ...details } = change(before);
    if (content === before) return { path: relPath, changed: false, ...details };

    // Obsidian Sync schreibt parallel in den Vault. Zwischen Lesen und Schreiben
    // liegt hier zwar kaum Zeit, aber die Prüfung kostet nichts.
    if (readFileSync(absolute, 'utf8') !== before) {
      throw new Error(`"${relPath}" wurde gerade anderweitig geändert. Bitte neu lesen und erneut versuchen.`);
    }
    writeFileSync(absolute, content, 'utf8');
    try {
      index.refresh?.(relPath);
    } catch {
      /* der nächste Komplettaufbau holt es nach */
    }
    return { path: relPath, changed: true, chars_before: before.length, chars_after: content.length, ...details };
  }

  return {
    replace({ path, oldText, newText, replaceAll = false }) {
      const search = String(oldText ?? '');
      const replacement = String(newText ?? '');
      if (!search) throw new Error('old_text darf nicht leer sein');
      if (search === replacement) throw new Error('old_text und new_text sind identisch');

      return modify(path, (content) => {
        const count = content.split(search).length - 1;
        if (count === 0) {
          throw new Error('old_text kommt in der Notiz nicht vor. Die Notiz mit vault_read neu lesen und den Text exakt übernehmen.');
        }
        if (count > 1 && !replaceAll) {
          throw new Error(
            `old_text kommt ${count}-mal vor. Mehr umgebenden Text angeben, bis die Stelle eindeutig ist, oder replace_all setzen.`,
          );
        }
        // Funktion statt String: sonst würden $&, $1 usw. in new_text interpretiert.
        const next = replaceAll ? content.split(search).join(replacement) : content.replace(search, () => replacement);
        return { content: next, replacements: replaceAll ? count : 1 };
      });
    },

    append({ path, text, heading = null }) {
      const addition = String(text ?? '').replace(/\s+$/, '');
      if (!addition.trim()) throw new Error('Text darf nicht leer sein');

      return modify(path, (content) => {
        const eol = content.includes('\r\n') ? '\r\n' : '\n';
        const lines = content.split(/\r?\n/);
        const bodyStart = frontmatterEnd(lines);
        let start = bodyStart;
        let end = lines.length;

        if (heading) {
          const wanted = String(heading).replace(/^#+\s*/, '').trim();
          const headings = findHeadings(lines, bodyStart);
          const matches = headings.filter((h) => h.text === wanted);
          if (matches.length === 0) {
            const available = headings.map((h) => `${'#'.repeat(h.level)} ${h.text}`).join(', ') || 'keine';
            throw new Error(`Überschrift "${wanted}" nicht gefunden. Vorhanden: ${available}`);
          }
          if (matches.length > 1) throw new Error(`Überschrift "${wanted}" kommt ${matches.length}-mal vor und ist nicht eindeutig.`);
          const [match] = matches;
          start = match.line + 1;
          end = headings.find((h) => h.line > match.line && h.level <= match.level)?.line ?? lines.length;
        }

        // Direkt hinter die letzte nicht-leere Zeile des Abschnitts, damit Listen
        // nahtlos weiterlaufen; Leerzeilen vor der nächsten Überschrift bleiben.
        let at = end;
        while (at > start && lines[at - 1].trim() === '') at -= 1;
        const added = addition.split(/\r?\n/);
        lines.splice(at, 0, ...added);
        // Am Dateiende: abschließenden Zeilenumbruch sicherstellen.
        if (at + added.length === lines.length) lines.push('');

        return { content: lines.join(eol), heading: heading ? String(heading).replace(/^#+\s*/, '').trim() : null };
      });
    },

    setFrontmatter({ path, set }) {
      const entries = Object.entries(set ?? {});
      if (entries.length === 0) throw new Error('Mindestens ein Feld angeben');
      for (const [key, value] of entries) {
        if (!KEY.test(key)) throw new Error(`Ungültiger Feldname "${key}"`);
        for (const v of Array.isArray(value) ? value : [value]) {
          if (typeof v === 'string' && CTRL_OR_NEWLINE.test(v)) {
            throw new Error(`Feld "${key}" darf keine Zeilenumbrüche oder Steuerzeichen enthalten`);
          }
        }
      }

      return modify(path, (content) => {
        const eol = content.includes('\r\n') ? '\r\n' : '\n';
        const lines = content.split(/\r?\n/);
        const fmEnd = frontmatterEnd(lines);
        const blocks = fmEnd > 0 ? splitBlocks(lines.slice(1, fmEnd - 1)) : [];
        const canonical = (k) => KEY_ALIASES[k] ?? k;
        const updated = [];
        const removed = [];

        for (const [key, value] of entries) {
          const i = blocks.findIndex((b) => b.key !== null && canonical(b.key) === canonical(key));
          if (value === null) {
            if (i !== -1) {
              blocks.splice(i, 1);
              removed.push(key);
            }
            continue;
          }
          const serialized = serialize(i !== -1 ? blocks[i].key : key, key === 'tags' ? normalizeTags(value) : value);
          if (i !== -1) blocks[i].lines = serialized;
          else blocks.push({ key, lines: serialized });
          updated.push(key);
        }

        const body = lines.slice(fmEnd);
        const fmLines = blocks.flatMap((b) => b.lines);
        const next = fmLines.length || fmEnd > 0 ? ['---', ...fmLines, '---', ...body] : body;
        return { content: next.join(eol), updated, removed };
      });
    },
  };
}

/** Index der ersten Zeile nach dem Frontmatter, 0 wenn es keins gibt. */
function frontmatterEnd(lines) {
  if (lines[0]?.trim() !== '---') return 0;
  for (let i = 1; i < lines.length; i += 1) if (lines[i].trim() === '---') return i + 1;
  return 0;
}

function findHeadings(lines, from) {
  const found = [];
  let fence = null;
  for (let i = from; i < lines.length; i += 1) {
    const f = lines[i].match(FENCE);
    if (f) {
      if (fence === null) fence = f[1];
      else if (fence === f[1]) fence = null;
      continue;
    }
    if (fence) continue;
    const m = lines[i].match(HEADING);
    if (m) found.push({ line: i, level: m[1].length, text: m[2].trim() });
  }
  return found;
}

/** Frontmatter-Zeilen in Blöcke je Schlüssel zerlegen; Folgezeilen (Listen) gehören zum Schlüssel davor. */
function splitBlocks(fmLines) {
  const blocks = [];
  for (const line of fmLines) {
    const m = line.match(/^([A-Za-zÄÖÜäöüß0-9_-]+)\s*:/);
    if (m) blocks.push({ key: m[1], lines: [line] });
    else if (blocks.length) blocks.at(-1).lines.push(line);
    else blocks.push({ key: null, lines: [line] });
  }
  return blocks;
}

function normalizeTags(value) {
  const strip = (t) => String(t).replace(/^#/, '').trim();
  return Array.isArray(value) ? value.map(strip).filter(Boolean) : strip(value);
}

function serialize(key, value) {
  if (!Array.isArray(value)) return [`${key}: ${scalar(value)}`];
  if (value.length === 0) return [`${key}: []`];
  return [`${key}:`, ...value.map((v) => `  - ${scalar(v)}`)];
}

const RESERVED = /^(true|false|yes|no|on|off|null|~)$/i;

/** Ohne Anführungszeichen nur, was YAML garantiert als genau diesen String liest (oder als Datum). */
function scalar(value) {
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  const s = String(value);
  if (/^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:\d{2})?)?$/.test(s)) return s;
  if (/^[\p{L}_][\p{L}\p{N} _./()+-]*$/u.test(s) && !/\s$/.test(s) && !RESERVED.test(s)) return s;
  return JSON.stringify(s);
}
