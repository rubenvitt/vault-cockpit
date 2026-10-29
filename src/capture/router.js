import { parseTaskLine, resolveTask, dueText, previewLine } from './syntax.js';
import { localDate, weekOf, weekId } from '../cockpit/week.js';

/**
 * Ein Eingang für alles, was von außen erfasst wird (Kurzbefehl, Sprachmemo,
 * Mail, Funke): Text mit `!` vorne wird eine Aufgabe in der Zunder-Inbox,
 * alles andere eine neue Notiz im Capture-Ordner des Vaults. Am Ende der
 * Titelzeile einer Aufgabe dürfen Fälligkeit, Ziel und `+woche` stehen
 * (`syntax.js`); dann legt Zunder sie gleich dort an.
 */

export const SOURCES = {
  'ios-kurzbefehl': 'iOS-Kurzbefehl',
  sprachmemo: 'Sprachmemo',
  mail: 'Mail',
  funke: 'Funke',
  api: 'Capture-Endpunkt',
  cockpit: 'Web-Cockpit',
};

const TITLE_MAX = 80;

/**
 * Erlaubte Erfassungs-IDs (`id` bei `/capture`, `cid` der Schnelleingabe im
 * Web-Cockpit, Funke, Mail): dieselbe Form wie `capture_id` im Frontmatter.
 */
export const CAPTURE_ID = /^[A-Za-z0-9_.:-]{1,128}$/;

export class CaptureError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
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

/**
 * Bereiche und Projekte aus Zunder, kurz zwischengespeichert je Client: Nicht
 * jede Erfassung soll `list_structure` aufrufen. Ein Fehler wird nicht
 * gemerkt, der nächste Versuch fragt wieder. Ein neuer Zugang in den
 * Einstellungen ist ein neuer Client und fragt ebenfalls neu.
 */
export function createStructureCache({ ttlMs = 60_000, now = () => Date.now() } = {}) {
  const cache = new WeakMap();
  return {
    async get(zunder) {
      const hit = cache.get(zunder);
      if (hit && now() - hit.at < ttlMs) return hit.areas;
      const areas = zunder.listStructure();
      cache.set(zunder, { at: now(), areas });
      try {
        return await areas;
      } catch (err) {
        if (cache.get(zunder)?.areas === areas) cache.delete(zunder);
        throw err;
      }
    },
  };
}

/** Gilt für alle Router, auch die, die das Web-Cockpit je Erfassung neu baut. */
const sharedStructure = createStructureCache();

/**
 * `zunder`: Client oder Funktion, die den aktuellen Client liefert (bzw. null).
 * Als Funktion wird sie bei jeder Aufgabe neu gefragt, damit ein in den
 * Einstellungen geänderter Zugang ohne Neustart gilt. `tz` (Text oder
 * Funktion) bestimmt, was „heute“ und die laufende Woche sind.
 */
