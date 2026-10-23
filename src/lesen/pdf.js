import { createHash } from 'node:crypto';
import { getDocumentProxy, extractText } from 'unpdf';
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
 */

export const MAX_PDF = 20 * 1024 * 1024;

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
 * Legt ein PDF im Eingang ab. `data`: Buffer, `filename` für den Titel, falls
 * das PDF keinen hat. Idempotent per `clientId` und Inhalt. Liefert `{ doc, duplicate }`.
 * shortcut: kein Zeitlimit für das Auslesen, nur das Größenlimit; ein Worker mit Timeout, falls einzelne PDFs den Dienst aufhalten.
 */
export async function savePdf({ store, data, filename = null, origin = 'formular', clientId = null }) {
  if (!data?.length) throw new ReadingError('Keine PDF-Datei');
  if (data.length > MAX_PDF) throw new ReadingError(`Die PDF-Datei ist zu groß (höchstens ${MAX_PDF / 1024 / 1024} MB)`);
  if (Buffer.from(data.subarray(0, 5)).toString('latin1') !== '%PDF-') throw new ReadingError('Das ist keine PDF-Datei');
  const url = `pdf:sha256-${createHash('sha256').update(data).digest('hex')}`;
  const known = store.find({ client_id: clientId, url });
  if (known) return { doc: known, duplicate: true };

  let info = {};
  let pages;
  try {
    // Eigene Kopie: pdf.js übernimmt den Puffer und gibt ihn danach nicht zurück.
    const pdf = await getDocumentProxy(new Uint8Array(data), { verbosity: 0 });
    try {
      info = (await pdf.getMetadata().catch(() => null))?.info ?? {};
      pages = (await extractText(pdf, { mergePages: false })).text;
    } finally {
      await pdf.loadingTask.destroy();
    }
  } catch {
    throw new ReadingError('Die PDF-Datei lässt sich nicht lesen');
  }
  const paragraphs = pages.flatMap(paragraphsOf);
  if (!paragraphs.length) throw new ReadingError('Das PDF enthält keinen Text (gescannt?), nichts gespeichert');
  const name = String(filename ?? '').replace(/\.pdf$/i, '').trim();
  const meta = (v) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 300) : null);
  return store.addDocument({
    url,
    title: meta(info.Title) || name.slice(0, 300) || paragraphs[0].slice(0, 120),
    author: meta(info.Author),
    kind: 'pdf',
    origin,
    client_id: clientId,
    ...textFields(paragraphs.map((p) => `<p>${esc(p)}</p>`).join('')),
  });
}
