import { ActionError } from '../cockpit/actions.js';
import { esc, head, appHeader, assets } from '../web/layout.js';
import { hidden, flashToast } from '../web/render.js';
import { readingNav, readingPage } from './pages.js';
import { markHighlights, placeHighlights, weiterAt } from './anchor.js';
import { textBlocks } from './blocks.js';
import { docJson, highlightJson, jsonReply } from './json.js';

/**
 * Leseansicht `/lesen/doc?id=…` (VCP-71): Lesetext in Leseschrift mit den
 * Markierungen, Fortschritt und Restzeit, dazu die Entscheidung nach dem Lesen
 * (VCP-96): „Fertig, weg“ oder „In den Vault“ (Notiz, wahlweise mit Volltext).
 * Auf breiten Bildschirmen daneben Bereiche, Stapel und eine Seitenleiste
 * (Querverbindungen, Markierungen, Tastenkürzel). Markieren und Speichern des
 * Fortschritts macht `/static/lesen-doc.js`; ohne JavaScript bleibt der Text
 * lesbar und jede Entscheidung ein Formular.
 *
 * Link-Vertrag für die anderen Seiten: `/lesen/doc?id=<id>`, mit `#weiter`
 * an die zuletzt gelesene Stelle (`scroll_anchor`, Zeichen im Lesetext).
 *
 * `/api/lesen/doc?id=…` liefert dasselbe für die native Leseansicht: den
 * Lesetext als Blöcke (src/lesen/blocks.js) und die Markierungen als Bereiche
 * darin, gerechnet wie die `<mark>` der Seite.
 */

