import { ActionError } from '../cockpit/actions.js';
import { esc, assets } from '../web/layout.js';
import { hidden } from '../web/render.js';
import { when } from '../web/health-render.js';
import { maskSecrets } from '../health/mask.js';
import { FetchError, splitCredentials } from './fetch.js';
import { ReadingError } from './store.js';
import { readingPage } from './pages.js';
import { discoverFeed, fetchFeedDefault, rememberBacklog, DEFAULT_INTERVAL, AUTO_PAUSE_ERRORS } from './feeds.js';
import { parseOpml, toOpml } from './opml.js';
import { jsonReply } from './json.js';

/**
 * Seite „Feeds“ unter Lesen (VCP-78): abonnieren (Feed- oder Website-Adresse),
 * je Feed pausieren, direkt auf den Stapel, Stichwort-Filter, Abstand,
 * entfernen; OPML importieren und exportieren. Abgerufen wird im Hintergrund
 * (src/lesen/feeds.js), ein neuer Feed ist beim nächsten Durchgang dran.
 * Gruppen (VCP-97): anlegen, umbenennen, ordnen, löschen; Pausieren und
 * „direkt auf den Stapel“ einer Gruppe gelten zusätzlich für alle ihre Feeds.
 * Sammeln (VCP-110): Feeds abhaken und gemeinsam verschieben, pausieren,
 * einstellen oder entfernen. Die Häkchen gehören über `form=` zum Formular der
 * Leiste unten, so geht es auch ohne JavaScript; Entfernen fragt vorher nach
 * (mit JavaScript im Dialog, sonst auf `/lesen/feeds/entfernen`).
 * src/web/static/lesen-feeds.js ergänzt Suche, „Alle auswählen“ und Zähler.
 *
 * Private Feeds: Zugangsdaten gehen in der Adresse (`https://name:passwort@…`,
 * auch aus OPML) oder in den Einstellungen des Feeds; gespeichert werden sie
 * getrennt und verschlüsselt (`store.setFeedAuth`), gezeigt wird nur, dass es
 * welche gibt.
 *
 * Für die App: `/api/lesen/feeds` liefert Gruppen (Reihenfolge, Flags, neue
 * Einträge) mit ihren Feeds und die ohne Gruppe als JSON (`feedsJson`),
 * `/api/lesen/feeds.opml` den Export; die Aktionen gelten mit Geräte-Token und
 * antworten mit `Accept: application/json` als JSON (src/web/http.js).
 */

const back = '/lesen/feeds';
const MIN_INTERVAL = 5;
const MAX_INTERVAL = 24 * 60;
/** Größte OPML-Datei für den Import. */
const MAX_OPML = 2 * 1024 * 1024;
/** Formular der Sammelleiste; die Häkchen der Feeds zeigen mit `form=` darauf. */
const BULK = 'feeds-auswahl';
/** Wert von `ziel` für „neue Gruppe anlegen“ (IDs sind nie so kurz). */
const NEW_GROUP = 'neu';
const feedsWord = (n) => `${n} ${n === 1 ? 'Feed' : 'Feeds'}`;

const asAction = async (run) => {
  try {
    return await run();
  } catch (err) {
    if (err instanceof FetchError) throw new ActionError(err.message, err.status);
    if (err instanceof ReadingError) throw new ActionError(err.message, 400);
    throw err;
  }
};

const host = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
};
// Icons liegen als data:-Adresse vor (aus feeds.js); alles andere zeigt den Anfangsbuchstaben.
const iconOf = (f) =>
  /^data:image\/[\w.+-]+;base64,/.test(f.icon ?? '')
    ? `<img src="${esc(f.icon)}" alt="" class="feed-icon" width="20" height="20">`
    : `<span class="feed-icon feed-letter" aria-hidden="true">${esc((f.title || host(f.url)).slice(0, 1).toUpperCase())}</span>`;

/** Zustand eines Feeds: `kind` (`paused`, `groupPaused`, `error`, `ok`, `new`) und der Text der Seite. */
function feedState(f, tz, now = Date.now()) {
  if (f.paused && f.error_count >= AUTO_PAUSE_ERRORS) return { kind: 'paused', text: `nach ${f.error_count} Fehlern pausiert: ${maskSecrets(f.last_error, { max: 160 })}` };
  if (f.paused) return { kind: 'paused', text: 'pausiert' };
  if (f.group_paused) return { kind: 'groupPaused', text: 'pausiert (Gruppe)' };
  if (f.error_count) return { kind: 'error', text: `Fehler (${f.error_count}×): ${maskSecrets(f.last_error, { max: 160 })}` };
  return f.last_fetch_at ? { kind: 'ok', text: `abgerufen ${when(f.last_fetch_at, tz, now)}` } : { kind: 'new', text: 'noch nicht abgerufen' };
}
const status = (f, tz) => feedState(f, tz).text;

