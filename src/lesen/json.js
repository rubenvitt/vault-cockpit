/**
 * JSON des Bereichs Lesen für die native App (`/api/lesen/…`, mit Geräte-Token
 * oder Sitzung). Die Endpunkte stehen neben ihren HTML-Seiten (inbox.js,
 * stack.js, doc.js, highlights.js, review-page.js, folgen-page.js) und rechnen
 * mit denselben Funktionen; hier nur die gemeinsamen Formen. Felder in
 * camelCase, Zeiten als ISO-Text wie in der Datenbank.
 */

/** Art eines Dokuments als Wort (Eingang, Leseansicht). */
export const KIND_LABELS = { artikel: 'Artikel', newsletter: 'Newsletter', feed: 'Feed-Eintrag', pdf: 'PDF' };

/** Antwort einer Seite aus src/lesen/http.js als JSON, nie im Cache. */
export const jsonReply = (status, body) => ({ status, body: JSON.stringify(body), headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });

/** Felder eines Dokuments (ohne Inhalt, wie `store.list`). */
export const docJson = (d) => ({
  id: d.id,
  url: d.url,
  canonicalUrl: d.canonical_url ?? null,
  commentsUrl: d.comments_url ?? null,
  title: d.title ?? null,
  author: d.author ?? null,
  site: d.site ?? null,
  kind: d.kind,
  kindLabel: KIND_LABELS[d.kind] ?? d.kind,
  origin: d.origin ?? null,
  excerpt: d.excerpt ?? null,
  wordCount: d.word_count ?? 0,
  readingMinutes: d.reading_minutes ?? 0,
  status: d.status,
  previousStatus: d.previous_status ?? null,
  progress: d.progress ?? 0,
  scrollAnchor: Number(d.scroll_anchor) || 0,
  topics: d.topics ?? [],
  savedAt: d.saved_at,
  statusChangedAt: d.status_changed_at ?? null,
  readAt: d.read_at ?? null,
  archivedAt: d.archived_at ?? null,
  updatedAt: d.updated_at ?? null,
});

/** Felder einer Markierung; aus Listen (`listHighlights` ohne `docId`) samt Titel, Adresse, Quelle und Themen des Dokuments. */
export const highlightJson = (h) => ({
  id: h.id,
  docId: h.doc_id,
  quote: h.quote,
  prefix: h.prefix ?? '',
  suffix: h.suffix ?? '',
  startHint: h.start_hint ?? null,
  note: h.note ?? null,
  createdAt: h.created_at,
  updatedAt: h.updated_at ?? null,
  reviewBox: h.review_box ?? 0,
  reviewDue: h.review_due ?? null,
  reviewState: h.review_state ?? 'aktiv',
  ...('doc_title' in h || 'doc_url' in h ? { docTitle: h.doc_title ?? null, docUrl: h.doc_url ?? null, docSite: h.doc_site ?? null, docTopics: h.doc_topics ?? [] } : {}),
});

/** Gruppen der Feeds für die Chips „Alle · Gruppe · Ohne Feed“. */
export const groupsJson = (groups) => groups.map((g) => ({ id: g.id, name: g.name }));
