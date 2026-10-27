import { createHash } from 'node:crypto';
import { getDocumentProxy } from 'unpdf';
import { esc } from '../web/layout.js';
import { textFields } from './extract.js';
import { ReadingError } from './store.js';

/**
 * PDFs in den Lesestapel (VCP-69): Text herausziehen (unpdf, reines JS mit
 * pdf.js), daraus Absätze als Lesetext machen, Lesezeit wie bei Artikeln. Die
 * Datei selbst wird nicht gespeichert. Adresse ist `pdf:sha256-<Hash>`, dieselbe
 * Datei liegt also nur einmal im Stapel.
 *
 * Vertrauensgrenze: höchstens `MAX_PDF` Bytes, beginnt mit `%PDF-`, sonst
 * `ReadingError`; ein PDF ohne Text (gescannt) wird abgelehnt statt leer abgelegt.
 * Auslesen begrenzt (`LIMITS`): Seitenzahl, Textmenge und Gesamtzeit, damit ein
 * bösartiges PDF (gepackte Streams, sehr viele Seiten) den Dienst nicht aufhält.
 */

export const MAX_PDF = 20 * 1024 * 1024;
export const LIMITS = { pages: 500, chars: 2_000_000, ms: 20_000 };

const limitError = (message, status) => Object.assign(new ReadingError(message), { status });

/**
 * Text je Seite, Seite für Seite; bricht bei zu vielen Seiten, zu viel Text oder
 * nach `LIMITS.ms` ab und gibt pdf.js dann frei.
 * shortcut: Grenzen im selben Prozess (pdf.js ohne Worker); eine einzelne Seite, die den Event-Loop lange blockiert, hält auch das Zeitlimit auf. Worker mit `resourceLimits`, falls der Upload je ohne Anmeldung offen ist.
 */
async function readPages(data) {
  let pdf = null;
  let stopped = false;
  const release = () => pdf?.loadingTask.destroy().catch(() => {});
  const work = (async () => {
    try {
      // Eigene Kopie: pdf.js übernimmt den Puffer und gibt ihn danach nicht zurück.
      pdf = await getDocumentProxy(new Uint8Array(data), { verbosity: 0 });
    } catch {
      throw new ReadingError('Die PDF-Datei lässt sich nicht lesen');
    }
    if (pdf.numPages > LIMITS.pages) throw limitError(`Das PDF hat ${pdf.numPages} Seiten, höchstens ${LIMITS.pages} gehen`, 413);
    const info = (await pdf.getMetadata().catch(() => null))?.info ?? {};
    const pages = [];
    let chars = 0;
    for (let n = 1; n <= pdf.numPages && !stopped; n++) {
      let text;
      try {
        const page = await pdf.getPage(n);
        text = (await page.getTextContent()).items.filter((i) => i.str != null).map((i) => i.str + (i.hasEOL ? '\n' : '')).join('');
        page.cleanup();
      } catch {
        throw new ReadingError('Die PDF-Datei lässt sich nicht lesen');
      }
      chars += text.length;
      if (chars > LIMITS.chars) throw limitError(`Das PDF enthält zu viel Text (höchstens ${LIMITS.chars / 1_000_000} Mio. Zeichen)`, 413);
      pages.push(text);
    }
    return { info, pages };
  })();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(limitError(`Das PDF ließ sich nicht in ${LIMITS.ms / 1000} Sekunden auslesen`, 422)), LIMITS.ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    stopped = true;
    clearTimeout(timer);
    work.catch(() => {}).finally(release);
  }
}

/**
 * Zeilen einer Seite zu Absätzen: Eine Zeile, die mit Satzzeichen endet, schließt
 * den Absatz; Silbentrennung am Zeilenende wird zusammengezogen.
 * shortcut: Absätze nur geraten (Satzende am Zeilenende), Spalten, Kopf- und Fußzeilen bleiben im Text; bei Bedarf Positionen aus extractTextItems auswerten.
 */
export function paragraphsOf(pageText) {
  const out = [];
  let cur = '';
  for (const line of pageText.split('\n').map((l) => l.trim())) {
    if (!line) {
      if (cur) out.push(cur);
      cur = '';
      continue;
    }
    cur = /\p{L}-$/u.test(cur) && /^\p{Ll}/u.test(line) ? cur.slice(0, -1) + line : cur ? `${cur} ${line}` : line;
    if (/[.!?:…]["“”'’)]?$/.test(line)) {
      out.push(cur);
      cur = '';
    }
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * PDF-Inhalt (`data`: Buffer) → Felder für `addDocument` (Titel, Autor, Lesetext,
 * `kind: 'pdf'`), ohne Adresse und Herkunft. `filename` für den Titel, falls das
 * PDF keinen hat. Fehler als `ReadingError`, bei überschrittenen Grenzen mit
 * `status` 413 oder 422.
 */
export async function pdfFields(data, filename = null) {
  if (!data?.length) throw new ReadingError('Keine PDF-Datei');
  if (data.length > MAX_PDF) throw limitError(`Die PDF-Datei ist zu groß (höchstens ${MAX_PDF / 1024 / 1024} MB)`, 413);
  if (!isPdf(data)) throw new ReadingError('Das ist keine PDF-Datei');
  const { info, pages } = await readPages(data);
  const paragraphs = pages.flatMap(paragraphsOf);
  if (!paragraphs.length) throw new ReadingError('Das PDF enthält keinen Text (gescannt?), nichts gespeichert');
  const name = String(filename ?? '').replace(/\.pdf$/i, '').trim();
  const meta = (v) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 300) : null);
  return {
    title: meta(info.Title) || name.slice(0, 300) || paragraphs[0].slice(0, 120),
    author: meta(info.Author),
    kind: 'pdf',
    ...textFields(paragraphs.map((p) => `<p>${esc(p)}</p>`).join('')),
  };
}

/** Ob `data` mit `%PDF-` beginnt; der Inhaltstyp lügt oft (`application/octet-stream`). */
export const isPdf = (data) => Buffer.from(data?.subarray?.(0, 5) ?? []).toString('latin1') === '%PDF-';

/**
 * Legt ein PDF im Eingang ab. `data`: Buffer, `filename` für den Titel, falls
 * das PDF keinen hat. Idempotent per `clientId` und Inhalt. Liefert `{ doc, duplicate }`.
 * Fehler als `ReadingError`, bei überschrittenen Grenzen mit `status` 413 oder 422.
 */
export async function savePdf({ store, data, filename = null, origin = 'formular', clientId = null }) {
  if (!data?.length) throw new ReadingError('Keine PDF-Datei');
  if (data.length > MAX_PDF) throw limitError(`Die PDF-Datei ist zu groß (höchstens ${MAX_PDF / 1024 / 1024} MB)`, 413);
  if (!isPdf(data)) throw new ReadingError('Das ist keine PDF-Datei');
  const url = `pdf:sha256-${createHash('sha256').update(data).digest('hex')}`;
  const known = store.find({ client_id: clientId, url });
  if (known) return { doc: known, duplicate: true };
  return store.addDocument({ url, origin, client_id: clientId, ...(await pdfFields(data, filename)) });
}
