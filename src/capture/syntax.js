/**
 * Leichte Syntax für Aufgaben (`!Text`): Fälligkeit, Bereich oder Projekt und
 * Phönix-Schritt stehen gleich beim Erfassen dabei, statt hinterher in der
 * Zunder-Inbox nachgetragen zu werden.
 *
 *     !Zahnarzt anrufen morgen #gesundheit
 *     → „Zahnarzt anrufen“, fällig morgen, im Bereich Gesundheit
 *
 * Regel gegen Fehldeutungen: Erkannt wird nur am **Ende der Titelzeile**, von
 * hinten nach vorn, solange die Wörter Kürzel sind. Das erste Wort ist immer
 * Titel. Was mitten im Satz steht („Termin für morgen vorbereiten“), bleibt Text.
 * Ein Satzzeichen am Zeilenende („…anrufen morgen.“) stört nicht.
 *
 * - Fälligkeit: `heute`, `morgen` (klein; „Morgen“ ist auch der Morgen),
 *   `übermorgen`, ein Wochentag (`Freitag`: das nächste Vorkommen ab morgen,
 *   am Montag ist „Montag“ also in einer Woche), `14.10.` (dieses Jahr, liegt es
 *   schon zurück, nächstes) oder `14.10.2026`. Davor darf `bis` stehen, vor
 *   Wochentag und Datum auch `am`; beides fällt mit weg. Steht ein anderes
 *   Wort davor, das die Angabe zum Satzteil macht („für morgen“, „ab Montag“,
 *   „jeden Freitag“), bleibt sie Text. Zwei Fälligkeiten setzen keine.
 * - Ziel: `#gesundheit`, unscharf gegen die Bereiche und Projekte aus Zunder
 *   (`list_structure`). Passt ein Kürzel zu keinem oder zu mehreren Zielen,
 *   bleibt es im Titel und die Aufgabe in der Inbox; die Meldung sagt warum.
 * - `+woche`: Phönix-Schritt der laufenden ISO-Woche.
 *
 * Alles hier ist reine Logik ohne Zunder-Aufrufe; `router.js` holt die
 * Struktur und legt an.
 */

const WEEKDAYS = ['montag', 'dienstag', 'mittwoch', 'donnerstag', 'freitag', 'samstag', 'sonntag'];
const WEEKDAY_SHORT = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
const DAY_MS = 86_400_000;

/** Wörter, nach denen eine Datumsangabe Satzteil ist und Text bleibt. */
const BLOCKERS = new Set([
  'für', 'fuer', 'ab', 'seit', 'von', 'vom', 'nach', 'vor', 'zu', 'zum', 'zur', 'bis', 'am',
  'der', 'die', 'das', 'den', 'dem', 'des', 'ein', 'einen', 'jeden', 'jede', 'jedem', 'jeder',
  'nächsten', 'nächster', 'naechsten', 'kommenden', 'kommender', 'diesen', 'dieser', 'diesem',
  'letzten', 'letzter', 'guten',
]);

const pad = (n) => String(n).padStart(2, '0');
const utcDay = (date) => {
  const [y, m, d] = date.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
};
const isoDate = (ms) => new Date(ms).toISOString().slice(0, 10);

/** Gültiges Kalenderdatum als JJJJ-MM-TT, sonst null. */
function validDate(y, m, d) {
  const ms = Date.UTC(y, m - 1, d);
  const date = new Date(ms);
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return isoDate(ms);
}

/**
 * Ein Wort als Fälligkeit: `{ due, relative }`, `{ invalid }` bei einem
 * Datum, das es nicht gibt (`31.02.`), oder null, wenn es keine Angabe ist.
 */
export function dateToken(word, today) {
  const lower = word.toLowerCase();
  if (lower === 'heute') return { due: today, relative: true };
  if (word === 'morgen') return { due: isoDate(utcDay(today) + DAY_MS), relative: true };
  if (lower === 'übermorgen') return { due: isoDate(utcDay(today) + 2 * DAY_MS), relative: true };
  const wd = WEEKDAYS.indexOf(lower);
  if (wd !== -1) {
    const dow = (new Date(utcDay(today)).getUTCDay() + 6) % 7; // Mo = 0
    const ahead = ((wd - dow + 6) % 7) + 1; // 1 … 7: ab morgen
    return { due: isoDate(utcDay(today) + ahead * DAY_MS), relative: false };
  }
  const m = /^(\d{1,2})\.(\d{1,2})\.(\d{4}|\d{2})?$/.exec(word);
  if (!m) return null;
  const [d, mo] = [Number(m[1]), Number(m[2])];
  if (m[3]) {
    const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    const due = validDate(y, mo, d);
    return due ? { due, relative: false } : { invalid: true };
  }
  // Ohne Jahr: dieses Jahr, liegt der Tag schon zurück, das nächste (den 29.02. erst im nächsten Schaltjahr).
  const year = Number(today.slice(0, 4));
  for (let y = year; y <= year + 4; y++) {
    const due = validDate(y, mo, d);
    if (due && due >= today) return { due, relative: false };
  }
  return { invalid: true };
}

