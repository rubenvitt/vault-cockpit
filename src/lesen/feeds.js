import { DOMParser, parseHTML } from 'linkedom';
import { safeFetch, normalizeUrl } from './fetch.js';
import { sanitizeHtml, extractArticle, readingMinutes } from './extract.js';
import { ReadingError } from './store.js';
import { esc } from '../web/layout.js';

/**
 * Feeds für den Lesestapel (VCP-78): RSS 2.0 (auch 1.0/RDF), Atom und JSON
 * Feed lesen, eine Website-Adresse über `<link rel="alternate">` zum Feed
 * auflösen und alle fälligen Feeds im Hintergrund abrufen.
 *
 * Neue Einträge werden Dokumente mit Herkunft `feed:<id>` im Eingang (oder mit
 * „direkt auf den Stapel“ im Stapel). Bekannt ist ein Eintrag über seine GUID,
 * ohne GUID über seine Adresse (`feed_entries`). Der erste Abruf holt nur die
 * neuesten fünf und merkt sich den Rest, damit ein neuer Feed den Eingang nicht
 * flutet.
 *
 * Pausieren und „direkt auf den Stapel“ wirken, wenn Feed ODER seine Gruppe es
 * gesetzt hat (VCP-97); eine pausierte Gruppe ruft keinen ihrer Feeds ab.
 *
 * XML liest linkedom; es löst keine Entitäten aus einer DTD auf (auch keine
 * externen), `&xxe;` bleibt Text. Abgerufen wird nur über `safeFetch`, mit
 * dessen Größen- und Zeitlimit; Inhalte gehen immer durch `sanitizeHtml`.
 */

export const DEFAULT_INTERVAL = 30;
const FIRST_FETCH = 5;
// Ab so vielen Wörtern gilt der Inhalt im Feed als Volltext, sonst wird die Seite geholt.
const FULL_TEXT_WORDS = 150;
const MAX_BACKOFF_MINUTES = 24 * 60;
const ICON_TYPES = ['image/png', 'image/x-icon', 'image/vnd.microsoft.icon', 'image/jpeg', 'image/gif', 'image/webp'];
const FEED_LINK = /^application\/(?:(?:rss|atom|feed)\+(?:xml|json)|json)$/i;

/** Feeds kommen als xml, rss+xml, json, oft auch als text/plain: Der Inhalt entscheidet, nicht der Typ. */
export const fetchFeedDefault = (url, opts = {}) => safeFetch(url, { accept: null, ...opts });

const squash = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const kids = (el, name) => [...(el?.children ?? [])].filter((c) => c.tagName.toLowerCase() === name);
const kid = (el, ...names) => names.map((n) => kids(el, n)[0]).find(Boolean) ?? null;
const text = (el, ...names) => squash(kid(el, ...names)?.textContent) || null;
/** Attribut aus XML; linkedom lässt dort `&amp;`, `&lt;` und `&gt;` stehen (Zahlen und `&quot;` löst es auf). */
export const xmlAttr = (el, name) => el?.getAttribute(name)?.replace(/&(lt|gt|amp);/g, (m, k) => ({ lt: '<', gt: '>', amp: '&' })[k]) ?? null;
const absolute = (href, base) => {
  // Leer hieße sonst: die Adresse des Feeds selbst.
  if (!String(href ?? '').trim()) return null;
  try {
    return normalizeUrl(new URL(String(href).trim(), base || undefined).href);
  } catch {
    return null;
  }
};
const time = (s) => {
  const t = Date.parse(s ?? '');
  return Number.isNaN(t) ? null : t;
};

/**
 * Text des Feeds → `{ title, siteUrl, icon, entries }`, je Eintrag `{ key,
 * url, title, author, html, published, comments }` (`html` ungesäubert). Kein
 * Feed: `ReadingError`.
 */
export function parseFeed(body, baseUrl) {
  const feed = parseAny(body, baseUrl);
  return { ...feed, entries: feed.entries.map(resolveLinkPost) };
}

