import { safeFetch, normalizeUrl, FetchError } from './fetch.js';
import { extractArticle } from './extract.js';
import { pdfFields, isPdf, MAX_PDF } from './pdf.js';

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

// GitHubs Ansicht eines PDFs ist eine HTML-Seite ohne den Text; `/raw/` leitet auf die Datei weiter.
const GITHUB_PDF = /^(https:\/\/github\.com\/[^/]+\/[^/]+)\/blob\/(.+\.pdf)$/i;

/**
 * Artikel hinter einer Adresse → Felder für `addDocument`: HTML über
 * `extractArticle`, PDF (erkannt am Inhalt, nicht am Inhaltstyp) über
 * `pdfFields`. `opts` (etwa `auth`) gehen an `fetchPage`. Anderes: `FetchError`
 * mit Status 415; PDF-Fehler als `ReadingError`.
 */
export async function fetchArticle(url, { fetchPage = safeFetch, ...opts } = {}) {
  const page = await fetchPage(String(url).replace(GITHUB_PDF, '$1/raw/$2'), { accept: null, maxBytes: MAX_PDF, ...opts });
  if (isPdf(page.bytes)) return { url: page.url, ...(await pdfFields(page.bytes)) };
  const type = String(page.contentType ?? 'text/html').split(';')[0].trim().toLowerCase();
  if (!['text/html', 'application/xhtml+xml'].includes(type)) throw new FetchError(`Kein Artikel (${type || 'ohne Inhaltstyp'})`, 415);
  return extractArticle(page.body, page.url);
}