export function createCaptureRouter({ capture, zunder = null, state, tz = 'Europe/Berlin', now = () => new Date(), structure = sharedStructure, logger = console }) {
  const currentZunder = typeof zunder === 'function' ? zunder : () => zunder;
  const currentTz = typeof tz === 'function' ? tz : () => tz;

  /** Titelzeile → Plan für `create_task`; die Struktur wird nur bei `#…` gebraucht. */
  async function plan(line, zunder) {
    const at = now();
    const zone = currentTz() || 'Europe/Berlin';
    const today = localDate(at, zone);
    const parsed = parseTaskLine(line, { today });
    let areas = null;
    let areasError = null;
    if (parsed.tags.length) {
      if (!zunder?.listStructure) areasError = 'Zunder ist nicht eingerichtet';
      else {
        try {
          areas = await structure.get(zunder);
        } catch (err) {
          logger.warn?.(`Capture: Bereiche aus Zunder nicht abrufbar: ${err.message}`);
        }
      }
    }
    const p = resolveTask(parsed, { fire: weekId(weekOf(at, zone)), areas, areasError });
    return { ...p, dueLabel: dueText(p.due, today) };
  }

  /** Erste nicht leere Zeile als Titel, der Rest als Beschreibung (oder ein ausdrücklicher Titel). */
  function split(text, title) {
    if (title && String(title).trim()) return { line: String(title).trim(), rest: text };
    const lines = text.split(/\r?\n/);
    const i = lines.findIndex((l) => l.trim());
    return i === -1 ? { line: '', rest: '' } : { line: lines[i].trim(), rest: lines.slice(i + 1).join('\n').trim() };
  }

  async function toZunder({ text, title, source, captureId }) {
    const zunder = currentZunder();
    if (!zunder) {
      throw new CaptureError('Weiterleitung an Zunder ist nicht eingerichtet (Cockpit → Einstellungen → Zunder)', 503);
    }
    const key = captureId ? `capture:${source}:${captureId}` : null;
    const known = key ? state.get(key) : null;
    if (known) return { kind: 'task', duplicate: true, ...known };

    const { line, rest } = split(text, title);
    if (!line) throw new CaptureError('Nach dem ! fehlt der Text der Aufgabe');
    const p = await plan(line, zunder);

    const footer = `_Erfasst über ${SOURCES[source] ?? source} (Vault Cockpit)_`;
    const created = await zunder.createTask({
      title: p.title,
      description: rest ? `${rest}\n\n${footer}` : footer,
      due: p.due,
      location: p.location ? { kind: p.location.kind, id: p.location.id } : null,
      phoenix: p.phoenix,
    });
    const task = { ...created, title: p.title, due: p.due, dueLabel: p.dueLabel, location: p.location ?? { kind: 'inbox' }, phoenix: p.phoenix, notes: p.notes };
    if (key) state.set(key, task);
    logger.info?.(`Capture (${source}) → Zunder ${task.ref ?? task.id}${p.location ? ` in ${p.location.name}` : ''}${p.due ? `, fällig ${p.due}` : ''}`);
    return { kind: 'task', ...task };
  }

  function toVault({ text, title, source, captureId, created }) {
    // Der Vault erkennt eine Wiederholung nur, solange die Notiz noch im
    // Capture-Ordner liegt. Der Merkzettel hält sie auch nach dem Ablegen
    // fest, wie bei Aufgaben (VCP-56).
    const key = captureId ? `capture-note:${source}:${captureId}` : null;
    const known = key ? state?.get(key) : null;
    if (known) return { kind: 'note', path: known.path, duplicate: true };

    // Ohne eigenen Titel heißt die Notiz nach Quelle und Zeitpunkt; der Text
    // gehört in den Inhalt, nicht in Dateiname oder Titel (ZUN-12).
    const noteTitle = cleanTitle(title) || null;
    let r;
    try {
      r = capture.write({ title: noteTitle, label: SOURCES[source], text, source, captureId, created });
    } catch (err) {
      throw new CaptureError(err.message);
    }
    if (key) state?.set(key, { path: r.path });
    if (!r.duplicate) logger.info?.(`Capture (${source}) → ${r.path}`);
    return { kind: 'note', path: r.path, duplicate: Boolean(r.duplicate) };
  }

  return {
    /**
     * Was beim Absenden entstünde, ohne etwas anzulegen: für die Vorschau unter
     * der Schnelleingabe. Notizen bleiben unverändert (`{ kind: 'note' }`).
     */
    async preview({ text }) {
      const body = String(text ?? '').trim();
      if (!body.startsWith('!')) return { kind: 'note', summary: 'Notiz' };
      const { line } = split(body.slice(1).trim(), null);
      if (!line) return { kind: 'task', title: '', due: null, dueLabel: '', location: null, phoenix: null, notes: [], summary: 'Aufgabe' };
      const p = await plan(line, currentZunder());
      return { kind: 'task', ...p, summary: previewLine(p) };
    },

    /**
     * @param {object} input
     * @param {string} input.text      der erfasste Text; `!` vorne → Zunder-Aufgabe
     * @param {string} [input.title]   optionaler Titel; Notizen ohne heißen nach Quelle und Zeit, Aufgaben nach der ersten Zeile
     * @param {string} input.source    Herkunft (Schlüssel aus SOURCES)
     * @param {string} [input.captureId] macht das Anlegen idempotent
     * @param {Date}   [input.created] Zeitpunkt der Erfassung (Funke, Mail)
     * @param {boolean} [input.allowTask=true] `!` auswerten (Funke-Notizen: nein)
     */
    async route({ text, title = null, source, captureId = null, created = null, allowTask = true }) {
      if (!SOURCES[source]) throw new CaptureError(`Unbekannte Quelle "${source}"`);
      // Gilt für Notizen und Aufgaben gleich, damit der Schlüssel im Merkzettel sauber bleibt.
      if (captureId !== null && !CAPTURE_ID.test(String(captureId))) {
        throw new CaptureError('Ungültige Capture-ID (Buchstaben, Ziffern und _ . : -, höchstens 128 Zeichen)');
      }
      const body = String(text ?? '').trim();
      if (!body) throw new CaptureError('Text darf nicht leer sein');

      if (allowTask && body.startsWith('!')) {
        return toZunder({ text: body.slice(1).trim(), title, source, captureId });
      }
      return toVault({ text: body, title, source, captureId, created });
    },
  };
}