const REDDIT = /(?:^|\.)(?:reddit\.com|redd\.it|redditmedia\.com)$/i;

/**
 * Link-Sammler: Bei Reddit zeigt der Eintrag auf die Diskussion, der Artikel
 * steckt im `[link]` des Inhalts. Dann wird der Artikel die Adresse und die
 * Diskussion `comments`. Bilder, Videos und Galerien bei Reddit selbst und
 * Textbeiträge bleiben, wie sie sind. `comments` ist nie die Adresse selbst
 * (WordPress setzt `<comments>` auf `…/beitrag/#respond`).
 */
function resolveLinkPost(entry) {
  let { url, comments } = entry;
  if (url && REDDIT.test(hostOf(url))) {
    const { document } = parseHTML(`<!doctype html><html><body>${entry.html ?? ''}</body></html>`);
    const link = [...document.querySelectorAll('a[href]')].find((a) => squash(a.textContent) === '[link]');
    const target = link && absolute(link.getAttribute('href'), url);
    if (target && !REDDIT.test(hostOf(target))) [url, comments] = [target, url];
  }
  return { ...entry, url, comments: comments && comments !== url ? comments : null };
}

/**
 * Gespeicherter Feed-Eintrag von vor der Auflösung → `{ url, comments }` oder
 * `null`: Reddit über `[link]` im Inhalt, Hacker News (hnrss) über „Comments
 * URL: …“ im Text.
 */
export function storedLinkPost(doc) {
  const hn = /Comments URL:\s*(https?:\/\/\S+)/.exec(doc.content_text ?? '')?.[1];
  const { url, comments } = resolveLinkPost({ url: doc.url, html: doc.content_html, comments: hn ? absolute(hn, doc.url) : null });
  return comments ? { url, comments } : null;
}

function parseAny(body, baseUrl) {
  const src = String(body ?? '').replace(/^\uFEFF/, '').trimStart();
  if (src.startsWith('{')) return parseJsonFeed(src, baseUrl);
  const root = new DOMParser().parseFromString(src, 'text/xml').documentElement;
  const type = root?.tagName?.toLowerCase();
  if (type === 'feed') return parseAtom(root, baseUrl);
  const channel = type === 'rss' || type === 'rdf:rdf' ? kid(root, 'channel') : null;
  if (!channel) throw new ReadingError('Kein RSS-, Atom- oder JSON-Feed');
  // RSS 1.0 hat die Einträge neben dem Kanal, RSS 2.0 darin.
  const items = type === 'rss' ? kids(channel, 'item') : kids(root, 'item');
  return {
    title: text(channel, 'title'),
    siteUrl: absolute(text(channel, 'link'), baseUrl),
    icon: absolute(text(kid(channel, 'image'), 'url'), baseUrl),
    entries: items.map((item) => {
      const guid = kid(item, 'guid');
      const link = absolute(text(item, 'link'), baseUrl) ?? (xmlAttr(guid, 'isPermaLink') !== 'false' ? absolute(text(item, 'guid'), baseUrl) : null);
      return {
        key: text(item, 'guid') ?? link,
        url: link,
        title: text(item, 'title'),
        author: text(item, 'dc:creator', 'author'),
        html: kid(item, 'content:encoded', 'description')?.textContent ?? '',
        published: time(text(item, 'pubdate', 'dc:date')),
        // Diskussion, etwa bei Hacker News und Lobsters.
        comments: absolute(text(item, 'comments'), baseUrl),
      };
    }),
  };
}

function parseAtom(root, baseUrl) {
  const alternate = (el) => {
    const link = kids(el, 'link').find((l) => (xmlAttr(l, 'rel') ?? 'alternate') === 'alternate');
    return absolute(xmlAttr(link, 'href'), baseUrl);
  };
  const content = (el) => {
    const c = kid(el, 'content', 'summary');
    const type = xmlAttr(c, 'type') ?? 'text';
    return type === 'xhtml' ? c.innerHTML : type === 'text' ? esc(c?.textContent ?? '') : c.textContent;
  };
  return {
    title: text(root, 'title'),
    siteUrl: alternate(root),
    icon: absolute(text(root, 'icon', 'logo'), baseUrl),
    entries: kids(root, 'entry').map((entry) => {
      const url = alternate(entry);
      return { key: text(entry, 'id') ?? url, url, title: text(entry, 'title'), author: text(kid(entry, 'author'), 'name'), html: content(entry), published: time(text(entry, 'published', 'updated')) };
    }),
  };
}

