import { readFileSync } from 'node:fs';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { ActionError } from '../cockpit/actions.js';
import { SettingsError } from '../cockpit/settings.js';
import { SCOPES, grantsOf } from '../cockpit/tokens.js';
import { SpeechError } from '../lesen/tts.js';
import { readLimited, FormError } from './multipart.js';
import { audioResponse } from '../lesen/folgen-page.js';

/**
 * Login und JSON-API der iOS-App (VCP-91). Die App ist nativ und meldet sich
 * über das Login-Blatt des Systems an (`ASWebAuthenticationSession`), dort
 * gehen auch Passkeys:
 *
 * 1. `GET /login?app=1&state=…&challenge=…` läuft wie der Web-Login über
 *    Pocket ID (src/web/http.js), endet aber mit einem Redirect auf den
 *    Universal Link `<PUBLIC_URL>/app/angemeldet?code=…&state=…` statt mit
 *    einer Sitzung. `challenge` = base64url(sha256(verifier)), wie PKCE.
 *    Den Link fängt das Login-Blatt ab; iOS gibt ihn nur an die App, die in
 *    `/.well-known/apple-app-site-association` steht (Team und Bundle-ID).
 * 2. `POST /api/app/einloesen` `{ code, verifier, device, replaces? }` tauscht
 *    den Code gegen einen Geräte-Token mit dem Recht `app`
 *    (src/cockpit/tokens.js). `replaces` ist der bisherige Token des Geräts:
 *    Er wird widerrufen, damit jedes Gerät nur einen Token hat (VCP-99). Ein
 *    Sitzungs-Cookie gibt es nicht mehr, die native App braucht keins; so
 *    liegt auf dem Gerät keine Kopie einer Web-Sitzung.
 *
 * Der Code lebt nur im Speicher, 60 Sekunden, und gilt für genau einen
 * Versuch: Wer ihn abfängt, hat den Verifier nicht. Der Redirect geht nur auf
 * das feste `/app/angemeldet`. Ein eigenes Schema (`cockpit://login`) gibt es
 * nur bei `PUBLIC_URL` ohne https und außerhalb von `NODE_ENV=production`
 * (`allowDevScheme`), also für einen lokalen Entwicklungsserver:
 * Dort gibt es keine Universal Links, und eine fremde App mit demselben Schema
 * könnte sich sonst selbst einen Login holen.
 *
 * Mit dem Geräte-Token (`Authorization: Bearer vct_…`) statt Sitzung und CSRF:
 * Der Login bei Pocket ID läuft mit `prompt=login` (src/web/http.js).
 * Einlösen ist je Absender begrenzt (hinter dem Proxy aus `X-Forwarded-For`).
 *
 * `GET /api/app/stapel?zeit=15`, `GET /api/app/text?id=…`,
 * `GET /api/app/audio?id=…&von=…&bis=…` (MP3 eines Satzes, nur mit Stimme vom
 * Server; welche, sagt `stimme` in `/api/app/stapel`), `POST /api/app/fortschritt`, `POST /api/app/markierung`, `GET /api/app/ich`,
 * `GET /api/app/folge?id=…` (MP3 einer fertigen Folge, mit `Range`, für den
 * nativen Player), `POST /api/app/abmelden` (widerruft den Token selbst).
 * Dieselbe Logik wie `/lesen/hoeren` und die `/aktion/lesen/…`-Aktionen.
 * Fehler wie src/lesen/api.js: `{ error, status, message }`.
 */

/** Standard für `APP_TEAM_ID` und `APP_BUNDLE_ID` (ios/project.yml). */
export const APP_TEAM_ID = 'H95J852PKP';
export const APP_BUNDLE_ID = 'dev.rubeen.cockpit';
export const APP_CALLBACK_PATH = '/app/angemeldet';
export const SITE_ASSOCIATION_PATH = '/.well-known/apple-app-site-association';
const DEV_REDIRECT = 'cockpit://login';
const CODE_SECONDS = 60;
// Je Absender; die Tabelle räumt jeder Versuch auf und hält höchstens REDEEM_SENDERS Absender einer Minute.
const REDEEM_LIMIT = 10;
const REDEEM_SENDERS = 256;
const REDEEM_WINDOW = 60_000;
const MAX_BODY = 16 * 1024;
const STATE = /^[\w.~-]{8,128}$/;
const CHALLENGE = /^[\w-]{43}$/;
const VERIFIER = /^[\w.~-]{43,128}$/;
const VERSION = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;

