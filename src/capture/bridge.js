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
 * Rückrichtung (`syncBack`): Ist die verlinkte Aufgabe in Zunder erledigt, hakt
 * die Brücke die Checkbox ab (`- [x]`); ist sie verworfen, wird die Checkbox
 * als abgebrochen markiert (`- [-]`, Konvention des Tasks-Plugins). Andersherum
 * (im Vault abgehakt → in Zunder erledigt) gibt es bewusst nicht: Zunder führt,
 * die Checkbox spiegelt nur.
 *
 * Bearbeitet wird nur über den Editor, also nur eigene, nicht vertrauliche
 * Notizen; Codeblöcke bleiben unberührt.
 */
const FENCE = /^\s*(```|~~~)/;
const OPEN_CHECKBOX = /^(\s*(?:[-*+]|\d+[.)])\s+)\[ \](\s+)(.*)$/;
const TASK_LINK = /\[↗[^\]]*\]\(([^)\s]*\/#\/aufgabe\/([^)\s/?#]+))\)/;
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Zeilen außerhalb von Codeblöcken. */
function* linesOutsideCode(content) {
  let fence = null;
  for (const line of content.split(/\r?\n/)) {
    const f = line.match(FENCE);
    if (f) {
      if (fence === null) fence = f[1];
      else if (fence === f[1]) fence = null;
      continue;
    }
    if (!fence) yield line;
  }
}

/** Findet markierte, offene Checkboxen; liefert je Zeile Text und Titel. */
export function findMarkedTasks(content, tag = 'zunder') {
  const marker = new RegExp(`(^|\\s)#${escapeRegExp(tag)}(?=$|[\\s.,;:!?)])`, 'i');
  const checkbox = /^(\s*(?:[-*+]|\d+[.)])\s+\[ \]\s+)(.*)$/;
  const found = [];
  for (const line of linesOutsideCode(content)) {
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

/**
 * Findet offene Checkboxen mit Link auf eine Zunder-Aufgabe; liefert je Zeile
 * Text, Aufgaben-ID und URL. Mit `urlPrefix` zählen nur Links dorthin.
 */
export function findLinkedTasks(content, urlPrefix = null) {
  const found = [];
  for (const line of linesOutsideCode(content)) {
    const m = line.match(OPEN_CHECKBOX);
    if (!m) continue;
    const link = m[3].match(TASK_LINK);
    if (!link || (urlPrefix && !link[1].startsWith(urlPrefix))) continue;
    found.push({ line, id: link[2], url: link[1] });
  }
  return found;
}

/** Schließt die Checkbox einer Zeile: `x` für erledigt, `-` für verworfen. */
export function closeLine(line, mark) {
  return line.replace(OPEN_CHECKBOX, (_, lead, gap, rest) => `${lead}[${mark}]${gap}${rest}`);
}

const MARK_FOR_STATUS = { done: 'x', dropped: '-' };

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

  /** Rückrichtung: in Zunder erledigte oder verworfene Aufgaben im Vault schließen. */
  async function syncBack() {
    const prefix = zunder.taskUrl ? zunder.taskUrl('') : null;
    const open = [];
    const seen = new Set();
    for (const path of index.pathsContaining('/#/aufgabe/')) {
      const note = index.getNote(path);
      if (!note?.content || note.class !== 'core' || note.sensitivity) continue;
      for (const { line, id } of findLinkedTasks(note.content, prefix)) {
        const key = `${path}\n${line}`;
        if (seen.has(key)) continue;
        seen.add(key);
        open.push({ path, line, id });
      }
    }

    // Je Aufgabe eine Abfrage: Offene, verlinkte Checkboxen sind wenige, und
    // `filter_tasks` blendet ältere erledigte Aufgaben aus.
    const status = new Map();
    for (const id of new Set(open.map((o) => o.id))) {
      try {
        status.set(id, (await zunder.getTask(id))?.status ?? null);
      } catch (err) {
        logger.warn?.(`Zunder-Brücke: Status von ${id} nicht abrufbar (${err.message})`);
      }
    }

    let closed = 0;
    for (const { path, line, id } of open) {
      const mark = MARK_FOR_STATUS[status.get(id)];
      if (!mark) continue;
      try {
        editor.replace({ path, oldText: line, newText: closeLine(line, mark), replaceAll: true });
        closed += 1;
        logger.info?.(`Zunder-Brücke: ${id} ${status.get(id)} → ${path}`);
      } catch (err) {
        logger.warn?.(`Zunder-Brücke: Checkbox in ${path} folgt beim nächsten Durchlauf (${err.message})`);
      }
    }
    return closed;
  }

  /** Durchläufe nacheinander, damit keine Zeile doppelt übertragen wird. */
  const enqueue = (paths) => enqueueJob(() => run(paths));
  const enqueueJob = (job) => {
    const next = queue.then(job);
    queue = next.catch(() => 0);
    return next;
  };

  return {
    tag: normalizedTag,
    /** Nur diese Notizen prüfen (nach gemeldeten Änderungen). */
    scan: (paths) => enqueue(paths.filter((p) => p.toLowerCase().endsWith('.md'))),
    /** Alle Notizen mit dem Tag prüfen (Start, periodisch). */
    scanAll: () => enqueue(index.pathsWithTag(normalizedTag)),
    /** In Zunder erledigte oder verworfene Aufgaben im Vault abhaken (Start, periodisch). */
    syncBack: () => enqueueJob(syncBack),
  };
}
