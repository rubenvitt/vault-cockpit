import { parseNote } from '../vault/markdown.js';
import { ActionError } from './actions.js';
import { FEUER_TYPE, findFeuer, planFeuer } from './feuer.js';
import { describeWeek, parseWeekId } from './week.js';
import { createAttachments, createLinkResolver } from './note-links.js';
import { createRelated } from './related.js';

/** Abschnitte der Feuer-Notiz, die das Cockpit bearbeitet. */
export const FEUER_FIELDS = { ziel: 'Feuer-Ziel', zug: 'Erster Zug' };

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
 *
 * Für die Vorschau löst der Schreibtisch Wikilinks und Bilder auf (`links` an
 * der Notiz, `openImage`) und kennt Backlinks und ähnliche Notizen (`related`),
 * alles nur unter den Notizen, die er auch zeigen darf. Bilder brauchen
 * `vaultPath`, ähnliche Notizen nach Bedeutung `semantic` (Index oder Getter).
 */
export function createNoteDesk({ index, editor, policy, settings, vaultPath = null, semantic = null }) {
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

  /** Wie `visible`, aber nur aus dem Index, ohne die Datei zu lesen (für Listen und Links). */
  function listed(path) {
    const p = String(path ?? '');
    if (!p || policy.isExcluded(p) || policy.sensitivityOf(p)) return null;
    const row = index.describe([p]).get(p);
    return row && !row.sensitivity && row.class === 'core' ? row : null;
  }

  const attachments = vaultPath ? createAttachments({ vaultPath, policy }) : null;
  const related = createRelated({ index, semantic, visible: listed });

  return {
    visible: (path) => Boolean(visible(path)),
    archiveFolder,

    /** Backlinks und ähnliche Notizen (siehe `createRelated`); null für unsichtbare Notizen. */
    related: (path, opts) => (visible(path) ? related.of(String(path), opts) : null),

    /** Bild aus dem Vault zum Ausliefern öffnen, siehe `createAttachments().open`. */
    openImage: (path) => attachments?.open(path) ?? null,

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
        links: createLinkResolver({ index, visible: listed, attachments }, row.path),
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

    /**
     * Wikilink von `path` nach `target` am Ende der Notiz anhängen („ähnlich,
     * aber nicht verlinkt“ im Graphen). Über den Basename, wenn er eindeutig
     * ist, sonst über den Pfad, damit der Link genau dieses Ziel trifft.
     */
    link(path, target) {
      mustSee(path);
      const to = visible(target);
      if (!to) throw new ActionError('Das Ziel gibt es nicht oder das Cockpit darf es nicht verlinken', 404);
      if (to.path === path) throw new ActionError('Eine Notiz verlinkt sich nicht selbst');
      const title = to.title ?? to.path.split('/').pop().replace(/\.md$/i, '');
      if (index.outgoingLinks(path).some((l) => l.path === to.path)) return { path, target: to.path, title, changed: false };
      const base = to.path.split('/').pop().replace(/\.md$/i, '');
      const name = index.basenameCount(base) === 1 ? base : to.path.replace(/\.md$/i, '');
      return { ...edit(() => editor.append({ path, text: `- [[${name}]]` })), target: to.path, title, changed: true };
    },

    /** Feuer-Ziel (`ziel`) oder Ersten Zug (`zug`) in der Feuer-Notiz der Woche ersetzen. */
    setFeuer(path, field, text) {
      const row = mustSee(path);
      const heading = FEUER_FIELDS[field];
      if (!heading) throw new ActionError('Unbekanntes Feld');
      if ((row.frontmatter?.type ?? row.type) !== FEUER_TYPE) throw new ActionError('Das ist keine Feuer-Notiz');
      if (!String(text ?? '').trim()) throw new ActionError(`${heading} darf nicht leer sein`);
      return { ...edit(() => editor.setSectionParagraph({ path, heading, text: String(text).slice(0, 2000) })), heading };
    },

    /**
     * Feuer-Notiz einer Woche (`2026-W42`) anlegen, wenn sie fehlt: mit
     * Feuer-Ziel und optional Erstem Zug, nach dem Muster der letzten.
     */
    createFeuer(weekId, goal, firstMove = '') {
      const parsed = parseWeekId(weekId);
      if (!parsed) throw new ActionError(`„${weekId ?? ''}“ ist keine Kalenderwoche wie 2026-W42`);
      if (!String(goal ?? '').trim()) throw new ActionError('Feuer-Ziel darf nicht leer sein');
      const week = describeWeek(parsed, settings.get().tz);
      const existing = findFeuer(index, week);
      if (existing) throw new ActionError(`Für diese Woche gibt es schon „${existing.title}“`, 409);
      const plan = edit(() => planFeuer(index, week, { goal: String(goal).slice(0, 2000), firstMove: String(firstMove ?? '').slice(0, 2000) }));
      const folder = allowedFolder(plan.folder);
      const r = edit(() => editor.create({ folder, name: plan.name, content: plan.content }));
      return { ...r, title: plan.title, week: week.id };
    },

    toggle(path, n, line, done) {
      mustSee(path);
      if (!/^\d{1,5}$/.test(String(n ?? ''))) throw new ActionError('Unbekannte Checkbox');
      return edit(() => editor.toggleTask({ path, n: Number(n), line, done }));
    },
  };
}
