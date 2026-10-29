import { safeFetch, normalizeUrl, FetchError, MAX_PAGE } from './fetch.js';
import { extractArticle } from './extract.js';
import { pdfFields, isPdf, MAX_PDF } from './pdf.js';

/**
 * Eine Adresse in den Lesestapel holen: SSRF-sicher abrufen, Lesetext
 * extrahieren, im Eingang ablegen. Idempotent: Ist `clientId` oder die Adresse
 * schon bekannt, wird nichts geholt. Für Formular, Kurzbefehl, Mail und
 * Schnelleingabe gleichermaßen; `origin` sagt später „Warum hier?“.
 * Steht hinter der Adresse ein PDF (etwa aus Safari geteilt), wird dessen Text
 * gespeichert (`fetchArticle` mit `allowPdf`): `saveUrl` läuft nur auf
 * Zutun des Nutzers, nie im Hintergrund für Adressen Dritter.
 *
 * Liefert `{ doc, duplicate }`. Fehler: `FetchError` (Abruf) oder
 * `ReadingError` (Speicher), beide mit verständlicher Meldung.
 */
export async function saveUrl({ store, url, origin = 'formular', clientId = null, fetchPage = safeFetch }) {
  const target = normalizeUrl(url);
  const known = store.find({ client_id: clientId, url: target });
  if (known) return { doc: known, duplicate: true };
  const fields = await fetchArticle(target, { fetchPage, allowPdf: true });
  return store.addDocument({ ...fields, origin, client_id: clientId });
}

// GitHubs Ansicht eines PDFs ist eine HTML-Seite ohne den Text; `/raw/` leitet auf die Datei weiter.
const GITHUB_PDF = /^(https:\/\/github\.com\/[^/]+\/[^/]+)\/blob\/(.+\.pdf)$/i;

/**
 * Artikel hinter einer Adresse → Felder für `addDocument`. `opts` (etwa `auth`)
 * gehen an `fetchPage`. Ohne `allowPdf` nur HTML, mit den
 * Grenzen von `safeFetch`. Mit `allowPdf` auch PDFs (erkannt am Inhalt, nicht am
 * Inhaltstyp) über `pdfFields`, dann anderes als `FetchError` 415.
 * `allowPdf` nur auf Knopfdruck, nie im Hintergrundabruf von Adressen Dritter:
 * pdf.js läuft im Hauptprozess (src/lesen/pdf.js, `readPages`), ein präpariertes
 * PDF hielte den Dienst auf.
 */
export async function fetchArticle(url, { fetchPage = safeFetch, allowPdf = false, ...opts } = {}) {
  if (!allowPdf) {
    const page = await fetchPage(url, opts);
    return extractArticle(page.body, page.url);
  }
  const page = await fetchPage(String(url).replace(GITHUB_PDF, '$1/raw/$2'), { accept: null, maxBytes: MAX_PDF, ...opts });
  if (isPdf(page.bytes)) return { url: page.url, ...(await pdfFields(page.bytes)) };
  const type = String(page.contentType ?? 'text/html').split(';')[0].trim().toLowerCase();
  if (!['text/html', 'application/xhtml+xml'].includes(type)) throw new FetchError(`Kein Artikel (${type || 'ohne Inhaltstyp'})`, 415);
  // Die höhere Grenze gilt nur für PDFs, eine Seite bleibt bei der von `safeFetch`.
  if ((page.bytes?.length ?? 0) > MAX_PAGE) throw new FetchError('Die Seite ist zu groß', 413);
  return extractArticle(page.body, page.url);
}
