import { readFileSync } from 'node:fs';
import { timingSafeEqual, randomUUID, createHash } from 'node:crypto';
import { createCookieSigner, parseCookies, cookie } from './session.js';
import { renderWeek, renderMessage, renderSettings, dueLabel } from './render.js';
import { versionAssets, THEME } from './layout.js';
import { renderGraph, renderSearch, GRAPH_CSS } from './graph-render.js';
import { renderNote, NOTE_CSS } from './note-render.js';
import { renderReview, REVIEW_CSS } from './review-render.js';
import { renderPlan, planRoutes, PLAN_CSS } from './plan-page.js';
import { SettingsError, MAX_CALENDARS } from '../cockpit/settings.js';
import { describeWeek, weekOf } from '../cockpit/week.js';
import { ActionError, SETTABLE } from '../cockpit/actions.js';

const staticFile = (name, enc) => readFileSync(new URL(`./static/${name}`, import.meta.url), enc);
const CLIENT_JS = staticFile('cockpit.js', 'utf8');
const GRAPH_JS = staticFile('graph.js', 'utf8');
// sigma + graphology + ForceAtlas2, gebündelt mit `npm run vendor` und eingecheckt.
const GRAPH_LIB = staticFile('vendor/graph-lib.js', 'utf8');
// Design-System (Tokens, Bausteine, Wochenansicht) plus die Teile der übrigen Seiten.
const CSS = staticFile('cockpit.css', 'utf8') + GRAPH_CSS + NOTE_CSS + REVIEW_CSS + PLAN_CSS;
const hash = (s) => createHash('sha256').update(s).digest('base64url').slice(0, 10);
const VERSION = { css: hash(CSS), js: hash(CLIENT_JS), graph: hash(GRAPH_JS), graphLib: hash(GRAPH_LIB) };
versionAssets(VERSION);

