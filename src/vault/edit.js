import { readFileSync, writeFileSync, realpathSync, renameSync, mkdirSync, existsSync, linkSync, unlinkSync, statSync, copyFileSync, utimesSync, constants } from 'node:fs';
import { join, sep, dirname } from 'node:path';
import { KEY_ALIASES } from './markdown.js';

// Tabulator ist erlaubt, Zeilenumbrüche und andere Steuerzeichen nicht.
const CTRL_OR_NEWLINE = /[\u0000-\u0008\u000a-\u001f]/;
const KEY = /^[A-Za-zÄÖÜäöüß0-9_-]+$/;
const HEADING = /^(#{1,6})\s+(.+?)(?:\s+#+)?\s*$/;
const FENCE = /^\s*(```|~~~)/;
const CHECKBOX = /^(\s*[-*+]\s+\[)([ xX])(\]\s?.*)$/;

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

  /** Nach dem Verschieben beide Pfade neu einlesen (der Manager löst Links dann neu auf). */
  function reindex(paths) {
    try {
      if (index.applyChanges) index.applyChanges(paths);
      else {
        for (const p of paths) index.refresh?.(p);
        index.relinkAll?.();
      }
    } catch {
      /* der nächste Komplettaufbau holt es nach */
    }
  }

  return {
    /**
     * Verschiebt eine Notiz in einen anderen Ordner, mit `name` auch unter
     * neuem Dateinamen. Ob der Zielordner erlaubt ist (Policy), prüft der
     * Aufrufer; hier geht es um Pfad-Sicherheit: kein `..`, nichts außerhalb
     * des Vaults, nichts überschreiben.
     */
    move({ path, folder, name: rename = null }) {
      const { relPath, absolute } = resolveTarget(path);
      const before = readFileSync(absolute, 'utf8');
      const target = String(folder ?? '').replace(/^\/+|\/+$/g, '');
      if (!target || target.split('/').some((p) => !p.trim() || p === '.' || p === '..' || p.startsWith('.')) || CTRL_OR_NEWLINE.test(target) || target.includes('\\')) {
        throw new Error(`„${folder}“ ist kein gültiger Ordner`);
      }
      const name = rename == null ? relPath.split('/').pop() : noteFileName(rename);
      const to = `${target}/${name}`;
      if (to === relPath) return { path: relPath, from: relPath, changed: false };
      const destination = join(vaultPath, to);
      const taken = () => new Error(`In „${target}“ gibt es schon eine Notiz „${name}“`);
      // Dieselbe Datei unter dem Ziel zählt nur als frei, wenn sich bloß die Schreibweise
      // ändert; ein zweiter harter Link mit anderem Namen ist eine belegte Notiz.
      const caseOnly = to.toLowerCase() === relPath.toLowerCase();
      const occupied = () => existsSync(destination) && !(caseOnly && sameFile(absolute, destination));
      if (occupied()) throw taken();
      // Auch der Zielordner darf nicht per Symlink aus dem Vault herausführen:
      // den tiefsten vorhandenen Ordner prüfen, bevor etwas angelegt wird.
      let existing = dirname(destination);
      while (!existsSync(existing)) existing = dirname(existing);
      const real = realpathSync(existing);
      if (real !== vaultReal && !real.startsWith(vaultReal + sep)) throw new Error(`„${target}“ zeigt aus dem Vault heraus`);
      // Wie bei modify: Hat der Sync die Notiz seit dem Lesen geändert, lieber abbrechen.
      if (readFileSync(absolute, 'utf8') !== before) {
        throw new Error(`"${relPath}" wurde gerade anderweitig geändert. Bitte neu lesen und erneut versuchen.`);
      }
      mkdirSync(dirname(destination), { recursive: true });
      // Atomar ohne Überschreiben (VCP-59): Ein harter Link scheitert, wenn das Ziel
      // inzwischen existiert; erst danach verschwindet der alte Name.
      let linked = false;
      try {
        linkSync(absolute, destination);
        linked = true;
      } catch (err) {
        if (err.code === 'EEXIST' && occupied()) throw taken();
        if (err.code === 'EEXIST') {
          // Nur die Schreibweise geändert (Dateisystem ohne Groß/klein): Das Ziel ist
          // dieselbe Datei, umbenennen kann nichts anderes überschreiben.
          renameSync(absolute, destination);
        } else {
          // Keine harten Links (manche Freigaben): exklusiv kopieren, das scheitert
          // ebenso an einem inzwischen angelegten Ziel; danach gilt der neue Name.
          if (!['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'EMLINK', 'ENOSYS'].includes(err.code)) throw err;
          try {
            copyFileSync(absolute, destination, constants.COPYFILE_EXCL);
          } catch (copyErr) {
            if (copyErr.code === 'EEXIST') throw taken();
            throw copyErr;
          }
          const { atime, mtime } = statSync(absolute);
          try { utimesSync(destination, atime, mtime); } catch { /* nur Zeitstempel */ }
          linked = true;
        }
      }
      if (linked) {
        try {
          unlinkSync(absolute);
        } catch (err) {
          // Alter Name bleibt: den neuen wieder entfernen, sonst gäbe es die Notiz zweimal.
          try { unlinkSync(destination); } catch { /* bleibt als zweiter Name */ }
          throw err;
        }
      }
      reindex([relPath, to]);
      return { path: to, from: relPath, changed: true };
    },

    /**
     * Legt eine neue Notiz an. Gibt es die Datei schon, bleibt sie unangetastet
     * und es kommt ein Fehler; Ordner werden wie bei `move` geprüft.
     */
    create({ folder, name, content }) {
      const target = String(folder ?? '').replace(/^\/+|\/+$/g, '');
      if (!target || target.split('/').some((p) => !p.trim() || p === '.' || p === '..' || p.startsWith('.')) || CTRL_OR_NEWLINE.test(target) || target.includes('\\')) {
        throw new Error(`„${folder}“ ist kein gültiger Ordner`);
      }
      // Dieselbe Prüfung wie beim Umbenennen (VCP-59); `.md` wird ergänzt.
      const file = noteFileName(name);
      const to = `${target}/${file}`;
      const destination = join(vaultPath, to);
      let existing = dirname(destination);
      while (!existsSync(existing)) existing = dirname(existing);
      const real = realpathSync(existing);
      if (real !== vaultReal && !real.startsWith(vaultReal + sep)) throw new Error(`„${target}“ zeigt aus dem Vault heraus`);
      mkdirSync(dirname(destination), { recursive: true });
      try {
        writeFileSync(destination, String(content ?? ''), { encoding: 'utf8', flag: 'wx' });
      } catch (err) {
        if (err.code === 'EEXIST') throw new Error(`In „${target}“ gibt es schon eine Notiz „${file}“`);
        throw err;
      }
      reindex([to]);
      return { path: to, changed: true };
    },

    /**
     * Schreibt Wikilinks und Einbettungen auf `from` (der Linktext vor `|` oder
     * `#`, genau so geschrieben) auf `to` um, außerhalb von Frontmatter,
     * Codeblöcken und Inline-Code, also genau dort, wo auch der Index Links zählt.
     * Für das Verschieben mit `update_links` (VCP-58); wie alle Änderungen nur
     * in eigenen, nicht vertraulichen Notizen und mit Abbruch, wenn der Sync
     * gleichzeitig schreibt. Liefert zusätzlich `count`.
     */
    relink({ path, from, to }) {
      const old = String(from ?? '');
      const next = String(to ?? '');
      if (!old || !next || /[\]|#^\n]/.test(next)) throw new Error(`„${to}“ ist kein gültiges Linkziel`);
      const pattern = new RegExp(`(!?\\[\\[)${old.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=[|#^\\]])`, 'g');
      return modify(path, (content) => {
        const eol = content.includes('\r\n') ? '\r\n' : '\n';
        const lines = content.split(/\r?\n/);
        let fence = null;
        let count = 0;
        // Frontmatter wie `splitFrontmatter`: ab `---` bis zur nächsten Zeile, die mit `---` beginnt.
        let start = 0;
        if (lines[0]?.startsWith('---')) {
          const end = lines.findIndex((l, i) => i > 0 && l.startsWith('---'));
          if (end !== -1) start = end + 1;
        }
        for (let i = start; i < lines.length; i += 1) {
          // Ein Zaun schließt nur mit derselben Sorte, mindestens gleich lang und ohne Info-Text.
          const f = lines[i].match(/^\s*(`{3,}|~{3,})(.*)$/);
          if (f) {
            if (fence === null) fence = f[1];
            else if (f[1][0] === fence[0] && f[1].length >= fence.length && !f[2].trim()) fence = null;
            continue;
          }
          if (fence) continue;
          // Ungerade Teile sind Inline-Code und bleiben, wie sie sind.
          lines[i] = lines[i].split(/(`[^`]*`)/).map((part, j) => (j % 2 ? part : part.replace(pattern, (_, open) => {
            count += 1;
            return `${open}${next}`;
          }))).join('');
        }
        return { content: lines.join(eol), count };
      });
    },

    /**
     * Hakt die `n`-te Checkbox (ab 0, Codeblöcke zählen nicht) ab oder wieder
     * auf. `line` ist der erwartete Zeilentext: Hat sich die Notiz seit dem
     * Anzeigen verschoben, wird nichts geändert.
     */
    toggleTask({ path, n, line, done }) {
      return modify(path, (content) => {
        const eol = content.includes('\r\n') ? '\r\n' : '\n';
        const lines = content.split(/\r?\n/);
        let seen = -1;
        let fence = null;
        for (let i = frontmatterEnd(lines); i < lines.length; i += 1) {
          const f = lines[i].match(FENCE);
          if (f) {
            if (fence === null) fence = f[1];
            else if (fence === f[1]) fence = null;
            continue;
          }
          if (fence) continue;
          const m = lines[i].match(CHECKBOX);
          if (!m || ++seen !== Number(n)) continue;
          if (line != null && lines[i].trim() !== String(line).trim()) break;
          lines[i] = `${m[1]}${done ? 'x' : ' '}${m[3]}`;
          return { content: lines.join(eol), line: lines[i].trim() };
        }
        throw new Error('Die Checkbox steht nicht mehr an dieser Stelle. Bitte neu laden.');
      });
    },

    /**
     * Ersetzt den ersten Absatz unter `## <heading>` (wie ihn das Cockpit
     * anzeigt). Fehlt der Abschnitt, kommt er ans Ende; ist er leer, kommt der
     * Text direkt unter die Überschrift. Der Rest der Notiz bleibt unberührt.
     */
    setSectionParagraph({ path, heading, text }) {
      const paragraph = String(text ?? '').replace(/\s*\n\s*/g, ' ').trim();
      if (!paragraph) throw new Error('Text darf nicht leer sein');
      const wanted = String(heading ?? '').trim().toLowerCase();
      return modify(path, (content) => {
        const eol = content.includes('\r\n') ? '\r\n' : '\n';
        const lines = content.split(/\r?\n/);
        const h = findHeadings(lines, frontmatterEnd(lines)).find((x) => x.level === 2 && x.text.toLowerCase() === wanted);
        if (!h) {
          while (lines.length && lines.at(-1).trim() === '') lines.pop();
          lines.push('', `## ${heading}`, '', paragraph, '');
          return { content: lines.join(eol), previous: null };
        }
        let i = h.line + 1;
        while (i < lines.length && lines[i].trim() === '') i += 1;
        let end = i;
        while (end < lines.length && lines[end].trim() !== '' && !/^#{1,6}\s/.test(lines[end])) end += 1;
        const previous = end > i ? lines.slice(i, end).map((l) => l.trim()).join(' ') : null;
        if (end > i) lines.splice(i, end - i, paragraph);
        else lines.splice(h.line + 1, i - h.line - 1, '', paragraph, '');
        return { content: lines.join(eol), previous };
      });
    },

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

/** Zeigen beide Pfade auf dieselbe Datei (nur andere Schreibweise auf einem Dateisystem ohne Groß/klein)? */
function sameFile(a, b) {
  try {
    const [x, y] = [statSync(a), statSync(b)];
    return x.ino === y.ino && x.dev === y.dev;
  } catch {
    return false;
  }
}

// Was Obsidian im Dateinamen nicht zulässt oder was Wikilinks bricht.
const BAD_FILENAME = /[\\/:*?"<>|#^[\]]/;

/**
 * Dateiname für eine umbenannte Notiz: `.md` wird ergänzt, wenn es fehlt;
 * ungültige Namen werden abgelehnt.
 */
export function noteFileName(raw) {
  const name = String(raw ?? '').trim();
  const file = /\.md$/i.test(name) ? name : `${name}.md`;
  const stem = file.slice(0, -3);
  if (!stem.trim() || stem.length > 200 || stem.startsWith('.') || /[\s.]$/.test(stem) || BAD_FILENAME.test(stem) || CTRL_OR_NEWLINE.test(stem)) {
    throw new Error(
      `„${raw ?? ''}“ ist kein gültiger Dateiname. Nicht erlaubt sind / \\ : * ? " < > | # ^ [ ], Zeilenumbrüche, ` +
        'ein Punkt am Anfang sowie Punkt oder Leerzeichen am Ende; höchstens 200 Zeichen.',
    );
  }
  return file;
}

/** Index der ersten Zeile nach dem Frontmatter, 0 wenn es keins gibt. */
function frontmatterEnd(lines) {
  if (lines[0]?.trim() !== '---') return 0;
  for (let i = 1; i < lines.length; i += 1) if (lines[i].trim() === '---') return i + 1;
  return 0;
}

/**
 * Überschriften einer Notiz wie bei `append` mit `heading`: hinter dem
 * Frontmatter, außerhalb von Code-Blöcken, `{ line, level, text }`.
 */
export function headingsOf(content) {
  const lines = String(content ?? '').split(/\r?\n/);
  return findHeadings(lines, frontmatterEnd(lines));
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
