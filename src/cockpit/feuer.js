/**
 * Phönix-Wochenziel aus dem Vault.
 *
 * Jede Woche hat eine Notiz vom Typ `1-wochen-feuer` mit `zeitraum`
 * („12.10.2026 – 18.10.2026“) im Frontmatter und einem Abschnitt
 * „## Feuer-Ziel“. Das Cockpit zeigt dessen ersten Absatz; gepflegt wird die
 * Notiz weiter in Obsidian.
 */

export const FEUER_TYPE = '1-wochen-feuer';

/** Erstes Datum aus `zeitraum` als JJJJ-MM-TT, sonst null. */
function zeitraumStart(value) {
  const m = /(\d{1,2})\.(\d{1,2})\.(\d{4})/.exec(String(value ?? ''));
  if (!m) return null;
  return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
}

/** Erster Absatz unter einer Überschrift `## <name>`. */
export function sectionParagraph(content, name) {
  const lines = String(content ?? '').split(/\r?\n/);
  const start = lines.findIndex((l) => new RegExp(`^##\\s+${name}\\s*$`, 'i').test(l.trim()));
  if (start === -1) return null;
  const para = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,6}\s/.test(line)) break;
    if (!line.trim()) {
      if (para.length) break;
      continue;
    }
    para.push(line.trim());
  }
  return para.length ? para.join(' ') : null;
}

/**
 * Die Feuer-Notiz der Woche: die, deren `zeitraum` am Montag beginnt. Für die
 * laufende Woche zählt ersatzweise die Notiz mit `status: aktiv`.
 */
export function findFeuer(index, week, { current = false } = {}) {
  const notes = index.notesOfType(FEUER_TYPE);
  const note =
    notes.find((n) => zeitraumStart(n.frontmatter.zeitraum) === week.monday) ??
    (current ? notes.find((n) => String(n.status ?? '').toLowerCase() === 'aktiv') : null);
  if (!note) return null;
  const full = index.getNote(note.path);
  const fm = note.frontmatter;
  return {
    path: note.path,
    title: note.title ?? note.path.split('/').pop().replace(/\.md$/i, ''),
    status: note.status ?? null,
    zeitraum: typeof fm.zeitraum === 'string' ? fm.zeitraum : null,
    alignment: typeof fm.alignment === 'string' ? fm.alignment : null,
    goal: sectionParagraph(full?.content, 'Feuer-Ziel'),
    firstMove: sectionParagraph(full?.content, 'Erster Zug'),
  };
}
