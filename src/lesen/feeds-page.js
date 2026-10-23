import { ActionError } from '../cockpit/actions.js';
import { esc } from '../web/layout.js';
import { hidden } from '../web/render.js';
import { when } from '../web/health-render.js';
import { maskSecrets } from '../health/mask.js';
import { FetchError } from './fetch.js';
import { ReadingError } from './store.js';
import { readingPage } from './pages.js';
import { discoverFeed, fetchFeedDefault, DEFAULT_INTERVAL } from './feeds.js';
import { parseOpml, toOpml } from './opml.js';

/**
 * Seite „Feeds“ unter Lesen (VCP-78): abonnieren (Feed- oder Website-Adresse),
 * je Feed pausieren, direkt auf den Stapel, Stichwort-Filter, Abstand,
 * entfernen; OPML importieren und exportieren. Abgerufen wird im Hintergrund
 * (src/lesen/feeds.js), ein neuer Feed ist beim nächsten Durchgang dran.
 */

const back = '/lesen/feeds';
const MIN_INTERVAL = 5;
const MAX_INTERVAL = 24 * 60;

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

function status(f, tz) {
  if (f.paused) return 'pausiert';
  if (f.error_count) return `Fehler (${f.error_count}×): ${maskSecrets(f.last_error, { max: 160 })}`;
  return f.last_fetch_at ? `abgerufen ${when(f.last_fetch_at, tz)}` : 'noch nicht abgerufen';
}

function feedItem(f, ctx) {
  const token = hidden({ csrf: ctx.write.csrf, back, id: f.id });
  const title = f.title || host(f.url);
  const link = /^https?:\/\//i.test(f.site_url ?? '') ? `<a href="${esc(f.site_url)}" class="lesen-title" rel="noopener noreferrer">${esc(title)}</a>` : `<span class="lesen-title">${esc(title)}</span>`;
  const meta = [host(f.url), `alle ${f.interval_minutes} min`, f.to_stack ? 'direkt auf den Stapel' : null, f.keyword_filter ? `nur „${f.keyword_filter}“` : null].filter(Boolean).map(esc).join(' · ');
  return `<li class="lesen-item feed${f.error_count ? ' feed-failing' : ''}">
    <div class="feed-head">${iconOf(f)}${link}</div>
    <span class="meta">${meta}</span>
    <span class="meta feed-status">${esc(status(f, ctx.tz))}</span>
    <details class="feed-edit"><summary>Einstellungen</summary>
      <form method="post" action="/aktion/lesen/feed/aendern" class="feed-form">${token}
        <label class="feed-check"><input type="checkbox" name="pausiert" value="1"${f.paused ? ' checked' : ''}> Pausiert</label>
        <label class="feed-check"><input type="checkbox" name="stapel" value="1"${f.to_stack ? ' checked' : ''}> Direkt auf den Stapel</label>
        <label class="feed-field"><span>Stichwort-Filter <span class="hint">durch Komma getrennt, leer = alles</span></span><input name="filter" value="${esc(f.keyword_filter ?? '')}" autocomplete="off"></label>
        <label class="feed-field"><span>Abstand in Minuten</span><input name="intervall" type="number" min="${MIN_INTERVAL}" max="${MAX_INTERVAL}" value="${esc(f.interval_minutes)}" inputmode="numeric"></label>
        <p class="feed-actions"><button type="submit" class="btn">Speichern</button></p>
      </form>
      <form method="post" action="/aktion/lesen/feed/entfernen">${token}<button type="submit" class="btn quiet danger">Feed entfernen</button></form>
    </details>
  </li>`;
}

