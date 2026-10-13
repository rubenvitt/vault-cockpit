import { createHash, timingSafeEqual } from 'node:crypto';
import { CaptureError } from './router.js';

const HTTP_SOURCES = ['api', 'ios-kurzbefehl', 'sprachmemo'];
const FUNKE_PREFIX = /^\d{4}-\d{2}-\d{2} \d{4}(?: |$)/;

const sha256 = (s) => createHash('sha256').update(s).digest();

/**
 * Capture-Endpunkte für Geräte, die kein OAuth sprechen (iOS-Kurzbefehl, Funke).
 *
 * Geschützt mit einem eigenen statischen Token (`CAPTURE_TOKEN`), getrennt vom
 * OAuth der MCP-Schnittstelle. Der Token kann nur anlegen: neue Notizen im
 * Capture-Ordner oder, mit `!`, Aufgaben in der Zunder-Inbox. Lesen oder
 * Ändern bestehender Notizen ist damit nicht möglich.
 *
 * - `POST /capture` — Text (`text/plain`) oder JSON `{text, title?, source?, id?}`.
 *   `source` ist `ios-kurzbefehl`, `sprachmemo` oder `api` (Standard), alternativ
 *   als Query-Parameter. Die Transkription eines Sprachmemos macht das iPhone.
 * - `GET /capture` — Verbindungstest.
 * - `POST /funke/notes`, `GET /funke/health` — dieselbe Schnittstelle wie der
 *   Funke-Relay. Funke braucht damit keinen eigenen Relay mehr, als Relay-URL
 *   genügt `<PUBLIC_URL>/funke`. Der Ordner aus der App wird ignoriert, die Notiz
 *   landet immer im Capture-Ordner.
 */
export function createCaptureHttp({ token, router, zunderEnabled = false }) {
  const expected = sha256(`Bearer ${token}`);
  const authorized = (req) => timingSafeEqual(sha256(String(req.headers.authorization ?? '')), expected);

  const json = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  // Fehler tragen den Status auch im Body: Ein iOS-Kurzbefehl sieht den HTTP-Status nicht.
  const fail = (res, status, error) => json(res, status, { error, status });

  function parseCapture(req, url, body) {
    const type = String(req.headers['content-type'] ?? '');
    let input = {};
    if (type.includes('application/json')) {
      try {
        input = JSON.parse(body || '{}');
      } catch {
        throw new CaptureError('Kein gültiges JSON');
      }
      if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new CaptureError('JSON-Objekt erwartet');
    } else {
      input = { text: body };
    }
    const source = input.source ?? url.searchParams.get('source') ?? 'api';
    if (!HTTP_SOURCES.includes(source)) {
      throw new CaptureError(`Unbekannte Quelle "${source}" (möglich: ${HTTP_SOURCES.join(', ')})`);
    }
    for (const field of ['text', 'title', 'id']) {
      if (input[field] !== undefined && input[field] !== null && typeof input[field] !== 'string') {
        throw new CaptureError(`Feld "${field}" muss Text sein`);
      }
    }
    return {
      text: input.text,
      title: input.title ?? url.searchParams.get('title') ?? null,
      source,
      captureId: input.id ?? url.searchParams.get('id') ?? null,
    };
  }

  function parseFunke(body) {
    let note;
    try {
      note = JSON.parse(body || '{}');
    } catch {
      throw new CaptureError('bad json');
    }
    const filename = typeof note.filename === 'string' ? note.filename.trim() : '';
    const content = typeof note.content === 'string' ? note.content : '';
    if (!filename) throw new CaptureError('empty filename');
    const created = typeof note.createdAt === 'string' ? new Date(note.createdAt) : null;
    return {
      text: content,
      title: filename.replace(FUNKE_PREFIX, '').trim() || 'Funke-Notiz',
      source: 'funke',
      // Funke sendet aus der Offline-Queue byte-identisch nach: gleicher Inhalt,
      // gleiche ID, keine zweite Notiz.
      captureId: `funke-${createHash('sha256').update(`${filename}\n${content}`).digest('hex').slice(0, 32)}`,
      created: created && !Number.isNaN(created.getTime()) ? created : null,
      allowTask: false,
    };
  }

  return {
    matches: (path) => path === '/capture' || path === '/funke/notes' || path === '/funke/health',

    async handle(req, res, url, body) {
      if (!authorized(req)) return fail(res, 401, 'unauthorized');
      const path = url.pathname;

      if (req.method === 'GET' && (path === '/capture' || path === '/funke/health')) {
        return json(res, 200, { ok: true, zunder: zunderEnabled });
      }
      if (req.method !== 'POST' || path === '/funke/health') return fail(res, 405, 'method not allowed');

      try {
        const input = path === '/funke/notes' ? parseFunke(body) : parseCapture(req, url, body);
        const result = await router.route(input);
        return json(res, result.duplicate ? 200 : 201, { ok: true, ...result });
      } catch (err) {
        if (err instanceof CaptureError) return fail(res, err.status, err.message);
        return fail(res, 502, err.message);
      }
    },
  };
}
