import { ActionError } from '../cockpit/actions.js';
import { FetchError } from './fetch.js';
import { ReadingError } from './store.js';
import { saveUrl } from './save.js';
import { renderInbox, renderStack, renderHighlights } from './pages.js';
import { stackRoutes } from './stack.js';

/**
 * Routen des Bereichs „Lesen“, eingebunden in src/web/http.js (Sitzung, CSRF,
 * Meldungen und Rückgängig kommen von dort).
 *
 * - `pages`: Pfad → `async (ctx) => ({ html, status? } | { redirect })`, nur
 *   angemeldet, nur GET. `ctx` siehe src/lesen/pages.js.
 * - `actions`: Pfad → `async (form, session) => ({ message, undo?, redirect? })`
 *   wie die übrigen `/aktion/…`; Fehler als `ActionError`.
 *
 * Eine neue Seite oder Aktion ist ein Eintrag hier (gern aus einer eigenen Datei).
 */
export function readingRoutes({ store, fetchPage = undefined, logger = console }) {
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
      ...stackRoutes({ store }).pages,
      '/lesen/markiert': async (ctx) => ({ html: renderHighlights(store.listHighlights(), ctx) }),
    },
    actions: {
      async '/aktion/lesen/speichern'(form, session) {
        const url = (form.get('url') ?? '').trim();
        if (!url) throw new ActionError('Bitte eine Adresse eingeben');
        const { doc, duplicate } = await asAction(() => saveUrl({ store, url, origin: 'formular', clientId: form.get('cid') || null, ...(fetchPage ? { fetchPage } : {}) }));
        if (!duplicate) logger.info?.(`Lesestapel: ${doc.url} gespeichert (${session.sub})`);
        return { message: `${duplicate ? 'Schon im Lesestapel' : 'Gespeichert'}: ${doc.title ?? doc.url}`, doc: { id: doc.id, title: doc.title, status: doc.status } };
      },
    },
  };
}