/** Kürzel für ein Ziel: `#` und mindestens ein Buchstabe (`#42` ist eine Nummer, kein Ziel). */
const TAG = /^#(?=[^#\s]*\p{L})[^#\s]+$/u;

/** Satzzeichen am Ende eines Wortes. */
const TRAILING = /[.,;:!?…]+$/u;

/** Ist das Wort ein Kürzel, das `parseTaskLine` am Zeilenende auswertet? */
const recognized = (w, today) => TAG.test(w) || w.toLowerCase() === '+woche' || dateToken(w, today) !== null;

/**
 * Zerlegt die Titelzeile einer Aufgabe. Liefert die Wörter, was am Ende
 * erkannt wurde (Fälligkeit, `+woche`, Ziel-Kürzel) und Hinweise. Ob ein
 * Kürzel zu einem Ziel passt, entscheidet erst `resolveTask`.
 */
export function parseTaskLine(line, { today }) {
  const words = String(line ?? '').trim().split(/\s+/).filter(Boolean);
  const removed = new Set();
  const tags = [];
  const notes = [];
  let date = null;
  let phoenix = false;

  for (let i = words.length - 1; i >= 1; i--) {
    let w = words[i];
    // Satzzeichen am Zeilenende („…morgen.“, häufig in Sprachmemos) zählen
    // nicht, außer sie gehören zur Angabe selbst (`14.10.`) (VCP-62).
    if (i === words.length - 1 && !recognized(w, today)) {
      const bare = w.replace(TRAILING, '');
      if (bare && bare !== w && recognized(bare, today)) w = bare;
    }
    if (TAG.test(w)) {
      tags.unshift({ index: i, token: w });
      continue;
    }
    if (w.toLowerCase() === '+woche') {
      phoenix = true;
      removed.add(i);
      continue;
    }
    const d = dateToken(w, today);
    if (!d) break;
    if (d.invalid) {
      notes.push(`${w} ist kein gültiges Datum.`);
      break;
    }
    const before = words[i - 1].toLowerCase();
    const prefix = i >= 2 && (before === 'bis' || (before === 'am' && !d.relative));
    if (!prefix && BLOCKERS.has(before)) break;
    if (date) {
      // Zwei Fälligkeiten („Freitag morgen“): nicht raten, beide bleiben Text.
      notes.push(`Zwei Fälligkeiten (${w}, ${date.word}), keine gesetzt.`);
      for (const k of date.indexes) removed.delete(k);
      date = null;
      break;
    }
    date = { due: d.due, word: w, indexes: prefix ? [i - 1, i] : [i] };
    for (const k of date.indexes) removed.add(k);
    if (prefix) i--;
  }
  return { words, removed, tags, notes, due: date?.due ?? null, phoenix };
}