const STATUS_MESSAGE = { eingang: 'In den Eingang gelegt', stapel: 'Auf den Stapel gelegt', archiv: 'Archiviert', abgelegt: 'Im Vault abgelegt', weg: 'Verworfen' };
const STATUS = '/aktion/lesen/doc/status';
const name = (d) => d.title ?? d.url;
const href = (u) => (/^https?:\/\//i.test(u ?? '') ? u : '#');
export const docLink = (id) => `/lesen/doc?id=${encodeURIComponent(id)}`;
const remaining = (d) => Math.max(1, Math.ceil(d.reading_minutes * (1 - d.progress)));
const restLabel = (d) => (d.progress >= 1 ? 'gelesen' : d.reading_minutes ? `noch ${remaining(d)} min` : '');
const NO_TEXT = 'Für diesen Artikel gibt es keinen Lesetext.';
const NOT_FOUND = 'Diesen Artikel gibt es nicht (mehr).';
/** Welche Entscheidungen nach dem Lesen gehen (Knöpfe der Seite). */
const decisions = (doc, vault) => ({ fertig: doc.status !== 'weg', vault, zurueck: ['archiv', 'abgelegt', 'weg'].includes(doc.status) });
const short = (s, n = 160) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

const KEYS = [
  ['H', 'Absatz markieren'],
  ['N', 'Notiz'],
  ['L', 'verbinden'],
  ['E', 'fertig, weg'],
  ['V', 'in den Vault'],
  ['J / K', 'Absatz weiter / zurück'],
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

/**
 * Nach dem Lesen: „Fertig, weg“ (E), „In den Vault“ (V, nur mit Lesestapel-Notizen)
 * mit Wahl „mit Volltext“, und nach einer Entscheidung „Zurück auf den Stapel“.
 */
function decide(doc, ctx, vault) {
  const form = (action, key, fields, body) => `<form method="post" action="${action}" class="act" data-decide="${key}">${hidden({ csrf: ctx.write.csrf, back: ctx.write.back, id: doc.id, ...fields })}${body}</form>`;
  return `<div class="lesen-decide">
      ${decisions(doc, vault).fertig ? form('/aktion/lesen/doc/fertig', 'fertig', {}, '<button type="submit" class="btn">Fertig, weg <kbd>E</kbd></button>') : ''}
      ${vault ? form('/aktion/lesen/doc/vault', 'vault', {}, '<label class="lesen-volltext"><input type="checkbox" name="volltext" value="1"> mit Volltext</label><button type="submit" class="btn primary">In den Vault <kbd>V</kbd></button>') : ''}
      ${decisions(doc, vault).zurueck ? form(STATUS, 'zurueck', { status: 'stapel' }, '<button type="submit" class="btn quiet">Zurück auf den Stapel</button>') : ''}
    </div>`;
}

function renderDoc(doc, { highlights, stackDocs, counts, vault }, ctx) {
  const { html, orphans } = markHighlights(doc.content_html ?? '', highlights, { weiter: Number(doc.scroll_anchor) || 0 });
  const meta = [doc.site, doc.author, doc.reading_minutes ? `${doc.reading_minutes} min` : null].filter(Boolean).map(esc).join(' · ');
  const text = doc.content_html
    ? html
    : `<span id="weiter"></span><p>${esc(doc.excerpt || NO_TEXT)}</p>`;
  const nav = ['eingang', 'stapel'].includes(doc.status) ? doc.status : null;
  return `<!doctype html>
<html lang="de">
${head(doc.title || doc.url, { script: true, scripts: [assets.lesenDoc, assets.lesenLinks] })}
<body class="page-lesen page-lesen-doc">
${appHeader({ current: 'lesen', user: ctx.user })}
${readingNav(nav)}
<main class="lesen-doc">
${areas(counts)}
${stack(stackDocs, doc.id)}
<article class="lesen-reader" data-doc="${esc(doc.id)}" data-minutes="${doc.reading_minutes}">
  <header class="lesen-doc-head">
    <h1>${esc(doc.title || doc.url)}</h1>
    <p class="meta">${meta}${meta ? ' · ' : ''}<a href="${esc(href(doc.url))}" rel="noopener noreferrer" target="_blank">Original</a>${doc.comments_url ? ` · <a href="${esc(href(doc.comments_url))}" rel="noopener noreferrer" target="_blank">Kommentare</a>` : ''}</p>
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
    ${decide(doc, ctx, vault)}
  </div>
  <div class="lesen-text">${text}</div>
</article>
<aside class="lesen-side">
  <section class="lesen-links" data-verbindungen><h2>Querverbindungen</h2><p class="empty">Markierung antippen oder Text auswählen, dann „Verbinden“: passende Stellen aus anderen Texten, Synthesen und Konzepten.</p></section>
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
 * Leseansicht als JSON: Dokument, Lesetext als Blöcke, Markierungen mit ihrer
 * Stelle (`start`/`end`, `lost` = „Stelle nicht mehr im Text“) und als
 * überlappungsfreie Bereiche `ranges` wie die `<mark>` der Seite, Lesestelle
 * (`anchor` wie gespeichert, `weiter` = erstes sichtbares Zeichen dort),
 * Bereiche mit Zählern, Stapel (30) und die möglichen Entscheidungen.
 */
function docJsonModel(doc, { highlights, stackDocs, counts, vault }) {
  const { text, blocks } = textBlocks(doc.content_html ?? '');
  const { ranges, found } = placeHighlights(text, highlights);
  const anchor = Number(doc.scroll_anchor) || 0;
  return {
    ok: true,
    doc: { ...docJson(doc), rest: restLabel(doc), remaining: doc.reading_minutes ? remaining(doc) : null },
    hasText: Boolean(doc.content_html),
    length: text.length,
    anchor,
    weiter: weiterAt(text, anchor),
    // Ohne Lesetext zeigt die Seite den Anriss oder einen Hinweis; Markierungen haben dann keine Stelle.
    blocks: doc.content_html ? blocks : textBlocks(`<p>${esc(doc.excerpt || NO_TEXT)}</p>`).blocks,
    highlights: highlights.map((h) => {
      const at = found.get(h.id);
      return { ...highlightJson(h), start: at?.start ?? null, end: at?.end ?? null, lost: !at };
    }),
    ranges: ranges.map((r) => ({ id: r.h.id, start: r.start, end: r.end, note: r.h.note ?? null })),
    counts,
    stack: stackDocs.map((d) => ({ id: d.id, title: d.title ?? null, url: d.url, site: d.site ?? null, progress: d.progress, readingMinutes: d.reading_minutes, rest: restLabel(d), started: d.progress > 0 && d.progress < 1, current: d.id === doc.id })),
    nav: ['eingang', 'stapel'].includes(doc.status) ? doc.status : null,
    vault,
    decisions: decisions(doc, vault),
  };
}

/** Antwort einer Entscheidung: Meldung, neuer Status, Rückgängig (alter Status), wenn sich etwas geändert hat. */
const decided = (message, { doc, previous, changed }) => ({
  message: `${message}: ${name(doc)}`,
  doc: { id: doc.id, status: doc.status },
  ...(changed ? { undo: { action: STATUS, fields: { id: doc.id, status: previous } } } : {}),
});

/**
 * Seite und Aktionen der Leseansicht; `asAction` macht Fehler des Speichers zur
 * Meldung, `onChange(docId)` hört Statuswechsel, `exporter` schreibt die
 * Lesestapel-Notiz (src/lesen/vault-export.js; ohne gibt es „In den Vault“ und
 * „Im Vault ablegen“ nicht).
 */
export function docRoutes({ store, asAction, onChange = () => {}, exporter = null }) {
  const must = (id) => {
    const doc = store.get(id);
    if (!doc) throw new ActionError('Dieses Dokument gibt es nicht', 404);
    return doc;
  };
  /** Notiz sofort schreiben; erst danach wechselt der Status, sonst stünde ein Text ohne Notiz im Archiv. */
  const toVault = (doc, opts) => {
    if (!exporter) throw new ActionError('Die Lesestapel-Notizen sind hier nicht angebunden', 503);
    let r;
    try {
      r = exporter.save(doc.id, opts);
    } catch (err) {
      throw new ActionError(`Nicht in den Vault geschrieben: ${err.message}`, 409);
    }
    if (r.state === 'übersprungen' && !r.path) throw new ActionError(r.reason, 409);
    return r;
  };

  const model = (doc) => ({ highlights: store.listHighlights({ docId: doc.id }), stackDocs: store.list({ status: 'stapel', limit: 30 }), counts: store.counts(), vault: Boolean(exporter) });

  return {
    pages: {
      async '/lesen/doc'(ctx) {
        const doc = store.get(ctx.url.searchParams.get('id'));
        if (!doc) return { status: 404, html: readingPage(ctx, { key: null, title: 'Nicht gefunden', body: `<section><p class="empty">${NOT_FOUND}</p></section>` }) };
        return { html: renderDoc(doc, model(doc), ctx) };
      },
      async '/api/lesen/doc'(ctx) {
        const doc = store.get(ctx.url.searchParams.get('id'));
        if (!doc) return jsonReply(404, { error: 'not_found', message: NOT_FOUND });
        return jsonReply(200, docJsonModel(doc, model(doc)));
      },
    },
    actions: {
      /** Status wechseln (`id`, `status`), z. B. zurück auf den Stapel; auch das Rückgängig der Entscheidungen. */
      async [STATUS](form) {
        const status = form.get('status');
        const r = await asAction(() => store.setStatus(form.get('id'), status));
        if (r.changed) onChange(r.doc.id);
        const kept = r.changed && ['archiv', 'abgelegt'].includes(r.previous) ? ' (die Notiz im Vault bleibt)' : '';
        const out = decided(STATUS_MESSAGE[status], r);
        return { ...out, message: out.message + kept };
      },
      /** „Fertig, weg“: gelesen, keine Notiz; eine vorhandene bleibt unberührt. */
      async '/aktion/lesen/doc/fertig'(form) {
        return decided('Fertig, weg', await asAction(() => store.setStatus(form.get('id'), 'weg', { read: true })));
      },
      /** „In den Vault“: Notiz mit `lesestatus: gelesen`, mit `volltext=1` samt Volltext; dann archiviert. */
      async '/aktion/lesen/doc/vault'(form) {
        const fullText = form.get('volltext') === '1';
        const doc = must(form.get('id'));
        // Erst gelesen (`read_at`, Datum für `gelesen:`), dann die Notiz, dann der Status.
        store.setStatus(doc.id, doc.status, { read: true });
        toVault(doc, { read: true, fullText });
        return decided(fullText ? 'Mit Volltext im Vault' : 'Im Vault', store.setStatus(doc.id, 'archiv'));
      },
      /** „Im Vault ablegen“ aus Eingang oder Stapel: ungelesen, immer mit Volltext; verlässt Eingang und Stapel. */
      async '/aktion/lesen/ablegen'(form) {
        const doc = must(form.get('id'));
        if (!['eingang', 'stapel', 'abgelegt'].includes(doc.status)) throw new ActionError(`Liegt nicht mehr in Eingang oder Stapel: ${name(doc)}`, 409);
        toVault(doc, { read: false, fullText: true });
        return decided('Im Vault abgelegt', store.setStatus(doc.id, 'abgelegt'));
      },
      /** Lesefortschritt (`fortschritt` 0..1, `anker` Zeichen im Lesetext); still, ohne Meldung. */
      async '/aktion/lesen/doc/fortschritt'(form) {
        const progress = form.get('fortschritt');
        if (!progress) throw new ActionError('Fortschritt fehlt');
        const anchor = form.get('anker');
        const doc = await asAction(() => store.setProgress(form.get('id'), progress, /^\d{1,8}$/.test(anchor ?? '') ? anchor : undefined));
        return { message: '', progress: doc.progress };
      },
    },
  };
}
