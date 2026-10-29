import { dot } from '../semantic/embedder.js';

/**
 * Wiedersehen (VCP-74), reine Funktionen: Planung nach Leitner und Häufungen
 * ähnlicher Markierungen. Seite und Aktionen in src/lesen/review-page.js.
 *
 * Leitner: Box 1..5 wartet 1, 3, 7, 21 und 60 Tage. Eine neue Markierung
 * liegt in Box 1 (die Tabelle zählt ab 0, beides heißt „neu“) und ist einen
 * Tag nach dem Anlegen fällig. Behalten rückt eine Box weiter, Box 5 bleibt
 * bei 60 Tagen. Losgelassene Markierungen sind nie mehr fällig.
 */

export const BOX_DAYS = [1, 3, 7, 21, 60];
export const MAX_BOX = BOX_DAYS.length;
/** Höchstens so viele Karten am Tag, der Rest kommt morgen. */
export const SESSION_LIMIT = 20;
const DAY_MS = 24 * 60 * 60 * 1000;

const boxOf = (h) => Math.min(MAX_BOX, Math.max(1, h.review_box ?? 0));

/** Fälligkeit als ISO-Text; ohne `review_due` einen Tag nach dem Anlegen. */
export const dueAt = (h) => h.review_due ?? new Date(Date.parse(h.created_at) + BOX_DAYS[0] * DAY_MS).toISOString();

export const isDue = (h, now) => h.review_state !== 'losgelassen' && Date.parse(dueAt(h)) <= now;

/** Fällige Markierungen, die am längsten fälligen zuerst. */
export const dueCards = (highlights, now) => highlights.filter((h) => isDue(h, now)).sort((a, b) => Date.parse(dueAt(a)) - Date.parse(dueAt(b)));

/** Patch für „Behalten“: eine Box weiter, fällig nach deren Abstand ab `now`. */
export function keep(h, now) {
  const box = Math.min(MAX_BOX, boxOf(h) + 1);
  return { review_box: box, review_due: new Date(now + BOX_DAYS[box - 1] * DAY_MS).toISOString(), review_state: 'aktiv' };
}

/** Patch für „Loslassen“: nur aus der Wiederholung, gelöscht wird nichts. */
export const letGo = () => ({ review_state: 'losgelassen' });

/**
 * Heute schon gesehen: seit `dayStart` entschieden (`reviewed_at`, VCP-85).
 * Ein Rückgängig löscht den Zeitpunkt und zählt die Karte damit nicht mehr.
 */
export const seenToday = (h, dayStart) => Boolean(h.reviewed_at) && h.reviewed_at >= dayStart;

/**
 * Häufungen ähnlicher Markierungen aus verschiedenen Dokumenten: Jede noch
 * freie Markierung sammelt die übrigen freien ein, deren Kosinus zu ihr
 * mindestens `threshold` ist und deren Dokument noch nicht in der Gruppe
 * steht. `vectors[i]` gehört zu `items[i]` und ist normiert (Skalarprodukt =
 * Kosinus). Liefert Gruppen (Arrays von Markierungen, mindestens zwei),
 * die größten und ähnlichsten zuerst.
 */
export function findClusters(items, vectors, { threshold = 0.75, maxSize = 5 } = {}) {
  const used = new Set();
  const groups = [];
  for (let i = 0; i < items.length; i += 1) {
    if (used.has(i)) continue;
    const docs = new Set([items[i].doc_id]);
    const members = [];
    const near = items
      .map((_, j) => ({ j, sim: dot(vectors[i], vectors[j]) }))
      .filter(({ j, sim }) => j !== i && !used.has(j) && sim >= threshold)
      .sort((a, b) => b.sim - a.sim);
    for (const { j, sim } of near) {
      if (members.length + 1 >= maxSize || docs.has(items[j].doc_id)) continue;
      docs.add(items[j].doc_id);
      members.push({ j, sim });
    }
    if (!members.length) continue;
    used.add(i);
    for (const { j } of members) used.add(j);
    const score = members.reduce((s, m) => s + m.sim, 0) / members.length;
    groups.push({ items: [items[i], ...members.map(({ j }) => items[j])], score });
  }
  return groups.sort((a, b) => b.items.length - a.items.length || b.score - a.score).map((g) => g.items);
}
