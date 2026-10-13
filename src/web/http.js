import { readFileSync } from 'node:fs';
import { timingSafeEqual, randomUUID } from 'node:crypto';
import { createCookieSigner, parseCookies, cookie } from './session.js';
import { renderWeek, renderMessage, renderSettings, CSS } from './render.js';
import { renderGraph, renderSearch, GRAPH_CSS } from './graph-render.js';
import { SettingsError, MAX_CALENDARS } from '../cockpit/settings.js';
import { describeWeek, weekOf } from '../cockpit/week.js';
import { ActionError, SETTABLE } from '../cockpit/actions.js';

const CLIENT_JS = readFileSync(new URL('./static/cockpit.js', import.meta.url), 'utf8');

const MAX_FORM = 64 * 1024;

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_FORM) {
        reject(new Error('Formular zu groß'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const SESSION = 'vc_session';
const LOGIN = 'vc_login';
const FLASH = 'vc_flash';

const HTML_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'content-security-policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'same-origin',
};

/**
 * Das Web-Cockpit: Wochenansicht unter `/`, dieselben Daten als JSON unter
 * `/api/woche`, Login über Pocket ID.
 *
 * - `GET /` und `GET /api/woche` — `?woche=2026-W42`, ohne Angabe die laufende Woche.
 * - `GET /graph?q=…` sucht (hybrid), `GET /graph?pfad=…` zeigt den Graphen um
 *   eine Notiz; `GET /api/graph?pfad=…` liefert ihn als JSON.
 * - `GET /login` → Pocket ID → `GET /auth/callback` setzt die Sitzung (12 h).
 * - `POST /logout` löscht sie. SameSite=Lax hält fremde Seiten davon ab.
 * - `GET`/`POST /einstellungen` — Kalender, Zunder-Zugang und Anzeige pflegen.
 * - `POST /aktion/status` setzt den Status einer Zunder-Aufgabe (abhaken und
 *   zurück), `POST /aktion/erfassen` ist die Schnelleingabe (Notiz, mit `!` eine
 *   Zunder-Aufgabe). Beide brauchen Sitzung, gleiche Herkunft und das CSRF-Token
 *   der Sitzung. Mit `Accept: application/json` antworten sie mit JSON (für
 *   `/static/cockpit.js`), sonst mit einer Weiterleitung und einer Meldung.
 * - `POST /einstellungen/tokens` legt einen API-Token für `/api/search` an und
 *   zeigt ihn einmal, `POST /einstellungen/tokens/widerrufen` löscht einen.
 * - `GET /kurzbefehle/<slug>.shortcut` liefert die signierten iOS-Kurzbefehle
 *   (verlinkt in den Einstellungen).
 *
 * Die Sitzung ist ein signiertes Cookie und nur für diese Routen gültig; die
 * MCP-Schnittstelle prüft weiter ausschließlich Bearer-Tokens.
 */
export function createWebHttp({ cockpit, settings, actions = null, tokens = null, shortcuts = [], captureEnabled = false, calendars = null, graph = null, search = null, oidc, sessionSecret, publicUrl, allowedSubjects = [], sessionHours = 12, logger = console, now = () => Date.now() }) {
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

  // CSRF: zusätzlich zu SameSite=Lax und der Herkunftsprüfung ein Token, das an
  // genau dieses Sitzungs-Cookie gebunden ist. Ohne Speicher auf dem Server.
  const rawSession = (req) => parseCookies(req.headers.cookie)[SESSION] ?? '';
  const csrfOf = (req) => signer.mac(`csrf\n${rawSession(req)}`);
  const csrfOk = (req, given) => {
    const a = Buffer.from(String(given ?? ''));
    const b = Buffer.from(csrfOf(req));
    return a.length === b.length && timingSafeEqual(a, b);
  };

  /** Meldung für die nächste Seite (ohne JavaScript): signiert, eine Minute gültig. */
  const flashCookie = (flash) => cookie(FLASH, signer.seal({ ...flash, exp: Math.floor(now() / 1000) + 60 }), { secure, maxAge: 60 });
  const takeFlash = (req, res) => {
    const raw = parseCookies(req.headers.cookie)[FLASH];
    if (!raw) return null;
    res.setHeader('set-cookie', [cookie(FLASH, '', { secure, maxAge: 0 })]);
    return signer.open(raw, now());
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
    // `sid` macht jede Anmeldung einzigartig, damit auch das CSRF-Token wechselt.
    const session = signer.seal({ sub: user.subject, name: user.name, sid: randomUUID(), exp: Math.floor(now() / 1000) + sessionHours * 3600 });
    redirect(res, safeNext(pending.next), [clear, cookie(SESSION, session, { secure, maxAge: sessionHours * 3600 })]);
  }

  /** Was die Seite zum Schreiben braucht; ohne `actions` bleibt sie lesend. */
  const writeContext = (req) => (actions ? { csrf: csrfOf(req), captureId: randomUUID() } : null);

  async function page(req, res, url, session, { status = 200, flash = null, draft = null } = {}) {
    const id = url.searchParams.get('woche');
    const model = await cockpit.week(id || null);
    if (!model) return send(res, 400, renderMessage('Unbekannte Woche', `„${id}“ ist keine Kalenderwoche wie 2026-W42.`, { link: { href: '/', label: 'Zur laufenden Woche' } }));
    const back = url.pathname + url.search;
    return send(res, status, renderWeek(model, { user: session.name ?? session.sub, write: writeContext(req), back, flash: flash ?? takeFlash(req, res), draft }));
  }

  const statusMessage = (t) => {
    const name = t.ref ? `${t.ref} ${t.title}` : t.title;
    if (t.status === 'done') return `Erledigt: ${name}`;
    if (t.status === 'in_progress') return `In Arbeit: ${name}`;
    if (t.status === 'blocked') return `Blockiert: ${name}`;
    return `Wieder offen: ${name}`;
  };
  const captureMessage = (r) => {
    if (r.kind === 'task') return `${r.duplicate ? 'Schon erfasst' : 'Aufgabe angelegt'}: ${r.ref ?? 'neue Aufgabe'} liegt in der Zunder-Inbox`;
    return `${r.duplicate ? 'Schon erfasst' : 'Notiz angelegt'}: ${r.path}`;
  };

  /**
   * Abhaken und Schnelleingabe. Mit JavaScript als JSON, ohne als Formular mit
   * Weiterleitung; schlägt es ohne JavaScript fehl, kommt die Seite direkt mit
   * Fehlermeldung und dem eingegebenen Text zurück, damit nichts verloren geht.
   */
  async function action(req, res, path, session) {
    const wantsJson = String(req.headers.accept ?? '').includes('application/json');
    const form = await readForm(req, res);
    if (!form) return;
    const back = safeNext(form.get('back'));
    if (!csrfOk(req, form.get('csrf'))) {
      const message = 'Die Seite ist veraltet. Bitte neu laden und noch einmal versuchen.';
      return wantsJson ? json(res, 403, { error: 'csrf', message }) : send(res, 403, renderMessage('Nicht gespeichert', message, { link: { href: back, label: 'Neu laden' } }));
    }
    let body;
    try {
      if (path === '/aktion/status') {
        const prev = form.get('prev');
        const task = await actions.setStatus(form.get('id'), form.get('status'));
        const undo = SETTABLE.includes(prev) && prev !== task.status ? { id: task.id, status: prev } : null;
        logger.info?.(`Cockpit: ${task.ref ?? task.id} → ${task.status} (${session.sub})`);
        body = { ok: true, message: statusMessage(task), task, undo };
      } else {
        const result = await actions.capture({ text: form.get('text') ?? '', captureId: form.get('cid') });
        body = { ok: true, message: captureMessage(result), result };
      }
    } catch (err) {
      if (!(err instanceof ActionError)) throw err;
      logger.warn?.(`Cockpit-Aktion ${path} fehlgeschlagen: ${err.message}`);
      if (wantsJson) return json(res, err.status, { error: 'action_failed', message: err.message });
      const draft = path === '/aktion/erfassen' ? form.get('text') : null;
      return page(req, res, new URL(back, publicUrl), session, { status: err.status, flash: { kind: 'error', message: err.message }, draft });
    }
    if (wantsJson) return json(res, 200, body);
    return redirect(res, back, [flashCookie({ kind: 'ok', message: body.message, undo: body.undo ?? null })]);
  }

  async function api(req, res, url) {
    const id = url.searchParams.get('woche');
    const model = await cockpit.week(id || null);
    if (!model) return json(res, 400, { error: 'invalid_week', error_description: 'Kalenderwoche wie 2026-W42 erwartet' });
    return json(res, 200, model);
  }

  async function settingsPage(req, res, session, { status = 200, notice = null, error = null, created = null } = {}) {
    let checks = {};
    if (calendars && settings.get().calendars.length) {
      const tz = settings.get().tz;
      const week = describeWeek(weekOf(new Date(now()), tz), tz);
      checks = await calendars.check(week.start, week.end);
    }
    const html = renderSettings({
      stored: settings.stored(),
      defaults: settings.defaults(),
      checks,
      notice,
      error,
      tokens: tokens?.list() ?? null,
      created,
      shortcuts,
      captureEnabled,
      tz: settings.get().tz,
      user: session.name ?? session.sub,
    });
    return send(res, status, html);
  }

  /**
   * Formular → vollständiger Einstellungsstand. Leere Geheimnisfelder
   * (Kalenderadresse, Passwort, Token) behalten den gespeicherten Wert.
   */
  function fromForm(form) {
    const stored = settings.stored();
    const field = (k) => (form.get(k) ?? '').trim();
    const calendarsIn = [];
    for (let i = 0; i <= MAX_CALENDARS; i++) {
      const id = field(`cal.${i}.id`);
      const prev = id ? stored.calendars.find((c) => c.id === id) : null;
      if (id && !prev) continue;
      if (form.get(`cal.${i}.remove`)) continue;
      const name = field(`cal.${i}.name`);
      const url = field(`cal.${i}.url`);
      if (!prev && !name && !url) continue;
      const username = field(`cal.${i}.username`);
      calendarsIn.push({
        id: prev?.id,
        name,
        kind: field(`cal.${i}.kind`) || 'ical',
        url: url || prev?.url,
        username,
        password: username ? field(`cal.${i}.password`) || prev?.password : null,
        filter: field(`cal.${i}.filter`).split(','),
      });
    }
    const clear = Boolean(form.get('zunder.clear'));
    return {
      tz: field('tz'),
      vaultName: field('vaultName'),
      inboxFolder: field('inboxFolder'),
      zunder: clear ? { url: null, token: null } : { url: field('zunder.url'), token: field('zunder.token') || stored.zunder.token },
      calendars: calendarsIn,
      hiddenEvents: form.has('hiddenEvents') ? field('hiddenEvents').split(',') : stored.hiddenEvents,
    };
  }

  // Zusätzlich zu SameSite=Lax: Formulare nur von dieser Seite annehmen.
  const foreignOrigin = (req) => req.headers.origin && req.headers.origin !== new URL(publicUrl).origin;

  /** Formular lesen; `null`, wenn schon mit 403/413 geantwortet wurde. */
  async function readForm(req, res) {
    if (foreignOrigin(req)) {
      json(res, 403, { error: 'forbidden', error_description: 'fremde Herkunft' });
      return null;
    }
    try {
      return new URLSearchParams(await readBody(req));
    } catch {
      json(res, 413, { error: 'too_large' });
      return null;
    }
  }

  async function saveSettings(req, res, session) {
    const form = await readForm(req, res);
    if (!form) return;
    try {
      settings.save(fromForm(form));
    } catch (err) {
      if (err instanceof SettingsError) return settingsPage(req, res, session, { status: 400, error: err.message });
      throw err;
    }
    logger.info?.(`Cockpit-Einstellungen gespeichert von ${session.sub}`);
    return redirect(res, '/einstellungen?gespeichert=1');
  }

  /** Antwortet direkt mit der Seite, weil der Klartext nur hier einmal auftaucht. */
  async function createToken(req, res, session) {
    const form = await readForm(req, res);
    if (!form) return;
    let created;
    try {
      created = tokens.create(form.get('name'));
    } catch (err) {
      if (err instanceof SettingsError) return settingsPage(req, res, session, { status: 400, error: err.message });
      throw err;
    }
    logger.info?.(`API-Token „${created.name}“ angelegt von ${session.sub}`);
    return settingsPage(req, res, session, { created });
  }

  async function revokeToken(req, res, session) {
    const form = await readForm(req, res);
    if (!form) return;
    if (tokens.revoke(form.get('id') ?? '')) logger.info?.(`API-Token widerrufen von ${session.sub}`);
    return redirect(res, '/einstellungen?widerrufen=1');
  }


  async function graphPage(req, res, url, session) {
    const path = url.searchParams.get('pfad');
    const user = session.name ?? session.sub;
    if (!path) {
      const q = (url.searchParams.get('q') ?? '').trim().slice(0, 500);
      const result = q && search ? await search(q) : { results: [], total: 0 };
      return send(res, 200, renderSearch(q, result, { user }));
    }
    const g = graph ? await graph.around(path) : null;
    if (!g) return send(res, 404, renderMessage('Notiz nicht gefunden', `„${path}“ gibt es nicht im Index.`, { link: { href: '/graph', label: 'Zur Suche' } }));
    const { vaultName, tz } = settings.get();
    return send(res, 200, renderGraph(g, { vaultName, user, tz }));
  }

  async function graphApi(req, res, url) {
    const g = graph ? await graph.around(url.searchParams.get('pfad') ?? '') : null;
    if (!g) return json(res, 404, { error: 'not_found', error_description: 'Notiz nicht im Index' });
    return json(res, 200, g);
  }

  const TOKEN_ROUTES = { '/einstellungen/tokens': createToken, '/einstellungen/tokens/widerrufen': revokeToken };
  const ACTION_ROUTES = new Set(actions ? ['/aktion/status', '/aktion/erfassen'] : []);
  const SHORTCUT_ROUTES = new Map(shortcuts.map((s) => [`/kurzbefehle/${s.slug}.shortcut`, s]));
  const ROUTES = new Set([...ACTION_ROUTES, ...SHORTCUT_ROUTES.keys(), '/static/cockpit.js', '/', '/api/woche', '/graph', '/api/graph', '/einstellungen', ...(tokens ? Object.keys(TOKEN_ROUTES) : []), '/login', '/auth/callback', '/logout', '/static/cockpit.css']);

  return {
    matches: (path) => ROUTES.has(path),

    async handle(req, res, url) {
      const path = url.pathname;
      const method = req.method === 'HEAD' ? 'GET' : req.method;

      if (path === '/static/cockpit.css' && method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'public, max-age=3600' });
        return res.end(CSS + GRAPH_CSS);
      }
      if (path === '/static/cockpit.js' && method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' });
        return res.end(CLIENT_JS);
      }
      if (path === '/login' && method === 'GET') return login(req, res, url);
      if (path === '/auth/callback' && method === 'GET') return callback(req, res, url);
      if (path === '/logout' && method === 'POST') {
        return redirect(res, '/login', [cookie(SESSION, '', { secure, maxAge: 0 })]);
      }
      const session = sessionOf(req);
      if (path === '/einstellungen') {
        if (!session) return redirect(res, '/login?next=%2Feinstellungen');
        if (method === 'POST') return saveSettings(req, res, session);
        if (method === 'GET') {
          const notice = url.searchParams.get('gespeichert') ? 'Gespeichert.' : url.searchParams.get('widerrufen') ? 'Token widerrufen.' : null;
          return settingsPage(req, res, session, { notice });
        }
      }
      if (ACTION_ROUTES.has(path)) {
        if (method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });
        if (!session) {
          if (String(req.headers.accept ?? '').includes('application/json')) {
            return json(res, 401, { error: 'unauthorized', message: 'Die Anmeldung ist abgelaufen. Bitte neu anmelden.' });
          }
          return redirect(res, '/login');
        }
        return action(req, res, path, session);
      }
      if (tokens && TOKEN_ROUTES[path]) {
        if (!session) return redirect(res, '/login?next=%2Feinstellungen');
        if (method === 'POST') return TOKEN_ROUTES[path](req, res, session);
        return redirect(res, '/einstellungen');
      }
      if (method !== 'GET') return json(res, 405, { error: 'method_not_allowed' });

      if (SHORTCUT_ROUTES.has(path)) {
        if (!session) return redirect(res, '/login?next=%2Feinstellungen');
        const s = SHORTCUT_ROUTES.get(path);
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-disposition': `attachment; filename="${s.slug}.shortcut"; filename*=UTF-8''${encodeURIComponent(s.file)}`,
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
        });
        return res.end(s.data);
      }
      if (path === '/api/woche') {
        if (!session) return json(res, 401, { error: 'unauthorized', error_description: 'Anmeldung unter /login nötig' });
        return api(req, res, url);
      }
      if (path === '/api/graph') {
        if (!session) return json(res, 401, { error: 'unauthorized', error_description: 'Anmeldung unter /login nötig' });
        return graphApi(req, res, url);
      }
      if (!session) return redirect(res, `/login?next=${encodeURIComponent(url.pathname + url.search)}`);
      if (path === '/graph') return graphPage(req, res, url, session);
      return page(req, res, url, session);
    },
  };
}
