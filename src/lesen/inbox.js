import { ActionError } from '../cockpit/actions.js';
import { zonedParts, zonedToUtc } from '../cockpit/week.js';
import { esc, assets } from '../web/layout.js';
import { hidden } from '../web/render.js';
import { readingPage, saveForm } from './pages.js';

/**
 * Eingang sortieren (VCP-70): eine Karte nach der anderen, je Karte Weg,
 * Stapel oder Jetzt lesen. Ohne JavaScript ein Formular mit drei Knöpfen und
 * Weiterleitung; mit JavaScript schickt `/static/cockpit.js` es als JSON
 * (Formular `.act`, mit Rückgängig in der Meldung) und lädt `main` neu,
 * `/static/lesen-eingang.js` macht Wischen und Tasten daraus.
 */

const SORT = '/aktion/lesen/sortieren';
/** `ziel` aus dem Formular → neuer Status. `eingang` ist das Rückgängig. */
const TARGETS = { weg: 'weg', stapel: 'stapel', lesen: 'stapel', eingang: 'eingang' };
const KIND = { artikel: 'Artikel', newsletter: 'Newsletter', feed: 'Feed-Eintrag', pdf: 'PDF' };

const name = (d) => d.title || d.url;
const href = (u) => (/^https?:\/\//i.test(u ?? '') ? u : '#');
const dateLabel = (iso, tz) => new Date(iso).toLocaleDateString('de-DE', { day: 'numeric', month: 'short', timeZone: tz });

/** Beginn des heutigen Tages in der Zeitzone, als ISO-Text wie in der Datenbank. */
export function dayStart(ms, tz) {
  const { year, month, day } = zonedParts(new Date(ms), tz);
  return zonedToUtc({ year, month, day }, tz).toISOString();
}

/** „Warum hier?“: die Herkunft (`origin`) in einem Satz. */
export function whyHere(doc, { getFeed, tz }) {
  const origin = doc.origin ?? '';
  if (origin === 'kurzbefehl') return 'Über den Kurzbefehl gespeichert';
  if (origin === 'mail') return 'Per Mail';
  if (origin === 'import') return 'Importiert';
  if (origin.startsWith('feed:')) {
    const feed = getFeed(origin.slice(5));
    if (!feed) return 'Aus einem Feed';
    const month = new Date(feed.created_at).toLocaleDateString('de-DE', { month: 'long', year: 'numeric', timeZone: tz });
    return `Feed ${feed.title || feed.url}, abonniert im ${month}`;
  }
  return 'Im Cockpit gespeichert';
}

function card(d, ctx, { getFeed, more }) {
  const site = d.site || (URL.canParse(d.url) ? new URL(d.url).hostname : null);
  const meta = [
    site ? `<a href="${esc(href(d.url))}" rel="noopener noreferrer">${esc(site)}</a>` : null,
    esc(KIND[d.kind] ?? d.kind),
    d.reading_minutes ? `${d.reading_minutes} min` : null,
  ].filter(Boolean).join(' · ');
  const topics = d.topics?.length ? `<ul class="inbox-topics" aria-label="Themen">${d.topics.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>` : '';
  return `<article class="inbox-card${more ? ' more' : ''}" data-id="${esc(d.id)}">
    <p class="inbox-meta">${meta}</p>
    <h2 class="inbox-title">${esc(name(d))}</h2>
    ${d.excerpt ? `<p class="inbox-excerpt">${esc(d.excerpt)}</p>` : ''}
    ${topics}
    <p class="inbox-why"><strong>Warum hier?</strong> ${esc(whyHere(d, { getFeed, tz: ctx.tz }))} · ${esc(dateLabel(d.saved_at, ctx.tz))}</p>
  </article>`;
}

/** Knopf mit Pfeil (Wischrichtung) und Taste (nur am Desktop sichtbar). */
const arrow = (a) => `<span aria-hidden="true">${a}</span>`;
const choice = (ziel, label, key, keys, cls = '') =>
  `<button type="submit" name="ziel" value="${ziel}" class="btn${cls}" aria-keyshortcuts="${keys}">${label} <kbd aria-hidden="true">${key}</kbd></button>`;

export function renderInboxPage({ doc, left, today }, ctx, { getFeed }) {
  const write = { csrf: ctx.write.csrf, back: ctx.write.back };
  const total = today.count + left;
  const progress = total
    ? `<div class="inbox-progress"><progress max="${total}" value="${today.count}">${today.count} von ${total}</progress><span class="meta">Heute ${today.count} von ${total} gesichtet</span></div>`
    : '';
  const stack = doc
    ? card(doc, ctx, { getFeed, more: left > 1 })
    : '<div class="inbox-empty"><p class="inbox-empty-title">Eingang leer</p><p class="meta">Alles gesichtet. <a href="/lesen/stapel">Zum Stapel</a></p></div>';
  const undo = today.last
    ? `<form method="post" action="${SORT}" class="act inbox-undo">${hidden({ ...write, id: today.last.id, ziel: 'eingang' })}<button type="submit" class="btn quiet" aria-keyshortcuts="z">${arrow('↶')} Rückgängig<span class="sr-only">: ${esc(name(today.last))}</span> <kbd aria-hidden="true">Z</kbd></button></form>`
    : '';
  const decide = doc
    ? `<form method="post" action="${SORT}" class="act inbox-decide">${hidden({ ...write, id: doc.id })}
      ${choice('weg', `${arrow('←')} Weg`, 'X', 'ArrowLeft x', ' inbox-weg')}
      ${choice('stapel', `${arrow('↓')} Stapel`, 'S', 'ArrowDown s')}
      ${choice('lesen', `Jetzt lesen ${arrow('→')}`, '↵', 'ArrowRight Enter', ' primary')}
    </form>`
    : '';
  const actions = undo || decide ? `<div class="inbox-actions">${undo}${decide}</div>` : '';
  const body = `<div class="inbox">${progress}${stack}${actions}</div>
<details class="more inbox-save"${doc ? '' : ' open'}><summary>Adresse speichern</summary>${saveForm(ctx)}</details>`;
  return readingPage(ctx, { key: 'eingang', title: 'Eingang', body, scripts: [assets.inbox] });
}

/** Seite und Aktion für src/lesen/http.js. `now` nur für Tests. */
export function inboxRoutes({ store, now = () => Date.now() }) {
  return {
    pages: {
      '/lesen/eingang': async (ctx) => {
        const [doc = null] = store.list({ status: 'eingang', limit: 1 });
        const model = { doc, left: store.counts().eingang, today: store.leftInboxSince(dayStart(now(), ctx.tz)) };
        return { html: renderInboxPage(model, ctx, { getFeed: store.getFeed }) };
      },
    },
    actions: {
      async [SORT](form) {
        const ziel = form.get('ziel');
        const status = TARGETS[ziel];
        if (!status) throw new ActionError('Unbekannte Entscheidung');
        const doc = store.get(form.get('id'));
        if (!doc) throw new ActionError('Dieses Dokument gibt es nicht', 404);
        // Nur aus dem Eingang heraus und (Rückgängig) wieder hinein; doppelt abgeschickt ändert nichts.
        const from = status === 'eingang' ? ['stapel', 'weg'] : ['eingang'];
        if (doc.status !== status && !from.includes(doc.status)) {
          throw new ActionError(`${status === 'eingang' ? 'Lässt sich nicht mehr zurücklegen' : 'Liegt nicht mehr im Eingang'}: ${name(doc)}`, 409);
        }
        const r = store.setStatus(doc.id, status);
        const message = { weg: 'Weg', stapel: 'Auf dem Stapel', eingang: 'Zurück im Eingang' }[status];
        return {
          message: `${message}: ${name(doc)}`,
          doc: { id: doc.id, status: r.doc.status },
          undo: r.changed ? { action: SORT, fields: { id: doc.id, ziel: r.previous } } : null,
          redirect: ziel === 'lesen' ? `/lesen/doc?id=${encodeURIComponent(doc.id)}` : null,
        };
      },
    },
  };
}