/** Kurzinfo unter dem Titel: Host, Abstand, „direkt auf den Stapel“, Filter. */
const metaOf = (f) => [host(f.url), f.has_auth ? 'mit Zugangsdaten' : null, `alle ${f.interval_minutes} min`, f.to_stack ? 'direkt auf den Stapel' : f.group_to_stack ? 'direkt auf den Stapel (Gruppe)' : null, f.keyword_filter ? `nur „${f.keyword_filter}“` : null].filter(Boolean).join(' · ');

/** Ein Feed für die App; Fehler maskiert wie auf der Seite, Icon nur als data:-Adresse. */
export function feedJson(f, tz, now = Date.now()) {
  const state = feedState(f, tz, now);
  return {
    id: f.id,
    url: f.url,
    host: host(f.url),
    siteUrl: /^https?:\/\//i.test(f.site_url ?? '') ? f.site_url : null,
    title: f.title || host(f.url),
    icon: /^data:image\/[\w.+-]+;base64,/.test(f.icon ?? '') ? f.icon : null,
    letter: (f.title || host(f.url)).slice(0, 1).toUpperCase(),
    paused: f.paused,
    toStack: f.to_stack,
    keywordFilter: f.keyword_filter ?? null,
    hasAuth: f.has_auth ?? false,
    intervalMinutes: f.interval_minutes,
    groupId: f.group_id ?? null,
    groupPaused: f.group_paused,
    groupToStack: f.group_to_stack,
    lastFetchAt: f.last_fetch_at ?? null,
    nextFetchAt: f.next_fetch_at ?? null,
    errorCount: f.error_count ?? 0,
    lastError: f.error_count ? maskSecrets(f.last_error, { max: 160 }) : null,
    state: state.kind,
    status: state.text,
    meta: metaOf(f),
  };
}

/**
 * Seite „Feeds“ als JSON: `groups` in ihrer Reihenfolge, je mit `inbox` (neue Einträge
 * im Eingang), Flags und ihren Feeds; `ungrouped` die Feeds ohne Gruppe; `limits` für
 * den Abstand in Minuten; `opml` die Adresse des Exports; `bulk` das Sammeln (VCP-110):
 * Weg der Aktion, die Werte von `tun` und der Wert von `ziel` für „neue Gruppe“.
 */
export function feedsJson({ feeds, groups = [], inbox = {} }, tz, now = Date.now()) {
  const items = feeds.map((f) => feedJson(f, tz, now));
  return {
    groups: groups.map((g, i) => ({
      id: g.id,
      name: g.name,
      position: i,
      paused: g.paused,
      toStack: g.to_stack,
      flags: [g.paused ? 'pausiert' : null, g.to_stack ? 'direkt auf den Stapel' : null].filter(Boolean).join(' · ') || null,
      inbox: inbox[g.id] ?? 0,
      canMoveUp: i > 0,
      canMoveDown: i < groups.length - 1,
      feeds: items.filter((f) => f.groupId === g.id),
    })),
    ungrouped: items.filter((f) => !f.groupId || !groups.some((g) => g.id === f.groupId)),
    total: items.length,
    limits: { minInterval: MIN_INTERVAL, maxInterval: MAX_INTERVAL, defaultInterval: DEFAULT_INTERVAL, maxOpmlBytes: MAX_OPML },
    opml: '/api/lesen/feeds.opml',
    bulk: { action: '/aktion/lesen/feeds/auswahl', actions: ACTIONS.map(([v]) => v), newGroup: NEW_GROUP },
  };
}

/** Auswahl der Gruppe; ohne Gruppen gibt es nichts zu wählen. */
const groupSelect = (groups, selected, label) =>
  groups.length
    ? `<label class="feed-field">${label}<select name="gruppe"><option value="">ohne Gruppe</option>${groups.map((g) => `<option value="${esc(g.id)}"${g.id === selected ? ' selected' : ''}>${esc(g.name)}</option>`).join('')}</select></label>`
    : '';

