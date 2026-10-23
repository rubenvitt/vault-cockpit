import { esc } from '../web/layout.js';
import { hidden } from '../web/render.js';
import { readingPage } from './pages.js';
import { NO_FEED } from './store.js';

/**
 * Stapel nach Zeitfenster (VCP-72): `/lesen/stapel?zeit=15` füllt die Zeit
 * mit passenden Texten, ohne `zeit` steht der ganze Stapel da, sortiert nach
 * `?sort=passt|neu|kurz`. Links und je Eintrag „Im Vault ablegen“ als
 * Formular (VCP-96), funktioniert ohne JavaScript. `?gruppe=` schränkt auf
 * eine Feed-Gruppe oder „ohne Feed“ ein (VCP-97), auch im Eingang.
 */

export const WINDOWS = [5, 15, 30, 60];
const SORTS = [
  ['passt', 'Passt jetzt'],
  ['neu', 'Neueste'],
  ['kurz', 'Kürzeste'],
];

const started = (doc) => doc.progress > 0;
// Lesezeit 0 heißt unbekannt (kein Text extrahiert): passt in kein Fenster.
const known = (doc) => doc.reading_minutes > 0;

/** Restzeit in Minuten: Lesezeit × (1 − Fortschritt), aufgerundet, mindestens 1. */
export const remainingMinutes = (doc) => Math.max(1, Math.ceil((doc.reading_minutes ?? 0) * (1 - (doc.progress ?? 0))));

/** Angefangene zuerst, dann nach Restzeit aufsteigend. */
const fitsNow = (a, b) => started(b) - started(a) || a.remaining - b.remaining;

/** Die ersten `n` in der Reihenfolge „Passt jetzt“, z. B. für den Offline-Cache (VCP-80). */
export const upNext = (docs, n) => docs.map((d) => ({ ...d, remaining: remainingMinutes(d) })).sort(fitsNow).slice(0, n);

/**
 * Auswahl für ein Zeitfenster von `minutes` Minuten: erst angefangene Texte
 * (kürzeste Restzeit zuerst), dann die übrigen, längste zuerst, solange sie
 * noch passen (gieriges Auffüllen). Die Summe bleibt ≤ `minutes`; Texte
 * ohne Lesezeit bleiben draußen.
 * Liefert `{ items: [{ ...doc, remaining }], total }`, `remaining` in Minuten.
 */
export function fitToWindow(docs, minutes) {
  const all = docs.filter(known).map((doc) => ({ ...doc, remaining: remainingMinutes(doc) }));
  const ordered = [...all.filter(started).sort((a, b) => a.remaining - b.remaining), ...all.filter((d) => !started(d)).sort((a, b) => b.remaining - a.remaining)];
  const items = [];
  let total = 0;
  for (const doc of ordered) {
    if (total + doc.remaining > minutes) continue;
    items.push(doc);
    total += doc.remaining;
  }
  return { items, total };
}

/** Ein Eintrag: Titel zur Leseansicht, bei angefangenen „Weiterlesen“ mit Restzeit. */
function stackItem(d, file) {
  const minutes = known(d) ? `${started(d) ? 'noch ' : ''}${d.remaining} Min.` : null;
  const meta = [started(d) ? 'Weiterlesen' : null, minutes, d.site].filter(Boolean).map(esc).join(' · ');
  return `<li class="lesen-item">
    <a href="/lesen/doc?id=${encodeURIComponent(d.id)}${started(d) ? '#weiter' : ''}" class="lesen-title">${esc(d.title || d.url)}</a>
    <span class="meta">${meta}</span>${file ? file(d) : ''}
  </li>`;
}

const list = (docs, file) => `<ul class="lesen-list">${docs.map((d) => stackItem(d, file)).join('')}</ul>`;

const chip = (href, label, current) => `<a href="${esc(href)}" class="chip"${current ? ' aria-current="true"' : ''}>${label}</a>`;

/** Adresse mit Query; leere Werte fallen weg. */
const link = (path, params) => {
  const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null)).toString();
  return q ? `${path}?${q}` : path;
};

/** `?gruppe=`: eine bekannte Gruppen-ID oder `ohne`, alles andere heißt ungefiltert (`group: null`). */
export function groupFilter(store, url) {
  const groups = store.listGroups();
  const g = url.searchParams.get('gruppe');
  return { groups, group: g === NO_FEED || groups.some((x) => x.id === g) ? g : null };
}