const ERRORS = { 400: 'bad_request', 401: 'unauthorized', 403: 'forbidden', 404: 'not_found', 405: 'method_not_allowed', 409: 'conflict', 413: 'too_large', 429: 'too_many_requests' };

const b64sha256 = (s) => createHash('sha256').update(s).digest('base64url');

class AppError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

/** `tokens` aus src/cockpit/tokens.js, `reading` aus src/lesen/http.js (Aktionen und `listen`). */
export function createAppAccess({ tokens, reading, publicUrl, appId = `${APP_TEAM_ID}.${APP_BUNDLE_ID}`, allowDevScheme = false, trustProxy = false, logger = console, now = () => Date.now() }) {
  const codes = new Map();
  const redirectTo = !publicUrl.startsWith('https://') && allowDevScheme ? DEV_REDIRECT : new URL(APP_CALLBACK_PATH, publicUrl).href;
  /** Absender → Zeitpunkte der Versuche im laufenden Fenster. */
  const attempts = new Map();

  /**
   * Absender des Requests: hinter dem Proxy der letzte Eintrag aus `X-Forwarded-For` (den setzt der
   * Proxy selbst; weiter vorn steht, was der Client mitschickt), sonst die Gegenstelle.
   */
  const senderOf = (req) => {
    const forwarded = trustProxy ? String(req.headers['x-forwarded-for'] ?? '').split(',').at(-1).trim() : '';
    return forwarded || req.socket?.remoteAddress || '?';
  };

  /**
   * Zählt den Versuch; false, wenn der Absender im Fenster schon `REDEEM_LIMIT` hatte oder schon
   * `REDEEM_SENDERS` andere Absender zählen (dann wartet ein neuer, bis Einträge ablaufen).
   */
  const allowAttempt = (sender, t) => {
    for (const [k, list] of attempts) {
      const recent = list.filter((a) => a > t - REDEEM_WINDOW);
      if (recent.length) attempts.set(k, recent);
      else attempts.delete(k);
    }
    const list = attempts.get(sender) ?? [];
    if (list.length >= REDEEM_LIMIT || (!list.length && attempts.size >= REDEEM_SENDERS)) return false;
    attempts.set(sender, [...list, t]);
    return true;
  };

  const json = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    res.end(JSON.stringify(body));
  };
  const fail = (res, status, message, error = ERRORS[status] ?? 'bad_request') => json(res, status, { error, status, message });

  async function readJson(req) {
    let input;
    try {
      input = JSON.parse((await readLimited(req, MAX_BODY)).toString('utf8') || '{}');
    } catch (err) {
      if (err instanceof FormError) throw new AppError('Zu groß', 413);
      throw new AppError('Kein gültiges JSON');
    }
    if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new AppError('JSON-Objekt erwartet');
    return input;
  }

  /** Felder als Formular für die `/aktion/lesen/…`-Aktionen; fehlende bleiben weg statt „null“. */
  const formOf = (input, fields) => {
    const form = new URLSearchParams();
    for (const f of fields) {
      const v = input[f];
      if (typeof v === 'string' || typeof v === 'number') form.set(f, String(v));
      else if (v !== undefined && v !== null) throw new AppError(`Feld "${f}" muss Text oder Zahl sein`);
    }
    return form;
  };

  async function redeem(req, res) {
    const t = now();
    if (!allowAttempt(senderOf(req), t)) return fail(res, 429, 'Zu viele Versuche. In einer Minute noch einmal.');
    const { code, verifier, device, replaces } = await readJson(req);
    // Jeder Versuch verbraucht den Code, auch ein falscher.
    const entry = typeof code === 'string' ? codes.get(code) : undefined;
    if (entry) codes.delete(code);
    const given = Buffer.from(b64sha256(typeof verifier === 'string' && VERIFIER.test(verifier) ? verifier : ''));
    const expected = Buffer.from(entry?.challenge ?? '');
    if (!entry || entry.exp <= t || given.length !== expected.length || !timingSafeEqual(given, expected)) {
      return fail(res, 400, 'Code ungültig, abgelaufen oder schon eingelöst. Bitte neu anmelden.', 'invalid_code');
    }
    // Ein Token je Gerät: Erst den neuen anlegen, dann den bisherigen widerrufen, damit ein
    // abgelehnter Gerätename den funktionierenden Token nicht kostet. Nur einen gültigen
    // `app`-Token; ein unbekannter oder schon widerrufener ändert nichts.
    const found = typeof replaces === 'string' ? tokens.find(replaces) : null;
    const previous = found?.scope === 'app' ? found : null;
    const create = () => tokens.create(device, 'app');
    let created;
    try {
      try {
        created = create();
      } catch (err) {
        // Volle Liste (Fehler ohne Feld): Der bisherige Token macht Platz, dann noch einmal.
        if (!(err instanceof SettingsError) || err.field || !previous) throw err;
        tokens.revoke(previous.id);
        created = create();
      }
    } catch (err) {
      if (err instanceof SettingsError) return fail(res, 400, err.message);
      throw err;
    }
    if (previous && tokens.revoke(previous.id)) logger.info?.(`App-Login: bisherigen Geräte-Token „${previous.name}“ widerrufen`);
    logger.info?.(`App-Login: Geräte-Token „${created.name}“ für ${entry.user.subject}`);
    return json(res, 200, {
      ok: true,
      token: { token: created.token, id: created.id, name: created.name, scopes: grantsOf('app') },
    });
  }

  /** Der Token des Requests mit Recht `app`, sonst antwortet es selbst (401 unbekannt oder widerrufen, 403 anderes Recht). */
  function deviceOf(req, res) {
    const m = /^Bearer (\S+)$/.exec(String(req.headers.authorization ?? ''));
    const t = m ? tokens.find(m[1]) : null;
    if (t && grantsOf(t.scope).includes('app')) return t;
    if (t && SCOPES.includes(t.scope)) fail(res, 403, 'Dieser Token hat nicht das Recht „App“.');
    else fail(res, 401, 'Token abgelehnt. Bitte in der App neu anmelden.');
    return null;
  }

  const slim = (d) => ({ id: d.id, title: d.title || d.url, url: d.url, site: d.site, kind: d.kind, minutes: d.reading_minutes, remaining: d.remaining, progress: d.progress });

  /** Pfad → [Methode, Handler(req, res, url, device)]. */
  const API = {
    // Abmelden in der App: widerruft genau diesen Geräte-Token, danach gibt jeder Endpunkt 401.
    '/api/app/abmelden': [
      'POST',
      (req, res, url, device) => {
        tokens.revoke(device.id);
        logger.info?.(`App abgemeldet: Geräte-Token „${device.name}“ widerrufen`);
        return json(res, 200, { ok: true });
      },
    ],
    '/api/app/ich': ['GET', (req, res, url, device) => json(res, 200, { ok: true, name: device.name, scopes: grantsOf(device.scope), version: VERSION })],
    '/api/app/stapel': [
      'GET',
      (req, res, url) => {
        const { zeit, items } = reading.listen.queue(url.searchParams.get('zeit'));
        // `stimme`: Anbieter der Stimme vom Server, `null` = Sprachausgabe des Geräts.
        return json(res, 200, { ok: true, zeit, stimme: reading.listen.voice?.() ?? null, items: items.map(slim) });
      },
    ],
    '/api/app/text': [
      'GET',
      (req, res, url) => {
        const body = reading.listen.text(url.searchParams.get('id'));
        return body ? json(res, 200, { ok: true, ...body }) : fail(res, 404, 'Diesen Artikel gibt es nicht');
      },
    ],
    '/api/app/audio': [
      'GET',
      async (req, res, url) => {
        const q = url.searchParams;
        const data = await reading.listen.audio({ id: q.get('id'), von: q.get('von'), bis: q.get('bis') });
        res.writeHead(200, { 'content-type': 'audio/mpeg', 'content-length': data.length, 'cache-control': 'private, max-age=86400', 'x-content-type-options': 'nosniff' });
        return res.end(req.method === 'HEAD' ? undefined : data);
      },
    ],
    '/api/app/folge': [
      'GET',
      (req, res, url) => {
        const path = reading.episodeAudio?.(url.searchParams.get('id') ?? '');
        if (!path) return fail(res, 404, 'Diese Folge gibt es nicht oder sie ist noch nicht fertig');
        const r = audioResponse(path, req.headers.range);
        res.writeHead(r.status, { ...r.headers, 'x-content-type-options': 'nosniff' });
        return res.end(req.method === 'HEAD' ? undefined : r.body);
      },
    ],
    '/api/app/fortschritt': [
      'POST',
      async (req, res, url, device) => {
        const form = formOf(await readJson(req), ['id', 'fortschritt', 'anker']);
        const r = await reading.actions['/aktion/lesen/doc/fortschritt'](form, { sub: `app:${device.name}` });
        return json(res, 200, { ok: true, progress: r.progress });
      },
    ],
    '/api/app/markierung': [
      'POST',
      async (req, res, url, device) => {
        const form = formOf(await readJson(req), ['id', 'quote', 'prefix', 'suffix', 'start', 'cid']);
        const r = await reading.actions['/aktion/lesen/markierung/neu'](form, { sub: `app:${device.name}` });
        return json(res, r.duplicate ? 200 : 201, { ok: true, id: r.highlight.id, duplicate: Boolean(r.duplicate), message: r.message });
      },
    ],
  };

  return {
    paths: ['/api/app/einloesen', ...Object.keys(API)],

    /** `{ state, challenge }` eines App-Logins aus `/login?app=1&…`, null wenn ungültig. */
    start(url) {
      const state = url.searchParams.get('state') ?? '';
      const challenge = url.searchParams.get('challenge') ?? '';
      return STATE.test(state) && CHALLENGE.test(challenge) ? { state, challenge } : null;
    },

    /** Für Universal Link (`applinks`) und das Login-Blatt mit https-Callback (`webcredentials`). */
    siteAssociation: {
      applinks: { details: [{ appIDs: [appId], components: [{ '/': `${APP_CALLBACK_PATH}*` }] }] },
      webcredentials: { apps: [appId] },
    },

    /** Nach erfolgreichem OIDC: einmaliger Code, Ziel immer `/app/angemeldet` (lokal ohne https und ohne Produktionsmodus `cockpit://login`). */
    finish(app, user) {
      const t = now();
      for (const [c, e] of codes) if (e.exp <= t) codes.delete(c);
      const code = randomBytes(32).toString('base64url');
      codes.set(code, { user, challenge: app.challenge, exp: t + CODE_SECONDS * 1000 });
      return `${redirectTo}?${new URLSearchParams({ code, state: app.state })}`;
    },

    /**
     * Geräte-Token mit Recht `app` aus `Authorization: Bearer …`, sonst null (antwortet nicht selbst).
     * Für die native App auf den JSON-Endpunkten und Aktionen des Cockpits (src/web/http.js).
     */
    device(req) {
      const m = /^Bearer (\S+)$/.exec(String(req.headers.authorization ?? ''));
      const t = m ? tokens.find(m[1]) : null;
      return t && grantsOf(t.scope).includes('app') ? t : null;
    },

    /** Abbruch oder Ablehnung zurück an die App, damit das Login-Blatt zugeht. */
    deny: (app, error) => `${redirectTo}?${new URLSearchParams({ error, state: app.state })}`,

    async handle(req, res, url) {
      try {
        if (url.pathname === '/api/app/einloesen') {
          if (req.method !== 'POST') return fail(res, 405, 'Nur POST');
          return await redeem(req, res);
        }
        const device = deviceOf(req, res);
        if (!device) return;
        const [method, run] = API[url.pathname];
        if ((req.method === 'HEAD' ? 'GET' : req.method) !== method) return fail(res, 405, `Nur ${method}`);
        return await run(req, res, url, device);
      } catch (err) {
        if (err instanceof AppError || err instanceof ActionError || err instanceof SpeechError) return fail(res, err.status ?? 400, err.message);
        throw err;
      }
    },
  };
}
