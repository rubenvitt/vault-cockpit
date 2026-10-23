import { CAPTURE_ID } from '../capture/router.js';
import { SCOPES } from '../cockpit/tokens.js';
import { readLimited, FormError } from '../web/multipart.js';
import { FetchError } from './fetch.js';
import { ReadingError } from './store.js';
import { saveUrl } from './save.js';

/**
 * `POST /lesestapel/speichern`: Artikel von außen in den Eingang des
 * Lesestapels, für den Kurzbefehl „Zum Lesestapel“ aus dem Teilen-Menü.
 *
 * Vertrauensgrenze wie `/capture` (src/capture/http.js): nur mit einem
 * API-Token mit dem Recht „Lesestapel“. Ein Token mit einem anderen Recht
 * bekommt 403, ein unbekannter 401; der alte `CAPTURE_TOKEN` gilt hier nicht.
 * Die Adresse geht nur über `saveUrl` (SSRF-Schutz in fetch.js), der Body ist
 * begrenzt.
 *
 * - Text (`text/plain`): die erste http(s)-Adresse darin.
 * - JSON `{url, title?, source?, id?}`: `source` ist `kurzbefehl` (Standard)
 *   oder `import`, `id` macht das Speichern idempotent wie bei `/capture`.
 *
 * Antwort mit `message` als fertigem Satz für die Mitteilung auf dem iPhone,
 * Fehler zusätzlich mit `status` im Body (der Kurzbefehl sieht den HTTP-Status nicht).
 */

export const PATH = '/lesestapel/speichern';
const MAX_BODY = 16 * 1024;
const ORIGINS = ['kurzbefehl', 'import'];

class ApiError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function errorMessage(status, error) {
  if (status === 401) return 'Token abgelehnt. Den Lesestapel-Token im Kurzbefehl prüfen.';
  if (status === 403) return 'Dieser Token darf nichts in den Lesestapel legen. Unter Einstellungen → API-Tokens einen mit dem Recht „Lesestapel“ anlegen.';
  return `Nicht gespeichert: ${error}`;
}

/** `fetchPage` nur für Tests (Standard: `safeFetch`). */
export function createReadingApi({ tokens, store, fetchPage = undefined, logger = console }) {
  const json = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  const fail = (res, status, error) => json(res, status, { error, status, message: errorMessage(status, error) });

  /** 0 = darf, sonst der HTTP-Status. */
  const access = (req) => {
    const m = /^Bearer (\S+)$/.exec(String(req.headers.authorization ?? ''));
    if (!m || !tokens) return 401;
    if (tokens.verify(m[1], 'lesestapel')) return 0;
    return SCOPES.some((s) => tokens.verify(m[1], s)) ? 403 : 401;
  };

  function parse(req, url, body) {
    const type = String(req.headers['content-type'] ?? '');
    let input;
    if (type.includes('application/json')) {
      try {
        input = JSON.parse(body.toString('utf8') || '{}');
      } catch {
        throw new ApiError('Kein gültiges JSON');
      }
      if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new ApiError('JSON-Objekt erwartet');
    } else {
      const text = body.toString('utf8');
      input = { url: text.match(/https?:\/\/\S+/i)?.[0] ?? text.trim() };
    }
    for (const field of ['url', 'title', 'source', 'id']) {
      if (input[field] !== undefined && input[field] !== null && typeof input[field] !== 'string') throw new ApiError(`Feld "${field}" muss Text sein`);
    }
    const origin = input.source ?? url.searchParams.get('source') ?? 'kurzbefehl';
    if (!ORIGINS.includes(origin)) throw new ApiError(`Unbekannte Quelle "${origin}" (möglich: ${ORIGINS.join(', ')})`);
    const clientId = input.id ?? url.searchParams.get('id') ?? null;
    if (clientId !== null && !CAPTURE_ID.test(clientId)) throw new ApiError('Ungültige ID (Buchstaben, Ziffern und _ . : -, höchstens 128 Zeichen)');
    if (!input.url?.trim()) throw new ApiError('Adresse fehlt');
    const title = input.title?.trim().slice(0, 300) || null;
    return { url: input.url.trim(), title, origin, clientId };
  }

  return {
    matches: (path) => path === PATH,

    async handle(req, res, url) {
      const denied = access(req);
      if (denied) return fail(res, denied, denied === 401 ? 'unauthorized' : 'forbidden');
      if (req.method !== 'POST') return fail(res, 405, 'method not allowed');
      try {
        const body = await readLimited(req, MAX_BODY);
        const input = parse(req, url, body);
        let { doc, duplicate } = await saveUrl({ store, url: input.url, origin: input.origin, clientId: input.clientId, ...(fetchPage ? { fetchPage } : {}) });
        if (!duplicate && input.title) doc = store.updateDocument(doc.id, { title: input.title });
        if (!duplicate) logger.info?.(`Lesestapel (${input.origin}) → ${doc.url}`);
        const name = doc.title ?? doc.url;
        return json(res, duplicate ? 200 : 201, { ok: true, duplicate, id: doc.id, title: doc.title, url: doc.url, kind: doc.kind, message: duplicate ? `Schon im Lesestapel: ${name}` : `Im Lesestapel: ${name}` });
      } catch (err) {
        if (err instanceof ApiError || err instanceof FetchError || err instanceof FormError) return fail(res, err.status, err.message);
        if (err instanceof ReadingError) return fail(res, 400, err.message);
        throw err;
      }
    },
  };
}