/** Chips Alle · je Gruppe · Ohne Feed, nur mit Gruppen oder aktivem Filter; `params` bleiben erhalten. */
export function groupChips(path, { groups, group }, params = {}) {
  if (!groups.length && !group) return '';
  const to = (gruppe) => link(path, { ...params, gruppe });
  const links = [chip(to(null), 'Alle', !group), ...groups.map((g) => chip(to(g.id), esc(g.name), group === g.id)), chip(to(NO_FEED), 'Ohne Feed', group === NO_FEED)];
  return `<nav class="chips lesen-gruppe" aria-label="Gruppe">${links.join('')}</nav>`;
}

function windowPicker(zeit, gruppe) {
  const links = [chip(link('/lesen/stapel', { gruppe }), 'Alle', !zeit), ...WINDOWS.map((m) => chip(link('/lesen/stapel', { zeit: m, gruppe }), `${m} Min.`, zeit === m))];
  return `<nav class="chips stapel-zeit" aria-label="Zeitfenster">${links.join('')}</nav>`;
}

function windowBody(docs, zeit, file) {
  const { items, total } = fitToWindow(docs, zeit);
  if (!items.length) {
    const [shortest = docs[0]] = docs.filter(known).map((d) => ({ ...d, remaining: remainingMinutes(d) })).sort((a, b) => a.remaining - b.remaining);
    return `<p class="empty">Nichts passt ganz – lies den Anfang eines längeren Textes</p>${list([shortest], file)}`;
  }
  const rest = docs.length - items.length;
  return `<div class="stapel-fill">
    <progress class="stapel-bar" value="${total}" max="${zeit}" aria-hidden="true"></progress>
    <span class="meta">${total} von ${zeit} Min.</span>
  </div>
  ${list(items, file)}
  ${rest ? `<p class="meta stapel-rest">${rest} weitere warten</p>` : ''}`;
}

function allBody(docs, sort, file, gruppe) {
  const all = docs.map((d) => ({ ...d, remaining: remainingMinutes(d) }));
  // `neu`: Reihenfolge aus dem Speicher, neueste zuerst.
  if (sort === 'kurz') all.sort((a, b) => a.remaining - b.remaining);
  if (sort === 'passt') all.sort(fitsNow);
  const sorter = `<nav class="chips stapel-sort" aria-label="Sortierung">${SORTS.map(([key, label]) => chip(link('/lesen/stapel', { sort: key, gruppe }), label, sort === key)).join('')}</nav>`;
  return `${sorter}${list(all, file)}`;
}

export function stackRoutes({ store, vault = false, folgen = false }) {
  return {
    pages: {
      async '/lesen/stapel'(ctx) {
        const zeit = Number(ctx.url.searchParams.get('zeit'));
        const minutes = WINDOWS.includes(zeit) ? zeit : null;
        const sortParam = ctx.url.searchParams.get('sort');
        const sort = SORTS.some(([key]) => key === sortParam) ? sortParam : 'passt';
        // SQLite: LIMIT -1 heißt ohne Grenze; kurze Texte sollen auch hinter den neuesten 100 passen.
        const filter = groupFilter(store, ctx.url);
        const docs = store.list({ status: 'stapel', group: filter.group, limit: -1 });
        // Im Vault ablegen (VCP-96): je Eintrag ein Formular, die Aktion steht in src/lesen/doc.js.
        const file = vault
          ? (d) => `<form method="post" action="/aktion/lesen/ablegen" class="act lesen-ablegen">${hidden({ csrf: ctx.write.csrf, back: ctx.write.back, id: d.id })}<button type="submit" class="btn quiet">Im Vault ablegen<span class="sr-only">: ${esc(d.title || d.url)}</span></button></form>`
          : null;
        const content = !docs.length ? '<p class="empty">Auf dem Stapel liegt nichts.</p>' : minutes ? windowBody(docs, minutes, file) : allBody(docs, sort, file, filter.group);
        const groups = groupChips('/lesen/stapel', filter, { zeit: minutes, sort: sortParam === sort && !minutes ? sort : null });
        // „Unterwegs hören“ ohne `gruppe`: /lesen/hoeren kennt nur `zeit`.
        return { html: readingPage(ctx, { key: 'stapel', title: 'Stapel', body: `<section>${groups}${windowPicker(minutes, filter.group)}<p class="stapel-hoeren"><a href="/lesen/hoeren?zeit=${minutes ?? 15}" class="btn quiet">Unterwegs hören</a>${folgen ? ` <a href="/lesen/folgen/neu?zeit=${minutes ?? 30}" class="btn quiet">Folge erzeugen</a>` : ''}</p>${content}</section>` }) };
      },
    },
    actions: {},
  };
}
