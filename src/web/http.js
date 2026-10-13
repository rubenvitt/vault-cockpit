import { createCookieSigner, parseCookies, cookie } from './session.js';
import { renderWeek, renderMessage, CSS } from './render.js';

const SESSION = 'vc_session';
const LOGIN = 'vc_login';

const HTML_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'content-security-policy':
    "default-src 'none'; style-src 'self'; img-src 'self' data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'same-origin',
};

/**
 * Das Web-Cockpit: Wochenansicht unter `/`, dieselben Daten als JSON unter
 * `/api/woche`, Login über Pocket ID.
 *
 * - `GET /` und `GET /api/woche` — `?woche=2026-W42`, ohne Angabe die laufende Woche.
 * - `GET /login` → Pocket ID → `GET /auth/callback` setzt die Sitzung (12 h).
 * - `POST /logout` löscht sie. SameSite=Lax hält fremde Seiten davon ab.
 *
 * Die Sitzung ist ein signiertes Cookie und nur für diese Routen gültig; die
 * MCP-Schnittstelle prüft weiter ausschließlich Bearer-Tokens.
 */
export function createWebHttp({ cockpit, oidc, sessionSecret, publicUrl, allowedSubjects = [], tz = 'Europe/Berlin', vaultName = null, sessionHours = 12, logger = console, now = () => Date.now() }) {
  const signer = createCookieSigner(sessionSecret);
  const secure = publicUrl.startsWith('https://');

  const send = (res, status, body, headers = {}) => {
    res.writeHead(status, { ...HTML_HEADERS, ...headers });
    res.end(body);
  };
  const json = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    res.end(JSON.stringify(body));
  };
  const redirect = (res, location, cookies = []) => {
    res.writeHead(303, { location, 'cache-control': 'no-store', 'set-cookie': cookies });
    res.end();
  };

  // Das Subject wird erneut geprüft, damit ein aus ALLOWED_SUBJECTS gestrichener
  // Account nicht bis zum Ablauf seines Cookies weiter hineinkommt.
  const sessionOf = (req) => {
    const s = signer.open(parseCookies(req.headers.cookie)[SESSION], now());
    return s && typeof s.sub === 'string' && (!allowedSubjects.length || allowedSubjects.includes(s.sub)) ? s : null;
  };

  /** Nur Pfade dieser Seite als Rücksprungziel, damit der Login kein offener Redirect ist. */
  const safeNext = (n) => (typeof n === 'string' && /^\/(?!\/)[^\\\s]*$/.test(n) ? n : '/');

  async function login(req, res, url) {
    const { url: target, pending } = await oidc.start();
    const value = signer.seal({ ...pending, next: safeNext(url.searchParams.get('next')), exp: Math.floor(now() / 1000) + 600 });
    redirect(res, target, [cookie(LOGIN, value, { secure, maxAge: 600 })]);
  }

  async function callback(req, res, url) {
    const pending = signer.open(parseCookies(req.headers.cookie)[LOGIN], now());
    const clear = cookie(LOGIN, '', { secure, maxAge: 0 });
    if (url.searchParams.get('error')) {
      res.setHeader('set-cookie', [clear]);
      return send(res, 401, renderMessage('Login abgebrochen', url.searchParams.get('error_description') ?? url.searchParams.get('error'), { link: { href: '/login', label: 'Noch einmal anmelden' } }));
    }
    let user;
    try {
      user = await oidc.finish({ code: url.searchParams.get('code'), state: url.searchParams.get('state'), pending });
    } catch (err) {
      logger.warn?.(`Web-Login abgelehnt: ${err.message}`);
      res.setHeader('set-cookie', [clear]);
      return send(res, 403, renderMessage('Kein Zugang', 'Die Anmeldung wurde nicht angenommen.', { link: { href: '/login', label: 'Noch einmal anmelden' } }));
    }
    const session = signer.seal({ sub: user.subject, name: user.name, exp: Math.floor(now() / 1000) + sessionHours * 3600 });
    redirect(res, safeNext(pending.next), [clear, cookie(SESSION, session, { secure, maxAge: sessionHours * 3600 })]);
  }

  async function page(req, res, url, session) {
    const id = url.searchParams.get('woche');
    const model = await cockpit.week(id || null);
    if (!model) return send(res, 400, renderMessage('Unbekannte Woche', `„${id}“ ist keine Kalenderwoche wie 2026-W42.`, { link: { href: '/', label: 'Zur laufenden Woche' } }));
    return send(res, 200, renderWeek(model, { tz, vaultName, user: session.name ?? session.sub }));
  }

  async function api(req, res, url) {
    const id = url.searchParams.get('woche');
    const model = await cockpit.week(id || null);
    if (!model) return json(res, 400, { error: 'invalid_week', error_description: 'Kalenderwoche wie 2026-W42 erwartet' });
    return json(res, 200, model);
  }

  const ROUTES = new Set(['/', '/api/woche', '/login', '/auth/callback', '/logout', '/static/cockpit.css']);

  return {
    matches: (path) => ROUTES.has(path),

    async handle(req, res, url) {
      const path = url.pathname;
      const method = req.method === 'HEAD' ? 'GET' : req.method;

      if (path === '/static/cockpit.css' && method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'public, max-age=3600' });
        return res.end(CSS);
      }
      if (path === '/login' && method === 'GET') return login(req, res, url);
      if (path === '/auth/callback' && method === 'GET') return callback(req, res, url);
      if (path === '/logout' && method === 'POST') {
        return redirect(res, '/login', [cookie(SESSION, '', { secure, maxAge: 0 })]);
      }
      if (method !== 'GET') return json(res, 405, { error: 'method_not_allowed' });

      const session = sessionOf(req);
      if (path === '/api/woche') {
        if (!session) return json(res, 401, { error: 'unauthorized', error_description: 'Anmeldung unter /login nötig' });
        return api(req, res, url);
      }
      if (!session) return redirect(res, `/login?next=${encodeURIComponent(url.pathname + url.search)}`);
      return page(req, res, url, session);
    },
  };
}
