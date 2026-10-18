/**
 * Kleinster Parser für `multipart/form-data`, gerade genug für ein Formular
 * mit Textfeldern und einer hochgeladenen Datei (Sicherung wiederherstellen).
 * Ohne Abhängigkeit, mit Größenlimit; alles landet im Speicher.
 */

export class FormError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

/** Liest den Body bis `limit` Bytes. Darüber wird der Rest verworfen, damit die Antwort noch ankommt. */
function readLimited(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size <= limit) chunks.push(c);
      // Weit darüber: Verbindung kappen statt alles mitzulesen.
      else if (size > 4 * limit) req.destroy();
    });
    req.on('end', () => (size > limit ? reject(new FormError('Die Datei ist zu groß', 413)) : resolve(Buffer.concat(chunks))));
    req.on('error', reject);
    req.on('close', () => size > limit && reject(new FormError('Die Datei ist zu groß', 413)));
  });
}

const param = (disposition, key) => new RegExp(`(?:^|;)\\s*${key}="([^"]*)"`, 'i').exec(disposition)?.[1];

/**
 * Zerlegt einen Body; `fields` als `URLSearchParams` (wie bei den übrigen
 * Formularen), `files` als Map Name → `{ filename, type, data }`.
 */
export function parseMultipart(body, boundary, { maxParts = 10 } = {}) {
  const delimiter = Buffer.from(`--${boundary}`);
  const next = Buffer.from(`\r\n--${boundary}`);
  const fields = new URLSearchParams();
  const files = new Map();
  let pos = body.indexOf(delimiter);
  if (pos < 0) throw new FormError('Formular unvollständig');
  pos += delimiter.length;
  for (let parts = 0; ; parts++) {
    if (body.subarray(pos, pos + 2).toString('latin1') === '--') break;
    if (parts >= maxParts) throw new FormError('Formular mit zu vielen Teilen');
    if (body.subarray(pos, pos + 2).toString('latin1') !== '\r\n') throw new FormError('Formular unvollständig');
    const headEnd = body.indexOf('\r\n\r\n', pos + 2);
    const end = headEnd < 0 ? -1 : body.indexOf(next, headEnd + 4);
    if (end < 0) throw new FormError('Formular unvollständig');
    const head = body.subarray(pos + 2, headEnd).toString('utf8');
    const disposition = /^content-disposition:\s*form-data\s*(;[^\r\n]*)/im.exec(head)?.[1];
    const name = disposition && param(disposition, 'name');
    if (!name) throw new FormError('Formularteil ohne Namen');
    const data = body.subarray(headEnd + 4, end);
    const filename = param(disposition, 'filename');
    if (filename === undefined) fields.append(name, data.toString('utf8'));
    else if (!files.has(name)) files.set(name, { filename, type: /^content-type:\s*([^\r\n]*)/im.exec(head)?.[1] ?? null, data });
    pos = end + next.length;
  }
  return { fields, files };
}

/** Liest und zerlegt eine Anfrage mit `multipart/form-data`. */
export async function readMultipart(req, { limit, maxParts = 10 }) {
  const m = /^multipart\/form-data\s*;.*?\bboundary=(?:"([^"]{1,70})"|([^\s;]{1,70}))/i.exec(req.headers['content-type'] ?? '');
  if (!m) throw new FormError('Formular mit Datei erwartet (multipart/form-data)', 415);
  return parseMultipart(await readLimited(req, limit), m[1] ?? m[2], { maxParts });
}
