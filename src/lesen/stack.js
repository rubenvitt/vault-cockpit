import { esc, assets } from '../web/layout.js';
import { hidden } from '../web/render.js';
import { readingPage } from './pages.js';
import { NO_FEED } from './store.js';
import { docJson, groupsJson, jsonReply } from './json.js';
import { ingestBadge } from './ingest-page.js';

/**
 * Stapel nach Zeitfenster (VCP-72): `/lesen/stapel?zeit=15` füllt die Zeit
 * mit passenden Texten, ohne `zeit` steht der ganze Stapel da, sortiert nach
 * `?sort=passt|neu|kurz`. Links und je Eintrag „Im Vault ablegen“ als
 * Formular (VCP-96), funktioniert ohne JavaScript. `?gruppe=` schränkt auf
 * eine Feed-Gruppe oder „ohne Feed“ ein (VCP-97), auch im Eingang.
 * `/api/lesen/stapel` liefert dieselbe Auswahl als JSON für die App.
 * Mit dem Ingest-Dienst trägt jeder Eintrag ein Abzeichen („Ingest bereit“,
 * „wird entworfen…“, „Ingest-Fehler“) oder den Knopf „Ingest entwerfen“
 * (src/lesen/ingest-page.js), gefragt mit einer Abfrage für den ganzen Stapel.
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

/**
 * Was `/lesen/stapel` zeigt, für Seite und JSON: mit Zeitfenster `zeit` die
 * passenden Texte (`total` Minuten, `rest` weitere warten), passt nichts, nur
 * der kürzeste (`fits: false`); ohne Zeitfenster alle nach `sort`.
 */
export function stackSelection(docs, { zeit = null, sort = 'passt' } = {}) {
  if (zeit) {
    const { items, total } = fitToWindow(docs, zeit);
    if (!items.length) {
      const [shortest = docs[0]] = docs.filter(known).map((d) => ({ ...d, remaining: remainingMinutes(d) })).sort((a, b) => a.remaining - b.remaining);
      return { items: shortest ? [shortest] : [], total: 0, rest: 0, fits: false };
    }
    return { items, total, rest: docs.length - items.length, fits: true };
  }
  const all = docs.map((d) => ({ ...d, remaining: remainingMinutes(d) }));
  // `neu`: Reihenfolge aus dem Speicher, neueste zuerst.
  if (sort === 'kurz') all.sort((a, b) => a.remaining - b.remaining);
  if (sort === 'passt') all.sort(fitsNow);
  return { items: all, total: null, rest: 0, fits: true };
}

function windowBody({ items, total, rest, fits }, zeit, file) {
  if (!fits) return `<p class="empty">Nichts passt ganz – lies den Anfang eines längeren Textes</p>${list(items, file)}`;
  return `<div class="stapel-fill">
    <progress class="stapel-bar" value="${total}" max="${zeit}" aria-hidden="true"></progress>
    <span class="meta">${total} von ${zeit} Min.</span>
  </div>
  ${list(items, file)}
  ${rest ? `<p class="meta stapel-rest">${rest} weitere warten</p>` : ''}`;
}

function allBody({ items }, sort, file, gruppe) {
  const sorter = `<nav class="chips stapel-sort" aria-label="Sortierung">${SORTS.map(([key, label]) => chip(link('/lesen/stapel', { sort: key, gruppe }), label, sort === key)).join('')}</nav>`;
  return `${sorter}${list(items, file)}`;
}

/** Eintrag des Stapels als JSON: Restzeit (`null` ohne bekannte Lesezeit) und ob angefangen. */
export const stackItemJson = (d) => ({ ...docJson(d), remaining: known(d) ? (d.remaining ?? remainingMinutes(d)) : null, started: started(d) });

/** `statusFor` liefert eine Map; ein schlichtes Objekt geht auch. */
const statusIn = (m, id) => (m instanceof Map ? m.get(id) : m?.[id]) ?? null;

