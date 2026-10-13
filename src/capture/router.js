/**
 * Ein Eingang für alles, was von außen erfasst wird (Kurzbefehl, Sprachmemo,
 * Mail, Funke): Text mit `!` vorne wird eine Aufgabe in der Zunder-Inbox,
 * alles andere eine neue Notiz im Capture-Ordner des Vaults.
 */

export const SOURCES = {
  'ios-kurzbefehl': 'iOS-Kurzbefehl',
  sprachmemo: 'Sprachmemo',
  mail: 'Mail',
  funke: 'Funke',
  api: 'Capture-Endpunkt',
};

const TITLE_MAX = 80;

export class CaptureError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

/** Erste nicht-leere Zeile, bereinigt, als Titel. */
export function deriveTitle(text) {
  const first = String(text ?? '').split(/\r?\n/).find((l) => l.trim()) ?? '';
  return cleanTitle(first.replace(/^#+\s*/, ''));
}

/** Macht aus beliebigem Text einen Titel, den capture.write annimmt. */
export function cleanTitle(raw) {
  let t = String(raw ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[\\/]/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/\s+/g, ' ')
    .trim();
  if (t.length > TITLE_MAX) t = `${t.slice(0, TITLE_MAX - 1).trim()}…`;
  return t;
}

export function createCaptureRouter({ capture, zunder = null, state, logger = console }) {
  async function toZunder({ text, title, source, captureId }) {
    if (!zunder) {
      throw new CaptureError('Weiterleitung an Zunder ist nicht eingerichtet (ZUNDER_URL, ZUNDER_TOKEN)', 503);
    }
    const key = captureId ? `capture:${source}:${captureId}` : null;
    const known = key ? state.get(key) : null;
    if (known) return { kind: 'task', duplicate: true, ...known };

    const lines = text.split(/\r?\n/);
    let taskTitle = title ? String(title).trim() : '';
    let rest = text;
    if (!taskTitle) {
      const i = lines.findIndex((l) => l.trim());
      taskTitle = i === -1 ? '' : lines[i].trim();
      rest = i === -1 ? '' : lines.slice(i + 1).join('\n').trim();
    }
    if (!taskTitle) throw new CaptureError('Nach dem ! fehlt der Text der Aufgabe');

    const footer = `_Erfasst über ${SOURCES[source] ?? source} (Vault Cockpit)_`;
    const task = await zunder.createTask({ title: taskTitle, description: rest ? `${rest}\n\n${footer}` : footer });
    if (key) state.set(key, task);
    logger.info?.(`Capture (${source}) → Zunder ${task.ref ?? task.id}`);
    return { kind: 'task', ...task };
  }

  function toVault({ text, title, source, captureId, created }) {
    const noteTitle = cleanTitle(title) || deriveTitle(text) || 'Notiz';
    let r;
    try {
      r = capture.write({ title: noteTitle, text, source, captureId, created });
    } catch (err) {
      throw new CaptureError(err.message);
    }
    if (!r.duplicate) logger.info?.(`Capture (${source}) → ${r.path}`);
    return { kind: 'note', path: r.path, duplicate: Boolean(r.duplicate) };
  }

  return {
    /**
     * @param {object} input
     * @param {string} input.text      der erfasste Text; `!` vorne → Zunder-Aufgabe
     * @param {string} [input.title]   optionaler Titel, sonst die erste Zeile
     * @param {string} input.source    Herkunft (Schlüssel aus SOURCES)
     * @param {string} [input.captureId] macht das Anlegen idempotent
     * @param {Date}   [input.created] Zeitpunkt der Erfassung (Funke, Mail)
     * @param {boolean} [input.allowTask=true] `!` auswerten (Funke-Notizen: nein)
     */
    async route({ text, title = null, source, captureId = null, created = null, allowTask = true }) {
      if (!SOURCES[source]) throw new CaptureError(`Unbekannte Quelle "${source}"`);
      const body = String(text ?? '').trim();
      if (!body) throw new CaptureError('Text darf nicht leer sein');

      if (allowTask && body.startsWith('!')) {
        return toZunder({ text: body.slice(1).trim(), title, source, captureId });
      }
      return toVault({ text: body, title, source, captureId, created });
    },
  };
}
