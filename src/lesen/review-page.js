import { randomUUID, createHash } from 'node:crypto';
import { ActionError } from '../cockpit/actions.js';
import { describeWeek, parseWeekId, weekOf } from '../cockpit/week.js';
import { esc, assets } from '../web/layout.js';
import { hidden } from '../web/render.js';
import { readingPage } from './pages.js';
import { dayStart } from './inbox.js';
import { docLink } from './doc.js';
import { inboxText, noteTitle } from './highlights.js';
import { REVIEW_STATES } from './store.js';
import { createEmbedCache } from './embed-cache.js';
import { MAX_BOX, SESSION_LIMIT, dueAt, dueCards, findClusters, isDue, keep, letGo, seenToday } from './review.js';
import { highlightJson, jsonReply } from './json.js';

/**
 * Wiedersehen (VCP-74): fällige Markierungen nacheinander, je Karte Behalten,
 * In eigenen Worten oder Loslassen; darunter die Woche mit Themen-Balken,
 * „Querverbindung entdeckt“ und Export als Markdown. Ohne JavaScript Formulare
 * mit Weiterleitung, mit JavaScript schickt `/static/cockpit.js` sie als JSON
 * (Formular `.act`, Rückgängig in der Meldung), `/static/lesen-eingang.js`
 * macht wie im Eingang Wischen und Tasten daraus (← Loslassen, → Behalten,
 * W eigene Worte, Z rückgängig).
 *
 * Jede Entscheidung merkt sich den Stand davor (`review_prev`) und ihren
 * Zeitpunkt (`reviewed_at`); die letzte von heute lässt sich wie im Eingang
 * dauerhaft über „Rückgängig“ auf der Seite zurücknehmen (VCP-85). Eine Notiz,
 * die „In eigenen Worten“ in die Inbox gelegt hat, bleibt dabei liegen, und
 * die Meldung sagt das.
 *
 * Formularfelder:
 * - `/aktion/lesen/wiedersehen`: `id`, `ziel` (`behalten|worte|loslassen`), bei `worte` dazu `worte`, `cid`
 * - `/aktion/lesen/wiedersehen/zurueck`: `id`; ältere Clients schicken `box`, `faellig`, `zustand` mit (gilt nur ohne gemerkten Stand)
 * - `/aktion/lesen/wiedersehen/verbindung`: `ids` (Markierungen, durch Komma getrennt)
 *
 * `/api/lesen/wiedersehen?woche=` liefert die Karten von heute und die Woche
 * als JSON, `/api/lesen/wiedersehen.md?woche=` den Export für die App.
 */

const REVIEW = '/aktion/lesen/wiedersehen';
const UNDO = '/aktion/lesen/wiedersehen/zurueck';
const LINK = '/aktion/lesen/wiedersehen/verbindung';
const MAX_WORDS = 4000;
/** shortcut: Schwelle für bge-m3 geschätzt, nicht an echten Markierungen gemessen; bei zu vielen oder zu wenigen Treffern nachjustieren. */
const CLUSTER_THRESHOLD = 0.75;
/** shortcut: höchstens so viele Markierungen einer Woche fürs Clustering (O(n²)); reicht für eine normale Woche. */
const CLUSTER_MAX_ITEMS = 200;

const name = (h) => h.doc_title || h.doc_url;
/** Gemerkter Stand vor der letzten Entscheidung oder null. */
const prevOf = (h) => {
  try {
    return h.review_prev ? JSON.parse(h.review_prev) : null;
  } catch {
    return null;
  }
};
const shortQuote = (q) => {
  const t = String(q).replace(/\s+/g, ' ').trim();
  return t.length > 60 ? `${t.slice(0, 59).trimEnd()}…` : t;
};
const dateLabel = (iso, tz) => new Date(iso).toLocaleDateString('de-DE', { day: 'numeric', month: 'numeric', timeZone: tz });