function feedItem(f, ctx, groups) {
  const token = hidden({ csrf: ctx.write.csrf, back, id: f.id });
  const title = f.title || host(f.url);
  const group = groups.find((g) => g.id === f.group_id)?.name ?? '';
  const search = [title, host(f.url), group].join(' ').toLocaleLowerCase('de');
  const link = /^https?:\/\//i.test(f.site_url ?? '') ? `<a href="${esc(f.site_url)}" class="lesen-title" rel="noopener noreferrer" target="_blank">${esc(title)}</a>` : `<span class="lesen-title">${esc(title)}</span>`;
  const meta = esc(metaOf(f));
  return `<li class="lesen-item feed${f.error_count ? ' feed-failing' : ''}" data-suche="${esc(search)}"${f.error_count ? ' data-fehler' : ''}>
    <div class="feed-head"><input type="checkbox" name="feed" value="${esc(f.id)}" form="${BULK}" class="feed-pick" aria-label="Auswählen: ${esc(title)}">${iconOf(f)}${link}</div>
    <span class="meta">${meta}</span>
    <span class="meta feed-status">${esc(status(f, ctx.tz))}</span>
    <details class="feed-edit"><summary>Einstellungen</summary>
      <form method="post" action="/aktion/lesen/feed/aendern" class="feed-form">${token}
        <label class="feed-field"><span>Adresse <span class="hint">Feed oder Website, wird beim Speichern geprüft</span></span><input name="url" type="url" value="${esc(f.url)}" required autocomplete="off" spellcheck="false" inputmode="url"></label>
        <fieldset class="feed-auth"><legend>Zugangsdaten <span class="hint">${f.has_auth ? 'gespeichert, verschlüsselt; leer lassen behält sie' : 'nur für private Feeds, werden verschlüsselt gespeichert'}</span></legend>
          <label class="feed-field"><span>Benutzername</span><input name="benutzer" autocomplete="off" spellcheck="false"${f.has_auth ? ' placeholder="gespeichert"' : ''}></label>
          <label class="feed-field"><span>Passwort oder Token</span><input name="passwort" type="password" autocomplete="new-password"${f.has_auth ? ' placeholder="gespeichert"' : ''}></label>
          ${f.has_auth ? '<label class="feed-check"><input type="checkbox" name="ohne_zugang" value="1"> Zugangsdaten löschen</label>' : ''}
        </fieldset>
        <label class="feed-check"><input type="checkbox" name="pausiert" value="1"${f.paused ? ' checked' : ''}> Pausiert</label>
        <label class="feed-check"><input type="checkbox" name="stapel" value="1"${f.to_stack ? ' checked' : ''}> Direkt auf den Stapel</label>
        <label class="feed-field"><span>Stichwort-Filter <span class="hint">durch Komma getrennt, leer = alles</span></span><input name="filter" value="${esc(f.keyword_filter ?? '')}" autocomplete="off"></label>
        <label class="feed-field"><span>Abstand in Minuten</span><input name="intervall" type="number" min="${MIN_INTERVAL}" max="${MAX_INTERVAL}" value="${esc(f.interval_minutes)}" inputmode="numeric"></label>
        ${groupSelect(groups, f.group_id, '<span>Gruppe</span>')}
        <p class="feed-actions"><button type="submit" class="btn">Speichern</button></p>
      </form>
      <form method="post" action="/aktion/lesen/feed/entfernen" data-confirm="${esc(`„${title}“ entfernen? Gespeicherte Artikel bleiben.`)}">${token}<button type="submit" class="btn quiet danger">Feed entfernen</button></form>
    </details>
  </li>`;
}

/** „Alle auswählen“ für einen Abschnitt; erst mit JavaScript sichtbar. */
const pickAll = (label) => `<label class="feed-check feed-pick-all" hidden><input type="checkbox" data-alle> ${esc(label)}</label>`;
const feedList = (feeds, ctx, groups, empty) =>
  feeds.length ? `${pickAll('Alle hier auswählen')}<ul class="lesen-list">${feeds.map((f) => feedItem(f, ctx, groups)).join('')}</ul>` : `<p class="empty">${empty}</p>`;