export function stackRoutes({ store, vault = false, folgen = false, ingest = null }) {
  /** Zeitfenster, Sortierung und Gruppe aus der Query, dazu die Texte des Stapels. */
  const query = (url) => {
    const zeit = Number(url.searchParams.get('zeit'));
    const minutes = WINDOWS.includes(zeit) ? zeit : null;
    const sortParam = url.searchParams.get('sort');
    const sort = SORTS.some(([key]) => key === sortParam) ? sortParam : 'passt';
    // SQLite: LIMIT -1 heißt ohne Grenze; kurze Texte sollen auch hinter den neuesten 100 passen.
    const filter = groupFilter(store, url);
    const docs = store.list({ status: 'stapel', group: filter.group, limit: -1 });
    return { minutes, sortParam, sort, filter, docs };
  };
  return {
    pages: {
      async '/lesen/stapel'(ctx) {
        const { minutes, sortParam, sort, filter, docs } = query(ctx.url);
        // Im Vault ablegen (VCP-96): je Eintrag ein Formular, die Aktion steht in src/lesen/doc.js.
        const ablegen = vault
          ? (d) => `<form method="post" action="/aktion/lesen/ablegen" class="act lesen-ablegen">${hidden({ csrf: ctx.write.csrf, back: ctx.write.back, id: d.id })}<button type="submit" class="btn quiet">Im Vault ablegen<span class="sr-only">: ${esc(d.title || d.url)}</span></button></form>`
          : null;
        let file = ablegen;
        if (ingest) {
          const statuses = ingest.statusFor(docs.map((d) => d.id));
          const available = Boolean(ingest.available()?.ok);
          const badge = (d) => ingestBadge(d.id, statusIn(statuses, d.id), { ctx, title: d.title || d.url, available });
          file = (d) => {
            const parts = [badge(d), ablegen ? ablegen(d) : ''].filter(Boolean).join('');
            return parts ? `<div class="lesen-item-acts">${parts}</div>` : '';
          };
        }
        const selection = stackSelection(docs, { zeit: minutes, sort });
        const content = !docs.length ? '<p class="empty">Auf dem Stapel liegt nichts.</p>' : minutes ? windowBody(selection, minutes, file) : allBody(selection, sort, file, filter.group);
        const groups = groupChips('/lesen/stapel', filter, { zeit: minutes, sort: sortParam === sort && !minutes ? sort : null });
        // „Unterwegs hören“ ohne `gruppe`: /lesen/hoeren kennt nur `zeit`.
        return { html: readingPage(ctx, { key: 'stapel', title: 'Stapel', body: `<section>${groups}${windowPicker(minutes, filter.group)}<p class="stapel-hoeren"><a href="/lesen/hoeren?zeit=${minutes ?? 15}" class="btn quiet">Unterwegs hören</a>${folgen ? ` <a href="/lesen/folgen/neu?zeit=${minutes ?? 30}" class="btn quiet">Folge erzeugen</a>` : ''}</p>${content}</section>`, scripts: ingest ? [assets.lesenIngest] : [] }) };
      },
      /** Stapel als JSON: Einträge mit Restzeit, beim Zeitfenster `window` (x von y Min., n weitere, ob etwas passt). */
      async '/api/lesen/stapel'(ctx) {
        const { minutes, sort, filter, docs } = query(ctx.url);
        const { items, total, rest, fits } = stackSelection(docs, { zeit: minutes, sort });
        const statuses = ingest ? ingest.statusFor(items.map((d) => d.id)) : null;
        return jsonReply(200, {
          ok: true,
          zeit: minutes,
          sort,
          windows: WINDOWS,
          sorts: SORTS.map(([key, label]) => ({ key, label })),
          filter: { gruppe: filter.group },
          groups: groupsJson(filter.groups),
          showGroups: filter.groups.length > 0 || Boolean(filter.group),
          count: docs.length,
          // `ingest`: Status des Entwurfs (`bereit`, `entwirft` …) oder null; ohne Dienst fehlt das Feld.
          items: items.map((d) => (ingest ? { ...stackItemJson(d), ingest: statusIn(statuses, d.id) } : stackItemJson(d))),
          ingest: Boolean(ingest),
          // Claude angebunden: „Ingest entwerfen“ geht (wie der Knopf im Stapel).
          ingestAvailable: Boolean(ingest?.available()?.ok),
          window: minutes ? { used: total, of: minutes, more: rest, fits } : null,
          vault,
          episodes: folgen,
          // Zeitfenster für „Unterwegs hören“ und „Folge erzeugen“ wie die Knöpfe der Seite.
          listenZeit: minutes ?? 15,
          episodeZeit: minutes ?? 30,
        });
      },
    },
    actions: {},
  };
}
