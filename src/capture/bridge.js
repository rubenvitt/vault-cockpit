/**
 * Zunder-Brücke: markierte Checkboxen im Vault werden Zunder-Aufgaben.
 *
 * Markiert ist eine offene Checkbox mit dem Tag `#zunder` (einstellbar):
 *
 *   - [ ] Steuererklärung abschicken #zunder
 *
 * Die Brücke legt dafür eine Aufgabe in der Zunder-Inbox an (Rücklink zur Notiz
 * über `vault_links` und in der Beschreibung) und ersetzt den Tag in der Notiz
 * durch einen Link auf die Aufgabe:
 *
 *   - [ ] Steuererklärung abschicken [↗ Zunder](https://zunder…/#/aufgabe/<id>)
 *
 * Damit ist die Zeile nicht mehr markiert und wird kein zweites Mal übertragen.
 * Gelingt das Zurückschreiben nicht (Notiz gerade geändert), merkt sich die
 * Brücke die Aufgabe und schreibt den Link beim nächsten Durchlauf, statt eine
 * zweite Aufgabe anzulegen.
 *
 * Bearbeitet wird nur über den Editor, also nur eigene, nicht vertrauliche
 * Notizen; Codeblöcke bleiben unberührt.
 */
const FENCE = /^\s*(```|~~~)/;
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Findet markierte, offene Checkboxen; liefert je Zeile Text und Titel. */
export function findMarkedTasks(content, tag = 'zunder') {
  const marker = new RegExp(`(^|\\s)#${escapeRegExp(tag)}(?=$|[\\s.,;:!?)])`, 'i');
  const checkbox = /^(\s*(?:[-*+]|\d+[.)])\s+\[ \]\s+)(.*)$/;
  const found = [];
  let fence = null;
  for (const line of content.split(/\r?\n/)) {
    const f = line.match(FENCE);
    if (f) {
      if (fence === null) fence = f[1];
      else if (fence === f[1]) fence = null;
      continue;
    }
    if (fence) continue;
    const m = line.match(checkbox);
    if (!m || !marker.test(m[2])) continue;
    const title = m[2].replace(new RegExp(marker.source, 'gi'), ' ').replace(/\s+/g, ' ').trim();
    if (title) found.push({ line, title });
  }
  return found;
}

/** Ersetzt den Tag in einer Zeile durch den Link auf die Aufgabe. */
export function linkLine(line, tag, task) {
  const marker = new RegExp(`(^|\\s)#${escapeRegExp(tag)}(?=$|[\\s.,;:!?)])`, 'i');
  const label = task.ref ? `↗ ${task.ref}` : '↗ Zunder';
  return line.replace(marker, (_, lead) => `${lead}[${label}](${task.url})`);
}

export function createZunderBridge({ index, editor, zunder, state, tag = 'zunder', vaultName = null, logger = console }) {
  const normalizedTag = tag.replace(/^#/, '').toLowerCase();
  let queue = Promise.resolve();

  function backlink(path) {
    const name = path.replace(/\.md$/i, '');
    const lines = [`Aus der Notiz [[${name}]] (\`${path}\`).`];
    if (vaultName) {
      lines.push(`[In Obsidian öffnen](obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodeURIComponent(name)})`);
    }
    lines.push('', '_Übertragen von der Zunder-Brücke (Vault Cockpit)_');
    return lines.join('\n');
  }

  async function processNote(path) {
    const note = index.getNote(path);
    if (!note?.content || note.class !== 'core' || note.sensitivity) return 0;
    if (!note.tags.includes(normalizedTag)) return 0;

    let created = 0;
    for (const { line, title } of findMarkedTasks(note.content, normalizedTag)) {
      const key = `bridge:${path}\n${title}`;
      let task = state.get(key);
      if (!task) {
        task = await zunder.createTask({ title, description: backlink(path), vaultLinks: [path] });
        state.set(key, task);
        created += 1;
        logger.info?.(`Zunder-Brücke: ${path} → ${task.ref ?? task.id}`);
      }
      try {
        editor.replace({ path, oldText: line, newText: linkLine(line, normalizedTag, task), replaceAll: true });
        state.delete(key);
      } catch (err) {
        logger.warn?.(`Zunder-Brücke: Rücklink in ${path} folgt beim nächsten Durchlauf (${err.message})`);
      }
    }
    return created;
  }

  async function run(paths) {
    let created = 0;
    for (const path of paths) {
      try {
        created += await processNote(path);
      } catch (err) {
        logger.error?.(`Zunder-Brücke: ${path} übersprungen: ${err.message}`);
      }
    }
    return created;
  }

  /** Durchläufe nacheinander, damit keine Zeile doppelt übertragen wird. */
  const enqueue = (paths) => {
    const next = queue.then(() => run(paths));
    queue = next.catch(() => 0);
    return next;
  };

  return {
    tag: normalizedTag,
    /** Nur diese Notizen prüfen (nach gemeldeten Änderungen). */
    scan: (paths) => enqueue(paths.filter((p) => p.toLowerCase().endsWith('.md'))),
    /** Alle Notizen mit dem Tag prüfen (Start, periodisch). */
    scanAll: () => enqueue(index.pathsWithTag(normalizedTag)),
  };
}
