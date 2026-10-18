import { parseNote } from '../vault/markdown.js';
import { DEFAULT_POLICY } from '../vault/policy.js';
import { noteFileName } from '../vault/edit.js';

const stripMd = (p) => p.replace(/\.md$/i, '');

/**
 * Notiz verschieben für das Werkzeug vault_move, mit denselben Regeln wie das
 * Ablegen im Cockpit (`src/cockpit/notes.js`): nur eigene, indexierte Notizen,
 * nie aus oder in vertrauliche oder ausgeschlossene Ordner. Dazu kommt, dass
 * das Ziel keine Readwise-Ablage sein darf, sonst wäre die Notiz danach nicht
 * mehr bearbeitbar. Pfad-Sicherheit, „Ziel existiert schon“ und die Prüfung
 * auf gleichzeitige Änderungen übernimmt der Editor.
 *
 * Wikilinks werden nicht umgeschrieben. Die Antwort nennt aber die Notizen,
 * deren Links nach dem Verschieben ins Leere zeigen: Links per Pfad
 * (`[[inbox/Idee]]`) immer, Links per Name (`[[Idee]]`) nur beim Umbenennen.
 */
export function moveNote({ index, editor, policy = DEFAULT_POLICY }, { path, folder, name = null }) {
  const from = String(path ?? '');
  if (policy.isExcluded(from) || policy.sensitivityOf(from)) {
    throw new Error(`"${from}" liegt in einem vertraulichen oder ausgeschlossenen Ordner und wird nicht verschoben.`);
  }
  const target = String(folder ?? '').trim().replace(/^\/+|\/+$/g, '');
  if (!target) throw new Error('Bitte einen Zielordner angeben, z.B. "projects/Alpha".');
  const file = name == null || String(name).trim() === '' ? from.split('/').pop() : noteFileName(name);
  for (const probe of [`${target}/_.md`, `${target}/${file}`]) {
    if (policy.isExcluded(probe) || policy.sensitivityOf(probe)) {
      throw new Error(`"${target}" ist ein vertraulicher oder ausgeschlossener Ordner; dorthin werden keine Notizen verschoben.`);
    }
    if (policy.classify(probe) !== 'core') {
      throw new Error(`"${target}" ist die Ablage für importierte Readwise-Texte; eigene Notizen gehören nicht dorthin.`);
    }
  }

  const renamed = file !== from.split('/').pop();
  const incoming = index.getNote(from) ? incomingLinks(index, from) : [];
  const knownFolder = (index.folders?.() ?? []).some((f) => f === target || f.startsWith(`${target}/`));

  const r = editor.move({ path: from, folder: target, name: renamed ? file : null });
  const result = { old_path: r.from, new_path: r.path, changed: r.changed };
  if (!r.changed) return { ...result, hint: 'Die Notiz liegt schon unter diesem Pfad; nichts geändert.' };
  if (!knownFolder) result.new_folder = true;

  // Was nach dem Verschieben nicht mehr aufgelöst wird; vertrauliche Quellen nur als Anzahl.
  const broken = incoming.filter((l) => renamed || l.byPath);
  const visible = broken.filter((l) => !l.sensitive);
  // Neues Linkziel: per Name, wenn der neue Name eindeutig ist, sonst per Pfad.
  const stem = stripMd(file);
  const unique = index.basenameCount?.(stem) === 1;
  if (visible.length) {
    result.links_to_update = visible.map((l) => ({
      path: l.source,
      title: l.title,
      old_target: l.raw,
      new_target: !l.byPath && unique ? stem : l.raw.endsWith('.md') ? r.path : stripMd(r.path),
    }));
  }
  const hidden = broken.length - visible.length;
  if (broken.length) {
    result.hint = [
      renamed
        ? 'Die Notiz wurde umbenannt; Wikilinks auf den alten Namen laufen jetzt ins Leere.'
        : 'Diese Notizen verlinken per Pfad statt per Name auf die Notiz; die Links laufen jetzt ins Leere.',
      visible.length
        ? 'In links_to_update steht je Notiz das alte Linkziel (old_target, der Teil in [[…]] vor | oder #) und das neue (new_target): ' +
          'Notiz mit vault_read lesen und den Link mit vault_edit anpassen.'
        : '',
      hidden ? `Dazu ${hidden} Notiz(en) in vertraulichen Ordnern, die hier nicht genannt werden.` : '',
    ].filter(Boolean).join(' ');
  }
  return result;
}

/**
 * Eingehende Wikilinks auf `path`, je Quelle und Linktext einmal, mit der
 * Angabe, ob per Pfad verlinkt wird. Per Pfad heißt wie bei der Auflösung im
 * Index: Der Linktext (mit `.md`) ist genau der Pfad der Notiz.
 */
function incomingLinks(index, path) {
  const found = [];
  for (const { path: source, title } of index.backlinks(path)) {
    const row = index.getNote(source);
    if (!row?.content) continue;
    const seen = new Set();
    for (const link of parseNote(row.content).links) {
      const raw = link.target;
      const byPath = (raw.endsWith('.md') ? raw : `${raw}.md`) === path;
      const byName = !byPath && stripMd(raw).toLowerCase() === stripMd(path.split('/').pop()).toLowerCase();
      if ((!byPath && !byName) || seen.has(raw)) continue;
      seen.add(raw);
      found.push({ source, title, raw, byPath, sensitive: Boolean(row.sensitivity) });
    }
  }
  return found;
}