function groupSection(g, i, { feeds, groups, inbox, ctx }) {
  const token = hidden({ csrf: ctx.write.csrf, back, id: g.id });
  const n = inbox[g.id] ?? 0;
  const flags = [g.paused ? 'pausiert' : null, g.to_stack ? 'direkt auf den Stapel' : null].filter(Boolean).join(' · ');
  return `<details open class="feed-group" data-gruppe>
  <summary><span class="feed-group-name">${esc(g.name)}</span> <span class="count-badge">${n} neu</span></summary>
  <p class="meta"><a href="/lesen/eingang?gruppe=${encodeURIComponent(g.id)}">${n} ${n === 1 ? 'neuer Eintrag' : 'neue Einträge'} im Eingang</a>${flags ? ` · ${esc(flags)}` : ''}</p>
  ${feedList(feeds.filter((f) => f.group_id === g.id), ctx, groups, 'Noch keine Feeds in dieser Gruppe.')}
  <details class="feed-edit"><summary>Gruppe bearbeiten</summary>
    <form method="post" action="/aktion/lesen/gruppe/aendern" class="feed-form">${token}
      <label class="feed-field"><span>Name</span><input name="name" value="${esc(g.name)}" required autocomplete="off"></label>
      <label class="feed-check"><input type="checkbox" name="pausiert" value="1"${g.paused ? ' checked' : ''}> Pausiert</label>
      <label class="feed-check"><input type="checkbox" name="stapel" value="1"${g.to_stack ? ' checked' : ''}> Direkt auf den Stapel</label>
      <p class="hint">Gilt für alle Feeds der Gruppe, zusätzlich zu deren eigener Einstellung.</p>
      <p class="feed-actions"><button type="submit" class="btn">Speichern</button></p>
    </form>
    <form method="post" action="/aktion/lesen/gruppe/verschieben" class="feed-actions">${token}
      <button type="submit" name="richtung" value="hoch" class="btn quiet"${i === 0 ? ' disabled' : ''}>Nach oben<span class="sr-only">: ${esc(g.name)}</span></button>
      <button type="submit" name="richtung" value="runter" class="btn quiet"${i === groups.length - 1 ? ' disabled' : ''}>Nach unten<span class="sr-only">: ${esc(g.name)}</span></button>
    </form>
    <form method="post" action="/aktion/lesen/gruppe/entfernen" data-confirm="${esc(`Gruppe „${g.name}“ löschen? Die Feeds bleiben, dann ohne Gruppe.`)}">${token}<button type="submit" class="btn quiet danger">Gruppe löschen</button> <span class="hint">Die Feeds bleiben, dann ohne Gruppe.</span></form>
  </details>
</details>`;
}

/** `inbox`: neue Einträge im Eingang je Gruppe (`store.inboxByGroup()`). */
export function renderFeeds({ feeds, groups = [], inbox = {} }, ctx) {
  const token = hidden({ csrf: ctx.write.csrf, back });
  let list;
  if (!feeds.length && !groups.length) list = '<p class="empty">Noch keine Feeds abonniert.</p>';
  else if (!groups.length) list = feedList(feeds, ctx, groups);
  else {
    const loose = feeds.filter((f) => !f.group_id);
    list = groups.map((g, i) => groupSection(g, i, { feeds, groups, inbox, ctx })).join('\n');
    if (loose.length) list += `\n<details open class="feed-group" data-gruppe><summary><span class="feed-group-name">Ohne Gruppe</span></summary>${feedList(loose, ctx, groups)}</details>`;
  }
  const body = `<section>
  <form method="post" action="/aktion/lesen/feed/abonnieren" class="lesen-save">${token}
    <label class="lesen-url"><span class="sr-only">Adresse eines Feeds oder einer Website</span><input type="url" name="url" required placeholder="https://… Feed oder Website" inputmode="url" autocomplete="off" spellcheck="false" enterkeyhint="go"></label>
    ${groupSelect(groups, null, '<span class="sr-only">Gruppe</span>')}
    <button type="submit" class="btn primary">Abonnieren</button>
  </form>
  <p class="meta">Neue Einträge landen von selbst im Eingang, beim ersten Abruf die letzten fünf. Private Feeds mit Zugangsdaten in der Adresse (<code>https://name:passwort@…</code>); sie werden getrennt und verschlüsselt gespeichert.</p>
</section>
${feeds.length ? tools(feeds) : ''}
<section class="feed-lists">${list}</section>
${feeds.length ? bulkBar(groups, ctx) : ''}
<section>
  <form method="post" action="/aktion/lesen/gruppe/anlegen" class="lesen-save">${token}
    <label class="lesen-url"><span class="sr-only">Name der neuen Gruppe</span><input name="name" required placeholder="Neue Gruppe" autocomplete="off"></label>
    <button type="submit" class="btn">Gruppe anlegen</button>
  </form>
</section>
<section class="feed-opml">
  <h2>OPML</h2>
  <form method="post" action="/aktion/lesen/feeds/import" enctype="multipart/form-data" class="lesen-save">${token}
    <label class="lesen-url"><span class="sr-only">OPML-Datei</span><input type="file" name="datei" accept=".opml,.xml,text/xml,text/x-opml,application/xml" required></label>
    <button type="submit" class="btn">Importieren</button>
  </form>
  <p><a href="/lesen/feeds.opml" class="btn quiet" download="feeds.opml">Als OPML exportieren</a></p>
</section>`;
  return readingPage(ctx, { key: 'feeds', title: 'Feeds', body, scripts: [assets.lesenFeeds] });
}