/** Woche aus `?woche=2026-W43`, sonst die aktuelle. */
const weekFrom = (url, now, tz) => describeWeek(parseWeekId(url.searchParams.get('woche')) ?? weekOf(new Date(now), tz), tz);
const inWeek = (h, w) => h.created_at >= w.start.toISOString() && h.created_at < w.end.toISOString();

/** Anzahl Markierungen je Thema; ohne Thema zählt die Quelle. Größte zuerst. */
export function topicCounts(items) {
  const counts = new Map();
  for (const h of items) for (const t of h.doc_topics?.length ? h.doc_topics : [h.doc_site || 'ohne Quelle']) counts.set(t, (counts.get(t) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'de')).map(([label, count]) => ({ label, count }));
}

/** Markdown der Woche: je Dokument die Zitate in der Reihenfolge des Markierens, Notizen darunter. */
export function weekMarkdown(items, w) {
  const byDoc = new Map();
  for (const h of [...items].sort((a, b) => a.created_at.localeCompare(b.created_at))) byDoc.set(h.doc_id, [...(byDoc.get(h.doc_id) ?? []), h]);
  const range = `${w.monday.split('-').reverse().join('.')} – ${w.sunday.split('-').reverse().join('.')}`;
  const sections = [...byDoc.values()].map((hs) => {
    const title = String(name(hs[0])).replace(/[[\]]/g, '');
    const head = /^https?:\/\//i.test(hs[0].doc_url ?? '') ? `## [${title}](${hs[0].doc_url})` : `## ${title}`;
    const quotes = hs.map((h) => [String(h.quote).trim().split(/\r?\n/).map((l) => `> ${l}`.trimEnd()).join('\n'), h.note].filter(Boolean).join('\n\n'));
    return [head, ...quotes].join('\n\n');
  });
  return `# Markierungen KW ${w.week} (${range})\n\n${sections.length ? sections.join('\n\n') : 'Keine Markierungen in dieser Woche.'}\n`;
}

/** Box 1..5 für die Anzeige („Box b von 5“); neue zählen als Box 1. */
const boxLabel = (h) => Math.min(MAX_BOX, Math.max(1, h.review_box));

/** Zahlen der Woche: Markierungen, Texte, Themen (je Thema, sonst Quelle). */
function weekStats(items) {
  const topics = topicCounts(items);
  return { topics, docs: new Set(items.map((h) => h.doc_id)).size };
}

/** „Rückgängig“ der letzten Entscheidung von heute, wie im Eingang (Taste Z). */
function renderUndo(last, ctx) {
  if (!last) return '';
  const label = `Rückgängig<span class="sr-only">: ${esc(shortQuote(last.quote))}</span>`;
  return `<div class="inbox-row"><form method="post" action="${UNDO}" class="act inbox-undo">${hidden({ csrf: ctx.write.csrf, back: ctx.write.back, id: last.id })}<button type="submit" class="btn quiet" aria-keyshortcuts="z"><span aria-hidden="true">↶</span> ${label} <kbd aria-hidden="true">Z</kbd></button></form></div>`;
}

