import { ActionError } from '../cockpit/actions.js';
import { zonedParts, zonedToUtc } from '../cockpit/week.js';
import { esc, assets } from '../web/layout.js';
import { hidden } from '../web/render.js';
import { readingPage, saveForm, keptUrl } from './pages.js';
import { groupChips, groupFilter } from './stack.js';
import { KIND_LABELS, docJson, groupsJson, jsonReply } from './json.js';
import { NO_FEED } from './store.js';

/**
 * Eingang sortieren (VCP-70): eine Karte nach der anderen, je Karte Weg,
 * Stapel oder Jetzt lesen, dazu „Im Vault ablegen“ (VCP-96) als eigenes
 * Formular. Ohne JavaScript ein Formular mit drei Knöpfen und
 * Weiterleitung; mit JavaScript schickt `/static/cockpit.js` es als JSON
 * (Formular `.act`, mit Rückgängig in der Meldung) und lädt `main` neu,
 * `/static/lesen-eingang.js` macht Wischen und Tasten daraus. `?gruppe=`
 * schränkt Karte, Zähler und „Heute x von y“ auf eine Feed-Gruppe ein
 * (VCP-97); `back` und das Neuladen tragen die Query mit.
 *
 * `/api/lesen/eingang?gruppe=` liefert dasselbe als JSON für die App.
 */

const SORT = '/aktion/lesen/sortieren';
/** `ziel` aus dem Formular → neuer Status. `eingang` ist das Rückgängig. */
const TARGETS = { weg: 'weg', stapel: 'stapel', lesen: 'stapel', eingang: 'eingang' };