/** Überblick, Suche und Filter über der Liste; Suche und Filter erst mit JavaScript. */
function tools(feeds) {
  const failing = feeds.filter((f) => f.error_count).length;
  const paused = feeds.filter((f) => f.paused || f.group_paused).length;
  const summary = [feedsWord(feeds.length), paused ? `${paused} pausiert` : null, failing ? `${failing} mit Fehlern` : null].filter(Boolean).join(' · ');
  return `<section class="feed-tools">
  <p class="meta">${esc(summary)}. Zum gemeinsamen Bearbeiten Feeds abhaken, mit Umschalt auch einen ganzen Bereich.</p>
  <div class="feed-filter" data-feed-filter hidden>
    <label class="lesen-url"><span class="sr-only">Feeds durchsuchen</span><input type="search" data-suche placeholder="Feeds durchsuchen" autocomplete="off" spellcheck="false" enterkeyhint="search"></label>
    ${failing ? '<label class="feed-check"><input type="checkbox" data-nur-fehler> Nur mit Fehlern</label>' : ''}
    ${pickAll('Alle sichtbaren auswählen')}
  </div>
  <p class="meta" data-treffer hidden></p>
</section>`;
}

/** Ein Wert pro Aktion; Gruppe und Abstand blenden sich per CSS (`:has`) passend ein. */
const ACTIONS = [
  ['gruppe', 'In Gruppe verschieben'],
  ['pausieren', 'Pausieren'],
  ['fortsetzen', 'Fortsetzen'],
  ['stapel-an', 'Direkt auf den Stapel'],
  ['stapel-aus', 'Nicht mehr direkt auf den Stapel'],
  ['abstand', 'Abstand ändern'],
  ['entfernen', 'Entfernen'],
];

/** Leiste unten für alle abgehakten Feeds (Formular `BULK`). */
function bulkBar(groups, ctx) {
  const options = [['', 'ohne Gruppe'], ...groups.map((g) => [g.id, g.name]), [NEW_GROUP, 'Neue Gruppe …']];
  return `<form method="post" action="/aktion/lesen/feeds/auswahl" id="${BULK}" class="feed-bulk" data-feed-bulk aria-label="Ausgewählte Feeds bearbeiten">${hidden({ csrf: ctx.write.csrf, back })}
  <p class="feed-bulk-count" data-zahl>Abgehakte Feeds:</p>
  <div class="feed-bulk-fields">
    <label class="feed-field"><span class="sr-only">Aktion</span><select name="tun">${ACTIONS.map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('')}</select></label>
    <label class="feed-field feed-bulk-ziel"><span class="sr-only">Gruppe</span><select name="ziel">${options.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join('')}</select></label>
    <label class="feed-field feed-bulk-neu"><span class="sr-only">Name der neuen Gruppe</span><input name="neu" placeholder="Name der neuen Gruppe" autocomplete="off"></label>
    <label class="feed-field feed-bulk-abstand"><span class="sr-only">Abstand in Minuten</span><input name="intervall" type="number" min="${MIN_INTERVAL}" max="${MAX_INTERVAL}" value="${DEFAULT_INTERVAL}" inputmode="numeric" aria-describedby="feed-bulk-min"><span id="feed-bulk-min" class="hint">Minuten</span></label>
    <button type="submit" class="btn primary">Anwenden</button>
  </div>
</form>`;
}

