import { readFileSync, realpathSync } from 'node:fs';
import { join, sep } from 'node:path';
import { createHash } from 'node:crypto';

/**
 * Generierte Bereiche in Vault-Notizen: Text, den das Cockpit selbst schreibt,
 * zwischen zwei Kommentar-Markern mit Prüfsumme (zuerst für die Flammen in der
 * Feuer-Notiz, VCP-52; dann für den Lesestapel, VCP-75):
 *
 *   <!-- cockpit:<name>:start · <Hinweis> -->
 *   …
 *   <!-- cockpit:<name>:ende 1a2b3c4d -->
 *
 * Der Endmarker trägt eine Prüfsumme des Inhalts. Passt sie nicht mehr, hat
 * jemand im Bereich von Hand geschrieben; dann bleibt die Notiz unberührt, bis
 * der Bereich zwischen den Markern geleert wird. Fehlen die Marker, kommt der
 * Bereich ans Ende der Notiz oder ans Ende eines Abschnitts `## <heading>`;
 * fehlt der Abschnitt, wird er mit `createHeading` am Ende angelegt.
 * Geschrieben wird über den Editor und nur, wenn sich der Inhalt ändert;
 * ändert der Sync die Notiz gleichzeitig, wirft der Editor, und der Aufrufer
 * versucht es später wieder.
 */

const NAME = /^[a-z0-9-]{1,40}$/;

export const sectionChecksum = (text) => createHash('sha256').update(text).digest('hex').slice(0, 8);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function markers(name) {
  if (!NAME.test(name)) throw new Error(`„${name}“ ist kein gültiger Name für einen Bereich`);
  return {
    start: new RegExp(`^[ \\t]*<!--\\s*cockpit:${name}:start\\b.*$`, 'gm'),
    end: new RegExp(`^[ \\t]*<!--\\s*cockpit:${name}:ende\\b(?:[ \\t]+([0-9a-f]{8}))?.*$`, 'gm'),
  };
}

/**
 * Der ganze Bereich mit Markern; `label` steht im Startmarker, `eol` wie in der
 * Notiz. `spaced` setzt Leerzeilen innen an die Marker (Markdown-Blöcke wie
 * Zitate oder Block-IDs kleben dann nicht am Kommentar).
 */
export function sectionBlock(name, inner, { label = null, eol = '\n', spaced = false } = {}) {
  markers(name);
  const text = String(inner).replace(/\r\n/g, '\n').trim();
  const body = spaced ? `\n${text}\n` : text;
  return [`<!-- cockpit:${name}:start${label ? ` · ${label}` : ''} -->`, body, `<!-- cockpit:${name}:ende ${sectionChecksum(text)} -->`].join('\n').replaceAll('\n', eol);
}

/**
 * Bereich `name` in `content` suchen: `null` ohne Marker, sonst
 * `{ from, to, inner, edited }` (`inner` ohne Marker, getrimmt, mit `\n`;
 * `edited`, wenn die Prüfsumme nicht passt) oder `{ broken: true }`, wenn
 * Marker fehlen, doppelt oder verkehrt herum stehen.
 */
export function findSection(content, name) {
  const { start, end } = markers(name);
  const starts = [...content.matchAll(start)];
  const ends = [...content.matchAll(end)];
  if (!starts.length && !ends.length) return null;
  if (starts.length !== 1 || ends.length !== 1 || ends[0].index < starts[0].index) return { broken: true };
  const inner = content.slice(starts[0].index + starts[0][0].length, ends[0].index).replace(/\r\n/g, '\n').trim();
  return { from: starts[0].index, to: ends[0].index + ends[0][0].length, inner, edited: Boolean(inner) && ends[0][1] !== sectionChecksum(inner) };
}

/**
 * Was mit der Notiz zu tun ist, damit der Bereich `inner` enthält:
 * `{ action: 'keep' }`, `{ action: 'replace', oldText, newText }`,
 * `{ action: 'insert', text, heading }` (für `editor.append`; `heading` null =
 * ans Ende der Notiz) oder `{ action: 'skip', reason }`. `create: false` legt
 * keine neuen Marker an.
 */
export function planSection(content, name, inner, { label = null, spaced = false, heading = null, createHeading = false, create = true } = {}) {
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const text = String(inner).replace(/\r\n/g, '\n').trim();
  const found = findSection(content, name);
  if (!found) {
    if (!create) return { action: 'keep' };
    const block = sectionBlock(name, text, { label, eol, spaced });
    if (!heading) return { action: 'insert', text: `${eol}${block}`, heading: null };
    if (new RegExp(`^##[ \\t]+${escapeRe(heading)}[ \\t]*#*[ \\t]*$`, 'm').test(content)) {
      // Leerzeile davor, damit der Kommentar nicht an einer Tabelle oder Liste klebt.
      return { action: 'insert', text: `${eol}${block}`, heading };
    }
    if (createHeading) return { action: 'insert', text: `${eol}## ${heading}${eol}${eol}${block}`, heading: null };
    return { action: 'skip', reason: `Die Notiz hat keinen Abschnitt „## ${heading}“` };
  }
  if (found.broken) return { action: 'skip', reason: `Die Marker des Bereichs „${name}“ fehlen zur Hälfte oder stehen doppelt; bitte in Obsidian aufräumen` };
  if (found.edited) {
    return { action: 'skip', reason: `Im Bereich „${name}“ wurde von Hand geschrieben; das Cockpit lässt ihn stehen (zum Neuschreiben den Bereich zwischen den Markern leeren)` };
  }
  if (found.inner === text) return { action: 'keep' };
  return { action: 'replace', oldText: content.slice(found.from, found.to), newText: sectionBlock(name, text, { label, eol, spaced }) };
}

/**
 * Bereich in die Notiz `path` schreiben: frisch lesen, planen, über den Editor
 * ändern. Liefert `{ state: 'aktuell' | 'geschrieben' | 'übersprungen', reason? }`;
 * Fehler des Editors (Notiz gesperrt, gleichzeitig vom Sync geändert) wirft er
 * weiter. Optionen wie bei `planSection`.
 */
export function writeSection({ vaultPath, editor, path, name, inner, ...options }) {
  const absolute = join(vaultPath, path);
  if (!realpathSync(absolute).startsWith(realpathSync(vaultPath) + sep)) throw new Error(`„${path}“ zeigt aus dem Vault heraus`);
  const plan = planSection(readFileSync(absolute, 'utf8'), name, inner, options);
  if (plan.action === 'keep') return { state: 'aktuell' };
  if (plan.action === 'skip') return { state: 'übersprungen', reason: plan.reason };
  if (plan.action === 'replace') editor.replace({ path, oldText: plan.oldText, newText: plan.newText });
  else editor.append({ path, heading: plan.heading, text: plan.text });
  return { state: 'geschrieben' };
}
