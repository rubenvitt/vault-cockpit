import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Die iOS-Kurzbefehle, die das Cockpit unter /kurzbefehle/… zum Laden anbietet. */
export const SHORTCUTS = [
  {
    slug: 'notiz',
    title: 'Notiz ins Cockpit',
    text: 'Text aus dem Teilen-Menü oder abgefragt. Mit ! vorne wird es eine Aufgabe in der Zunder-Inbox.',
  },
  {
    slug: 'sprachmemo',
    title: 'Sprachmemo ins Cockpit',
    text: 'Nimmt auf, transkribiert auf dem iPhone und legt den Text als Notiz ab.',
  },
];

/**
 * Lädt die signierten `.shortcut`-Dateien aus `dir` (Standard: `assets/kurzbefehle`
 * im Repo). Fehlt eine Datei, fehlt nur dieser Eintrag.
 */
export function loadShortcuts(dir = new URL('../../assets/kurzbefehle/', import.meta.url).pathname) {
  return SHORTCUTS.flatMap((s) => {
    try {
      return [{ ...s, file: `${s.title}.shortcut`, data: readFileSync(join(dir, `${s.title}.shortcut`)) }];
    } catch {
      return [];
    }
  });
}