/** Rückfrage ohne JavaScript, bevor abgehakte Feeds entfernt werden. */
export function renderRemove(feeds, ctx) {
  const ids = feeds.map((f) => f.id);
  const body = feeds.length
    ? `<section class="feed-remove">
  <p>${esc(feedsWord(feeds.length))} entfernen? Gespeicherte Artikel bleiben, es kommen nur keine neuen mehr.</p>
  <ul class="lesen-list">${feeds.map((f) => `<li class="lesen-item feed"><div class="feed-head">${iconOf(f)}<span class="lesen-title">${esc(f.title || host(f.url))}</span></div><span class="meta">${esc(host(f.url))}</span></li>`).join('')}</ul>
  <form method="post" action="/aktion/lesen/feeds/auswahl" class="feed-actions">${hidden({ csrf: ctx.write.csrf, back, tun: 'entfernen', bestaetigt: '1' })}${ids.map((id) => `<input type="hidden" name="feed" value="${esc(id)}">`).join('')}
    <button type="submit" class="btn danger">${esc(feedsWord(feeds.length))} entfernen</button>
    <a href="${back}" class="btn quiet">Abbrechen</a>
  </form>
</section>`
    : `<p class="empty">Diese Feeds gibt es nicht mehr.</p><p><a href="${back}" class="btn quiet">Zurück zu den Feeds</a></p>`;
  return readingPage(ctx, { key: 'feeds', title: 'Feeds entfernen', body });
}

