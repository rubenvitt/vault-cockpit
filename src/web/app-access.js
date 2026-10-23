import { readFileSync } from 'node:fs';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { ActionError } from '../cockpit/actions.js';
import { SettingsError } from '../cockpit/settings.js';
import { SCOPES, grantsOf } from '../cockpit/tokens.js';
import { readLimited, FormError } from './multipart.js';

/**
 * Login und JSON-API der iOS-App (VCP-91). Die App ist eine Hülle um das
 * Web-Cockpit (WKWebView); Passkeys gehen dort nicht, deshalb meldet sie sich
 * über das Login-Blatt des Systems an (`ASWebAuthenticationSession`):
 *
 * 1. `GET /login?app=1&state=…&challenge=…` läuft wie der Web-Login über
 *    Pocket ID (src/web/http.js), endet aber mit einem Redirect auf den
 *    Universal Link `<PUBLIC_URL>/app/angemeldet?code=…&state=…` statt mit
 *    einer Sitzung. `challenge` = base64url(sha256(verifier)), wie PKCE.
 *    Den Link fängt das Login-Blatt ab; iOS gibt ihn nur an die App, die in
 *    `/.well-known/apple-app-site-association` steht (Team und Bundle-ID).
 * 2. `POST /api/app/einloesen` `{ code, verifier, device }` tauscht den Code
 *    gegen ein Sitzungs-Cookie (für den `WKHTTPCookieStore`) und einen
 *    Geräte-Token mit dem Recht `app` (src/cockpit/tokens.js).
 *
 * Der Code lebt nur im Speicher, 60 Sekunden, und gilt für genau einen
 * Versuch: Wer ihn abfängt, hat den Verifier nicht. Der Redirect geht nur auf
 * das feste `/app/angemeldet`. Ein eigenes Schema (`cockpit://login`) gibt es
 * nur bei `PUBLIC_URL` ohne https, also für einen lokalen Entwicklungsserver:
 * Dort gibt es keine Universal Links, und eine fremde App mit demselben Schema
 * könnte sich sonst selbst einen Login holen.
 *
 * Mit dem Geräte-Token (`Authorization: Bearer vct_…`) statt Sitzung und CSRF:
 * `GET /api/app/stapel?zeit=15`, `GET /api/app/text?id=…`,
 * `POST /api/app/fortschritt`, `POST /api/app/markierung`, `GET /api/app/ich`.
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
// shortcut: ein globales Fenster für alle Absender (ein Nutzer, wenige Geräte); bei mehr Nutzern je Adresse zählen.
const REDEEM_LIMIT = 10;
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

/**
 * `sessions` aus src/web/sessions.js, `tokens` aus src/cockpit/tokens.js,
 * `reading` aus src/lesen/http.js (Aktionen und `listen`).
 */
export function createAppAccess({ sessions, tokens, reading, publicUrl, appId = `${APP_TEAM_ID}.${APP_BUNDLE_ID}`, logger = console, now = () => Date.now() }) {
  const codes = new Map();
  const redirectTo = publicUrl.startsWith('https://') ? new URL(APP_CALLBACK_PATH, publicUrl).href : DEV_REDIRECT;
  let attempts = [];

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
    attempts = attempts.filter((a) => a > t - REDEEM_WINDOW);
    if (attempts.length >= REDEEM_LIMIT) return fail(res, 429, 'Zu viele Versuche. In einer Minute noch einmal.');
    attempts.push(t);
    const { code, verifier, device } = await readJson(req);
    // Jeder Versuch verbraucht den Code, auch ein falscher.
    const entry = typeof code === 'string' ? codes.get(code) : undefined;
    if (entry) codes.delete(code);
    const given = Buffer.from(b64sha256(typeof verifier === 'string' && VERIFIER.test(verifier) ? verifier : ''));
    const expected = Buffer.from(entry?.challenge ?? '');
    if (!entry || entry.exp <= t || given.length !== expected.length || !timingSafeEqual(given, expected)) {
      return fail(res, 400, 'Code ungültig, abgelaufen oder schon eingelöst. Bitte neu anmelden.', 'invalid_code');
    }
    let created;
    // shortcut: jeder App-Login legt einen neuen Geräte-Token an, der alte bleibt bis zum Widerruf (alle zählen gegen MAX_TOKENS); bei Bedarf schickt die App den alten mit und das Einlösen widerruft ihn.
    try {
      created = tokens.create(device, 'app');
    } catch (err) {
      if (err instanceof SettingsError) return fail(res, 400, err.message);
      throw err;
    }
    logger.info?.(`App-Login: Geräte-Token „${created.name}“ für ${entry.user.subject}`);
    return json(res, 200, {
      ok: true,
      cookie: sessions.issueValues(entry.user, new URL(publicUrl).hostname),
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
    '/api/app/ich': ['GET', (req, res, url, device) => json(res, 200, { ok: true, name: device.name, scopes: grantsOf(device.scope), version: VERSION })],
    '/api/app/stapel': [
      'GET',
      (req, res, url) => {
        const { zeit, items } = reading.listen.queue(url.searchParams.get('zeit'));
        return json(res, 200, { ok: true, zeit, items: items.map(slim) });
      },
    ],
    '/api/app/text': [
      'GET',
      (req, res, url) => {
        const body = reading.listen.text(url.searchParams.get('id'));
        return body ? json(res, 200, { ok: true, ...body }) : fail(res, 404, 'Diesen Artikel gibt es nicht');
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

    /** Nach erfolgreichem OIDC: einmaliger Code, Ziel immer `/app/angemeldet` (lokal ohne https `cockpit://login`). */
    finish(app, user) {
      const t = now();
      for (const [c, e] of codes) if (e.exp <= t) codes.delete(c);
      const code = randomBytes(32).toString('base64url');
      codes.set(code, { user, challenge: app.challenge, exp: t + CODE_SECONDS * 1000 });
      return `${redirectTo}?${new URLSearchParams({ code, state: app.state })}`;
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
        if (err instanceof AppError || err instanceof ActionError) return fail(res, err.status ?? 400, err.message);
        throw err;
      }
    },
  };
}
