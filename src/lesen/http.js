import { ActionError } from '../cockpit/actions.js';
import { FetchError } from './fetch.js';
import { ReadingError } from './store.js';
import { saveUrl } from './save.js';
import { stackRoutes } from './stack.js';
import { inboxRoutes } from './inbox.js';
import { feedRoutes } from './feeds-page.js';
import { addRoutes } from './add.js';
import { docRoutes } from './doc.js';
import { highlightRoutes } from './highlights.js';
import { reviewRoutes } from './review-page.js';

/**
 * Routen des Bereichs „Lesen“, eingebunden in src/web/http.js (Sitzung, CSRF,
 * Meldungen und Rückgängig kommen von dort).
 *
 * - `pages`: Pfad → `async (ctx) => ({ html, status? } | { redirect } | { body, headers })`,
 *   nur angemeldet, nur GET. `ctx` siehe src/lesen/pages.js; `body` mit
 *   `headers` für Downloads (OPML-Export).
 * - `actions`: Pfad → `async (form, session) => ({ message, undo?, redirect? })`
 *   wie die übrigen `/aktion/…`; Fehler als `ActionError`.
 * - `uploads`: Aktion → Größenlimit für Aktionen mit Datei (`multipart/form-data`),
 *   die Dateien liegen dann in `form.files`.
 *
 * Eine neue Seite oder Aktion ist ein Eintrag hier (gern aus einer eigenen Datei).
 * `capture` legt Notizen in der Vault-Inbox an („In Inbox“, src/lesen/highlights.js).
 * `review` geht an das Wiedersehen (`onOwnWords`, src/lesen/review-page.js).
 * `embedCache` ist der gemeinsame Speicher für Embeddings von Markierungen
 * (src/lesen/embed-cache.js); ohne gibt es keine Querverbindung im Wiedersehen.
 * `onChange(docId)` meldet Archivieren, „fertig gelesen“ und geänderte
 * Markierungen (für die Lesestapel-Notiz im Vault, src/lesen/vault-export.js).
 */
export function readingRoutes({ store, fetchPage = undefined, fetchFeed = undefined, capture = null, review = {}, embedCache = null, onChange = () => {}, logger = console }) {
  const feeds = feedRoutes({ store, fetchFeed, logger });
  /** Fehler aus Abruf und Speicher als Meldung für die Seite. */
  const asAction = async (run) => {
    try {
      return await run();
    } catch (err) {
      if (err instanceof FetchError) throw new ActionError(err.message, err.status);
      if (err instanceof ReadingError) throw new ActionError(err.message, err.status ?? 400);
      throw err;
    }
  };

  const inbox = inboxRoutes({ store });

  const add = addRoutes({ store, asAction, logger });

  const doc = docRoutes({ store, asAction, onChange });
  const marked = highlightRoutes({ store, asAction, capture, onChange, logger });
  const wiedersehen = reviewRoutes({ store, capture, logger, embedCache, ...review });

  return {
    uploads: { ...add.uploads, ...feeds.uploads },
    pages: {
      ...add.pages,
      '/lesen': async () => ({ redirect: '/lesen/eingang' }),
      ...inbox.pages,
      ...stackRoutes({ store }).pages,
      ...feeds.pages,
      ...doc.pages,
      ...marked.pages,
      ...wiedersehen.pages,
    },
    actions: {
      ...inbox.actions,
      ...add.actions,
      ...doc.actions,
      ...marked.actions,
      ...wiedersehen.actions,
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