/** Seiten und Aktionen für `readingRoutes` (src/lesen/http.js). */
export function feedRoutes({ store, fetchFeed = fetchFeedDefault, logger = console, now = () => Date.now() }) {
  const feedOf = (form) => {
    const feed = store.getFeed(form.get('id'));
    if (!feed) throw new ActionError('Diesen Feed gibt es nicht mehr', 404);
    return feed;
  };
  const groupOf = (form) => {
    const group = store.getGroup(form.get('id'));
    if (!group) throw new ActionError('Diese Gruppe gibt es nicht mehr', 404);
    return group;
  };
  /**
   * Neue Adresse aus den Einstellungen (fehlt sie oder ist sie gleich: `{}`):
   * geprüft wie beim Abonnieren, eine Website führt zu ihrem Feed. Danach gilt
   * der Feed als frisch (gleich wieder dran, ohne Fehler und ohne ETag); was
   * er schon kennt, bleibt bekannt, vom Neuen kommen höchstens fünf.
   */
  const newAddress = async (feed, input, auth) => {
    if (!input || input === feed.url) return {};
    const { url, feed: parsed } = await asAction(() => discoverFeed(input, { fetchFeed, auth }));
    if (url === feed.url) return {};
    if (store.listFeeds().some((f) => f.url === url)) throw new ActionError('Diesen Feed gibt es schon');
    rememberBacklog(store, feed.id, parsed.entries);
    return { url, etag: null, last_modified: null, last_error: null, error_count: 0, next_fetch_at: null, ...(parsed.siteUrl ? { site_url: parsed.siteUrl } : {}) };
  };
  /** Zugangsdaten aus den Feldern `benutzer`/`passwort`, sonst `null`. */
  const typed = (form) => {
    const user = form.get('benutzer') ?? '';
    const password = form.get('passwort') ?? '';
    return user.trim() || password ? { user: user.trim(), password } : null;
  };
  /**
   * Zugangsdaten nach dem Speichern der Einstellungen: `undefined` heißt
   * unverändert, `null` löschen. Ein leeres Feld behält den gespeicherten
   * Teil (neues Passwort, gleicher Name und umgekehrt).
   */
  const nextAuth = (feed, form, fromUrl) => {
    if (form.get('ohne_zugang') === '1') return feed.has_auth ? null : undefined;
    if (fromUrl) return fromUrl;
    const t = typed(form);
    if (!t) return undefined;
    let old = null;
    try {
      old = feed.has_auth ? store.feedAuth(feed.id) : null;
    } catch {
      // nicht mehr zu öffnen: dann zählt nur, was jetzt eingetragen ist
    }
    return { user: t.user || old?.user || '', password: t.password || old?.password || '' };
  };
  const opml = async () => ({
    body: toOpml(store.listFeeds(), { groups: store.listGroups() }),
    headers: { 'content-type': 'text/x-opml; charset=utf-8', 'content-disposition': 'attachment; filename="feeds.opml"', 'cache-control': 'no-store' },
  });
  return {
    uploads: { '/aktion/lesen/feeds/import': MAX_OPML },
    pages: {
      '/lesen/feeds': async (ctx) => ({ html: renderFeeds({ feeds: store.listFeeds(), groups: store.listGroups(), inbox: store.inboxByGroup() }, ctx) }),
      '/lesen/feeds/entfernen': async (ctx) => ({ html: renderRemove([...new Set(ctx.url.searchParams.getAll('feed'))].map((id) => store.getFeed(id)).filter(Boolean), ctx) }),
      '/lesen/feeds.opml': opml,
      '/api/lesen/feeds': async (ctx) => jsonReply(200, feedsJson({ feeds: store.listFeeds(), groups: store.listGroups(), inbox: store.inboxByGroup() }, ctx.tz, now())),
      // Derselbe Export für die App (mit Geräte-Token, `/lesen/…` bleibt beim Cookie).
      '/api/lesen/feeds.opml': opml,
    },
    actions: {
      async '/aktion/lesen/feed/abonnieren'(form, session) {
        const input = (form.get('url') ?? '').trim();
        if (!input) throw new ActionError('Bitte eine Adresse eingeben');
        const split = await asAction(async () => splitCredentials(input));
        const auth = typed(form) ?? split.auth;
        const { url, feed } = await asAction(() => discoverFeed(split.url, { fetchFeed, auth }));
        const r = await asAction(() => store.addFeed({ url, title: feed.title, site_url: feed.siteUrl, interval_minutes: DEFAULT_INTERVAL, group_id: form.get('gruppe') || null, ...(auth ? { auth } : {}) }));
        if (!r.duplicate) logger.info?.(`Feeds: ${r.feed.title ?? host(url)} abonniert (${session.sub})`); // nie die URL: private Feeds tragen Tokens darin
        return { message: `${r.duplicate ? 'Schon abonniert' : 'Abonniert'}: ${r.feed.title ?? host(url)}` };
      },
      async '/aktion/lesen/feed/aendern'(form) {
        const feed = feedOf(form);
        const minutes = Number(form.get('intervall'));
        const input = (form.get('url') ?? '').trim();
        const split = input ? await asAction(async () => splitCredentials(input)) : { url: '', auth: null };
        const auth = await asAction(async () => nextAuth(feed, form, split.auth));
        const moved = await newAddress(feed, split.url, auth === undefined ? await asAction(async () => store.feedAuth(feed.id)) : auth);
        if (auth !== undefined) await asAction(async () => store.setFeedAuth(feed.id, auth));
        const f = await asAction(() => store.updateFeed(feed.id, {
          // Neue Zugangsdaten: gleich wieder dran, alte Fehler zählen nicht mehr.
          ...(auth !== undefined ? { last_error: null, error_count: 0, next_fetch_at: null } : {}),
          ...moved,
          ...(form.has('gruppe') ? { group_id: form.get('gruppe') } : {}),
          paused: form.get('pausiert') === '1',
          to_stack: form.get('stapel') === '1',
          keyword_filter: (form.get('filter') ?? '').trim() || null,
          interval_minutes: Number.isFinite(minutes) && minutes > 0 ? Math.round(Math.min(MAX_INTERVAL, Math.max(MIN_INTERVAL, minutes))) : feed.interval_minutes,
        }));
        return { message: `Gespeichert: ${f.title ?? host(f.url)}` };
      },
      async '/aktion/lesen/feed/entfernen'(form) {
        const feed = feedOf(form);
        store.deleteFeed(feed.id);
        return { message: `Entfernt: ${feed.title ?? host(feed.url)}. Gespeicherte Artikel bleiben.` };
      },
      async '/aktion/lesen/feeds/auswahl'(form, session) {
        const ids = [...new Set(form.getAll('feed').filter(Boolean))];
        if (!ids.length) throw new ActionError('Bitte zuerst Feeds abhaken');
        const tun = form.get('tun');
        const apply = async (patch, done) => {
          const changed = await asAction(() => store.updateFeeds(ids, patch));
          if (!changed.length) throw new ActionError('Diese Feeds gibt es nicht mehr', 404);
          return { message: `${feedsWord(changed.length)} ${done}` };
        };
        switch (tun) {
          case 'gruppe': {
            const ziel = form.get('ziel') ?? '';
            if (!ziel) return apply({ group_id: null }, 'jetzt ohne Gruppe');
            const group = ziel === NEW_GROUP ? (await asAction(() => store.addGroup({ name: form.get('neu') }))).group : store.getGroup(ziel);
            if (!group) throw new ActionError('Diese Gruppe gibt es nicht mehr', 404);
            return apply({ group_id: group.id }, `in „${group.name}“`);
          }
          case 'pausieren':
            return apply({ paused: true }, 'pausiert');
          case 'fortsetzen':
            return apply({ paused: false }, 'laufen wieder');
          case 'stapel-an':
            return apply({ to_stack: true }, 'legen direkt auf den Stapel');
          case 'stapel-aus':
            return apply({ to_stack: false }, 'legen in den Eingang');
          case 'abstand': {
            const minutes = Number(form.get('intervall'));
            if (!Number.isFinite(minutes) || minutes <= 0) throw new ActionError('Bitte einen Abstand in Minuten angeben');
            const m = Math.round(Math.min(MAX_INTERVAL, Math.max(MIN_INTERVAL, minutes)));
            return apply({ interval_minutes: m }, `alle ${m} min`);
          }
          case 'entfernen': {
            // Ohne Bestätigung erst die Rückfrage (mit JavaScript kam sie schon im Dialog).
            if (form.get('bestaetigt') !== '1') return { message: '', redirect: `/lesen/feeds/entfernen?${new URLSearchParams(ids.map((id) => ['feed', id]))}` };
            const n = store.deleteFeeds(ids);
            if (!n) throw new ActionError('Diese Feeds gibt es nicht mehr', 404);
            logger.info?.(`Feeds: ${n} auf einmal entfernt (${session.sub})`);
            return { message: `${feedsWord(n)} entfernt. Gespeicherte Artikel bleiben.` };
          }
          default:
            throw new ActionError('Unbekannte Aktion');
        }
      },
      async '/aktion/lesen/feeds/import'(form, session) {
        const file = form.files?.get('datei');
        if (!file?.data?.length) throw new ActionError('Bitte eine OPML-Datei wählen');
        const list = await asAction(() => parseOpml(file.data.toString('utf8')));
        if (!list.length) throw new ActionError('In der Datei steht kein Feed');
        let added = 0;
        for (const { group, ...f } of list) {
          // Ordner werden Gruppen; ein schon abonnierter Feed behält eine vorhandene Zuordnung.
          const groupId = group?.trim() ? store.addGroup({ name: group }).group.id : null;
          const r = await asAction(async () => store.addFeed({ ...f, group_id: groupId, interval_minutes: DEFAULT_INTERVAL }));
          if (!r.duplicate) added += 1;
          else if (groupId && !r.feed.group_id) store.updateFeed(r.feed.id, { group_id: groupId });
        }
        logger.info?.(`Feeds: ${added} aus OPML importiert (${session.sub})`);
        const known = list.length - added;
        return { message: `${added} ${added === 1 ? 'Feed' : 'Feeds'} importiert${known ? `, ${known} schon abonniert` : ''}` };
      },
      async '/aktion/lesen/gruppe/anlegen'(form) {
        const { group, duplicate } = await asAction(() => store.addGroup({ name: form.get('name') }));
        return { message: `${duplicate ? 'Gibt es schon' : 'Gruppe angelegt'}: ${group.name}` };
      },
      async '/aktion/lesen/gruppe/aendern'(form) {
        const group = groupOf(form);
        const g = await asAction(() => store.updateGroup(group.id, { name: form.get('name'), paused: form.get('pausiert') === '1', to_stack: form.get('stapel') === '1' }));
        return { message: `Gespeichert: ${g.name}` };
      },
      async '/aktion/lesen/gruppe/verschieben'(form) {
        const group = groupOf(form);
        const delta = { hoch: -1, runter: 1 }[form.get('richtung')];
        if (!delta) throw new ActionError('Unbekannte Richtung');
        store.moveGroup(group.id, delta);
        return { message: `Verschoben: ${group.name}` };
      },
      async '/aktion/lesen/gruppe/entfernen'(form) {
        const group = groupOf(form);
        store.deleteGroup(group.id);
        return { message: `Gruppe gelöscht: ${group.name}. Ihre Feeds bleiben, jetzt ohne Gruppe.` };
      },
    },
  };
}