function renderCard(h, ctx, { canCapture, undo = '' }) {
  const write = { csrf: ctx.write.csrf, back: ctx.write.back };
  const meta = [`<a href="${esc(`${docLink(h.doc_id)}#h-${h.id}`)}">${esc(name(h))}</a>`, h.doc_site ? esc(h.doc_site) : null, `Box ${boxLabel(h)} von ${MAX_BOX}`].filter(Boolean).join(' · ');
  const words = canCapture
    ? `<details class="wiedersehen-worte"><summary aria-keyshortcuts="w">In eigenen Worten <kbd aria-hidden="true">W</kbd></summary>
      <form method="post" action="${REVIEW}" class="act">${hidden({ ...write, id: h.id, ziel: 'worte', cid: randomUUID() })}
        <label><span class="sr-only">In eigenen Worten</span><textarea name="worte" rows="4" maxlength="${MAX_WORDS}" required placeholder="Was heißt das für mich?"></textarea></label>
        <button type="submit" class="btn">In die Inbox und weiter</button>
      </form>
    </details>`
    : '';
  return `<article class="inbox-card wiedersehen-card" data-id="${esc(h.id)}">
    <p class="inbox-meta">${meta}</p>
    <blockquote class="lesen-quote">${esc(h.quote)}</blockquote>
    ${h.note ? `<p class="wiedersehen-note">${esc(h.note)}</p>` : ''}
  </article>
  <div class="wiedersehen-actions">
    ${undo}
    <form method="post" action="${REVIEW}" class="act wiedersehen-decide wisch" data-links="loslassen" data-rechts="behalten">${hidden({ ...write, id: h.id })}
      <button type="submit" name="ziel" value="loslassen" class="btn" aria-keyshortcuts="ArrowLeft l"><span aria-hidden="true">←</span> Loslassen <kbd aria-hidden="true">L</kbd></button>
      <button type="submit" name="ziel" value="behalten" class="btn primary" aria-keyshortcuts="ArrowRight Enter b">Behalten <span aria-hidden="true">→</span> <kbd aria-hidden="true">↵</kbd></button>
    </form>
    ${words}
  </div>`;
}

function renderWeek({ w, items, clusters }, ctx, { canCapture }) {
  const { topics, docs } = weekStats(items);
  const max = topics[0]?.count ?? 0;
  const pager = `<nav class="pager" aria-label="Wochen">
    <a href="/lesen/wiedersehen?woche=${esc(w.prev)}" rel="prev" aria-label="Vorige Woche, KW ${Number(w.prev.slice(6))}"><span aria-hidden="true">‹</span> KW ${Number(w.prev.slice(6))}</a>
    <span class="pager-now">KW ${w.week}</span>
    <a href="/lesen/wiedersehen?woche=${esc(w.next)}" rel="next" aria-label="Nächste Woche, KW ${Number(w.next.slice(6))}">KW ${Number(w.next.slice(6))} <span aria-hidden="true">›</span></a>
  </nav>`;
  const bars = topics.length
    ? `<ul class="wiedersehen-topics">${topics
        .map((t) => `<li><span class="wiedersehen-topic">${esc(t.label)}</span><progress max="${max}" value="${t.count}">${t.count}</progress><span class="meta">${t.count}</span></li>`)
        .join('')}</ul>`
    : '<p class="empty">In dieser Woche ist nichts markiert.</p>';
  const link = clusters.length
    ? clusters
        .map(
          (group) => `<aside class="wiedersehen-link">
    <h3>Querverbindung entdeckt</h3>
    <ul>${group.map((h) => `<li><blockquote class="lesen-quote">${esc(h.quote)}</blockquote><span class="meta"><a href="${esc(`${docLink(h.doc_id)}#h-${h.id}`)}">${esc(name(h))}</a>${h.doc_topics.length ? ` · ${h.doc_topics.map(esc).join(', ')}` : ''}</span></li>`).join('')}</ul>
    ${canCapture ? `<form method="post" action="${LINK}" class="act">${hidden({ csrf: ctx.write.csrf, back: ctx.write.back, ids: group.map((h) => h.id).join(',') })}<button type="submit" class="btn">Als eigene Notiz anlegen</button></form>` : ''}
  </aside>`,
        )
        .join('')
    : '';
  return `<section class="wiedersehen-week">
  <div class="wiedersehen-week-head"><h2>Die Woche <span class="meta">${esc(dateLabel(w.start, ctx.tz))} – ${esc(dateLabel(w.days[6].start, ctx.tz))}</span></h2>${pager}</div>
  <div class="stats">
    <div class="stat"><span class="stat-value">${items.length}</span><span class="stat-label">${items.length === 1 ? 'Markierung' : 'Markierungen'}</span></div>
    <div class="stat"><span class="stat-value">${docs}</span><span class="stat-label">${docs === 1 ? 'Text' : 'Texte'}</span></div>
    <div class="stat"><span class="stat-value">${topics.length}</span><span class="stat-label">Themen und Quellen</span></div>
  </div>
  ${bars}
  ${link}
  ${items.length ? `<p><a href="/lesen/wiedersehen.md?woche=${esc(w.id)}" class="btn quiet" download="markierungen-${esc(w.id)}.md">Als Markdown exportieren</a></p>` : ''}
</section>`;
}

export function renderReviewPage(model, ctx, opts) {
  const { card, seen, left, later } = model;
  const total = seen + left;
  const progress = total
    ? `<div class="inbox-progress"><progress max="${total}" value="${seen}">${seen} von ${total}</progress><span class="meta">Heute ${seen} von ${total} gesehen${later ? ` · ${later} weitere morgen` : ''}</span></div>`
    : '';
  const empty = later
    ? `<div class="inbox-empty"><p class="inbox-empty-title">Für heute reicht es</p><p class="meta">${later} ${later === 1 ? 'Markierung kommt' : 'Markierungen kommen'} morgen dran.</p></div>`
    : '<div class="inbox-empty"><p class="inbox-empty-title">Nichts fällig</p><p class="meta">Neue Markierungen kommen einen Tag später wieder. <a href="/lesen/markiert">Alle Markierungen</a></p></div>';
  const undo = renderUndo(model.last, ctx);
  const body = `<div class="inbox wiedersehen">${progress}${card ? renderCard(card, ctx, { ...opts, undo }) : empty}${!card && undo ? `<div class="wiedersehen-actions">${undo}</div>` : ''}</div>
${renderWeek(model, ctx, opts)}`;
  return readingPage(ctx, { key: 'wiedersehen', title: 'Wiedersehen', body, scripts: [assets.inbox] });
}

/**
 * Seiten und Aktionen für src/lesen/http.js.
 * - `capture`: Notiz in der Vault-Inbox (wie „In Inbox“); ohne gibt es „In eigenen Worten“ und „Als eigene Notiz anlegen“ nicht.
 * - `embedCache`: gemeinsamer Speicher für Embeddings (src/lesen/embed-cache.js); ohne legt die Seite einen
 *   eigenen über `embedder` an (liefert `{ model, embed }` oder `null`). Ohne Embedder bleibt der Kasten „Querverbindung“ weg.
 * - `onOwnWords({ highlight, words, result })`: Haken nach „In eigenen Worten“, z. B. für die Lesestapel-Notiz (VCP-75).
 * - `now` nur für Tests.
 */
export function reviewRoutes({ store, capture = null, embedder = () => null, embedCache = null, onOwnWords = null, logger = console, now = () => Date.now() }) {
  embedCache ??= createEmbedCache({ embedder, logger, label: 'Wiedersehen' });
  /** Vektoren zu `items` oder `null`, wenn es keinen Embedder gibt, er nicht antwortet oder (noch) nicht fertig ist. */
  async function vectorsFor(items) {
    if (items.length < 2) return null;
    const vecs = await embedCache.vectors(items.map((h) => h.quote));
    return vecs?.every(Boolean) ? vecs : null;
  }

  const highlightOf = (id) => {
    const h = store.getHighlight(id);
    if (!h) throw new ActionError('Diese Markierung gibt es nicht', 404);
    return h;
  };
  // Doppelt abgeschickt rückt nichts zweimal weiter.
  const dueOf = (id) => {
    const h = highlightOf(id);
    if (!isDue(h, now())) throw new ActionError('Diese Markierung ist gerade nicht dran', 409);
    return h;
  };
  const undoOf = (h) => ({ action: UNDO, fields: { id: h.id } });

  /** Was die Seite zeigt: Fällige, Zähler von heute, die Woche aus `?woche=` mit Häufungen. */
  async function model(ctx) {
    const t = now();
    // Ohne Grenze (`LIMIT -1`): auch alte Markierungen kommen wieder.
    const all = store.listHighlights({ limit: -1 });
    const today = all.filter((h) => seenToday(h, dayStart(t, ctx.tz)));
    const seen = today.length;
    // Die letzte Entscheidung von heute, die sich noch zurücknehmen lässt.
    const last = today.filter(prevOf).sort((a, b) => b.reviewed_at.localeCompare(a.reviewed_at))[0] ?? null;
    const due = dueCards(all, t);
    const left = Math.min(due.length, Math.max(0, SESSION_LIMIT - seen));
    const w = weekFrom(ctx.url, t, ctx.tz);
    const items = all.filter((h) => inWeek(h, w));
    const sample = items.slice(0, CLUSTER_MAX_ITEMS);
    const vectors = await vectorsFor(sample);
    const clusters = vectors ? findClusters(sample, vectors, { threshold: CLUSTER_THRESHOLD }).slice(0, 3) : [];
    return { card: left ? due[0] : null, due, seen, left, later: due.length - left, last, w, items, clusters };
  }

  /** Markdown der Woche als Download (Web) und für die App. */
  async function markdown(ctx) {
    const w = weekFrom(ctx.url, now(), ctx.tz);
    const items = store.listHighlights({ limit: -1 }).filter((h) => inWeek(h, w));
    return {
      body: weekMarkdown(items, w),
      headers: { 'content-type': 'text/markdown; charset=utf-8', 'content-disposition': `attachment; filename="markierungen-${w.id}.md"`, 'cache-control': 'no-store' },
    };
  }

  return {
    pages: {
      async '/lesen/wiedersehen'(ctx) {
        return { html: renderReviewPage(await model(ctx), ctx, { canCapture: Boolean(capture) }) };
      },
      /**
       * JSON: alle Karten, die heute noch dran sind (höchstens bis `SESSION_LIMIT`),
       * Zähler wie „Heute x von y gesehen · n weitere morgen“ und die Woche.
       */
      async '/api/lesen/wiedersehen'(ctx) {
        const { due, seen, left, later, last, w, items, clusters } = await model(ctx);
        const { topics, docs } = weekStats(items);
        const card = (h) => ({ ...highlightJson(h), box: boxLabel(h), dueAt: dueAt(h) });
        return jsonReply(200, {
          ok: true,
          seen,
          left,
          later,
          total: seen + left,
          limit: SESSION_LIMIT,
          maxBox: MAX_BOX,
          canCapture: Boolean(capture),
          cards: due.slice(0, left).map(card),
          // Letzte Entscheidung von heute zum Zurücknehmen (wie `undo` im Eingang).
          last: last && { ...highlightJson(last), decision: prevOf(last).ziel ?? null },
          undo: last ? undoOf(last) : null,
          week: {
            id: w.id,
            year: w.year,
            week: w.week,
            monday: w.monday,
            sunday: w.sunday,
            start: w.start.toISOString(),
            end: w.end.toISOString(),
            label: `${dateLabel(w.start, ctx.tz)} – ${dateLabel(w.days[6].start, ctx.tz)}`,
            prev: { id: w.prev, week: Number(w.prev.slice(6)) },
            next: { id: w.next, week: Number(w.next.slice(6)) },
            stats: { highlights: items.length, texts: docs, topics: topics.length },
            topics,
            clusters: clusters.map((group) => ({ ids: group.map((h) => h.id), items: group.map(highlightJson) })),
            export: items.length ? `/api/lesen/wiedersehen.md?woche=${w.id}` : null,
          },
        });
      },
      '/lesen/wiedersehen.md': markdown,
      '/api/lesen/wiedersehen.md': markdown,
    },
    actions: {
      async [REVIEW](form, session) {
        const ziel = form.get('ziel');
        if (!['behalten', 'worte', 'loslassen'].includes(ziel)) throw new ActionError('Unbekannte Entscheidung');
        const h = dueOf(form.get('id'));
        let message = ziel === 'loslassen' ? 'Losgelassen' : 'Behalten';
        const prev = { ziel, box: h.review_box, due: h.review_due ?? null, state: h.review_state };
        if (ziel === 'worte') {
          if (!capture) throw new ActionError('Die Vault-Inbox ist hier nicht angebunden', 503);
          const words = (form.get('worte') ?? '').trim();
          if (!words) throw new ActionError('Bitte in eigenen Worten etwas schreiben');
          if (words.length > MAX_WORDS) throw new ActionError(`Der Text ist zu lang (höchstens ${MAX_WORDS} Zeichen)`);
          const doc = store.get(h.doc_id);
          const result = await capture({ text: inboxText({ quote: h.quote, note: words, doc }), title: noteTitle('Gedanke zu', doc), captureId: form.get('cid') || null });
          if (!result.duplicate) logger.info?.(`Wiedersehen: eigene Worte zu ${doc.url} in die Inbox (${session.sub})`);
          try {
            await onOwnWords?.({ highlight: h, doc, words, result });
          } catch (err) {
            // Die Notiz liegt schon in der Inbox; der Haken darf die Karte nicht festhalten.
            logger.warn?.(`Wiedersehen: Haken für eigene Worte fehlgeschlagen (${err.message})`);
          }
          message = `In der Inbox: ${result.path}`;
          prev.inbox = result.path;
        }
        const decided = { reviewed_at: new Date(now()).toISOString(), review_prev: JSON.stringify(prev) };
        store.updateHighlight(h.id, { ...(ziel === 'loslassen' ? letGo() : keep(h, now())), ...decided });
        return { message, undo: undoOf(h) };
      },

      async [UNDO](form) {
        const h = highlightOf(form.get('id'));
        const prev = prevOf(h);
        const box = Number(prev ? prev.box : form.get('box'));
        const due = (prev ? prev.due : form.get('faellig')) || null;
        const state = prev ? prev.state : form.get('zustand');
        if (!Number.isInteger(box) || box < 0 || box > MAX_BOX || (due && Number.isNaN(Date.parse(due))) || !REVIEW_STATES.includes(state)) {
          throw new ActionError('Lässt sich nicht zurücksetzen');
        }
        store.updateHighlight(h.id, { review_box: box, review_due: due, review_state: state, reviewed_at: null, review_prev: null });
        // Die Notiz aus „In eigenen Worten“ nimmt das Cockpit nicht zurück: Sie kann im Vault schon weiterbearbeitet sein.
        return { message: prev?.inbox ? `Wieder dran. Die Notiz in der Inbox bleibt: ${prev.inbox}` : 'Wieder dran' };
      },

      async [LINK](form, session) {
        if (!capture) throw new ActionError('Die Vault-Inbox ist hier nicht angebunden', 503);
        const ids = [...new Set((form.get('ids') ?? '').split(',').filter(Boolean))].sort();
        if (ids.length < 2 || ids.length > 10) throw new ActionError('Eine Querverbindung braucht zwei bis zehn Markierungen');
        const items = ids.map(highlightOf);
        const docs = new Map(items.map((h) => [h.doc_id, store.get(h.doc_id)]));
        const text = ['Querverbindung entdeckt', ...items.map((h) => inboxText({ quote: h.quote, note: h.note, doc: docs.get(h.doc_id) }))].join('\n\n');
        // Dieselbe Gruppe legt nur eine Notiz an.
        const captureId = `verbindung-${createHash('sha256').update(ids.join(',')).digest('hex').slice(0, 32)}`;
        const titles = [...new Set(items.map((h) => noteTitle('', docs.get(h.doc_id)).trim()))];
        const result = await capture({ text, title: `Querverbindung ${titles.slice(0, 2).join(' und ')}${titles.length > 2 ? ' und mehr' : ''}`, captureId });
        if (!result.duplicate) logger.info?.(`Wiedersehen: Querverbindung aus ${items.length} Markierungen in die Inbox (${session.sub})`);
        return { message: `${result.duplicate ? 'Schon in der Inbox' : 'In der Inbox'}: ${result.path}`, result };
      },
    },
  };
}
