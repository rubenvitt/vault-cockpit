import { ActionError } from '../cockpit/actions.js';
import { FetchError } from './fetch.js';
import { ReadingError } from './store.js';
import { saveUrl } from './save.js';
import { renderInbox, renderStack, renderHighlights } from './pages.js';
import { feedRoutes } from './feeds-page.js';

/**
 * Routen des Bereichs „Lesen“, eingebunden in src/web/http.js (Sitzung, CSRF,
 * Meldungen und Rückgängig kommen von dort).
 *
 * - `pages`: Pfad → `async (ctx) => ({ html, status? } | { redirect } | { body, headers })`,
 *   nur angemeldet, nur GET. `ctx` siehe src/lesen/pages.js; `body` mit
 *   `headers` für Downloads (OPML-Export).
 * - `actions`: Pfad → `async (form, session) => ({ message, undo?, redirect? })`
 *   wie die übrigen `/aktion/…`; Fehler als `ActionError`. Mit Datei
 *   (`multipart/form-data`) liegen die Dateien unter `form.files`.
 *
 * Eine neue Seite oder Aktion ist ein Eintrag hier (gern aus einer eigenen Datei).
 */
export function readingRoutes({ store, fetchPage = undefined, fetchFeed = undefined, logger = console }) {
  const feeds = feedRoutes({ store, fetchFeed, logger });
  /** Fehler aus Abruf und Speicher als Meldung für die Seite. */
  const asAction = async (run) => {
    try {
      return await run();
    } catch (err) {
      if (err instanceof FetchError) throw new ActionError(err.message, err.status);
      if (err instanceof ReadingError) throw new ActionError(err.message, 400);
      throw err;
    }
  };

  return {
    pages: {
      '/lesen': async () => ({ redirect: '/lesen/eingang' }),
      '/lesen/eingang': async (ctx) => ({ html: renderInbox(store.list({ status: 'eingang' }), ctx) }),
      '/lesen/stapel': async (ctx) => ({ html: renderStack(store.list({ status: 'stapel' }), ctx) }),
      '/lesen/markiert': async (ctx) => ({ html: renderHighlights(store.listHighlights(), ctx) }),
      ...feeds.pages,
    },
    actions: {
      async '/aktion/lesen/speichern'(form, session) {
        const url = (form.get('url') ?? '').trim();
        if (!url) throw new ActionError('Bitte eine Adresse eingeben');
        const { doc, duplicate } = await asAction(() => saveUrl({ store, url, origin: 'formular', clientId: form.get('cid') || null, ...(fetchPage ? { fetchPage } : {}) }));
        if (!duplicate) logger.info?.(`Lesestapel: ${doc.url} gespeichert (${session.sub})`);
        return { message: `${duplicate ? 'Schon im Lesestapel' : 'Gespeichert'}: ${doc.title ?? doc.url}`, doc: { id: doc.id, title: doc.title, status: doc.status } };
      },
      ...feeds.actions,
    },
  };
}
