import { safeFetch, normalizeUrl } from './fetch.js';
import { extractArticle } from './extract.js';

/**
 * Eine Adresse in den Lesestapel holen: SSRF-sicher abrufen, Lesetext
 * extrahieren, im Eingang ablegen. Idempotent: Ist `clientId` oder die Adresse
 * schon bekannt, wird nichts geholt. Für Formular, Kurzbefehl, Mail und
 * Schnelleingabe gleichermaßen; `origin` sagt später „Warum hier?“.
 *
 * Liefert `{ doc, duplicate }`. Fehler: `FetchError` (Abruf) oder
 * `ReadingError` (Speicher), beide mit verständlicher Meldung.
 */
export async function saveUrl({ store, url, origin = 'formular', clientId = null, fetchPage = safeFetch }) {
  const target = normalizeUrl(url);
  const known = store.find({ client_id: clientId, url: target });
  if (known) return { doc: known, duplicate: true };
  const page = await fetchPage(target);
  return store.addDocument({ ...extractArticle(page.body, page.url), origin, client_id: clientId });
}
