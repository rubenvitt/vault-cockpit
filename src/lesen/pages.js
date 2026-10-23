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
  ['feeds', '/lesen/feeds', 'Feeds'],
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

/** Formular „URL speichern“; `cid` macht doppeltes Absenden harmlos. */
export const saveForm = (ctx) => `<form method="post" action="/aktion/lesen/speichern" class="lesen-save">
    ${hidden({ csrf: ctx.write.csrf, back: ctx.write.back, cid: randomUUID() })}
    <label class="lesen-url"><span class="sr-only">Adresse des Artikels</span><input type="url" name="url" required placeholder="https://… Artikel speichern" inputmode="url" autocomplete="off" spellcheck="false" enterkeyhint="go"></label>
    <button type="submit" class="btn primary">Speichern</button>
  </form>`;
