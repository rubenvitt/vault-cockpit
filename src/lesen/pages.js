import { randomUUID } from 'node:crypto';
import { esc, head, appHeader } from '../web/layout.js';
import { hidden, flashToast } from '../web/render.js';

/**
 * Seiten des Bereichs „Lesen“. Jede Seite bekommt `ctx` aus src/web/http.js:
 * `{ url, range, user, tz, write: { csrf, back }, flash, nav }` (`range`: `Range`-Header für Audio,
 * `nav`: Zusätze der Unternavigation, siehe `readingNav`).
 */

/** Unternavigation unter der Kopfzeile; `/wissen` ist die Suche im Vault (VCP-76). */
const SUB = [
  ['eingang', '/lesen/eingang', 'Eingang'],
  ['stapel', '/lesen/stapel', 'Stapel'],
  ['folgen', '/lesen/folgen', 'Folgen'],
  ['markiert', '/lesen/markiert', 'Markiert'],
  ['wiedersehen', '/lesen/wiedersehen', 'Wiedersehen'],
  ['wissen', '/wissen', 'Wissen'],
  ['feeds', '/lesen/feeds', 'Feeds'],
];

/**
 * `nav` (Objekt oder Funktion, die eines liefert, damit nur gezählt wird, was
 * auch gezeigt wird): `{ ingest: n }` fügt nach dem Stapel „Ingest“ mit der
 * Zahl der bereiten Entwürfe ein (src/lesen/ingest-page.js); ohne fehlt der Eintrag.
 */
export function readingNav(current, nav = null) {
  let extra = null;
  try {
    extra = typeof nav === 'function' ? nav() : nav;
  } catch {
    extra = null;
  }
  const items = SUB.map(([key, href, label]) => [key, href, label]);
  if (extra && 'ingest' in extra) {
    const n = Number(extra.ingest) || 0;
    items.splice(2, 0, ['ingest', '/lesen/ingest', `Ingest<span class="subnav-count" data-ingest-count${n ? '' : ' hidden'}>${n}</span>`]);
  }
  return `<nav class="subnav" aria-label="Lesen">${items
    .map(([key, href, label]) => `<a href="${href}" class="subnav-link"${key === current ? ' aria-current="page"' : ''}>${label}</a>`)
    .join('')}</nav>`;
}

/**
 * Rahmen einer Lesen-Seite: Kopfzeile, Unternavigation, Titel, Inhalt, Meldung.
 * `heading` (fertiges HTML) ersetzt die Überschrift, `bodyClass` kommt zu `page-lesen`.
 */
export function readingPage(ctx, { key, title, body, scripts = [], heading = null, bodyClass = '' }) {
  return `<!doctype html>
<html lang="de">
${head(title, { script: true, scripts })}
<body class="page-lesen${bodyClass ? ` ${esc(bodyClass)}` : ''}">
${appHeader({ current: 'lesen', user: ctx.user })}
${readingNav(key, ctx.nav)}
<div class="page-head">${heading ?? `<h1>${esc(title)}</h1>`}</div>
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
