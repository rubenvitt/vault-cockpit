import { randomUUID } from 'node:crypto';
import { esc, head, appHeader } from '../web/layout.js';
import { hidden, flashToast } from '../web/render.js';

/**
 * Seiten des Bereichs „Lesen“. Jede Seite bekommt `ctx` aus src/web/http.js:
 * `{ url, range, user, tz, write: { csrf, back }, flash, nav }` (`range`: `Range`-Header für Audio,
 * `nav`: Zusätze der Unternavigation, siehe `readingNav`).
 */

/**
 * Unternavigation unter der Kopfzeile: vier Reiter für den Ablauf eines Textes
 * (Weiter · Eingang · Stapel · Folgen), der Rest unter „Mehr“ (ein `<details>`,
 * geht ohne JavaScript). Steht man auf einer Seite aus „Mehr“, trägt der Knopf
 * ihren Namen. Auf breiten Bildschirmen stehen die Einträge aus „Mehr“ als
 * eigene Reiter daneben und das Menü fällt weg (CSS, `.subnav-weit`).
 * `/wissen` ist die Suche im Vault (VCP-76).
 */
const MAIN = [
  ['weiter', '/lesen/weiter', 'Weiter'],
  ['eingang', '/lesen/eingang', 'Eingang'],
  ['stapel', '/lesen/stapel', 'Stapel'],
  ['folgen', '/lesen/folgen', 'Folgen'],
];
const MORE = [
  ['markiert', '/lesen/markiert', 'Markiert', 'Alle Markierungen nach Quelle und Thema'],
  ['wiedersehen', '/lesen/wiedersehen', 'Wiedersehen', 'Markierungen wiederholen'],
  ['wissen', '/wissen', 'Wissen', 'Im Vault suchen'],
  ['fragen', '/fragen', 'Fragen', 'Mit Claude über den ganzen Vault sprechen'],
  ['feeds', '/lesen/feeds', 'Feeds', 'Abos verwalten'],
];

/**
 * `nav` (Objekt oder Funktion, die eines liefert, damit nur gezählt wird, was
 * auch gezeigt wird): `{ ingest: n }` nimmt „Ingest“ in „Mehr“ auf und zeigt
 * die Zahl der bereiten Entwürfe an „Weiter“ (dort stehen sie unter „Prüfen“)
 * und an „Ingest“ (src/lesen/ingest-page.js); ohne fehlt der Eintrag.
 * „Fragen“ (src/fragen/page.js) steht nur mit `{ fragen: true }` in „Mehr“.
 */
export function readingNav(current, nav = null) {
  let extra = null;
  try {
    extra = typeof nav === 'function' ? nav() : nav;
  } catch {
    extra = null;
  }
  const ingest = extra && 'ingest' in extra;
  const n = ingest ? Number(extra.ingest) || 0 : 0;
  const count = ingest ? `<span class="subnav-count" data-ingest-count${n ? '' : ' hidden'}>${n}</span>` : '';
  const more = [...(ingest ? [['ingest', '/lesen/ingest', 'Ingest', 'Entwürfe fürs Wiki abhaken']] : []), ...MORE.filter(([key]) => key !== 'fragen' || extra?.fragen)];
  const tabs = MAIN.map(([key, href, label]) => `<a href="${href}" class="subnav-link"${key === current ? ' aria-current="page"' : ''}>${label}${key === 'weiter' ? count : ''}</a>`).join('');
  const here = more.find(([key]) => key === current);
  const menu = more
    .map(([key, href, label, hint]) => `<a href="${href}" class="subnav-item"${key === current ? ' aria-current="page"' : ''}><span>${label}${key === 'ingest' ? count : ''}</span><span class="meta">${hint}</span></a>`)
    .join('');
  const wide = more.map(([key, href, label]) => `<a href="${href}" class="subnav-link subnav-weit"${key === current ? ' aria-current="page"' : ''}>${label}${key === 'ingest' ? count : ''}</a>`).join('');
  return `<nav class="subnav lesen-tabs" aria-label="Lesen">${tabs}<details class="menu subnav-mehr"><summary class="subnav-link"${here ? ' aria-current="page"' : ''}>${here ? here[2] : 'Mehr'}<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3 4.5l3 3 3-3"/></svg></summary><div class="subnav-menu">${menu}</div></details>${wide}</nav>`;
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

/** Adresse, die ohne JavaScript nicht gespeichert werden konnte (kommt mit der Fehlermeldung zurück), sonst leer. */
export const keptUrl = (ctx) => (ctx.flash?.kind === 'error' && typeof ctx.flash.url === 'string' ? ctx.flash.url : '');

/** Formular „URL speichern“; `cid` macht doppeltes Absenden harmlos. Nach einem Fehler steht die Adresse wieder drin. */
export const saveForm = (ctx) => `<form method="post" action="/aktion/lesen/speichern" class="lesen-save">
    ${hidden({ csrf: ctx.write.csrf, back: ctx.write.back, cid: randomUUID() })}
    <label class="lesen-url"><span class="sr-only">Adresse des Artikels</span><input type="url" name="url" required placeholder="https://… Artikel speichern" inputmode="url" autocomplete="off" spellcheck="false" enterkeyhint="go"${keptUrl(ctx) ? ` value="${esc(keptUrl(ctx))}"` : ''}></label>
    <button type="submit" class="btn primary">Speichern</button>
  </form>`;