/** Web-App-Manifest: Das Cockpit startet auf dem iPhone und unter Android wie eine App. */
const MANIFEST = JSON.stringify({
  name: 'Vault Cockpit',
  short_name: 'Cockpit',
  description: 'Woche führen, Gedanken festhalten, Vault durchsuchen.',
  lang: 'de',
  start_url: '/',
  scope: '/',
  display: 'standalone',
  background_color: THEME.light,
  theme_color: THEME.light,
  icons: [
    { src: '/static/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
    { src: '/static/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
    { src: '/static/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    { src: '/static/icon.svg', sizes: 'any', type: 'image/svg+xml' },
  ],
  shortcuts: [
    { name: 'Schnelleingabe', short_name: 'Erfassen', url: '/?erfassen=1' },
    { name: 'Suche', url: '/graph' },
  ],
});

/** Öffentliche Dateien ohne Sitzung: Stylesheet, Script, Manifest, Icons. */
const PUBLIC = new Map([
  ['/static/cockpit.css', { type: 'text/css; charset=utf-8', body: CSS, version: VERSION.css }],
  ['/static/cockpit.js', { type: 'text/javascript; charset=utf-8', body: CLIENT_JS, version: VERSION.js }],
  ['/static/graph.js', { type: 'text/javascript; charset=utf-8', body: GRAPH_JS, version: VERSION.graph }],
  ['/static/vendor/graph-lib.js', { type: 'text/javascript; charset=utf-8', body: GRAPH_LIB, version: VERSION.graphLib }],
  ['/manifest.webmanifest', { type: 'application/manifest+json; charset=utf-8', body: MANIFEST }],
  ['/static/icon.svg', { type: 'image/svg+xml', body: staticFile('icon.svg') }],
  ...['apple-touch-icon', 'icon-192', 'icon-512', 'icon-maskable-512'].map((n) => [`/static/icons/${n}.png`, { type: 'image/png', body: staticFile(`icons/${n}.png`) }]),
]);

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
 * - `GET /rueckblick?woche=…` — Wochenrückblick (erledigt gegen geplant, Flammen-Zeit).
 * - `GET /planen?woche=…&q=…&bereich=…&aus=…` — Woche planen (VCP-47): Zunder-Aufgaben
 *   suchen und holen (`POST /aktion/woche/holen`), aus der Woche nehmen
 *   (`POST /aktion/woche/raus`, Rückgängig über `/aktion/woche/zuruecksetzen`),
 *   Flamme einplanen (`POST /aktion/woche/flamme`).
 * - `GET /graph?q=…` sucht (hybrid), `GET /graph?pfad=…` zeigt den Graphen um
 *   eine Notiz; `GET /api/graph?pfad=…` liefert ihn als JSON, `GET /api/suche?q=…`
 *   die besten Treffer für die Live-Suche. Mit JavaScript wird der Graph
 *   interaktiv (`/static/graph.js` mit sigma aus `/static/vendor/graph-lib.js`),
 *   ohne bleibt das SVG.
 * - `GET /login` → Pocket ID → `GET /auth/callback` setzt die Sitzung (12 h).
 * - `POST /logout` löscht sie. SameSite=Lax hält fremde Seiten davon ab.
 * - `GET`/`POST /einstellungen` — Kalender, Zunder-Zugang und -Brücke, Mail-Abruf,
 *   Embeddings und Anzeige pflegen.
 * - `POST /aktion/status` setzt den Status einer Zunder-Aufgabe (abhaken, in
 *   Arbeit, blockiert, offen, verworfen), `POST /aktion/faellig` verschiebt die
 *   Fälligkeit, `POST /aktion/zuordnen` legt eine Aufgabe aus der Inbox in einen
 *   Bereich oder ein Projekt, `POST /aktion/phoenix` markiert einen Phönix-Schritt,
 *   `POST /aktion/flamme` startet (`an=1`) oder stoppt eine Flamme,
 *   `POST /aktion/notiz/…` legt eine Notiz ab, setzt Tags, hängt Text an oder
 *   hakt eine Checkbox ab (Vorschau unter `GET /notiz?pfad=…`),
 *   `POST /aktion/verlinken` hängt einen Wikilink zu einer ähnlichen Notiz an,
 *   `POST /aktion/erfassen` ist die Schnelleingabe (Notiz, mit `!` eine
 *   Zunder-Aufgabe). Alle brauchen Sitzung, gleiche Herkunft und das CSRF-Token
 *   der Sitzung. Mit `Accept: application/json` antworten sie mit JSON (für
 *   `/static/cockpit.js`), sonst mit einer Weiterleitung und einer Meldung.
 * - `POST /einstellungen/tokens` legt einen API-Token an (Recht `search` für
 *   `/api/search` oder `capture` für `/capture` und `/funke`) und zeigt ihn einmal, `POST /einstellungen/tokens/widerrufen` löscht einen.
 * - `GET /kurzbefehle/<slug>.shortcut` liefert die signierten iOS-Kurzbefehle
 *   (verlinkt in den Einstellungen).
 *
 * Die Sitzung ist ein signiertes Cookie und nur für diese Routen gültig; die
 * MCP-Schnittstelle prüft weiter ausschließlich Bearer-Tokens.
 */
export function createWebHttp({ cockpit, settings, actions = null, notes = null, plan = null, tokens = null, shortcuts = [], captureEnabled = false, calendars = null, graph = null, search = null, oidc, sessionSecret, publicUrl, allowedSubjects = [], sessionHours = 12, logger = console, now = () => Date.now() }) {
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
  const writeContext = (req) => (actions ? { csrf: csrfOf(req), captureId: randomUUID(), notes: Boolean(notes), plan: Boolean(plan) } : null);

  async function page(req, res, url, session, { status = 200, flash = null, draft = null } = {}) {
    const id = url.searchParams.get('woche');
    const model = await cockpit.week(id || null);
    if (!model) return send(res, 400, renderMessage('Unbekannte Woche', `„${id}“ ist keine Kalenderwoche wie 2026-W42.`, { link: { href: '/', label: 'Zur laufenden Woche' } }));
    const back = url.pathname + url.search;
    return send(res, status, renderWeek(model, { user: session.name ?? session.sub, write: writeContext(req), back, flash: flash ?? takeFlash(req, res), draft, focus: url.searchParams.has('erfassen') }));
  }

  /** Notizseite `/notiz?pfad=…`: Vorschau und Verarbeiten. */
  async function notePage(req, res, url, session, { status = 200, flash = null, draft = null } = {}) {
    const path = url.searchParams.get('pfad') ?? '';
    const note = notes?.get(path);
    if (!note) {
      return send(res, 404, renderMessage('Notiz nicht verfügbar', `„${path}“ gibt es nicht, oder sie liegt in einem vertraulichen oder ausgeschlossenen Ordner.`, { link: { href: '/', label: 'Zur Woche' } }));
    }
    const { vaultName } = settings.get();
    const html = renderNote(note, {
      user: session.name ?? session.sub,
      write: actions ? writeContext(req) : null,
      back: url.pathname + url.search,
      flash: flash ?? takeFlash(req, res),
      draft,
      targets: notes.targets(note.path),
      archive: notes.archiveFolder(),
      vaultName,
    });
    return send(res, status, html);
  }

  /** Wochenrückblick `/rueckblick?woche=…`: erledigt gegen geplant, Flammen-Zeit je Bereich. */
  async function reviewPage(req, res, url, session) {
    const id = url.searchParams.get('woche');
    const model = cockpit.review ? await cockpit.review(id || null) : null;
    if (!model) return send(res, 400, renderMessage('Unbekannte Woche', `„${id}“ ist keine Kalenderwoche wie 2026-W42.`, { link: { href: '/rueckblick', label: 'Zur laufenden Woche' } }));
    return send(res, 200, renderReview(model, { user: session.name ?? session.sub }));
  }

  /** Planungsseite `/planen?woche=…`: Aufgaben in die Woche holen, Flammen einplanen. */
  async function planPage(req, res, url, session, { status = 200, flash = null } = {}) {
    const id = url.searchParams.get('woche');
    const p = (k) => url.searchParams.get(k) ?? '';
    const model = await plan.view(id || null, { q: p('q'), area: p('bereich'), from: p('aus') });
    if (!model) return send(res, 400, renderMessage('Unbekannte Woche', `„${id}“ ist keine Kalenderwoche wie 2026-W42.`, { link: { href: '/planen', label: 'Zur laufenden Woche' } }));
    return send(res, status, renderPlan(model, { user: session.name ?? session.sub, write: writeContext(req), back: url.pathname + url.search, flash: flash ?? takeFlash(req, res) }));
  }

  /** Seite hinter `back` mit Meldung (Weg ohne JavaScript, wenn eine Aktion scheitert). */
  const backPage = (req, res, back, session, opts) => {
    const url = new URL(back, publicUrl);
    // Die Graphseite rendert sich aus der Meldung im Cookie neu.
    if (url.pathname === '/graph') return redirect(res, back, [flashCookie(opts.flash)]);
    if (url.pathname === '/planen' && plan) return planPage(req, res, url, session, opts);
    return url.pathname === '/notiz' && notes ? notePage(req, res, url, session, opts) : page(req, res, url, session, opts);
  };
  /** Nach dem Verschieben gibt es die alte Notizseite nicht mehr. */
  const notePageOf = (path) => `/notiz?pfad=${encodeURIComponent(path)}`;

  const taskName = (t) => (t.ref ? `${t.ref} ${t.title}` : t.title);
  const statusMessage = (t) => {
    if (t.status === 'done') return `Erledigt: ${taskName(t)}`;
    if (t.status === 'in_progress') return `In Arbeit: ${taskName(t)}`;
    if (t.status === 'blocked') return `Blockiert: ${taskName(t)}`;
    if (t.status === 'dropped') return `Verworfen: ${taskName(t)}`;
    return `Wieder offen: ${taskName(t)}`;
  };
  const dueMessage = (t) => (t.due ? `Fällig ${dueLabel(t.due, settings.get().tz)}: ${taskName(t)}` : `Ohne Fälligkeit: ${taskName(t)}`);
  const placeName = (loc) => {
    if (!loc || loc.kind === 'inbox') return 'Inbox';
    if (loc.kind === 'loose') return 'Lose';
    if (loc.kind === 'project') return loc.area_name ? `${loc.area_name} / ${loc.name}` : (loc.name ?? 'Projekt');
    return loc.name ?? loc.area_name ?? 'Bereich';
  };
  const flameMessage = (t, on) => {
    const failed = typeof t.timing === 'string' ? ` · Timing: ${t.timing}` : '';
    if (on) return `Flamme läuft: ${taskName(t)}${t.timing === true ? ' · Timing misst mit' : failed}`;
    const minutes = t.startedAt && t.endedAt ? Math.round((Date.parse(t.endedAt) - Date.parse(t.startedAt)) / 60_000) : null;
    return `Flamme gestoppt: ${taskName(t)}${minutes != null ? ` · ${minutes} min` : ''}${failed}`;
  };
  const captureMessage = (r) => {
    if (r.kind === 'task') return `${r.duplicate ? 'Schon erfasst' : 'Aufgabe angelegt'}: ${r.ref ?? 'neue Aufgabe'} liegt in der Zunder-Inbox`;
    return `${r.duplicate ? 'Schon erfasst' : 'Notiz angelegt'}: ${r.path}`;
  };

  /**
   * Die schreibenden Aktionen. Jede liefert `{ message, …, undo }`; `undo` ist
   * `{ action, fields }`, also genau das Formular, das den alten Stand
   * wiederherstellt (ohne JavaScript als Knopf in der Meldung).
   */
  const ACTIONS = actions
    ? {
        async '/aktion/status'(form, session) {
          const prev = form.get('prev');
          const task = await actions.setStatus(form.get('id'), form.get('status'));
          const undo = SETTABLE.includes(prev) && prev !== task.status ? { action: '/aktion/status', fields: { id: task.id, status: prev } } : null;
          logger.info?.(`Cockpit: ${task.ref ?? task.id} → ${task.status} (${session.sub})`);
          return { message: statusMessage(task), task, undo };
        },
        async '/aktion/faellig'(form, session) {
          const due = form.get('due') === 'datum' ? form.get('date') : form.get('due');
          const prev = (form.get('prev') ?? '').slice(0, 10);
          const task = await actions.setDue(form.get('id'), due);
          const undo = form.has('prev') && prev !== (task.due ?? '').slice(0, 10) ? { action: '/aktion/faellig', fields: { id: task.id, due: prev || 'keine' } } : null;
          logger.info?.(`Cockpit: ${task.ref ?? task.id} fällig ${task.due ?? '–'} (${session.sub})`);
          return { message: dueMessage(task), task, undo };
        },
        async '/aktion/zuordnen'(form, session) {
          const prev = form.get('prev');
          const task = await actions.move(form.get('id'), form.get('ziel'));
          const undo = prev === 'inbox' && task.location?.kind !== 'inbox' ? { action: '/aktion/zuordnen', fields: { id: task.id, ziel: 'inbox' } } : null;
          logger.info?.(`Cockpit: ${task.ref ?? task.id} → ${placeName(task.location)} (${session.sub})`);
          return { message: `${placeName(task.location)}: ${taskName(task)}`, task, undo };
        },
        async '/aktion/phoenix'(form, session) {
          const prev = form.get('prev') ?? '';
          const task = await actions.setPhoenix(form.get('id'), form.get('fire'));
          const now = task.phoenix?.role === 'feuer_schritt' ? task.phoenix.fire : '';
          const undo = form.has('prev') && prev !== now ? { action: '/aktion/phoenix', fields: { id: task.id, fire: prev } } : null;
          logger.info?.(`Cockpit: ${task.ref ?? task.id} Phönix ${now || '–'} (${session.sub})`);
          const message = now ? `Phönix-Schritt KW ${Number(now.slice(6))}: ${taskName(task)}` : `Kein Phönix-Schritt mehr: ${taskName(task)}`;
          return { message, task, undo };
        },
        async '/aktion/flamme'(form, session) {
          const on = form.get('an') === '1';
          const task = await actions.flame(form.get('id'), on);
          logger.info?.(`Cockpit: Flamme ${on ? 'an' : 'aus'} ${task.ref ?? task.id} (${session.sub})`);
          return { message: flameMessage(task, on), task };
        },
        ...(notes
          ? {
              async '/aktion/notiz/ablegen'(form, session) {
                const back = safeNext(form.get('back'));
                const r = notes.move(form.get('pfad'), form.get('ordner'));
                const folder = r.path.slice(0, r.path.lastIndexOf('/'));
                const from = r.from.includes('/') ? r.from.slice(0, r.from.lastIndexOf('/')) : '';
                logger.info?.(`Cockpit: ${r.from} → ${r.path} (${session.sub})`);
                // Von der Notizseite aus geht es zur neuen Adresse der Notiz.
                const redirect = back.startsWith('/notiz') ? notePageOf(r.path) : null;
                const undo = r.changed && from ? { action: '/aktion/notiz/ablegen', fields: { pfad: r.path, ordner: from, back: redirect ? notePageOf(r.from) : back } } : null;
                return { message: r.changed ? `Abgelegt in ${folder}/` : `Liegt schon in ${folder}/`, path: r.path, redirect, undo };
              },
              async '/aktion/notiz/tags'(form) {
                const r = notes.setTags(form.get('pfad'), form.get('tags'));
                return { message: r.tags.length ? `Tags: ${r.tags.map((t) => `#${t}`).join(' ')}` : 'Tags entfernt', path: r.path };
              },
              async '/aktion/notiz/anhaengen'(form) {
                const r = notes.append(form.get('pfad'), form.get('text'));
                return { message: 'Angehängt', path: r.path };
              },
              async '/aktion/feuer'(form, session) {
                const r = notes.setFeuer(form.get('pfad'), form.get('feld'), form.get('text'));
                logger.info?.(`Cockpit: ${r.heading} in ${r.path} (${session.sub})`);
                const undo = r.changed && r.previous ? { action: '/aktion/feuer', fields: { pfad: r.path, feld: form.get('feld'), text: r.previous } } : null;
                return { message: r.changed ? `${r.heading} gespeichert` : `${r.heading} unverändert`, path: r.path, undo };
              },
              async '/aktion/verlinken'(form, session) {
                const r = notes.link(form.get('pfad'), form.get('ziel'));
                if (r.changed) logger.info?.(`Cockpit: ${r.path} → [[${r.target}]] (${session.sub})`);
                return { message: r.changed ? `Verlinkt: ${r.title}` : `Schon verlinkt: ${r.title}`, path: r.path, target: r.target };
              },
              async '/aktion/feuer/anlegen'(form, session) {
                const r = notes.createFeuer(form.get('woche'), form.get('ziel'), form.get('zug'));
                logger.info?.(`Cockpit: ${r.path} angelegt (${session.sub})`);
                return { message: `${r.title} angelegt`, path: r.path };
              },
              async '/aktion/notiz/checkbox'(form) {
                const done = form.get('erledigt') === '1';
                const r = notes.toggle(form.get('pfad'), form.get('n'), form.get('line'), done);
                const undo = { action: '/aktion/notiz/checkbox', fields: { pfad: r.path, n: form.get('n'), line: r.line, erledigt: done ? '0' : '1' } };
                return { message: done ? 'Abgehakt' : 'Wieder offen', path: r.path, undo };
              },
            }
          : {}),
        // Wochenplanung; leert danach einen Zwischenspeicher der Wochenansicht, falls es einen gibt.
        ...(plan ? planRoutes(plan, { tz: () => settings.get().tz, logger, changed: () => cockpit.invalidate?.() }) : {}),
        async '/aktion/erfassen'(form) {
          const result = await actions.capture({ text: form.get('text') ?? '', captureId: form.get('cid') });
          return { message: captureMessage(result), result };
        },
      }
    : {};

  /**
   * Alle Aktionen. Mit JavaScript als JSON, ohne als Formular mit
   * Weiterleitung; schlägt es ohne JavaScript fehl, kommt die Seite direkt mit
   * Fehlermeldung (und bei der Schnelleingabe dem eingegebenen Text) zurück,
   * damit nichts verloren geht.
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
      body = { ok: true, ...(await ACTIONS[path](form, session)) };
    } catch (err) {
      if (!(err instanceof ActionError)) throw err;
      logger.warn?.(`Cockpit-Aktion ${path} fehlgeschlagen: ${err.message}`);
      if (wantsJson) return json(res, err.status, { error: 'action_failed', message: err.message });
      const draft = path === '/aktion/erfassen' || path === '/aktion/notiz/anhaengen' ? form.get('text') : null;
      return backPage(req, res, back, session, { status: err.status, flash: { kind: 'error', message: err.message }, draft });
    }
    const flash = flashCookie({ kind: 'ok', message: body.message, undo: body.undo ?? null });
    // Muss die Seite wechseln (Notiz verschoben), kommt die Meldung per Cookie mit.
    if (wantsJson) {
      if (body.redirect) res.setHeader('set-cookie', [flash]);
      return json(res, 200, body);
    }
    return redirect(res, body.redirect ?? back, [flash]);
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
      captureEnabled: typeof captureEnabled === 'function' ? captureEnabled() : captureEnabled,
      tz: settings.get().tz,
      user: session.name ?? session.sub,
      csrf: csrfOf(req),
    });
    return send(res, status, html);
  }

  /**
   * Formular → vollständiger Einstellungsstand. Leere Geheimnisfelder
   * (Kalenderadresse, Passwort, Tokens) behalten den gespeicherten Wert.
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
      // Die Seite schickt `cal.auth` mit: Ein iCal-Abo ohne Haken bei „Mit Anmeldung“ verliert dann Benutzer und Passwort.
      const kind = field(`cal.${i}.kind`) || 'ical';
      const username = kind === 'ical' && form.get('cal.auth') && !form.get(`cal.${i}.auth`) ? '' : field(`cal.${i}.username`);
      calendarsIn.push({
        id: prev?.id,
        name,
        kind,
        url: url || prev?.url,
        username,
        password: username ? field(`cal.${i}.password`) || prev?.password : null,
        filter: field(`cal.${i}.filter`).split(','),
      });
    }
    const clear = Boolean(form.get('zunder.clear'));
    const choice = (k) => ({ an: true, aus: false })[field(k)] ?? null;
    const list = (k) => field(k).split(/[,\s]+/);
    return {
      tz: field('tz'),
      vaultName: field('vaultName'),
      inboxFolder: field('inboxFolder'),
      zunder: clear ? { url: null, token: null } : { url: field('zunder.url'), token: field('zunder.token') || stored.zunder.token },
      bridge: { enabled: choice('bridge.enabled'), tag: field('bridge.tag') },
      mail: {
        token: form.get('mail.clear') ? null : field('mail.token') || stored.mail.token,
        senders: list('mail.senders'),
        mailbox: field('mail.mailbox'),
        doneMailbox: field('mail.doneMailbox'),
        pollMinutes: field('mail.pollMinutes'),
      },
      embed: { url: field('embed.url'), model: field('embed.model') },
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

  /** Einstellungs- und Token-Formulare: wie die Aktionen nur mit dem CSRF-Token der Sitzung. */
  async function readSettingsForm(req, res) {
    const form = await readForm(req, res);
    if (!form) return null;
    if (!csrfOk(req, form.get('csrf'))) {
      send(res, 403, renderMessage('Nicht gespeichert', 'Die Seite ist veraltet. Bitte neu laden und noch einmal versuchen.', { link: { href: '/einstellungen', label: 'Neu laden' } }));
      return null;
    }
    return form;
  }

  async function saveSettings(req, res, session) {
    const form = await readSettingsForm(req, res);
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
    const form = await readSettingsForm(req, res);
    if (!form) return;
    let created;
    try {
      created = tokens.create(form.get('name'), form.get('scope') || 'search');
    } catch (err) {
      if (err instanceof SettingsError) return settingsPage(req, res, session, { status: 400, error: err.message });
      throw err;
    }
    logger.info?.(`API-Token „${created.name}“ angelegt von ${session.sub}`);
    return settingsPage(req, res, session, { created });
  }

  async function revokeToken(req, res, session) {
    const form = await readSettingsForm(req, res);
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
    return send(res, 200, renderGraph(g, { vaultName, user, tz, write: writeContext(req), back: url.pathname + url.search, flash: takeFlash(req, res) }));
  }

  /** Live-Suche: die besten Treffer, knapp. */
  async function searchApi(req, res, url) {
    const q = (url.searchParams.get('q') ?? '').trim().slice(0, 500);
    if (!q || !search) return json(res, 200, { query: q, results: [], total: 0 });
    const r = await search(q);
    const results = r.results.slice(0, 8).map((x) => ({ path: x.path, title: x.title ?? x.path, snippet: x.snippet ?? null, streams: x.streams ?? [] }));
    return json(res, 200, { query: q, results, total: r.total, degraded: r.degraded ?? null });
  }

  async function graphApi(req, res, url) {
    const g = graph ? await graph.around(url.searchParams.get('pfad') ?? '') : null;
    if (!g) return json(res, 404, { error: 'not_found', error_description: 'Notiz nicht im Index' });
    return json(res, 200, g);
  }

  const TOKEN_ROUTES = { '/einstellungen/tokens': createToken, '/einstellungen/tokens/widerrufen': revokeToken };
  const ACTION_ROUTES = new Set(Object.keys(ACTIONS));
  const SHORTCUT_ROUTES = new Map(shortcuts.map((s) => [`/kurzbefehle/${s.slug}.shortcut`, s]));
  const ROUTES = new Set([...ACTION_ROUTES, ...SHORTCUT_ROUTES.keys(), ...PUBLIC.keys(), '/', '/api/woche', '/api/suche', '/rueckblick', ...(notes ? ['/notiz'] : []), ...(plan ? ['/planen'] : []), '/graph', '/api/graph', '/einstellungen', ...(tokens ? Object.keys(TOKEN_ROUTES) : []), '/login', '/auth/callback', '/logout']);

  return {
    matches: (path) => ROUTES.has(path),

    async handle(req, res, url) {
      const path = url.pathname;
      const method = req.method === 'HEAD' ? 'GET' : req.method;

      if (PUBLIC.has(path) && method === 'GET') {
        const file = PUBLIC.get(path);
        // Mit passendem Versions-Parameter darf der Browser die Datei behalten; ein Deploy ändert die Adresse.
        const pinned = file.version && url.searchParams.get('v') === file.version;
        res.writeHead(200, {
          'content-type': file.type,
          'cache-control': pinned ? 'public, max-age=31536000, immutable' : file.version ? 'no-cache' : 'public, max-age=86400',
          'x-content-type-options': 'nosniff',
        });
        return res.end(file.body);
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
      if (path === '/api/suche') {
        if (!session) return json(res, 401, { error: 'unauthorized', error_description: 'Anmeldung unter /login nötig' });
        return searchApi(req, res, url);
      }
      if (!session) return redirect(res, `/login?next=${encodeURIComponent(url.pathname + url.search)}`);
      if (path === '/graph') return graphPage(req, res, url, session);
      if (path === '/notiz') return notePage(req, res, url, session);
      if (path === '/rueckblick') return reviewPage(req, res, url, session);
      if (path === '/planen' && plan) return planPage(req, res, url, session);
      return page(req, res, url, session);
    },
  };
}
