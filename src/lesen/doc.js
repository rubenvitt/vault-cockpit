import { ActionError } from '../cockpit/actions.js';
import { esc, head, appHeader, assets } from '../web/layout.js';
import { hidden, flashToast } from '../web/render.js';
import { readingNav, readingPage } from './pages.js';
import { markHighlights } from './anchor.js';

/**
 * Leseansicht `/lesen/doc?id=…` (VCP-71): Lesetext in Leseschrift mit den
 * Markierungen, Fortschritt und Restzeit, Archivieren. Auf breiten
 * Bildschirmen daneben Bereiche, Stapel und eine Seitenleiste (Querverbindungen,
 * Markierungen, Tastenkürzel). Markieren und Speichern des Fortschritts macht
 * `/static/lesen-doc.js`; ohne JavaScript bleibt der Text lesbar und
 * Archivieren ein Formular.
 *
 * Link-Vertrag für die anderen Seiten: `/lesen/doc?id=<id>`, mit `#weiter`
 * an die zuletzt gelesene Stelle (`scroll_anchor`, Zeichen im Lesetext).
 */

const STATUS_MESSAGE = { eingang: 'In den Eingang gelegt', stapel: 'Auf den Stapel gelegt', archiv: 'Archiviert', weg: 'Verworfen' };
const href = (u) => (/^https?:\/\//i.test(u ?? '') ? u : '#');
export const docLink = (id) => `/lesen/doc?id=${encodeURIComponent(id)}`;
const remaining = (d) => Math.max(1, Math.ceil(d.reading_minutes * (1 - d.progress)));
const restLabel = (d) => (d.progress >= 1 ? 'gelesen' : d.reading_minutes ? `noch ${remaining(d)} min` : '');
const short = (s, n = 160) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

const KEYS = [
  ['H', 'markieren'],
  ['N', 'Notiz'],
  ['L', 'verbinden'],
  ['E', 'archivieren'],
  ['J / K', 'nächster / vorheriger Absatz'],
];

/** Bereiche des Lesestapels mit Zählern. */
function areas(counts) {
  const items = [
    ['/lesen/eingang', 'Eingang', counts.eingang],
    ['/lesen/stapel', 'Stapel', counts.stapel],
    ['/lesen/markiert', 'Markiert', null],
    ['/wissen', 'Wissen', null],
  ];
  return `<nav class="lesen-col lesen-areas" aria-label="Bereiche"><h2>Bereiche</h2><ul>${items
    .map(([to, label, n]) => `<li><a href="${to}">${label}${n ? ` <span class="meta">${n}</span>` : ''}</a></li>`)
    .join('')}</ul></nav>`;
}

/** Die Dokumente auf dem Stapel, das offene hervorgehoben. */
function stack(docs, current) {
  const body = docs.length
    ? `<ol>${docs
        .map((d) => `<li><a href="${esc(docLink(d.id))}${d.progress > 0 && d.progress < 1 ? '#weiter' : ''}"${d.id === current ? ' aria-current="page"' : ''}>${esc(d.title || d.url)}<span class="meta">${esc([d.site, restLabel(d)].filter(Boolean).join(' · '))}</span></a></li>`)
        .join('')}</ol>`
    : '<p class="empty">Leer.</p>';
  return `<nav class="lesen-col lesen-stack" aria-label="Stapel"><h2>Stapel</h2>${body}</nav>`;
}

/** Markierungen des Dokuments in Lesereihenfolge; verlorene Stellen bleiben mit Hinweis stehen. */
function highlightList(highlights, orphans, ctx) {
  if (!highlights.length) return '<p class="empty">Text auswählen, um zu markieren.</p>';
  const lost = new Set(orphans.map((h) => h.id));
  return `<ul class="lesen-notes">${highlights
    .map(
      (h) => `<li data-hl="${esc(h.id)}">
    ${lost.has(h.id) ? `<blockquote class="lesen-quote">${esc(short(h.quote))}</blockquote><span class="meta">Stelle nicht mehr im Text</span>` : `<a href="#h-${esc(h.id)}" class="lesen-quote">${esc(short(h.quote))}</a>`}
    ${h.note ? `<p class="lesen-note">${esc(h.note)}</p>` : ''}
    <form method="post" action="/aktion/lesen/markierung/loeschen" data-hl-form>${hidden({ csrf: ctx.write.csrf, back: ctx.write.back, id: h.id })}<button type="submit" class="btn quiet">Entfernen</button></form>
  </li>`,
    )
    .join('')}</ul>`;
}

function renderDoc(doc, { highlights, stackDocs, counts }, ctx) {
  const { html, orphans } = markHighlights(doc.content_html ?? '', highlights, { weiter: Number(doc.scroll_anchor) || 0 });
  const meta = [doc.site, doc.author, doc.reading_minutes ? `${doc.reading_minutes} min` : null].filter(Boolean).map(esc).join(' · ');
  const archived = doc.status === 'archiv';
  const text = doc.content_html
    ? html
    : `<span id="weiter"></span><p>${esc(doc.excerpt || 'Für diesen Artikel gibt es keinen Lesetext.')}</p>`;
  const nav = ['eingang', 'stapel'].includes(doc.status) ? doc.status : null;
  return `<!doctype html>
<html lang="de">
${head(doc.title || doc.url, { script: true, scripts: [assets.lesenDoc] })}
<body class="page-lesen page-lesen-doc">
${appHeader({ current: 'lesen', user: ctx.user })}
${readingNav(nav)}
<main class="lesen-doc">
${areas(counts)}
${stack(stackDocs, doc.id)}
<article class="lesen-reader" data-doc="${esc(doc.id)}" data-minutes="${doc.reading_minutes}">
  <header class="lesen-doc-head">
    <h1>${esc(doc.title || doc.url)}</h1>
    <p class="meta">${meta}${meta ? ' · ' : ''}<a href="${esc(href(doc.url))}" rel="noopener noreferrer">Original</a></p>
  </header>
  <div class="lesen-progress">
    <progress max="1" value="${doc.progress}" aria-label="Gelesen"></progress>
    <span class="meta" data-rest>${esc(restLabel(doc))}</span>
    ${doc.progress > 0 && doc.progress < 1 ? '<a href="#weiter" class="meta">Weiterlesen</a>' : ''}
  </div>
  <div class="lesen-tools">
    <div class="lesen-view">
      <button type="button" class="btn quiet" data-size="-1" aria-label="Schrift kleiner">A−</button>
      <button type="button" class="btn quiet" data-size="1" aria-label="Schrift größer">A+</button>
      <button type="button" class="btn quiet" data-font aria-pressed="false">Ohne Serifen</button>
    </div>
    <form method="post" action="/aktion/lesen/doc/status" class="act" data-archive>${hidden({ csrf: ctx.write.csrf, back: ctx.write.back, id: doc.id, status: archived ? 'stapel' : 'archiv' })}<button type="submit" class="btn">${archived ? 'Zurück auf den Stapel' : 'Archivieren'} <kbd>E</kbd></button></form>
  </div>
  <div class="lesen-text">${text}</div>
</article>
<aside class="lesen-side">
  <section class="lesen-links" data-verbindungen><h2>Querverbindungen</h2><p class="empty">Noch keine Querverbindungen.</p></section>
  <section><h2>Markierungen</h2>${highlightList(highlights, orphans, ctx)}</section>
  <section class="lesen-keys"><h2>Tastenkürzel</h2><dl>${KEYS.map(([k, label]) => `<div><dt><kbd>${k}</kbd></dt><dd>${label}</dd></div>`).join('')}</dl></section>
</aside>
</main>
<div class="lesen-selbar" role="toolbar" aria-label="Auswahl" hidden>
  <button type="button" class="btn" data-cmd="mark">Markieren <kbd>H</kbd></button>
  <button type="button" class="btn" data-cmd="note">Notiz <kbd>N</kbd></button>
  <button type="button" class="btn" data-cmd="link">Verbinden <kbd>L</kbd></button>
  <button type="button" class="btn" data-cmd="inbox">In Inbox</button>
  <button type="button" class="btn danger" data-cmd="delete" hidden>Entfernen</button>
</div>
<div class="toasts" aria-live="polite">${flashToast(ctx.flash, { write: ctx.write, back: ctx.write.back })}</div>
</body>
</html>`;
}

/**
 * Seite und Aktionen der Leseansicht; `asAction` macht Fehler des Speichers zur
 * Meldung, `onChange(docId)` hört Statuswechsel und „fertig gelesen“.
 */
export function docRoutes({ store, asAction, onChange = () => {} }) {
  return {
    pages: {
      async '/lesen/doc'(ctx) {
        const doc = store.get(ctx.url.searchParams.get('id'));
        if (!doc) return { status: 404, html: readingPage(ctx, { key: null, title: 'Nicht gefunden', body: '<section><p class="empty">Diesen Artikel gibt es nicht (mehr).</p></section>' }) };
        const model = { highlights: store.listHighlights({ docId: doc.id }), stackDocs: store.list({ status: 'stapel', limit: 30 }), counts: store.counts() };
        return { html: renderDoc(doc, model, ctx) };
      },
    },
    actions: {
      /** Status wechseln (`id`, `status`), z. B. Archivieren; Rückgängig stellt den alten her. */
      async '/aktion/lesen/doc/status'(form) {
        const status = form.get('status');
        const { doc, previous, changed } = await asAction(() => store.setStatus(form.get('id'), status));
        if (changed) onChange(doc.id);
        return {
          message: `${STATUS_MESSAGE[status]}: ${doc.title ?? doc.url}`,
          doc: { id: doc.id, status: doc.status },
          ...(changed ? { undo: { action: '/aktion/lesen/doc/status', fields: { id: doc.id, status: previous } } } : {}),
        };
      },
      /** Lesefortschritt (`fortschritt` 0..1, `anker` Zeichen im Lesetext); still, ohne Meldung. */
      async '/aktion/lesen/doc/fortschritt'(form) {
        const progress = form.get('fortschritt');
        if (!progress) throw new ActionError('Fortschritt fehlt');
        const anchor = form.get('anker');
        const doc = await asAction(() => store.setProgress(form.get('id'), progress, /^\d{1,8}$/.test(anchor ?? '') ? anchor : undefined));
        if (doc.progress >= 1) onChange(doc.id);
        return { message: '', progress: doc.progress };
      },
    },
  };
}