function parseJsonFeed(src, baseUrl) {
  let feed;
  try {
    feed = JSON.parse(src);
  } catch {
    throw new ReadingError('Der JSON-Feed lässt sich nicht lesen');
  }
  if (!Array.isArray(feed?.items)) throw new ReadingError('Kein JSON-Feed (es fehlen die Einträge)');
  const str = (v) => (typeof v === 'string' ? squash(v) || null : null);
  return {
    title: str(feed.title),
    siteUrl: absolute(str(feed.home_page_url), baseUrl),
    icon: absolute(str(feed.favicon) ?? str(feed.icon), baseUrl),
    entries: feed.items.map((item) => {
      const url = absolute(str(item?.url) ?? str(item?.external_url), baseUrl);
      return {
        key: (item?.id != null ? String(item.id) : null) ?? url,
        url,
        title: str(item?.title),
        author: str(item?.authors?.[0]?.name) ?? str(item?.author?.name),
        html: typeof item?.content_html === 'string' ? item.content_html : esc(str(item?.content_text) ?? str(item?.summary) ?? ''),
        published: time(item?.date_published),
      };
    }),
  };
}

/** Feed-Adresse aus `<link rel="alternate" type="application/rss+xml" …>` einer Webseite, sonst `null`. */
export function findFeedLink(html, baseUrl) {
  const { document } = parseHTML(String(html ?? ''));
  const link = [...document.querySelectorAll('link[rel~="alternate"][href]')].find((l) => FEED_LINK.test(squash(l.getAttribute('type'))));
  return link ? absolute(link.getAttribute('href'), baseUrl) : null;
}

/**
 * Adresse aus dem Formular → `{ url, feed }`: entweder direkt ein Feed oder
 * eine Webseite, die auf einen verweist.
 */
export async function discoverFeed(input, { fetchFeed = fetchFeedDefault } = {}) {
  const res = await fetchFeed(normalizeUrl(input));
  try {
    return { url: res.url, feed: parseFeed(res.body, res.url) };
  } catch (err) {
    const alt = findFeedLink(res.body, res.url);
    if (!alt) throw new ReadingError(`Unter dieser Adresse ist kein Feed zu finden (${err.message})`);
    const found = await fetchFeed(alt);
    return { url: found.url, feed: parseFeed(found.body, found.url) };
  }
}

const words = (s) => (s.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) ?? []).length;

/** Felder für `addDocument` aus dem Inhalt im Feed (gesäubert). */
function fromFeed(entry, site) {
  const html = sanitizeHtml(entry.html, entry.url);
  // Blöcke durch Zeilenumbrüche trennen, sonst kleben Absätze aneinander.
  const plain = parseHTML(`<!doctype html><html><body>${html.replace(/<br>|<\/(?:p|div|h[1-6]|li|blockquote|pre|tr|td|th)>/g, '$&\n')}</body></html>`).document.body.textContent;
  const contentText = plain.split(/\n+/).map(squash).filter(Boolean).join('\n\n');
  const count = words(contentText);
  return {
    url: entry.url,
    comments_url: entry.comments ?? null,
    title: entry.title || entry.url,
    author: entry.author,
    site,
    excerpt: squash(contentText).slice(0, 500) || null,
    content_html: html,
    content_text: contentText,
    word_count: count,
    reading_minutes: count ? readingMinutes(count) : 0,
  };
}

