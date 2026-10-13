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
 * Abgleich (`syncBack`): Ist die verlinkte Aufgabe in Zunder erledigt, hakt
 * die Brücke die Checkbox ab (`- [x]`); ist sie verworfen, wird die Checkbox
 * als abgebrochen markiert (`- [-]`, Konvention des Tasks-Plugins).
 *
 * Andersherum meldet sie Abhaken im Vault an Zunder (`[x]` → erledigt, `[-]` →
 * verworfen). Dafür merkt sie je Notiz und Aufgabe die zuletzt gesehene
 * Markierung und meldet nur echte Übergänge von offen zu geschlossen. Eine in
 * Zunder wieder geöffnete Aufgabe, deren Checkbox noch abgehakt ist, bleibt
 * deshalb offen; eine Checkbox, die beim ersten Blick schon abgehakt ist, wird
 * nur gemerkt.
 *
 * Bearbeitet wird nur über den Editor, also nur eigene, nicht vertrauliche
 * Notizen; Codeblöcke bleiben unberührt.
 *
 * `zunder` ist ein Client oder eine Funktion, die den aktuellen Client liefert.
 * Jeder Durchlauf fragt sie neu: Ohne Zugang ruht die Brücke, mit neuem Zugang
 * (Einstellungen) arbeitet sie ohne Neustart weiter. Ebenso dürfen `tag`,
 * `vaultName` und `enabled` Funktionen sein (Einstellungen → Zunder-Brücke).
 */
