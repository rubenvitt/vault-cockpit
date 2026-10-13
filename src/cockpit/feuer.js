/**
 * Phönix-Wochenziel aus dem Vault.
 *
 * Jede Woche hat eine Notiz vom Typ `1-wochen-feuer` mit `zeitraum`
 * („12.10.2026 – 18.10.2026“) im Frontmatter und einem Abschnitt
 * „## Feuer-Ziel“. Das Cockpit zeigt dessen ersten Absatz; gepflegt wird die
 * Notiz weiter in Obsidian. Fehlt die Notiz einer Woche, legt `planFeuer` sie
 * nach dem Muster der letzten Feuer-Notiz an (gleicher Ordner und Feuersturm).
 */

export const FEUER_TYPE = '1-wochen-feuer';

/** Erstes Datum aus `zeitraum` als JJJJ-MM-TT, sonst null. */
export function zeitraumStart(value) {
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

const FEUERSTURM_WEEKS = 12;
const DAY_NAMES = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
const DAY_MS = 86_400_000;

const dmy = (iso) => iso.split('-').reverse().join('.');
const dm = (iso) => dmy(iso).slice(0, 6);
const plusDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

/** Ein Absatz für die Notiz: Zeilenumbrüche werden zu Leerzeichen. */
const oneParagraph = (text) => String(text ?? '').replace(/\s*\r?\n\s*/g, ' ').trim();

/**
 * Neue Feuer-Notiz für eine Woche, nach dem Muster der letzten Feuer-Notiz
 * davor: gleicher Ordner, gleicher Feuersturm, Wochennummer und Dateiname
 * weitergezählt („Feuer W3 - 2026-Q4“ → „Feuer W4 - 2026-Q4“). Struktur wie in
 * der Feuer-Planung (Feuer-Ziel, Erster Zug, Tägliche Schritte, Flammen,
 * Notizen, Daily Notes); Alignment, Schritte und Flammen bleiben der Planung
 * in Obsidian überlassen.
 *
 * Wirft mit deutscher Meldung, wenn es kein Muster gibt oder der Feuersturm
 * mit dieser Woche vorbei wäre (dann gehört ein neuer Feuersturm geplant).
 */
export function planFeuer(index, week, { goal, firstMove = '' }) {
  const before = index
    .notesOfType(FEUER_TYPE)
    .map((n) => ({ ...n, start: zeitraumStart(n.frontmatter.zeitraum) }))
    .filter((n) => n.start && n.start < week.monday)
    .sort((a, b) => b.start.localeCompare(a.start));
  const last = before[0];
  if (!last) throw new Error('Es gibt noch keine Feuer-Notiz, nach deren Muster das Cockpit eine neue anlegen könnte. Die erste bitte in Obsidian planen.');

  const name = last.path.split('/').pop();
  const lastNo = Number(/^W(\d+)$/i.exec(String(last.frontmatter.woche ?? ''))?.[1] ?? /\bW(\d+)\b/.exec(name)?.[1]);
  if (!lastNo || !/\bW\d+\b/.test(name)) throw new Error(`„${name}“ hat keine Wochennummer (W1 …); danach kann das Cockpit keine neue Feuer-Notiz benennen.`);
  const number = lastNo + Math.round((Date.parse(week.monday) - Date.parse(last.start)) / (7 * DAY_MS));
  if (number > FEUERSTURM_WEEKS) {
    throw new Error(`Mit dieser Woche wäre es W${number}, der Feuersturm hat nur ${FEUERSTURM_WEEKS} Wochen. Den nächsten Feuersturm bitte in Obsidian planen.`);
  }

  const folder = last.path.includes('/') ? last.path.slice(0, last.path.lastIndexOf('/')) : '';
  const fileName = name.replace(/\bW\d+\b/, `W${number}`);
  const title = fileName.replace(/\.md$/i, '');
  const feuersturm = typeof last.frontmatter.feuersturm === 'string' ? last.frontmatter.feuersturm : null;
  const zeitraum = `${dmy(week.monday)} – ${dmy(week.sunday)}`;
  const days = DAY_NAMES.map((d, i) => `| ${d} ${dm(plusDays(week.monday, i))} | – | 🔲 |`);

  const content = [
    '---',
    `type: ${FEUER_TYPE}`,
    ...(feuersturm ? [`feuersturm: ${JSON.stringify(feuersturm)}`] : []),
    `woche: W${number}`,
    `zeitraum: "${zeitraum}"`,
    'status: aktiv',
    'tags:',
    '  - phönix-progression',
    `  - ${FEUER_TYPE}`,
    '---',
    '',
    `# ${title}`,
    '',
    `> ${feuersturm ? `Feuersturm: ${feuersturm} · ` : ''}Woche **${number}/${FEUERSTURM_WEEKS}** · ${dm(week.monday)} – ${dmy(week.sunday)}`,
    '> Im Cockpit angelegt.',
    '',
    '## Feuer-Ziel',
    '',
    oneParagraph(goal),
    '',
    '## Erster Zug',
    '',
    ...(oneParagraph(firstMove) ? [oneParagraph(firstMove), ''] : []),
    '## Tägliche Schritte',
    '',
    '| Tag | Schritt | Status |',
    '|-----|---------|--------|',
    ...days,
    '',
    '## Flammen',
    '',
    '| # | Tag | Uhrzeit | Thema | Status |',
    '|---|-----|---------|-------|--------|',
    '',
    '## Notizen',
    '',
    '## Daily Notes',
    '',
    '→ `/feuer-review`',
    '',
  ].join('\n');

  return { folder, name: fileName, title, number, content };
}
