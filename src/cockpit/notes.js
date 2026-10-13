import { parseNote } from '../vault/markdown.js';
import { ActionError } from './actions.js';

const TAG = /^[\p{L}\p{N}_/-]+$/u;

/**
 * Notizen im Cockpit ansehen und verarbeiten: Vorschau, Ablegen in einen
 * Ordner, Archivieren, Tags setzen, Text anhängen, Checkbox abhaken.
 *
 * Geschrieben wird nur über den Editor (`src/vault/edit.js`), der lokal ändert
 * und nichts überschreibt. Sichtbar und bearbeitbar sind nur eigene Notizen
 * aus dem Index, die weder vertraulich noch ausgeschlossen sind; vertrauliche
 * oder ausgeschlossene Ordner werden auch nie als Ziel angeboten oder
 * angenommen.
 */
export function createNoteDesk({ index, editor, policy, settings }) {
  /** Die Notiz, wenn das Cockpit sie zeigen darf, sonst null. */
  function visible(path) {
    const p = String(path ?? '');
    if (!p || policy.isExcluded(p) || policy.sensitivityOf(p)) return null;
    const row = index.getNote(p);
    if (!row || row.content == null || row.sensitivity || row.class !== 'core') return null;
    return row;
  }

  const mustSee = (path) => {
    const row = visible(path);
    if (!row) throw new ActionError('Diese Notiz gibt es nicht oder das Cockpit darf sie nicht bearbeiten', 404);
    return row;
  };

  /** Ein Ordner, in den das Cockpit ablegen darf; sonst ActionError. */
  function allowedFolder(folder) {
    const f = String(folder ?? '').trim().replace(/^\/+|\/+$/g, '');
    if (!f) throw new ActionError('Bitte einen Ordner angeben');
    const probe = `${f}/_.md`;
    if (policy.isExcluded(probe) || policy.sensitivityOf(probe)) {
      throw new ActionError(`„${f}“ ist vertraulich oder ausgeschlossen; dorthin legt das Cockpit nichts ab`, 403);
    }
    return f;
  }

  /** Editor-Fehler sind Eingabefehler (Pfad, Stelle verschoben …) mit deutscher Meldung. */
  const edit = (fn) => {
    try {
      return fn();
    } catch (err) {
      if (err instanceof ActionError) throw err;
      throw new ActionError(err.message, 400);
    }
  };

  const folderOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

  /** Archiv-Ordner: der oberste Ordner, der „archiv“ heißt (auch `40-archiv`), sonst null. */
  function archiveFolder() {
    const tops = [...new Set(index.folders().map((f) => f.split('/')[0]))];
    return tops.find((f) => /^(\d+[-_ ]?)?archiv(e)?$/i.test(f)) ?? null;
  }

  return {
    visible: (path) => Boolean(visible(path)),
    archiveFolder,

    /** Alles für die Notizseite; null, wenn das Cockpit die Notiz nicht zeigen darf. */
    get(path) {
      const row = visible(path);
      if (!row) return null;
      const parsed = parseNote(row.content);
      const folder = folderOf(row.path);
      const { inboxFolder } = settings.get();
      return {
        path: row.path,
        folder,
        title: row.title ?? row.path.split('/').pop().replace(/\.md$/i, ''),
        frontmatter: parsed.frontmatter,
        tags: parsed.tags,
        body: parsed.body,
        inInbox: folder === inboxFolder || folder.startsWith(`${inboxFolder}/`),
      };
    },

    /** Zielordner zum Ablegen: alle sichtbaren Ordner außer dem, in dem die Notiz liegt. */
    targets(path) {
      const here = folderOf(String(path ?? ''));
      return index.folders().filter((f) => f !== here && !policy.isExcluded(`${f}/_.md`) && !policy.sensitivityOf(`${f}/_.md`));
    },

    move(path, folder) {
      mustSee(path);
      const target = allowedFolder(folder);
      return edit(() => editor.move({ path, folder: target }));
    },

    /** Tags als Liste (Komma oder Leerzeichen getrennt, `#` optional); leer entfernt das Feld. */
    setTags(path, raw) {
      mustSee(path);
      const tags = [...new Set(String(raw ?? '').split(/[\s,]+/).map((t) => t.replace(/^#/, '')).filter(Boolean))];
      const bad = tags.find((t) => !TAG.test(t));
      if (bad) throw new ActionError(`„${bad}“ ist kein gültiger Tag`);
      return { ...edit(() => editor.setFrontmatter({ path, set: { tags: tags.length ? tags : null } })), tags };
    },

    append(path, text) {
      mustSee(path);
      if (!String(text ?? '').trim()) throw new ActionError('Der Text ist leer');
      return edit(() => editor.append({ path, text: String(text).slice(0, 20_000) }));
    },

    toggle(path, n, line, done) {
      mustSee(path);
      if (!/^\d{1,5}$/.test(String(n ?? ''))) throw new ActionError('Unbekannte Checkbox');
      return edit(() => editor.toggleTask({ path, n: Number(n), line, done }));
    },
  };
}
