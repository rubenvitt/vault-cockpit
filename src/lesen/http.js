import { ActionError } from '../cockpit/actions.js';
import { FetchError } from './fetch.js';
import { ReadingError } from './store.js';
import { saveUrl } from './save.js';
import { stackRoutes, toRead, upNext } from './stack.js';
import { inboxRoutes } from './inbox.js';
import { feedRoutes } from './feeds-page.js';
import { addRoutes } from './add.js';
import { docRoutes, docLink } from './doc.js';
import { highlightRoutes } from './highlights.js';
import { reviewRoutes } from './review-page.js';
import { listenRoutes, listenQueue, listenText, listenAudio } from './listen.js';
import { connectionRoutes } from './connections.js';
import { folgenRoutes } from './folgen-page.js';
import { ingestRoutes } from './ingest-page.js';
import { fragenRoutes } from '../fragen/page.js';
import { weiterRoutes } from './weiter.js';

/**
 * Routen des Bereichs „Lesen“, eingebunden in src/web/http.js (Sitzung, CSRF,
 * Meldungen und Rückgängig kommen von dort).
 *
 * - `pages`: Pfad → `async (ctx) => ({ html, status? } | { redirect } | { body, headers })`,
 *   nur angemeldet, nur GET. `ctx` siehe src/lesen/pages.js; `body` mit
 *   `headers` für Downloads (OPML-Export) und JSON. Pfade unter `/api/lesen/…`
 *   gelten auch mit dem Geräte-Token der App (src/lesen/json.js): Eingang,
 *   Stapel, Dokument (Lesetext als Blöcke), Markiert, Wiedersehen, Folgen.
 * - `actions`: Pfad → `async (form, session) => ({ message, undo?, redirect? })`
 *   wie die übrigen `/aktion/…`; Fehler als `ActionError`.
 * - `uploads`: Aktion → Größenlimit für Aktionen mit Datei (`multipart/form-data`),
 *   die Dateien liegen dann in `form.files`.
 *
 * - `offlineDocs(n)`: Links der nächsten `n` Artikel des Stapels (wie „Passt jetzt“) für den Offline-Cache.
 * - `listen`: Wiedergabeliste, Text und Audio zum Vorlesen (src/lesen/listen.js), für die App-API.
 *
 * Eine neue Seite oder Aktion ist ein Eintrag hier (gern aus einer eigenen Datei).
 * `capture` legt Notizen in der Vault-Inbox an („In Inbox“, src/lesen/highlights.js).
 * `review` geht an das Wiedersehen (`onOwnWords`, src/lesen/review-page.js).
 * `embedCache` ist der gemeinsame Speicher für Embeddings von Markierungen
 * (src/lesen/embed-cache.js); ohne gibt es keine Querverbindung im Wiedersehen.
 * `connections` (`index`, `semantic`, `policy`, `exporter`) schaltet die
 * Querverbindungen der Leseansicht ein (src/lesen/connections.js).
 * `speech` ist die Stimme vom Server (src/lesen/tts.js); ohne liest nur das Gerät vor.
 * `episodes` erzeugt Folgen aus dem Stapel (src/lesen/folgen.js); ohne gibt es die Seite „Folgen“ nicht.
 * `readNote(path)` liest eine Vault-Notiz (Text der Transkripte zum Kopieren
 * und Teilen), `publicUrl` macht deren Einmal-Links absolut.
 * `onChange(docId)` meldet Statuswechsel und geänderte Markierungen (für die
 * Lesestapel-Notiz im Vault, src/lesen/vault-export.js). `exporter` schaltet
 * „In den Vault“ und „Im Vault ablegen“ ein (VCP-96, src/lesen/doc.js).
 * `ingest` ist der Ingest-Dienst (src/lesen/ingest.js, `createIngest`); ohne
 * gibt es keine Ingest-Oberfläche (src/lesen/ingest-page.js), nur
 * `/api/lesen/ingest` mit `enabled: false`. `planter` pflanzt Übernommenes ein
 * (src/lesen/einpflanzen.js, `createPlanter`).
 *
 * `fragen` (`{ chat, index, visible }`, src/fragen/page.js) schaltet „Fragen“
 * ein: Gespräche mit Claude über den ganzen Vault.
 *
 * `nav` ergänzt die Unternavigation (`readingNav` in src/lesen/pages.js), etwa
 * um „Ingest“ mit der Zahl der bereiten Entwürfe; src/web/http.js reicht es als
 * `ctx.nav` an die Seiten.
 */
export function readingRoutes({ store, fetchPage = undefined, fetchFeed = undefined, capture = null, review = {}, embedCache = null, connections = null, exporter = null, speech = null, episodes = null, readNote = null, publicUrl = '', ingest = null, planter = null, fragen = null, triage = () => false, onChange = () => {}, logger = console }) {
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

  const inbox = inboxRoutes({ store, vault: Boolean(exporter), triage });

  const add = addRoutes({ store, asAction, logger });

  const doc = docRoutes({ store, asAction, onChange, exporter, ingest });
  const marked = highlightRoutes({ store, asAction, capture, onChange, logger });
  const wiedersehen = reviewRoutes({ store, capture, logger, embedCache, ...review });
  const folgen = folgenRoutes({ store, episodes, ingest, readNote, publicUrl });
  const ingestUi = ingestRoutes({ store, ingest, planter, logger });
  const ask = fragen ? fragenRoutes(fragen) : { pages: {}, actions: {} };
  // „Weiter“: wo jeder Text steht und was als Nächstes geht; Einstieg in den Bereich.
  const weiter = weiterRoutes({ store, ingest, planter, episodes, vault: Boolean(exporter) });
  const links = connections ? connectionRoutes({ store, embedCache, logger, ...connections }) : { pages: {}, actions: {} };

  return {
    nav: ingest || fragen ? () => ({ ...(ingest ? { ingest: ingest.counts()?.bereit ?? 0 } : {}), ...(fragen ? { fragen: true } : {}) }) : null,
    offlineDocs: (n) => upNext(toRead(store.list({ status: 'stapel', limit: -1 })), n).map((d) => docLink(d.id)),
    listen: {
      queue: (zeit) => listenQueue(store, zeit),
      text: (id) => listenText(store, id),
      audio: (params) => listenAudio(store, speech, params),
      voice: () => speech?.voice() ?? null,
    },
    /** Einmal-Link eines Transkripts, ohne Anmeldung (`{ path, get }`, src/lesen/folgen-page.js) oder null. */
    shared: folgen.shared,
    /** Pfad der fertigen MP3 einer Folge oder null (für `/api/app/folge`). */
    episodeAudio: (id) => episodes?.audioPath(id) ?? null,
    uploads: { ...add.uploads, ...feeds.uploads },
    pages: {
      ...add.pages,
      '/lesen': async () => ({ redirect: '/lesen/weiter' }),
      ...weiter.pages,
      ...inbox.pages,
      ...stackRoutes({ store, vault: Boolean(exporter), folgen: Boolean(episodes), ingest }).pages,
      ...listenRoutes({ store, speech }).pages,
      ...folgen.pages,
      ...ingestUi.pages,
      ...feeds.pages,
      ...doc.pages,
      ...marked.pages,
      ...wiedersehen.pages,
      ...links.pages,
      ...ask.pages,
    },
    actions: {
      ...folgen.actions,
      ...weiter.actions,
      ...ingestUi.actions,
      ...inbox.actions,
      ...add.actions,
      ...doc.actions,
      ...marked.actions,
      ...wiedersehen.actions,
      ...links.actions,
      ...ask.actions,
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
