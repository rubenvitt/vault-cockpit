import { randomUUID } from 'node:crypto';
import { esc, head, appHeader } from '../web/layout.js';
import { hidden, flashToast } from '../web/render.js';

/**
 * Seiten des Bereichs „Lesen“. Jede Seite bekommt `ctx` aus src/web/http.js:
 * `{ url, user, tz, write: { csrf, back }, flash }`.
 */

/** Unternavigation unter der Kopfzeile; `/wissen` ist die Suche im Vault (VCP-76). */
const SUB = [
  ['eingang', '/lesen/eingang', 'Eingang'],
  ['stapel', '/lesen/stapel', 'Stapel'],
  ['markiert', '/lesen/markiert', 'Markiert'],
  ['wissen', '/wissen', 'Wissen'],
];

export function readingNav(current) {
  return `<nav class="subnav" aria-label="Lesen">${SUB.map(
    ([key, href, label]) => `<a href="${href}" class="subnav-link"${key === current ? ' aria-current="page"' : ''}>${label}</a>`,
  ).join('')}</nav>`;
}

/** Rahmen einer Lesen-Seite: Kopfzeile, Unternavigation, Titel, Inhalt, Meldung. */
export function readingPage(ctx, { key, title, body, scripts = [] }) {
  return `<!doctype html>
<html lang="de">
${head(title, { script: true, scripts })}
<body class="page-lesen">
${appHeader({ current: 'lesen', user: ctx.user })}
${readingNav(key)}
<div class="page-head"><h1>${esc(title)}</h1></div>
<main class="lesen">
${body}
</main>
<div class="toasts" aria-live="polite">${flashToast(ctx.flash, { write: ctx.write, back: ctx.write.back })}</div>
</body>
</html>`;
}

// Adressen kommen auch aus Mail und Import: verlinkt wird nur http(s).
const href = (u) => (/^https?:\/\//i.test(u ?? '') ? u : '#');
const dateLabel = (iso, tz) => new Date(iso).toLocaleDateString('de-DE', { day: 'numeric', month: 'short', timeZone: tz });

/** Ein Dokument als Zeile: Titel (vorerst zum Original), Quelle, Lesezeit, gespeichert am. */
function docItem(d, tz) {
  const meta = [d.site, d.reading_minutes ? `${d.reading_minutes} min` : null, `gespeichert ${dateLabel(d.saved_at, tz)}`].filter(Boolean).map(esc).join(' · ');
  return `<li class="lesen-item">
    <a href="${esc(href(d.url))}" class="lesen-title" rel="noopener noreferrer">${esc(d.title || d.url)}</a>
    <span class="meta">${meta}</span>
    ${d.excerpt ? `<p class="lesen-excerpt">${esc(d.excerpt)}</p>` : ''}
  </li>`;
}

const docList = (docs, ctx, empty) => (docs.length ? `<ul class="lesen-list">${docs.map((d) => docItem(d, ctx.tz)).join('')}</ul>` : `<p class="empty">${esc(empty)}</p>`);

/** Formular „URL speichern“; `cid` macht doppeltes Absenden harmlos. */
export const saveForm = (ctx) => `<form method="post" action="/aktion/lesen/speichern" class="lesen-save">
    ${hidden({ csrf: ctx.write.csrf, back: ctx.write.back, cid: randomUUID() })}
    <label class="lesen-url"><span class="sr-only">Adresse des Artikels</span><input type="url" name="url" required placeholder="https://… Artikel speichern" inputmode="url" autocomplete="off" spellcheck="false" enterkeyhint="go"></label>
    <button type="submit" class="btn primary">Speichern</button>
  </form>`;

export const renderInbox = (docs, ctx) =>
  readingPage(ctx, { key: 'eingang', title: 'Eingang', body: `<section>${saveForm(ctx)}</section><section>${docList(docs, ctx, 'Der Eingang ist leer.')}</section>` });

export const renderStack = (docs, ctx) =>
  readingPage(ctx, { key: 'stapel', title: 'Stapel', body: `<section>${docList(docs, ctx, 'Auf dem Stapel liegt nichts.')}</section>` });

export function renderHighlights(items, ctx) {
  const body = items.length
    ? `<ul class="lesen-list">${items
        .map(
          (h) => `<li class="lesen-item">
    <blockquote class="lesen-quote">${esc(h.quote)}</blockquote>
    ${h.note ? `<p class="lesen-excerpt">${esc(h.note)}</p>` : ''}
    <a href="${esc(href(h.doc_url))}" class="meta" rel="noopener noreferrer">${esc(h.doc_title || h.doc_url)}</a>
  </li>`,
        )
        .join('')}</ul>`
    : '<p class="empty">Noch nichts markiert.</p>';
  return readingPage(ctx, { key: 'markiert', title: 'Markiert', body: `<section>${body}</section>` });
}