/** Passt ein Eintrag zum Stichwort-Filter („KI, Rust“: eins davon in Titel oder Text)? Leer = alles. */
export function matchesFilter(filter, entry) {
  const terms = String(filter ?? '').split(',').map((t) => squash(t).toLowerCase()).filter(Boolean);
  if (!terms.length) return true;
  const hay = `${entry.title ?? ''} ${String(entry.html ?? '').replace(/<[^>]*>/g, ' ')}`.toLowerCase();
  return terms.some((t) => hay.includes(t));
}

const hostOf = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
};

/**
 * Hintergrundabruf. `runDue()` holt alle fälligen, nicht pausierten Feeds
 * (`next_fetch_at` erreicht oder leer), höchstens `concurrency` gleichzeitig;
 * ein Fehler bleibt beim Feed (`last_error`, `error_count`) und stoppt die
 * anderen nicht. Danach ist der Feed nach `interval_minutes` wieder dran, nach
 * Fehlern später (doppelter Abstand je Fehler, höchstens ein Tag).
 *
 * `last_fetch_at` ist der letzte Versuch; ob er klappte, sagt `error_count`.
 * `fetchFeed`, `fetchPage` und `now` setzen Tests, `start()` braucht es nur im
 * Betrieb.
 */
export function createFeedPoller({ store, fetchFeed = fetchFeedDefault, fetchPage = safeFetch, now = () => Date.now(), concurrency = 3, logger = console }) {
  let timer = null;
  let running = null;
  const iso = (ms) => new Date(ms).toISOString();

  /** Volltext: der Feed, wenn er lang genug ist, sonst die Seite; scheitert die, doch der Feed. */
  async function article(entry, site) {
    const own = fromFeed(entry, site);
    if (own.word_count >= FULL_TEXT_WORDS) return own;
    try {
      const page = await fetchPage(entry.url);
      const full = extractArticle(page.body, page.url);
      if (full.word_count > own.word_count) return { ...full, url: entry.url, comments_url: own.comments_url, title: entry.title || full.title };
    } catch (err) {
      logger.warn?.(`Feeds: ${entry.url} nicht geholt, nehme den Feed-Inhalt: ${err.message}`);
    }
    return own;
  }

  /** Icon als `data:`-Adresse (die CSP lädt keine fremden Bilder); `''` heißt: keins gefunden. */
  // shortcut: Ein nicht gefundenes Icon (`''`) wird nie wieder versucht; nachrüsten, wenn Feeds später eins bekommen.
  async function icon(feed, parsed) {
    try {
      const res = await fetchFeed(parsed.icon ?? new URL('/favicon.ico', parsed.siteUrl ?? feed.url).href, { accept: ICON_TYPES, maxBytes: 100_000 });
      return `data:${String(res.contentType).split(';')[0].trim().toLowerCase()};base64,${Buffer.from(res.bytes).toString('base64')}`;
    } catch {
      return '';
    }
  }

  /** Ein Feed: abrufen, neue Einträge anlegen. Liefert Anzahl neuer Dokumente und Felder für den Feed. */
  async function refresh(feed) {
    const headers = { ...(feed.etag ? { 'if-none-match': feed.etag } : {}), ...(feed.last_modified ? { 'if-modified-since': feed.last_modified } : {}) };
    const res = await fetchFeed(feed.url, { headers });
    if (res.status === 304) return { added: 0, patch: {} };
    const parsed = parseFeed(res.body, res.url);
    const known = store.knownEntries(feed.id);
    const first = known.size === 0;
    // Neueste zuerst; ohne Datum gilt die Reihenfolge im Feed.
    const fresh = parsed.entries.filter((e) => e.key && !known.has(e.key));
    if (fresh.every((e) => e.published)) fresh.sort((a, b) => b.published - a.published);
    const take = first ? fresh.slice(0, FIRST_FETCH) : fresh;
    // Erster Abruf: den Rest vorab als bekannt merken, sonst rückt er nach einem Fehler unten beim nächsten Mal nach.
    if (first) for (const entry of fresh.slice(FIRST_FETCH)) store.rememberEntry(feed.id, entry.key, null);
    const site = parsed.title ?? feed.title ?? hostOf(feed.url);
    let added = 0;
    // Älteste zuerst anlegen, damit der neueste Eintrag oben im Eingang steht.
    for (const entry of [...take].reverse()) {
      if (known.has(entry.key)) continue;
      known.add(entry.key);
      // shortcut: Gefilterte Einträge bleiben für immer bekannt, ein gelockerter Filter holt sie nicht nach; ändern, wenn das stört.
      if (!entry.url || !matchesFilter(feed.keyword_filter, entry)) {
        store.rememberEntry(feed.id, entry.key, null);
        continue;
      }
      const { doc, duplicate } = store.addDocument({ ...(await article(entry, site)), kind: 'feed', origin: `feed:${feed.id}`, status: feed.to_stack || feed.group_to_stack ? 'stapel' : 'eingang' });
      store.rememberEntry(feed.id, entry.key, doc.id);
      if (!duplicate) added += 1;
    }
    const patch = {
      etag: res.headers?.etag ?? null,
      last_modified: res.headers?.['last-modified'] ?? null,
      ...(feed.title ? {} : { title: parsed.title }),
      ...(parsed.siteUrl ? { site_url: parsed.siteUrl } : {}),
      ...(feed.icon == null ? { icon: await icon(feed, parsed) } : {}),
    };
    return { added, patch };
  }

  async function runFeed(feed) {
    const at = now();
    const minutes = feed.interval_minutes || DEFAULT_INTERVAL;
    try {
      const { added, patch } = await refresh(feed);
      if (store.getFeed(feed.id)) store.updateFeed(feed.id, { ...patch, last_fetch_at: iso(at), last_error: null, error_count: 0, next_fetch_at: iso(at + minutes * 60_000) });
      if (added) logger.info?.(`Feeds: ${added} neu aus ${feed.title ?? hostOf(feed.url)}`);
      return added;
    } catch (err) {
      const errors = feed.error_count + 1;
      const wait = Math.min(minutes * 2 ** errors, MAX_BACKOFF_MINUTES);
      if (store.getFeed(feed.id)) store.updateFeed(feed.id, { last_fetch_at: iso(at), last_error: String(err?.message ?? err), error_count: errors, next_fetch_at: iso(at + wait * 60_000) });
      logger.warn?.(`Feeds: ${feed.title ?? hostOf(feed.url)} fehlgeschlagen (${errors}×): ${err?.message ?? err}`);
      return 0;
    }
  }

  /** Alle fälligen Feeds einmal; läuft schon ein Durchgang, wartet man auf ihn. Liefert die Zahl neuer Dokumente. */
  function runDue() {
    if (running) return running;
    running = (async () => {
      const t = now();
      const queue = store.listFeeds().filter((f) => !f.paused && !f.group_paused && (!f.next_fetch_at || Date.parse(f.next_fetch_at) <= t));
      let added = 0;
      const worker = async () => {
        // Erst warten, dann addieren: `added += await …` läse den Stand vor dem Warten.
        while (queue.length) {
          const n = await runFeed(queue.shift());
          added += n;
        }
      };
      await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
      return added;
    })()
      .catch((err) => {
        // Etwa die Datenbank nach einem gescheiterten Wiederherstellen; ohne catch beendete das den Prozess.
        logger.error?.(`Feeds: Durchgang fehlgeschlagen: ${err.message}`);
        return 0;
      })
      .finally(() => {
        running = null;
      });
    return running;
  }

  /** Zustand für /zustand (src/health/collect.js), je Feed ein Teil. Fehlertexte maskiert erst collect.js. */
  function health() {
    const base = { id: 'feeds', name: 'Feeds' };
    const feeds = store.listFeeds();
    if (!feeds.length) return { ...base, state: 'off', summary: 'keine Feeds abonniert', facts: [] };
    // Name nie die Adresse: private Feeds tragen gern einen Token darin.
    // shortcut: Ein dauerhaft toter Feed hält den Dienst auf „Fehler“ (Störung in der Kopfzeile, `degraded`), bis man ihn pausiert oder entfernt; wie bei den Kalendern.
    const items = feeds.map((f) => ({
      id: `feed-${f.id}`,
      name: f.title || hostOf(f.url),
      state: f.paused || f.group_paused ? 'off' : f.error_count ? 'error' : f.last_fetch_at ? 'ok' : 'unknown',
      summary: f.paused || f.group_paused ? 'pausiert' : f.error_count ? `${f.error_count}× fehlgeschlagen` : f.last_fetch_at ? null : 'noch nicht abgerufen',
      lastOkAt: f.error_count ? null : f.last_fetch_at,
      lastErrorAt: f.error_count ? f.last_fetch_at : null,
      lastError: f.error_count ? f.last_error : null,
    }));
    const failed = items.filter((i) => i.state === 'error');
    const last = failed.filter((i) => i.lastErrorAt).sort((a, b) => a.lastErrorAt.localeCompare(b.lastErrorAt)).at(-1);
    const active = items.filter((i) => i.state !== 'off');
    return {
      ...base,
      state: failed.length ? 'error' : active.some((i) => i.state === 'ok') ? 'ok' : active.length ? 'unknown' : 'off',
      summary: failed.length ? `${failed.length} von ${items.length} mit Fehler` : `${items.length} ${items.length === 1 ? 'Feed' : 'Feeds'}${active.length < items.length ? `, ${items.length - active.length} pausiert` : ''}`,
      lastOkAt: items.map((i) => i.lastOkAt).filter(Boolean).sort().at(-1) ?? null,
      lastErrorAt: last?.lastErrorAt ?? null,
      lastError: last ? `${last.name}: ${last.lastError}` : null,
      facts: [],
      items,
    };
  }

  /**
   * Feed-Einträge von vor der Auflösung nachträglich wie neue behandeln:
   * Artikel als Adresse, Diskussion als Kommentar-Link, Volltext von der
   * Seite. Nur im Eingang und auf dem Stapel und ohne Markierungen (Archiv
   * und Abgelegtes haben schon eine Notiz im Vault, Markierungen hängen am
   * alten Text). Neuer Text setzt den Lesefortschritt zurück. Gibt es den
   * Artikel schon als eigenes Dokument, bleibt der Eintrag, wie er ist.
   * Liefert die Zahl aufgelöster Dokumente.
   */
  async function resolveOld() {
    let resolved = 0;
    for (const doc of store.listFeedStubs(FULL_TEXT_WORDS)) {
      const link = storedLinkPost(doc);
      if (!link) continue;
      const other = link.url !== doc.url ? store.find({ url: link.url }) : null;
      if (other && other.id !== doc.id) continue;
      const full = await article({ url: link.url, comments: link.comments, title: doc.title, author: doc.author, html: doc.content_html ?? '' }, doc.site);
      const longer = full.word_count > doc.word_count;
      // Seite nicht erreichbar: Adresse und Kommentar-Link trotzdem, der Kurztext bleibt.
      store.updateDocument(doc.id, {
        url: link.url,
        comments_url: link.comments,
        ...(longer ? { canonical_url: full.canonical_url ?? null, excerpt: full.excerpt, content_html: full.content_html, content_text: full.content_text, word_count: full.word_count, reading_minutes: full.reading_minutes } : {}),
      });
      if (longer && doc.progress > 0) store.setProgress(doc.id, 0, null);
      resolved += 1;
    }
    if (resolved) logger.info?.(`Feeds: ${resolved} ältere Einträge nachträglich aufgelöst`);
    return resolved;
  }

  return {
    runDue,
    health,
    resolveOld,
    /** Jede Minute nachsehen, welche Feeds dran sind (jeder hat seinen eigenen Abstand); einmal ältere Einträge auflösen. */
    start(tickMinutes = 1) {
      runDue();
      resolveOld().catch((err) => logger.error?.(`Feeds: Nachträgliches Auflösen fehlgeschlagen: ${err.message}`));
      timer = setInterval(runDue, tickMinutes * 60_000);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
    },
  };
}