export function renderFeeds(feeds, ctx) {
  const token = hidden({ csrf: ctx.write.csrf, back });
  const list = feeds.length ? `<ul class="lesen-list">${feeds.map((f) => feedItem(f, ctx)).join('')}</ul>` : '<p class="empty">Noch keine Feeds abonniert.</p>';
  const body = `<section>
  <form method="post" action="/aktion/lesen/feed/abonnieren" class="lesen-save">${token}
    <label class="lesen-url"><span class="sr-only">Adresse eines Feeds oder einer Website</span><input type="url" name="url" required placeholder="https://… Feed oder Website" inputmode="url" autocomplete="off" spellcheck="false" enterkeyhint="go"></label>
    <button type="submit" class="btn primary">Abonnieren</button>
  </form>
  <p class="meta">Neue Einträge landen von selbst im Eingang, beim ersten Abruf die letzten fünf.</p>
</section>
<section>${list}</section>
<section class="feed-opml">
  <h2>OPML</h2>
  <form method="post" action="/aktion/lesen/feeds/import" enctype="multipart/form-data" class="lesen-save">${token}
    <label class="lesen-url"><span class="sr-only">OPML-Datei</span><input type="file" name="datei" accept=".opml,.xml,text/xml,text/x-opml,application/xml" required></label>
    <button type="submit" class="btn">Importieren</button>
  </form>
  <p><a href="/lesen/feeds.opml" class="btn quiet" download="feeds.opml">Als OPML exportieren</a></p>
</section>`;
  return readingPage(ctx, { key: 'feeds', title: 'Feeds', body });
}

/** Seiten und Aktionen für `readingRoutes` (src/lesen/http.js). */
export function feedRoutes({ store, fetchFeed = fetchFeedDefault, logger = console }) {
  const feedOf = (form) => {
    const feed = store.getFeed(form.get('id'));
    if (!feed) throw new ActionError('Diesen Feed gibt es nicht mehr', 404);
    return feed;
  };
  return {
    pages: {
      '/lesen/feeds': async (ctx) => ({ html: renderFeeds(store.listFeeds(), ctx) }),
      '/lesen/feeds.opml': async () => ({
        body: toOpml(store.listFeeds()),
        headers: { 'content-type': 'text/x-opml; charset=utf-8', 'content-disposition': 'attachment; filename="feeds.opml"', 'cache-control': 'no-store' },
      }),
    },
    actions: {
      async '/aktion/lesen/feed/abonnieren'(form, session) {
        const input = (form.get('url') ?? '').trim();
        if (!input) throw new ActionError('Bitte eine Adresse eingeben');
        const { url, feed } = await asAction(() => discoverFeed(input, { fetchFeed }));
        const r = store.addFeed({ url, title: feed.title, site_url: feed.siteUrl, interval_minutes: DEFAULT_INTERVAL });
        if (!r.duplicate) logger.info?.(`Feeds: ${url} abonniert (${session.sub})`);
        return { message: `${r.duplicate ? 'Schon abonniert' : 'Abonniert'}: ${r.feed.title ?? host(url)}` };
      },
      async '/aktion/lesen/feed/aendern'(form) {
        const feed = feedOf(form);
        const minutes = Number(form.get('intervall'));
        const f = store.updateFeed(feed.id, {
          paused: form.get('pausiert') === '1',
          to_stack: form.get('stapel') === '1',
          keyword_filter: (form.get('filter') ?? '').trim() || null,
          interval_minutes: Number.isFinite(minutes) && minutes > 0 ? Math.round(Math.min(MAX_INTERVAL, Math.max(MIN_INTERVAL, minutes))) : feed.interval_minutes,
        });
        return { message: `Gespeichert: ${f.title ?? host(f.url)}` };
      },
      async '/aktion/lesen/feed/entfernen'(form) {
        const feed = feedOf(form);
        store.deleteFeed(feed.id);
        return { message: `Entfernt: ${feed.title ?? host(feed.url)}. Gespeicherte Artikel bleiben.` };
      },
      async '/aktion/lesen/feeds/import'(form, session) {
        const file = form.files?.get('datei');
        if (!file?.data?.length) throw new ActionError('Bitte eine OPML-Datei wählen');
        const list = await asAction(() => parseOpml(file.data.toString('utf8')));
        if (!list.length) throw new ActionError('In der Datei steht kein Feed');
        let added = 0;
        for (const f of list) if (!store.addFeed({ ...f, interval_minutes: DEFAULT_INTERVAL }).duplicate) added += 1;
        logger.info?.(`Feeds: ${added} aus OPML importiert (${session.sub})`);
        const known = list.length - added;
        return { message: `${added} ${added === 1 ? 'Feed' : 'Feeds'} importiert${known ? `, ${known} schon abonniert` : ''}` };
      },
    },
  };
}
