import { createHash, timingSafeEqual } from 'node:crypto';
import { CaptureError } from './router.js';
import { placement } from './syntax.js';

const HTTP_SOURCES = ['api', 'ios-kurzbefehl', 'sprachmemo'];
const FUNKE_PREFIX = /^\d{4}-\d{2}-\d{2} \d{4}(?: |$)/;

const sha256 = (s) => createHash('sha256').update(s).digest();

/**
 * Capture-Endpunkte für Geräte, die kein OAuth sprechen (iOS-Kurzbefehl, Funke).
 *
 * Geschützt mit API-Tokens mit dem Recht „Capture“, angelegt im Web-Cockpit
 * unter Einstellungen → API-Tokens (`tokens`), getrennt vom OAuth der
 * MCP-Schnittstelle. Zum Übergang gilt daneben ein statischer Token aus der
 * Umgebung (`CAPTURE_TOKEN`, `token`). Ein Token kann nur anlegen: neue Notizen im
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
 * - `POST /funke/tasks` — JSON `{id, title, description?}`: eine Aufgabe aus
 *   Funke. Der Titel geht durch dieselbe Schnelleingabe-Syntax wie `!` beim
 *   Kurzbefehl (Fälligkeit, `#Ziel`, `+woche`), die Funke-Task-ID macht das
 *   Nachsenden aus der Offline-Queue idempotent. Ohne Zunder im Cockpit kommt
 *   `503`; Funke schickt die Aufgabe dann wie bisher selbst an Zunder.
 */
function successMessage(result) {
  // Nennt Ziel und Fälligkeit und, was nicht erkannt wurde, damit der Kurzbefehl es anzeigt.
  if (result.kind === 'task') {
    const where = `Aufgabe ${result.ref ?? result.id} ${placement(result)}`;
    return [where.endsWith('.') ? where : `${where}.`, ...(result.notes ?? [])].join(' ');
  }
  return `Notiz angelegt: ${result.path}`;
}

function errorMessage(status, error) {
  if (status === 401) return 'Token abgelehnt. Den Capture-Token im Kurzbefehl prüfen.';
  if (status === 503) return 'Aufgaben mit ! gehen erst, wenn das Cockpit mit Zunder verbunden ist. Ohne ! vorne wird es eine Notiz.';
  if (status === 502) return `Zunder lehnt ab: ${error}`;
  return `Fehler: ${error}`;
}

/** `zunderEnabled`: Wahrheitswert oder Funktion, die bei jeder Abfrage gefragt wird. */
export function createCaptureHttp({ token = null, tokens = null, router, zunderEnabled = false }) {
  const zunderOn = typeof zunderEnabled === 'function' ? zunderEnabled : () => zunderEnabled;
  const expected = token ? sha256(`Bearer ${token}`) : null;
  const authorized = (req) => {
    const header = String(req.headers.authorization ?? '');
    const legacy = expected ? timingSafeEqual(sha256(header), expected) : false;
    const m = /^Bearer (\S+)$/.exec(header);
    return (Boolean(m) && Boolean(tokens?.verify(m[1], 'capture'))) || legacy;
  };

  const json = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  // Jede Antwort trägt einen fertigen Satz (`message`) und Fehler ihren Status: Ein
  // iOS-Kurzbefehl sieht den HTTP-Status nicht und zeigt nur `message` als Mitteilung.
  const fail = (res, status, error) => json(res, status, { error, status, message: errorMessage(status, error) });

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

  function parseFunkeTask(body) {
    let task;
    try {
      task = JSON.parse(body || '{}');
    } catch {
      throw new CaptureError('bad json');
    }
    if (typeof task !== 'object' || task === null || Array.isArray(task)) throw new CaptureError('JSON-Objekt erwartet');
    const id = typeof task.id === 'string' ? task.id.trim() : '';
    // Der Titel ist eine Zeile: Zeilenumbrüche aus der KI-Veredelung würden sonst
    // den Rest des Titels in die Beschreibung schieben.
    const title = typeof task.title === 'string' ? task.title.replace(/\s+/g, ' ').trim() : '';
    const description = typeof task.description === 'string' ? task.description.trim() : '';
    if (!id) throw new CaptureError('empty id');
    if (!title) throw new CaptureError('empty title');
    return {
      text: description ? `!${title}\n${description}` : `!${title}`,
      source: 'funke',
      captureId: `funke-task-${id}`,
    };
  }

  const ROUTES = {
    '/funke/notes': parseFunke,
    '/funke/tasks': parseFunkeTask,
  };

  return {
    matches: (path) => path === '/capture' || path === '/funke/health' || Object.hasOwn(ROUTES, path),

    async handle(req, res, url, body) {
      if (!authorized(req)) return fail(res, 401, 'unauthorized');
      const path = url.pathname;

      if (req.method === 'GET' && (path === '/capture' || path === '/funke/health')) {
        return json(res, 200, { ok: true, zunder: Boolean(zunderOn()) });
      }
      if (req.method !== 'POST' || path === '/funke/health') return fail(res, 405, 'method not allowed');

      try {
        const input = Object.hasOwn(ROUTES, path) ? ROUTES[path](body) : parseCapture(req, url, body);
        const result = await router.route(input);
        return json(res, result.duplicate ? 200 : 201, { ok: true, ...result, message: successMessage(result) });
      } catch (err) {
        if (err instanceof CaptureError) return fail(res, err.status, err.message);
        return fail(res, 502, err.message);
      }
    },
  };
}