/** Kleinbuchstaben, Umlaute ausgeschrieben, nur Buchstaben und Ziffern als Wörter. */
export function normalize(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** Abstand nach Damerau-Levenshtein (mit Vertauschung), für Tippfehler. */
function distance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

/** Erlaubte Tippfehler: ab 5 Zeichen einer, ab 9 zwei, darunter keiner. */
const tolerance = (q) => (q.length >= 9 ? 2 : q.length >= 5 ? 1 : 0);

/**
 * Ziele aus `list_structure`: aktive Bereiche und ihre aktiven Projekte, als
 * `{ kind, id, name, area_id?, area_name?, key? }` (wie `location` in Zunder).
 */
export function targetsOf(areas) {
  const out = [];
  for (const a of areas ?? []) {
    if (a.state === 'archived') continue;
    out.push({ kind: 'area', id: a.id, name: a.name });
    for (const p of a.projects ?? []) {
      if (p.status && p.status !== 'active') continue;
      out.push({ kind: 'project', id: p.id, name: p.name, area_id: a.id, area_name: a.name, key: p.key ?? null });
    }
  }
  return out;
}

/**
 * Sucht das Ziel zu einem Kürzel (ohne `#`), in Stufen: gleicher Name oder
 * Projektschlüssel, Anfang des Namens, Anfang eines Wortes im Namen, Name mit
 * Tippfehler. Es gilt die beste Stufe mit Treffern; hat sie genau einen,
 * ist das Ziel klar, sonst ist das Kürzel mehrdeutig.
 *
 * @returns {{ target } | { ambiguous: object[] } | { none: true }}
 */
export function matchTarget(query, targets) {
  const q = normalize(query).join('');
  if (!q) return { none: true };
  const levels = [[], [], [], []];
  for (const t of targets) {
    const words = normalize(t.name);
    const name = words.join('');
    if (q === name || (t.key && q === t.key.toLowerCase())) levels[0].push(t);
    else if (q.length >= 3 && name.startsWith(q)) levels[1].push(t);
    else if (q.length >= 3 && words.some((_, i) => i > 0 && words.slice(i).join('').startsWith(q))) levels[2].push(t);
    else if (tolerance(q) && [name, ...words].some((w) => Math.abs(w.length - q.length) <= tolerance(q) && distance(q, w) <= tolerance(q))) levels[3].push(t);
  }
  const best = levels.find((l) => l.length);
  if (!best) return { none: true };
  return best.length === 1 ? { target: best[0] } : { ambiguous: best };
}

/** Name eines Ziels für Meldungen: „Gesundheit“, „Ehrenamt / Gruppe I&K“. */
export const targetName = (t) => (t.kind === 'project' && t.area_name ? `${t.area_name} / ${t.name}` : t.name);

const listNames = (targets) => {
  const names = targets.slice(0, 3).map(targetName);
  return targets.length > 3 ? `${names.join(', ')} …` : names.join(', ');
};

/**
 * Löst die Kürzel einer zerlegten Zeile gegen die Struktur auf und baut den
 * Plan für `create_task`: `{ title, due, phoenix, location, notes }`.
 * `location` ist null für die Inbox. `areas` null heißt: Struktur nicht
 * abrufbar (`areasError` sagt dann warum), alle Kürzel bleiben Text.
 */
export function resolveTask(parsed, { fire, areas = null, areasError = null }) {
  const removed = new Set(parsed.removed);
  const notes = [...parsed.notes];
  const found = [];
  if (parsed.tags.length && !areas) {
    notes.push(`${areasError ?? 'Bereiche und Projekte aus Zunder sind gerade nicht abrufbar'}, ${parsed.tags.map((t) => t.token).join(' ')} bleibt im Titel.`);
  } else if (parsed.tags.length) {
    const targets = targetsOf(areas);
    for (const tag of parsed.tags) {
      const m = matchTarget(tag.token.slice(1), targets);
      if (m.target) found.push({ tag, target: m.target });
      else if (m.ambiguous) notes.push(`${tag.token} passt zu mehreren Zielen (${listNames(m.ambiguous)}).`);
      else notes.push(`${tag.token} passt zu keinem Bereich und keinem Projekt.`);
    }
  }

  // Mehrere Kürzel: gleiches Ziel oder Bereich plus eines seiner Projekte ist
  // eindeutig (das Projekt gilt), alles andere ein Widerspruch.
  let location = null;
  const distinct = [...new Map(found.map((f) => [`${f.target.kind}:${f.target.id}`, f.target])).values()];
  const projects = distinct.filter((t) => t.kind === 'project');
  if (distinct.length === 1) location = distinct[0];
  else if (projects.length === 1 && distinct.every((t) => t === projects[0] || (t.kind === 'area' && t.id === projects[0].area_id))) location = projects[0];
  else if (distinct.length > 1) notes.push(`${found.map((f) => f.tag.token).join(' und ')} zeigen auf verschiedene Ziele.`);
  if (location) for (const f of found) removed.add(f.tag.index);

  const title = parsed.words.filter((_, i) => !removed.has(i)).join(' ');
  return {
    title,
    due: parsed.due,
    phoenix: parsed.phoenix ? { role: 'feuer_schritt', fire } : null,
    location: location ? { kind: location.kind, id: location.id, name: location.name, ...(location.area_name ? { area_name: location.area_name } : {}) } : null,
    notes,
  };
}

/** Fälligkeit für Meldungen, bezogen auf heute: „heute“, „morgen“, „Fr 23.10.“, „Do 14.10.2027“. */
export function dueText(due, today) {
  if (!due) return '';
  const days = Math.round((utcDay(due) - utcDay(today)) / DAY_MS);
  if (days === 0) return 'heute';
  if (days === 1) return 'morgen';
  const [y, m, d] = due.split('-').map(Number);
  const label = `${WEEKDAY_SHORT[new Date(utcDay(due)).getUTCDay()]} ${pad(d)}.${pad(m)}.`;
  return y === Number(today.slice(0, 4)) ? label : `${label}${y}`;
}

const phoenixText = (p) => (p?.fire ? `Phönix-Schritt KW ${Number(p.fire.slice(6))}` : '');

/** Wo die Aufgabe liegt und was gesetzt ist, als Satzteil: „liegt in Gesundheit, fällig morgen“. */
export function placement(r) {
  const place = r.location && r.location.kind !== 'inbox' ? targetName(r.location) : 'der Zunder-Inbox';
  return [`liegt in ${place}`, r.dueLabel ? `fällig ${r.dueLabel}` : '', phoenixText(r.phoenix)].filter(Boolean).join(', ');
}

/** Vorschau unter der Schnelleingabe: „Aufgabe · morgen · Gesundheit“. */
export function previewLine(r) {
  const place = r.location && r.location.kind !== 'inbox' ? targetName(r.location) : 'Inbox';
  return ['Aufgabe', r.dueLabel, place, phoenixText(r.phoenix)].filter(Boolean).join(' · ');
}

/**
 * `> https://…` (genau eine http(s)-Adresse nach `>`, sonst nichts) ist ein
 * Artikel für den Lesestapel; liefert die Adresse, sonst null. Ein Markdown-Zitat
 * wie `> Ein kluger Satz` bleibt eine Notiz.
 */
export function articleUrl(text) {
  return /^\s*>\s*(https?:\/\/\S+)\s*$/i.exec(String(text ?? ''))?.[1] ?? null;
}