const FENCE = /^\s*(```|~~~)/;
const OPEN_CHECKBOX = /^(\s*(?:[-*+]|\d+[.)])\s+)\[ \](\s+)(.*)$/;
const ANY_CHECKBOX = /^\s*(?:[-*+]|\d+[.)])\s+\[([ xX-])\]\s+(.*)$/;
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
 * Findet Checkboxen mit Link auf eine Zunder-Aufgabe; liefert je Zeile Text,
 * Aufgaben-ID, URL und Markierung (`' '` offen, `'x'` erledigt, `'-'`
 * abgebrochen). Mit `urlPrefix` zählen nur Links dorthin.
 */
export function findLinkedCheckboxes(content, urlPrefix = null) {
  const found = [];
  for (const line of linesOutsideCode(content)) {
    const m = line.match(ANY_CHECKBOX);
    if (!m) continue;
    const link = m[2].match(TASK_LINK);
    if (!link || (urlPrefix && !link[1].startsWith(urlPrefix))) continue;
    found.push({ line, id: link[2], url: link[1], mark: m[1].toLowerCase() });
  }
  return found;
}

/** Wie `findLinkedCheckboxes`, aber nur offene Checkboxen. */
export function findLinkedTasks(content, urlPrefix = null) {
  return findLinkedCheckboxes(content, urlPrefix)
    .filter((f) => f.mark === ' ')
    .map(({ line, id, url }) => ({ line, id, url }));
}

/** Schließt die Checkbox einer Zeile: `x` für erledigt, `-` für verworfen. */
export function closeLine(line, mark) {
  return line.replace(OPEN_CHECKBOX, (_, lead, gap, rest) => `${lead}[${mark}]${gap}${rest}`);
}

const MARK_FOR_STATUS = { done: 'x', dropped: '-' };
const STATUS_FOR_MARK = { x: 'done', '-': 'dropped' };
const SEEN = 'seen:';
const seenKey = (path, id) => `${SEEN}${path}\n${id}`;

const getter = (v) => (typeof v === 'function' ? v : () => v);

export function createZunderBridge({ index, editor, zunder, state, tag = 'zunder', vaultName = null, enabled = true, logger = console }) {
  const currentTag = getter(tag);
  const normalized = () => String(currentTag() || 'zunder').replace(/^#/, '').toLowerCase();
  const currentVaultName = getter(vaultName);
  const isEnabled = getter(enabled);
  const currentZunder = typeof zunder === 'function' ? zunder : () => zunder;
  let queue = Promise.resolve();

  function backlink(path) {
    const name = path.replace(/\.md$/i, '');
    const lines = [`Aus der Notiz [[${name}]] (\`${path}\`).`];
    const vaultName = currentVaultName();
    if (vaultName) {
      lines.push(`[In Obsidian öffnen](obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodeURIComponent(name)})`);
    }
    lines.push('', '_Übertragen von der Zunder-Brücke (Vault Cockpit)_');
    return lines.join('\n');
  }

  async function processNote(zunder, path) {
    const note = index.getNote(path);
    if (!note?.content || note.class !== 'core' || note.sensitivity) return 0;
    const tag = normalized();
    if (!note.tags.includes(tag)) return 0;

    let created = 0;
    for (const { line, title } of findMarkedTasks(note.content, tag)) {
      const key = `bridge:${path}\n${title}`;
      let task = state.get(key);
      if (!task) {
        task = await zunder.createTask({ title, description: backlink(path), vaultLinks: [path] });
        state.set(key, task);
        created += 1;
        logger.info?.(`Zunder-Brücke: ${path} → ${task.ref ?? task.id}`);
      }
      try {
        editor.replace({ path, oldText: line, newText: linkLine(line, tag, task), replaceAll: true });
        state.delete(key);
        // Gleich als offen merken, damit Abhaken vor dem nächsten Abgleich zählt.
        state.set(seenKey(path, task.id), ' ');
      } catch (err) {
        logger.warn?.(`Zunder-Brücke: Rücklink in ${path} folgt beim nächsten Durchlauf (${err.message})`);
      }
    }
    return created;
  }

  async function run(paths) {
    const zunder = isEnabled() ? currentZunder() : null;
    if (!zunder) return 0;
    let created = 0;
    for (const path of paths) {
      try {
        created += await processNote(zunder, path);
      } catch (err) {
        logger.error?.(`Zunder-Brücke: ${path} übersprungen: ${err.message}`);
      }
    }
    return created;
  }

  /**
   * Abgleich in beide Richtungen: im Vault abgehakte Checkboxen an Zunder
   * melden, in Zunder erledigte oder verworfene Aufgaben im Vault schließen.
   */
  async function syncBack() {
    const zunder = isEnabled() ? currentZunder() : null;
    if (!zunder) return { closed: 0, reported: 0 };
    const prefix = zunder.taskUrl ? zunder.taskUrl('') : null;
    // Je Notiz und Aufgabe: offene Zeilen und die Markierung des Paars
    // (offen, sobald eine Zeile offen ist, sonst die der ersten Zeile).
    const pairs = new Map();
    for (const path of index.pathsContaining('/#/aufgabe/')) {
      const note = index.getNote(path);
      if (!note?.content || note.class !== 'core' || note.sensitivity) continue;
      for (const { line, id, mark } of findLinkedCheckboxes(note.content, prefix)) {
        const key = seenKey(path, id);
        let pair = pairs.get(key);
        if (!pair) pairs.set(key, (pair = { path, id, mark, open: new Set() }));
        if (mark === ' ') {
          pair.mark = ' ';
          pair.open.add(line);
        }
      }
    }

    // Echte Übergänge im Vault: zuletzt offen gesehen, jetzt geschlossen.
    const checked = [...pairs.values()].filter((p) => p.mark !== ' ' && state.get(seenKey(p.path, p.id)) === ' ');

    // Je Aufgabe eine Abfrage: Offene oder frisch abgehakte, verlinkte
    // Checkboxen sind wenige, und `filter_tasks` blendet ältere erledigte aus.
    const ids = new Set([...pairs.values()].filter((p) => p.open.size).map((p) => p.id));
    for (const p of checked) ids.add(p.id);
    const status = new Map();
    for (const id of ids) {
      try {
        status.set(id, (await zunder.getTask(id))?.status ?? null);
      } catch (err) {
        logger.warn?.(`Zunder-Brücke: Status von ${id} nicht abrufbar (${err.message})`);
      }
    }

    let reported = 0;
    const retry = new Set();
    for (const p of checked) {
      const key = seenKey(p.path, p.id);
      if (!status.has(p.id)) {
        retry.add(key);
        continue;
      }
      if (MARK_FOR_STATUS[status.get(p.id)]) continue; // in Zunder schon geschlossen
      const next = STATUS_FOR_MARK[p.mark];
      try {
        await zunder.setStatus(p.id, next);
        status.set(p.id, next);
        reported += 1;
        logger.info?.(`Zunder-Brücke: ${p.path} → ${p.id} ${next}`);
      } catch (err) {
        retry.add(key);
        logger.warn?.(`Zunder-Brücke: ${p.id} nicht als ${next} gemeldet, nächster Durchlauf (${err.message})`);
      }
    }

    let closed = 0;
    for (const p of pairs.values()) {
      const mark = MARK_FOR_STATUS[status.get(p.id)];
      if (!mark) continue;
      for (const line of p.open) {
        try {
          editor.replace({ path: p.path, oldText: line, newText: closeLine(line, mark), replaceAll: true });
          p.open.delete(line);
          closed += 1;
          logger.info?.(`Zunder-Brücke: ${p.id} ${status.get(p.id)} → ${p.path}`);
        } catch (err) {
          logger.warn?.(`Zunder-Brücke: Checkbox in ${p.path} folgt beim nächsten Durchlauf (${err.message})`);
        }
      }
      if (!p.open.size && p.mark === ' ') p.mark = mark;
    }

    // Gesehene Markierungen festhalten; verschwundene Zeilen vergessen.
    for (const [key, p] of pairs) {
      if (!retry.has(key) && state.get(key) !== p.mark) state.set(key, p.mark);
    }
    for (const key of state.keys(SEEN)) if (!pairs.has(key)) state.delete(key);

    return { closed, reported };
  }

  /** Durchläufe nacheinander, damit keine Zeile doppelt übertragen wird. */
  const enqueue = (paths) => enqueueJob(() => run(paths));
  const enqueueJob = (job) => {
    const next = queue.then(job);
    queue = next.catch(() => 0);
    return next;
  };

  return {
    /** Aktueller Tag ohne `#`. */
    get tag() {
      return normalized();
    },
    /** Ob die Brücke eingeschaltet ist, unabhängig vom Zunder-Zugang. */
    enabled: () => Boolean(isEnabled()),
    /** Ob die Brücke gerade arbeitet: eingeschaltet und mit Zunder-Zugang. */
    active: () => Boolean(isEnabled()) && Boolean(currentZunder()),
    /** Nur diese Notizen prüfen (nach gemeldeten Änderungen). */
    scan: (paths) => enqueue(paths.filter((p) => p.toLowerCase().endsWith('.md'))),
    /** Alle Notizen mit dem Tag prüfen (Start, periodisch). */
    scanAll: () => enqueue(index.pathsWithTag(normalized())),
    /** Erledigt-Stand in beide Richtungen abgleichen (Start, periodisch). */
    syncBack: () => enqueueJob(syncBack),
  };
}