const name = (d) => d.title || d.url;
const href = (u) => (/^https?:\/\//i.test(u ?? '') ? u : '#');
/** Quelle für die Kopfzeile der Karte: `site`, sonst der Host. */
const siteOf = (d) => d.site || (URL.canParse(d.url) ? new URL(d.url).hostname : null);
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
  const site = siteOf(d);
  const meta = [
    site ? `<a href="${esc(href(d.url))}" rel="noopener noreferrer" target="_blank">${esc(site)}</a>` : null,
    esc(KIND_LABELS[d.kind] ?? d.kind),
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

export function renderInboxPage({ doc, left, today, filter }, ctx, { getFeed, vault = false }) {
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
    ? `<form method="post" action="${SORT}" class="act inbox-decide wisch" data-links="weg" data-unten="stapel" data-rechts="lesen">${hidden({ ...write, id: doc.id })}
      ${choice('weg', `${arrow('←')} Weg`, 'X', 'ArrowLeft x', ' inbox-weg')}
      ${choice('stapel', `${arrow('↓')} Stapel`, 'S', 'ArrowDown s')}
      ${choice('lesen', `Jetzt lesen ${arrow('→')}`, '↵', 'ArrowRight Enter', ' primary')}
    </form>`
    : '';
  // Im Vault ablegen (VCP-96): ein Knopf, kein Wischen; die Aktion steht in src/lesen/doc.js.
  const file = doc && vault
    ? `<form method="post" action="/aktion/lesen/ablegen" class="act inbox-ablegen">${hidden({ ...write, id: doc.id })}<button type="submit" class="btn quiet" aria-keyshortcuts="a">Im Vault ablegen <kbd aria-hidden="true">A</kbd></button></form>`
    : '';
  const row = undo || file ? `<div class="inbox-row">${undo}${file}</div>` : '';
  const actions = row || decide ? `<div class="inbox-actions">${row}${decide}</div>` : '';
  const body = `${groupChips('/lesen/eingang', filter)}<div class="inbox">${progress}${stack}${actions}</div>
<details class="more inbox-save"${doc && !keptUrl(ctx) ? '' : ' open'}><summary>Adresse speichern</summary>${saveForm(ctx)}</details>`;
  return readingPage(ctx, { key: 'eingang', title: 'Eingang', body, scripts: [assets.inbox] });
}

/**
 * Eingang als JSON: oberste Karte (mit Herkunft in einem Satz und Feed),
 * „Heute x von y gesichtet“, Rückgängig der letzten Entscheidung von heute,
 * Gruppen mit ihren Zählern und der aktive Filter.
 */
function inboxJson({ doc, left, today, filter }, { store, tz, vault }) {
  const feed = doc?.origin?.startsWith('feed:') ? store.getFeed(doc.origin.slice(5)) : null;
  const perGroup = store.inboxByGroup();
  return {
    ok: true,
    doc: doc && {
      ...docJson(doc),
      siteLabel: siteOf(doc),
      why: whyHere(doc, { getFeed: store.getFeed, tz }),
      savedLabel: dateLabel(doc.saved_at, tz),
      feed: feed && { id: feed.id, title: feed.title ?? null, url: feed.url, siteUrl: feed.site_url ?? null, groupId: feed.group_id ?? null },
    },
    left,
    more: left > 1,
    today: { seen: today.count, total: today.count + left, last: today.last },
    undo: today.last ? { action: SORT, fields: { id: today.last.id, ziel: 'eingang' } } : null,
    filter: { gruppe: filter.group },
    groups: groupsJson(filter.groups).map((g) => ({ ...g, count: perGroup[g.id] ?? 0 })),
    noFeedCount: store.counts({ group: NO_FEED }).eingang,
    showGroups: filter.groups.length > 0 || Boolean(filter.group),
    vault,
  };
}

/** Seite, JSON und Aktion für src/lesen/http.js; `vault` zeigt „Im Vault ablegen“. `now` nur für Tests. */
export function inboxRoutes({ store, vault = false, now = () => Date.now() }) {
  const model = (ctx) => {
    const filter = groupFilter(store, ctx.url);
    const { group } = filter;
    const [doc = null] = store.list({ status: 'eingang', group, limit: 1 });
    return { doc, left: store.counts({ group }).eingang, today: store.leftInboxSince(dayStart(now(), ctx.tz), { group }), filter };
  };
  return {
    pages: {
      '/lesen/eingang': async (ctx) => ({ html: renderInboxPage(model(ctx), ctx, { getFeed: store.getFeed, vault }) }),
      '/api/lesen/eingang': async (ctx) => jsonReply(200, inboxJson(model(ctx), { store, tz: ctx.tz, vault })),
    },
    actions: {
      async [SORT](form) {
        const ziel = form.get('ziel');
        const status = TARGETS[ziel];
        if (!status) throw new ActionError('Unbekannte Entscheidung');
        const doc = store.get(form.get('id'));
        if (!doc) throw new ActionError('Dieses Dokument gibt es nicht', 404);
        // Nur aus dem Eingang heraus und (Rückgängig) wieder hinein; doppelt abgeschickt ändert nichts.
        const from = status === 'eingang' ? ['stapel', 'weg', 'abgelegt'] : ['eingang'];
        if (doc.status !== status && !from.includes(doc.status)) {
          throw new ActionError(`${status === 'eingang' ? 'Lässt sich nicht mehr zurücklegen' : 'Liegt nicht mehr im Eingang'}: ${name(doc)}`, 409);
        }
        const r = store.setStatus(doc.id, status);
        const message = { weg: 'Weg', stapel: 'Auf dem Stapel', eingang: 'Zurück im Eingang' }[status];
        return {
          message: `${message}: ${name(doc)}${r.changed && r.previous === 'abgelegt' ? ' (die Notiz im Vault bleibt)' : ''}`,
          doc: { id: doc.id, status: r.doc.status },
          undo: r.changed ? { action: SORT, fields: { id: doc.id, ziel: r.previous } } : null,
          redirect: ziel === 'lesen' ? `/lesen/doc?id=${encodeURIComponent(doc.id)}` : null,
        };
      },
    },
  };
}
