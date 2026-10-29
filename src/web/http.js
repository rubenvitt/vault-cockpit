import { readFileSync, createReadStream, closeSync } from 'node:fs';
import { timingSafeEqual, randomUUID, createHash } from 'node:crypto';
import { createCookieSigner, parseCookies, cookie } from './session.js';
import { createSessions } from './sessions.js';
import { createAppAccess, APP_CALLBACK_PATH, SITE_ASSOCIATION_PATH } from './app-access.js';
import { renderDraftRescue } from './session-render.js';
import { renderWeek, renderMessage, renderSettings, dueLabel } from './render.js';
import { versionAssets, THEME } from './layout.js';
import { renderGraph, renderSearch, renderWholeGraph, graphJson, GRAPH_CSS } from './graph-render.js';
import { renderNote, noteOrigin, NOTE_CSS } from './note-render.js';
import { noteJson } from './note-json.js';
import { renderReview, REVIEW_CSS } from './review-render.js';
import { renderPlan, planRoutes, PLAN_CSS } from './plan-page.js';
import { renderHealth, healthAlert, HEALTH_CSS } from './health-render.js';
import { offlineFiles, readingOfflineUrls, OFFLINE_CSS, OFFLINE_MARK, SYNTHESIS_FOLDER } from './offline.js';
import { SettingsError, MAX_CALENDARS, TTS_PROVIDERS } from '../cockpit/settings.js';
import { describeWeek, weekOf } from '../cockpit/week.js';
import { ActionError, SETTABLE } from '../cockpit/actions.js';
import { BackupError, MAX_BACKUP, checkPassphrase } from '../cockpit/backup.js';
import { settingsJson, mergeSettingsForm, tokensJson, scopesJson, shortcutsJson, shortcutsIntro, backupJson, SCOPE_LABELS } from './settings-json.js';
import { readMultipart, FormError } from './multipart.js';
import { restoredMessage } from './backup-render.js';
import { placement } from '../capture/syntax.js';
import { wissenPage, wissenView, wissenQuery } from './wissen-page.js';
import { openPoints, SYNTHESIS } from './synthesis-render.js';
import { evidenceRoutes } from '../lesen/synthesis-evidence.js';

const staticFile = (name, enc) => readFileSync(new URL(`./static/${name}`, import.meta.url), enc);
const UI_JS = staticFile('ui.js', 'utf8');
const PLAYER_JS = staticFile('player.js', 'utf8');
const CLIENT_JS = staticFile('cockpit.js', 'utf8');
const GRAPH_JS = staticFile('graph.js', 'utf8');
const WHOLE_GRAPH_JS = staticFile('graph-alles.js', 'utf8');
const OFFLINE_JS = staticFile('offline.js', 'utf8');
const INBOX_JS = staticFile('lesen-eingang.js', 'utf8');
const LESEN_DOC_JS = staticFile('lesen-doc.js', 'utf8');
const LESEN_HOEREN_JS = staticFile('lesen-hoeren.js', 'utf8');
const LESEN_FOLGEN_JS = staticFile('lesen-folgen.js', 'utf8');
const LESEN_LINKS_JS = staticFile('lesen-verbinden.js', 'utf8');
const LESEN_FEEDS_JS = staticFile('lesen-feeds.js', 'utf8');
const LESEN_INGEST_JS = staticFile('lesen-ingest.js', 'utf8');
const FRAGEN_JS = staticFile('fragen.js', 'utf8');
// sigma + graphology + ForceAtlas2, gebündelt mit `npm run vendor` und eingecheckt.
const GRAPH_LIB = staticFile('vendor/graph-lib.js', 'utf8');
// Design-System (Tokens, Bausteine, Wochenansicht) plus die Teile der übrigen Seiten.
const CSS = staticFile('cockpit.css', 'utf8') + GRAPH_CSS + NOTE_CSS + REVIEW_CSS + PLAN_CSS + HEALTH_CSS + OFFLINE_CSS;
const hash = (s) => createHash('sha256').update(s).digest('base64url').slice(0, 10);
const VERSION = { css: hash(CSS), ui: hash(UI_JS), player: hash(PLAYER_JS), js: hash(CLIENT_JS), graph: hash(GRAPH_JS), wholeGraph: hash(WHOLE_GRAPH_JS), graphLib: hash(GRAPH_LIB), offline: hash(OFFLINE_JS), inbox: hash(INBOX_JS), lesenDoc: hash(LESEN_DOC_JS), lesenHoeren: hash(LESEN_HOEREN_JS), lesenFolgen: hash(LESEN_FOLGEN_JS), lesenLinks: hash(LESEN_LINKS_JS), lesenFeeds: hash(LESEN_FEEDS_JS), lesenIngest: hash(LESEN_INGEST_JS), fragen: hash(FRAGEN_JS) };
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
  ['/static/ui.js', { type: 'text/javascript; charset=utf-8', body: UI_JS, version: VERSION.ui }],
  ['/static/player.js', { type: 'text/javascript; charset=utf-8', body: PLAYER_JS, version: VERSION.player }],
  ['/static/cockpit.js', { type: 'text/javascript; charset=utf-8', body: CLIENT_JS, version: VERSION.js }],
  ['/static/graph.js', { type: 'text/javascript; charset=utf-8', body: GRAPH_JS, version: VERSION.graph }],
  ['/static/graph-alles.js', { type: 'text/javascript; charset=utf-8', body: WHOLE_GRAPH_JS, version: VERSION.wholeGraph }],
  ['/static/vendor/graph-lib.js', { type: 'text/javascript; charset=utf-8', body: GRAPH_LIB, version: VERSION.graphLib }],
  ['/static/offline.js', { type: 'text/javascript; charset=utf-8', body: OFFLINE_JS, version: VERSION.offline }],
  ['/static/lesen-eingang.js', { type: 'text/javascript; charset=utf-8', body: INBOX_JS, version: VERSION.inbox }],
  ['/static/lesen-doc.js', { type: 'text/javascript; charset=utf-8', body: LESEN_DOC_JS, version: VERSION.lesenDoc }],
  ['/static/lesen-hoeren.js', { type: 'text/javascript; charset=utf-8', body: LESEN_HOEREN_JS, version: VERSION.lesenHoeren }],
  ['/static/lesen-folgen.js', { type: 'text/javascript; charset=utf-8', body: LESEN_FOLGEN_JS, version: VERSION.lesenFolgen }],
  ['/static/lesen-verbinden.js', { type: 'text/javascript; charset=utf-8', body: LESEN_LINKS_JS, version: VERSION.lesenLinks }],
  ['/static/lesen-feeds.js', { type: 'text/javascript; charset=utf-8', body: LESEN_FEEDS_JS, version: VERSION.lesenFeeds }],
  ['/static/lesen-ingest.js', { type: 'text/javascript; charset=utf-8', body: LESEN_INGEST_JS, version: VERSION.lesenIngest }],
  ['/static/fragen.js', { type: 'text/javascript; charset=utf-8', body: FRAGEN_JS, version: VERSION.fragen }],
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

const LOGIN = 'vc_login';
const FLASH = 'vc_flash';

const HTML_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'content-security-policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; media-src 'self' blob:; manifest-src 'self'; worker-src 'self'; frame-src 'self'; form-action 'self'; frame-ancestors 'self'; base-uri 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'same-origin',
};

// Service Worker `/sw.js` und App-Hülle `/offline`, beide ohne Sitzung (src/web/offline.js).
for (const [path, file] of offlineFiles(PUBLIC, { html: HTML_HEADERS }).entries) PUBLIC.set(path, file);

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
 *   ohne bleibt das SVG. `GET /graph/alles` zeigt den ganzen Vault als Graph
 *   (`/static/graph-alles.js`), Knoten und vorberechnete Positionen kommen aus
 *   `GET /api/graph/alles` (src/graph/whole.js).
 * - `GET /login` → Pocket ID → `GET /auth/callback` setzt die Sitzung. Sie
 *   verlängert sich bei Nutzung und endet nach 30 Tagen ohne Nutzung, spätestens
 *   nach 90 (einstellbar, siehe `sessions.js`).
 * - `POST /logout` löscht sie. SameSite=Lax hält fremde Seiten davon ab.
 *   `POST /einstellungen/abmelden` beendet alle Sitzungen auf allen Geräten.
 * - `GET`/`POST /einstellungen` — Kalender, Zunder-Zugang und -Brücke, Mail-Abruf,
 *   Embeddings und Anzeige pflegen.
 * - `POST /aktion/status` setzt den Status einer Zunder-Aufgabe (abhaken, in
 *   Arbeit, blockiert, offen, verworfen), `POST /aktion/faellig` verschiebt die
 *   Fälligkeit, `POST /aktion/zuordnen` legt eine Aufgabe aus der Inbox in einen
 *   Bereich oder ein Projekt, `POST /aktion/phoenix` markiert einen Phönix-Schritt,
 *   `POST /aktion/flamme` startet (`an=1`) oder stoppt eine Flamme,
 *   `POST /aktion/notiz/…` legt eine Notiz ab, setzt Tags, hängt Text an oder
 *   hakt eine Checkbox ab (Vorschau unter `GET /notiz?pfad=…`, Bilder daraus
 *   unter `GET /notiz/bild?pfad=…`),
 *   `POST /aktion/verlinken` hängt einen Wikilink zu einer ähnlichen Notiz an,
 *   `POST /aktion/erfassen` ist die Schnelleingabe (Notiz, mit `!` eine
 *   Zunder-Aufgabe; `GET /api/erfassen/vorschau?text=…` zeigt vorher, wo sie landet). Alle brauchen Sitzung, gleiche Herkunft und das CSRF-Token
 *   der Sitzung. Mit `Accept: application/json` antworten sie mit JSON (für
 *   `/static/cockpit.js`), sonst mit einer Weiterleitung und einer Meldung.
 *   Ist die Sitzung abgelaufen, geht es über den Login zurück, ein Text aus
 *   Schnelleingabe oder Anhängen steht danach wieder im Feld.
 * - `POST /einstellungen/tokens` legt einen API-Token an (Recht `search` für
 *   `/api/search` oder `capture` für `/capture` und `/funke`) und zeigt ihn einmal, `POST /einstellungen/tokens/widerrufen` löscht einen.
 * - `POST /einstellungen/sicherung` liefert die verschlüsselte Sicherung von
 *   `/data` als Datei, `POST /einstellungen/sicherung/wiederherstellen`
 *   (`multipart/form-data`) schreibt eine zurück und startet das Cockpit neu
 *   (`restart`); ist es nicht leer, nur mit `ersetzen=1`.
 * - `GET /kurzbefehle/<slug>.shortcut` liefert die signierten iOS-Kurzbefehle
 *   (verlinkt in den Einstellungen).
 * - `GET /wissen?q=…&art=…&status=…` sucht in den Synthesen (`type: synthesis`),
 *   `POST /aktion/synthese/aufgaben` legt die offenen Punkte einer Synthese
 *   als Zunder-Aufgaben an (je Punkt höchstens einmal). Mit `evidence`
 *   (src/lesen/synthesis-evidence.js) zeigt eine Synthese passende neue
 *   Markierungen, `POST /aktion/synthese/beleg` hängt eine an, `/wissen?lesen=1`
 *   filtert danach.
 * - `GET /zustand` zeigt den Zustand der Hintergrunddienste (`health`, siehe
 *   src/health/collect.js); meldet einer einen Fehler, trägt die Kopfzeile der
 *   Wochenansicht einen Hinweis dorthin.
 * - `GET /lesen/…` und `POST /aktion/lesen/…` — Lesestapel (VCP-77), Seiten und
 *   Aktionen aus `reading` (src/lesen/http.js).
 * - `GET /sw.js` (Service Worker) und `GET /offline` (App-Hülle ohne Netz) gibt
 *   es ohne Sitzung; `GET /api/sitzung` liefert das CSRF-Token der Sitzung, mit
 *   dem der Offline-Puffer die Schnelleingabe nachsendet (401 ohne Sitzung).
 *   `GET /api/lesen/offline` nennt die Seiten, die der Service Worker als
 *   Lesestoff für unterwegs speichern darf (src/web/offline.js).
 * - JSON für die native App (auch mit Sitzung): `GET /api/notiz?pfad=…` (Notizseite,
 *   Text als Baum, src/web/note-json.js), `GET /api/wissen?q=…&art=…&status=…&lesen=1`,
 *   `GET /api/suche?q=…&alle=1` (alle Treffer statt der besten acht), `GET /api/zustand`;
 *   `/api/graph` bringt die Listen der Graphseite mit, `/api/woche` unter `alert` die
 *   gestörten Dienste.
 * - Einstellungen für die App (src/web/settings-json.js): `GET`/`POST /api/einstellungen`
 *   (Felder wie das Formular, fehlende bleiben), `POST /api/einstellungen/abmelden`
 *   („Überall abmelden“), `GET`/`POST /api/einstellungen/tokens` und
 *   `POST /api/einstellungen/tokens/widerrufen`, `GET`/`POST /api/einstellungen/sicherung`
 *   (Stand bzw. Datei) und `POST /api/einstellungen/sicherung/wiederherstellen`,
 *   `GET /api/einstellungen/kurzbefehle`; die Kurzbefehle selbst lädt die App mit Geräte-Token.
 * - `GET /login?app=1&state=…&challenge=…` und `/api/app/…` — Login und
 *   JSON-API der iOS-App mit Geräte-Token (src/web/app-access.js);
 *   `GET /.well-known/apple-app-site-association` und `GET /app/angemeldet`
 *   (Universal Link des Logins) ohne Anmeldung.
 *
 * Die Sitzung ist ein signiertes Cookie und nur für diese Routen gültig; die
 * MCP-Schnittstelle prüft weiter ausschließlich Bearer-Tokens.
 */
export function createWebHttp({ cockpit, settings, actions = null, notes = null, plan = null, reading = null, tokens = null, shortcuts = [], captureEnabled = false, calendars = null, graph = null, wholeGraph = null, search = null, evidence = null, health = null, backup = null, restart = () => {}, oidc, sessionSecret, publicUrl, appId = undefined, allowDevScheme = false, trustProxy = false, allowedSubjects = [], logger = console, now = () => Date.now() }) {
  const signer = createCookieSigner(sessionSecret);
  const secure = publicUrl.startsWith('https://');
  const sessions = createSessions({ signer, settings, allowedSubjects, secure, now });
  const READING_PAGES = reading?.pages ?? {};
  // iOS-App: Login über das System-Blatt, Geräte-Token, JSON-API (VCP-91).
  const appAccess = tokens && reading ? createAppAccess({ tokens, reading, publicUrl, appId, allowDevScheme, trustProxy, logger, now }) : null;

  const send = (res, status, body, headers = {}) => {
    res.writeHead(status, { ...HTML_HEADERS, ...headers });
    res.end(body);
  };
  const json = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    res.end(JSON.stringify(body));
  };
  // Angehängt statt gesetzt, damit ein verlängertes Sitzungs-Cookie mitgeht.
  const redirect = (res, location, cookies = []) => {
    for (const c of cookies) res.appendHeader('set-cookie', c);
    res.writeHead(303, { location, 'cache-control': 'no-store' });
    res.end();
  };

  // Prüft Signatur, Ablauf, Generation und das Subject gegen ALLOWED_SUBJECTS.
  const sessionOf = (req) => sessions.read(req);

  /**
   * Native App: Mit Geräte-Token (`Authorization: Bearer vct_…`, Recht `app`) gelten die
   * JSON-Endpunkte (`/api/…`, auch Einstellungen, Tokens und Sicherung unter
   * `/api/einstellungen…`), die Aktionen, Bilder aus Notizen und die Kurzbefehle zum Laden
   * wie mit einer Sitzung. HTML-Seiten und ihre Formulare (`/einstellungen…`) bleiben beim
   * Cookie. Ein CSRF-Token braucht es dafür nicht: Den Header schickt kein Browser von selbst mit.
   * `tokenId`: der Geräte-Token selbst (in der Token-Liste `current`).
   */
  const appSessionOf = (req, path) => {
    if (!appAccess || !/^Bearer /.test(String(req.headers.authorization ?? ''))) return null;
    if (!(path.startsWith('/api/') || ACTION_ROUTES.has(path) || path === '/notiz/bild' || SHORTCUT_ROUTES.has(path))) return null;
    const device = appAccess.device(req);
    return device ? { sub: `app:${device.name}`, name: device.name, app: true, tokenId: device.id } : null;
  };

  // CSRF: zusätzlich zu SameSite=Lax und der Herkunftsprüfung ein Token, das an
  // den Login dieser Sitzung gebunden ist. Ohne Speicher auf dem Server.
  const csrfOf = (req) => {
    const s = sessionOf(req);
    return s ? sessions.csrf(s) : '';
  };
  const csrfOk = (req, given) => {
    const a = Buffer.from(String(given ?? ''));
    const b = Buffer.from(csrfOf(req));
    return b.length > 0 && a.length === b.length && timingSafeEqual(a, b);
  };

  /** Meldung für die nächste Seite (ohne JavaScript): signiert, eine Minute gültig. */
  const flashCookie = (flash) => cookie(FLASH, signer.seal({ ...flash, exp: Math.floor(now() / 1000) + 60 }), { secure, maxAge: 60 });
  const takeFlash = (req, res) => {
    const raw = parseCookies(req.headers.cookie)[FLASH];
    if (!raw) return null;
    res.appendHeader('set-cookie', cookie(FLASH, '', { secure, maxAge: 0 }));
    return signer.open(raw, now());
  };

  /** Nur Pfade dieser Seite als Rücksprungziel, damit der Login kein offener Redirect ist. */
  const safeNext = (n) => (typeof n === 'string' && /^\/(?!\/)[^\\\s]*$/.test(n) ? n : '/');

  async function login(req, res, url) {
    // `app=1`: Login der iOS-App, endet auf `/app/angemeldet` (Universal Link) statt mit einer Sitzung.
    const app = url.searchParams.get('app') === '1' ? appAccess?.start(url) : null;
    if (url.searchParams.get('app') === '1' && !app) return send(res, 400, renderMessage('Login nicht möglich', 'Der App-Login braucht gültige Werte für state und challenge.'));
    // Im Rahmen des Players (/static/player.js) lässt sich Pocket ID nicht öffnen: anmelden im ganzen Fenster.
    if (!app && req.headers['sec-fetch-dest'] === 'iframe') {
      const next = safeNext(url.searchParams.get('next'));
      return send(res, 200, renderMessage('Neu anmelden', 'Die Anmeldung ist abgelaufen.', { link: { href: `/login?next=${encodeURIComponent(next)}`, label: 'Anmelden', top: true } }));
    }
    // App-Login immer mit erneuter Anmeldung bei Pocket ID (`prompt=login`): Sonst könnte eine fremde
    // App, solange Pocket ID im gemeinsamen Safari-Speicher angemeldet ist, ohne Rückfrage einen Login starten.
    const { url: target, pending } = await oidc.start(app ? { prompt: 'login' } : {});
    const value = signer.seal({ ...pending, ...(app ? { app } : { next: safeNext(url.searchParams.get('next')) }), exp: Math.floor(now() / 1000) + 600 });
    redirect(res, target, [cookie(LOGIN, value, { secure, maxAge: 600 })]);
  }

  async function callback(req, res, url) {
    const pending = signer.open(parseCookies(req.headers.cookie)[LOGIN], now());
    const clear = cookie(LOGIN, '', { secure, maxAge: 0 });
    if (url.searchParams.get('error')) {
      if (pending?.app && appAccess) return redirect(res, appAccess.deny(pending.app, 'access_denied'), [clear]);
      res.setHeader('set-cookie', [clear]);
      return send(res, 401, renderMessage('Login abgebrochen', url.searchParams.get('error_description') ?? url.searchParams.get('error'), { link: { href: '/login', label: 'Noch einmal anmelden' } }));
    }
    let user;
    try {
      user = await oidc.finish({ code: url.searchParams.get('code'), state: url.searchParams.get('state'), pending });
    } catch (err) {
      logger.warn?.(`Web-Login abgelehnt: ${err.message}`);
      if (pending?.app && appAccess) return redirect(res, appAccess.deny(pending.app, 'access_denied'), [clear]);
      res.setHeader('set-cookie', [clear]);
      return send(res, 403, renderMessage('Kein Zugang', 'Die Anmeldung wurde nicht angenommen.', { link: { href: '/login', label: 'Noch einmal anmelden' } }));
    }
    // Die App bekommt nur den Code; Sitzung und Token gibt es erst beim Einlösen.
    if (pending.app && appAccess) return redirect(res, appAccess.finish(pending.app, user), [clear]);
    // Jede Anmeldung bekommt eine eigene `sid`, damit auch das CSRF-Token wechselt.
    redirect(res, safeNext(pending.next), [clear, sessions.issue(user)]);
  }

  /** Aktionen, deren Text eine abgelaufene Sitzung überlebt (Feld `text`). */
  const DRAFT_ACTIONS = new Set(['/aktion/erfassen', '/aktion/notiz/anhaengen']);
  const DRAFT_FLASH = { kind: 'error', message: 'Nicht gespeichert: Die Anmeldung war abgelaufen. Der Text steht wieder im Feld.' };

  /**
   * Aktion ohne gültige Sitzung (ohne JavaScript): über den Login zurück auf
   * die Seite. Den Text nimmt ein verschlüsseltes Cookie mit, aber nur bei
   * einem Formular nachweislich von dieser Seite, damit niemand einen Entwurf
   * unterschieben kann. Passt er nicht hinein, zeigt die Seite ihn zum Kopieren.
   */
  async function expiredAction(req, res, path) {
    const form = await readForm(req, res);
    if (!form) return;
    const back = safeNext(form.get('back'));
    const loginHref = `/login?next=${encodeURIComponent(back)}`;
    const text = DRAFT_ACTIONS.has(path) ? (form.get('text') ?? '') : '';
    if (!text.trim()) return redirect(res, loginHref);
    const sameOrigin = req.headers.origin === new URL(publicUrl).origin || req.headers['sec-fetch-site'] === 'same-origin';
    if (sameOrigin && sessions.keepDraft(res, { action: path, back, text })) return redirect(res, loginHref);
    return send(res, 401, renderDraftRescue(text, loginHref));
  }

  /** Was die Seite zum Schreiben braucht; ohne `actions` bleibt sie lesend. */
  const writeContext = (req) => (actions ? { csrf: csrfOf(req), captureId: randomUUID(), notes: Boolean(notes), plan: Boolean(plan) } : null);

  async function page(req, res, url, session, { status = 200, flash = null, draft = null } = {}) {
    const id = url.searchParams.get('woche');
    const model = await cockpit.week(id || null);
    if (!model) return send(res, 400, renderMessage('Unbekannte Woche', `„${id}“ ist keine Kalenderwoche wie 2026-W42.`, { link: { href: '/', label: 'Zur laufenden Woche' } }));
    const back = url.pathname + url.search;
    const kept = draft === null && actions ? sessions.takeDraft(req, res, (d) => d.action === '/aktion/erfassen') : null;
    // Nur die laufende Woche darf der Service Worker für offline behalten, und nie mit einem Entwurf im Feld.
    const offline = !id && status === 200 && !kept && !draft ? { [OFFLINE_MARK]: 'woche' } : {};
    return send(res, status, renderWeek(model, { user: session.name ?? session.sub, write: writeContext(req), back, flash: flash ?? takeFlash(req, res) ?? (kept ? DRAFT_FLASH : null), draft: draft ?? kept?.text ?? null, focus: url.searchParams.has('erfassen') || Boolean(kept), alert: health ? healthAlert(health.failing()) : '' }), offline);
  }

  /** Zustand der Hintergrunddienste; Zunder und Kalender werden dabei frisch geprüft. */
  async function healthPage(req, res, session) {
    const services = await health.check();
    return send(res, 200, renderHealth(services, { tz: settings.get().tz, user: session.name ?? session.sub, now: now() }));
  }

  /** Was Notizseite und `/api/notiz` außer der Notiz zeigen: Ziele, Verwandte, Vorschläge, Belege. */
  async function noteExtras(note) {
    const related = notes.related?.(note.path) ?? null;
    return {
      targets: notes.targets(note.path),
      archive: notes.archiveFolder(),
      vaultName: settings.get().vaultName,
      related,
      graph: Boolean(graph),
      // Vorschläge zum Ablegen nur für Inbox-Notizen und nur, wenn die Seite schreiben darf.
      suggestions: actions && note.inInbox ? (notes.suggest?.(note.path, related) ?? null) : null,
      zunder: Boolean(actions && settings.get().zunder),
      evidence: evidence && note.frontmatter?.type === SYNTHESIS ? await evidence.suggest(note.path) : null,
    };
  }

  /** Notiz als JSON für die App (`/api/notiz?pfad=…`, siehe src/web/note-json.js). */
  async function noteApi(req, res, url) {
    const path = url.searchParams.get('pfad') ?? '';
    const note = notes.get(path);
    if (!note) return json(res, 404, { error: 'not_found', message: `„${path}“ gibt es nicht, oder sie liegt in einem vertraulichen oder ausgeschlossenen Ordner.` });
    return json(res, 200, noteJson(note, { write: Boolean(actions), ...(await noteExtras(note)) }));
  }

  /**
   * Zustand als JSON (`/api/zustand`): die Dienste wie auf `/zustand` (frisch geprüft),
   * `failing` wie `alert` in `/api/woche`, `checkedAt` der Stand.
   */
  async function healthApi() {
    const services = await health.check();
    return { checkedAt: new Date(now()).toISOString(), failing: services.filter((s) => s.state === 'error').map(({ id, name }) => ({ id, name })), services };
  }

  /** Notizseite `/notiz?pfad=…`: Vorschau und Verarbeiten. */
  async function notePage(req, res, url, session, { status = 200, flash = null, draft = null } = {}) {
    const path = url.searchParams.get('pfad') ?? '';
    const note = notes?.get(path);
    if (!note) {
      return send(res, 404, renderMessage('Notiz nicht verfügbar', `„${path}“ gibt es nicht, oder sie liegt in einem vertraulichen oder ausgeschlossenen Ordner.`, { link: { href: '/', label: 'Zur Woche' } }));
    }
    // Herkunft (Inbox, Graph …) wandert in die Adresse, damit sie Aktionen ohne JavaScript übersteht.
    const origin = noteOrigin(url.searchParams.get('zurueck'), req.headers.referer, new URL(publicUrl).origin);
    if (origin && !url.searchParams.has('zurueck')) url.searchParams.set('zurueck', origin.path);
    const back = url.pathname + url.search;
    const kept = draft === null && actions ? sessions.takeDraft(req, res, (d) => d.action === '/aktion/notiz/anhaengen' && d.back === back) : null;
    const html = renderNote(note, {
      origin,
      user: session.name ?? session.sub,
      write: actions ? writeContext(req) : null,
      back,
      flash: flash ?? takeFlash(req, res) ?? (kept ? DRAFT_FLASH : null),
      draft: draft ?? kept?.text ?? null,
      ...(await noteExtras(note)),
    });
    // Synthesen darf der Service Worker für offline behalten (VCP-80), aber nie mit einem Entwurf im Feld.
    const offline = status === 200 && !kept && !draft && note.path.startsWith(`${SYNTHESIS_FOLDER}/`) ? { [OFFLINE_MARK]: 'lesen' } : {};
    return send(res, status, html, offline);
  }

  /**
   * Bild aus dem Vault für die Notizseite (`/notiz/bild?pfad=…`): nur
   * angemeldet, nur Bildformate ohne SVG, nichts aus vertraulichen oder
   * ausgeschlossenen Ordnern, kein Symlink. Nie im Cache.
   */
  function noteImage(req, res, url) {
    const file = notes.openImage?.(url.searchParams.get('pfad'));
    if (!file) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      return res.end('Bild nicht verfügbar');
    }
    res.writeHead(200, {
      'content-type': file.type,
      'content-length': file.size,
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
      'content-disposition': 'inline',
      'cross-origin-resource-policy': 'same-origin',
    });
    if (req.method === 'HEAD') {
      closeSync(file.fd);
      return res.end();
    }
    createReadStream(null, { fd: file.fd }).on('error', () => res.destroy()).pipe(res);
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
    // Graph- und Lesen-Seiten rendern sich aus der Meldung im Cookie neu.
    if (url.pathname === '/graph' || READING_PAGES[url.pathname]) return redirect(res, back, [flashCookie(opts.flash)]);
    if (url.pathname === '/planen' && plan) return planPage(req, res, url, session, opts);
    return url.pathname === '/notiz' && notes ? notePage(req, res, url, session, opts) : page(req, res, url, session, opts);
  };
  /** Nach dem Verschieben gibt es die alte Notizseite nicht mehr. */
  /** Notizseite; `from` ist die bisherige Notizadresse, deren Herkunft (`zurueck`) mitgeht. */
  const notePageOf = (path, from = null) => {
    const zurueck = from ? new URL(from, publicUrl).searchParams.get('zurueck') : null;
    return `/notiz?pfad=${encodeURIComponent(path)}${zurueck ? `&zurueck=${encodeURIComponent(zurueck)}` : ''}`;
  };

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
    if (r.kind === 'article') return `${r.duplicate ? 'Schon im Lesestapel' : 'Im Lesestapel'}: ${r.title}`;
    if (r.kind === 'task') return `${r.duplicate ? 'Schon erfasst' : 'Aufgabe angelegt'}: ${r.ref ?? 'neue Aufgabe'} ${placement(r)}${r.notes?.length ? ` · ${r.notes.join(' ')}` : ''}`;
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
                const redirect = back.startsWith('/notiz') ? notePageOf(r.path, back) : null;
                const undo = r.changed && from ? { action: '/aktion/notiz/ablegen', fields: { pfad: r.path, ordner: from, back: redirect ? notePageOf(r.from, back) : back } } : null;
                return { message: r.changed ? `Abgelegt in ${folder}/` : `Liegt schon in ${folder}/`, path: r.path, from: r.from, folder, redirect, undo };
              },
              async '/aktion/notiz/tags'(form) {
                const r = notes.setTags(form.get('pfad'), form.get('tags'));
                return { message: r.tags.length ? `Tags: ${r.tags.map((t) => `#${t}`).join(' ')}` : 'Tags entfernt', path: r.path, tags: r.tags };
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
                return { message: r.changed ? `Verlinkt: ${r.title}` : `Schon verlinkt: ${r.title}`, path: r.path, target: r.target, title: r.title, changed: Boolean(r.changed) };
              },
              async '/aktion/feuer/anlegen'(form, session) {
                const r = notes.createFeuer(form.get('woche'), form.get('ziel'), form.get('zug'));
                logger.info?.(`Cockpit: ${r.path} angelegt (${session.sub})`);
                return { message: `${r.title} angelegt`, path: r.path };
              },
              async '/aktion/synthese/aufgaben'(form, session) {
                const note = notes.get(form.get('pfad'));
                if (note?.frontmatter.type !== SYNTHESIS) throw new ActionError('Diese Synthese gibt es nicht oder das Cockpit darf sie nicht zeigen', 404);
                const points = openPoints(note.body);
                if (!points.length) throw new ActionError('Die Synthese hat keine offenen Punkte');
                const r = await actions.synthesisTasks({ path: note.path, points });
                logger.info?.(`Cockpit: ${r.created} offene Punkte aus ${note.path} nach Zunder (${session.sub})`);
                const message = r.created ? `Nach Zunder: ${r.created} ${r.created === 1 ? 'Aufgabe' : 'Aufgaben'}${r.existing ? `, ${r.existing} schon dort` : ''}` : 'Alle offenen Punkte sind schon in Zunder';
                return { message, path: note.path, created: r.created, existing: r.existing ?? 0 };
              },
              ...(evidence ? evidenceRoutes(evidence, { logger }) : {}),
              async '/aktion/notiz/checkbox'(form) {
                const done = form.get('erledigt') === '1';
                const r = notes.toggle(form.get('pfad'), form.get('n'), form.get('line'), done);
                const undo = { action: '/aktion/notiz/checkbox', fields: { pfad: r.path, n: form.get('n'), line: r.line, erledigt: done ? '0' : '1' } };
                return { message: done ? 'Abgehakt' : 'Wieder offen', path: r.path, n: Number(form.get('n')), line: r.line, done, undo };
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
  Object.assign(ACTIONS, reading?.actions);

  /**
   * Alle Aktionen. Mit JavaScript als JSON, ohne als Formular mit
   * Weiterleitung; schlägt es ohne JavaScript fehl, kommt die Seite direkt mit
   * Fehlermeldung (und bei der Schnelleingabe dem eingegebenen Text) zurück,
   * damit nichts verloren geht.
   */
  async function action(req, res, path, session) {
    const wantsJson = String(req.headers.accept ?? '').includes('application/json');
    const form = await readForm(req, res, reading?.uploads?.[path]);
    if (!form) return;
    const back = safeNext(form.get('back'));
    if (!session.app && !csrfOk(req, form.get('csrf'))) {
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
    // `link`: Ziel zum Weitergehen in der Meldung (etwa die neue Source-Page nach dem Ingest), nur eigene Pfade.
    const flash = flashCookie({ kind: 'ok', message: body.message, undo: body.undo ?? null, link: body.link ?? null });
    // Muss die Seite wechseln (Notiz verschoben), kommt die Meldung per Cookie mit.
    if (wantsJson) {
      if (body.redirect && !session.app) res.appendHeader('set-cookie', flash);
      return json(res, 200, body);
    }
    return redirect(res, body.redirect ?? back, [flash]);
  }

  async function api(req, res, url) {
    const id = url.searchParams.get('woche');
    const model = await cockpit.week(id || null);
    if (!model) return json(res, 400, { error: 'invalid_week', error_description: 'Kalenderwoche wie 2026-W42 erwartet' });
    // `can`: was die Seite anbietet (Schreiben, Feuer-Notiz, Planen), wie `writeContext` für die HTML-Seite.
    // `alert`: gestörte Hintergrunddienste `[{ id, name }]` für den roten Hinweis „Störung“ (wie `healthAlert`).
    return json(res, 200, { ...model, can: { actions: Boolean(actions), notes: Boolean(notes), plan: Boolean(plan) }, alert: health ? health.failing() : [] });
  }

  /** Erreichbarkeit der Kalender in dieser Woche (`{ [id]: { ok, count } | { ok: false, error } }`). */
  async function calendarChecks() {
    if (!calendars || !settings.get().calendars.length) return {};
    const tz = settings.get().tz;
    const week = describeWeek(weekOf(new Date(now()), tz), tz);
    return calendars.check(week.start, week.end);
  }
  const captureOn = () => (typeof captureEnabled === 'function' ? captureEnabled() : captureEnabled);

  async function settingsPage(req, res, session, { status = 200, notice = null, error = null, created = null } = {}) {
    const checks = await calendarChecks();
    const html = renderSettings({
      stored: settings.stored(),
      defaults: settings.defaults(),
      checks,
      notice,
      error,
      tokens: tokens?.list() ?? null,
      created,
      shortcuts,
      captureEnabled: captureOn(),
      tz: settings.get().tz,
      user: session.name ?? session.sub,
      csrf: csrfOf(req),
      backup: backup?.status() ?? null,
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
        // Nur für die Fehlermeldung: welches Feld `cal.N.…` gemeint ist.
        formIndex: i,
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
      flameNote: { enabled: choice('flameNote.enabled') },
      readingNotes: { folder: field('readingNotes.folder') },
      mail: {
        token: form.get('mail.clear') ? null : field('mail.token') || stored.mail.token,
        senders: list('mail.senders'),
        mailbox: field('mail.mailbox'),
        doneMailbox: field('mail.doneMailbox'),
        pollMinutes: field('mail.pollMinutes'),
      },
      embed: { url: field('embed.url'), model: field('embed.model') },
      tts: {
        provider: TTS_PROVIDERS.includes(field('tts.provider')) ? field('tts.provider') : null,
        key: form.get('tts.clear') ? null : field('tts.key') || stored.tts?.key || null,
        voice: field('tts.voice'),
        model: field('tts.model'),
      },
      episodes: { host: field('episodes.host'), guest: field('episodes.guest'), model: field('episodes.model'), language: field('episodes.language') },
      ingest: { nightly: choice('ingest.nightly'), hour: field('ingest.hour'), model: field('ingest.model'), limit: field('ingest.limit'), agent: choice('ingest.agent') },
      calendars: calendarsIn,
      hiddenEvents: form.has('hiddenEvents') ? field('hiddenEvents').split(',') : stored.hiddenEvents,
      // Die Generation ändert nur „Überall abmelden“.
      session: { idleDays: field('session.idleDays'), maxDays: field('session.maxDays'), generation: stored.session.generation },
    };
  }

  // Zusätzlich zu SameSite=Lax: Formulare nur von dieser Seite annehmen.
  const foreignOrigin = (req) => req.headers.origin && req.headers.origin !== new URL(publicUrl).origin;

  /**
   * Formular lesen; `null`, wenn schon mit 403/413 geantwortet wurde. Mit
   * `uploadLimit` (nur Aktionen aus `reading.uploads`) auch `multipart/form-data`
   * bis zu dieser Größe, die Dateien dann in `form.files`.
   */
  async function readForm(req, res, uploadLimit = 0) {
    if (foreignOrigin(req)) {
      json(res, 403, { error: 'forbidden', error_description: 'fremde Herkunft' });
      return null;
    }
    if (uploadLimit && /^multipart\/form-data/i.test(req.headers['content-type'] ?? '')) {
      try {
        const { fields, files } = await readMultipart(req, { limit: uploadLimit });
        return Object.assign(fields, { files });
      } catch (err) {
        if (!(err instanceof FormError)) throw err;
        if (!res.destroyed) json(res, err.status, { error: 'bad_form', message: err.message });
        return null;
      }
    }
    try {
      return new URLSearchParams(await readBody(req));
    } catch (err) {
      if (!(err instanceof FormError)) json(res, 413, { error: 'too_large' });
      else if (!res.destroyed) json(res, err.status, { error: 'invalid_form', message: err.message });
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

  /** Sicherung als Datei; bei einem Fehler wieder die Seite mit Meldung. */
  async function downloadBackup(req, res, session) {
    const form = await readSettingsForm(req, res);
    if (!form) return;
    let file;
    try {
      file = await backup.create(form.get('passphrase') ?? '', { repeat: form.get('passphrase2') ?? '' });
    } catch (err) {
      if (err instanceof BackupError) return settingsPage(req, res, session, { status: 400, error: err.message });
      throw err;
    }
    logger.info?.(`Sicherung heruntergeladen von ${session.sub} (${file.files.join(', ')})`);
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="${file.filename}"`,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    return res.end(file.body);
  }

  /** Wiederherstellen; danach Neustart, damit alle Teile den neuen Stand lesen. */
  async function restoreBackup(req, res, session) {
    if (foreignOrigin(req)) return json(res, 403, { error: 'forbidden', error_description: 'fremde Herkunft' });
    let form;
    try {
      form = await readMultipart(req, { limit: MAX_BACKUP + 64 * 1024 });
    } catch (err) {
      if (!(err instanceof FormError)) throw err;
      return res.destroyed ? undefined : settingsPage(req, res, session, { status: err.status, error: err.message });
    }
    if (!csrfOk(req, form.fields.get('csrf'))) {
      return send(res, 403, renderMessage('Nicht wiederhergestellt', 'Die Seite ist veraltet. Bitte neu laden und noch einmal versuchen.', { link: { href: '/einstellungen', label: 'Neu laden' } }));
    }
    let result;
    try {
      result = await backup.restore(form.files.get('datei')?.data ?? null, form.fields.get('passphrase') ?? '', { replace: form.fields.get('ersetzen') === '1' });
    } catch (err) {
      if (err instanceof BackupError) return settingsPage(req, res, session, { status: 400, error: err.message });
      throw err;
    }
    logger.info?.(`Sicherung vom ${result.createdAt} wiederhergestellt von ${session.sub} (${result.files.join(', ')}), Neustart`);
    const msg = restoredMessage(result, settings.get().tz);
    res.once('finish', () => restart());
    // Mit dem Sitzungs-Secret der Sicherung gilt das Cookie nach dem Neustart ohnehin nicht mehr.
    const cookies = result.files.includes('session-secret') ? { 'set-cookie': [sessions.clear()] } : {};
    return send(res, 200, renderMessage(msg.title, msg.text, { link: msg.link }), cookies);
  }

  /** „Überall abmelden“: neue Generation, auch diese Sitzung endet. */
  async function revokeSessions(req, res, session) {
    const form = await readSettingsForm(req, res);
    if (!form) return;
    sessions.revokeAll();
    logger.info?.(`Cockpit: alle Sitzungen beendet von ${session.sub}`);
    res.appendHeader('set-cookie', sessions.clear());
    return send(res, 200, renderMessage('Überall abgemeldet', 'Die Anmeldung ist auf allen Geräten beendet, auch hier.', { link: { href: '/login?next=%2Feinstellungen', label: 'Neu anmelden' } }));
  }

  /*
   * Einstellungen, Tokens, Sicherung und Kurzbefehle als JSON für die native App
   * (src/web/settings-json.js), mit Geräte-Token oder Sitzung. Antworten
   * `{ ok, message, … }`, Fehler `{ error, message, field? }`; mit Sitzung braucht
   * jedes POST das CSRF-Token wie die Seite. Geheimnisse gehen nie hinaus.
   */
  const unauthorized = (res) => json(res, 401, { error: 'unauthorized', message: 'Die Anmeldung ist abgelaufen. Bitte neu anmelden.' });
  const invalid = (res, err, status = 400) => json(res, status, { error: 'invalid', message: err.message, ...(err.field ? { field: err.field } : {}) });

  /** Formular einer JSON-Schreibroute; `null`, wenn schon geantwortet wurde (fremde Herkunft, zu groß, CSRF). */
  async function readApiForm(req, res, session) {
    const form = await readForm(req, res);
    if (!form) return null;
    if (!session.app && !csrfOk(req, form.get('csrf'))) {
      json(res, 403, { error: 'csrf', message: 'Die Seite ist veraltet. Bitte neu laden und noch einmal versuchen.' });
      return null;
    }
    return form;
  }

  /** `GET /api/einstellungen`: alles, was die Einstellungsseite zeigt (Felder, Stände, Kalender, Tokens, Kurzbefehle, Sicherung). */
  async function settingsApi(req, res, url, session) {
    return json(res, 200, settingsJson({
      stored: settings.stored(),
      defaults: settings.defaults(),
      checks: await calendarChecks(),
      tokens: tokens?.list() ?? null,
      currentToken: session.tokenId ?? null,
      shortcuts,
      captureEnabled: captureOn(),
      backup: backup?.status() ?? null,
    }));
  }

  /**
   * `POST /api/einstellungen`: Felder wie das HTML-Formular (`fromForm`). Was fehlt, bleibt
   * wie gespeichert; leere Geheimnisfelder behalten den Wert, `….clear=1` löscht ihn.
   */
  async function saveSettingsApi(req, res, url, session) {
    const form = await readApiForm(req, res, session);
    if (!form) return;
    try {
      settings.save(fromForm(mergeSettingsForm(settings.stored(), form)));
    } catch (err) {
      if (err instanceof SettingsError) return invalid(res, err);
      throw err;
    }
    logger.info?.(`Cockpit-Einstellungen gespeichert von ${session.sub}`);
    return json(res, 200, { ok: true, message: 'Gespeichert.' });
  }

  /** `POST /api/einstellungen/abmelden`: „Überall abmelden“ (alle Sitzungs-Cookies); Geräte-Tokens bleiben. */
  async function revokeSessionsApi(req, res, url, session) {
    const form = await readApiForm(req, res, session);
    if (!form) return;
    sessions.revokeAll();
    logger.info?.(`Cockpit: alle Sitzungen beendet von ${session.sub}`);
    if (!session.app) res.appendHeader('set-cookie', sessions.clear());
    return json(res, 200, { ok: true, message: 'Überall abgemeldet: Die Anmeldung im Browser ist auf allen Geräten beendet. Geräte-Tokens der App bleiben gültig.' });
  }

  const tokenList = (session) => ({ tokens: tokensJson(tokens.list(), session.tokenId ?? null), scopes: scopesJson() });

  /** `POST /api/einstellungen/tokens` `{ name, scope }`: der Klartext steht nur in dieser Antwort. */
  async function createTokenApi(req, res, url, session) {
    const form = await readApiForm(req, res, session);
    if (!form) return;
    let created;
    try {
      created = tokens.create(form.get('name'), form.get('scope') || 'search');
    } catch (err) {
      if (err instanceof SettingsError) return invalid(res, err);
      throw err;
    }
    logger.info?.(`API-Token „${created.name}“ angelegt von ${session.sub}`);
    const entry = tokens.list().find((t) => t.id === created.id);
    const label = SCOPE_LABELS[created.scope] ?? created.scope;
    return json(res, 200, {
      ok: true,
      message: `${label}-Token „${created.name}“ angelegt. Jetzt kopieren, er wird nicht noch einmal angezeigt.`,
      token: { token: created.token, id: created.id, name: created.name, scope: created.scope, scopeLabel: label, createdAt: entry?.createdAt ?? null },
      ...tokenList(session),
    });
  }

  /** `POST /api/einstellungen/tokens/widerrufen` `{ id }`; `self`: der Geräte-Token dieser Anfrage, danach gilt er nicht mehr. */
  async function revokeTokenApi(req, res, url, session) {
    const form = await readApiForm(req, res, session);
    if (!form) return;
    const id = form.get('id') ?? '';
    if (!tokens.revoke(id)) return json(res, 404, { error: 'not_found', message: 'Diesen Token gibt es nicht mehr.' });
    logger.info?.(`API-Token widerrufen von ${session.sub}`);
    return json(res, 200, { ok: true, message: 'Token widerrufen.', id, self: id === session.tokenId, ...tokenList(session) });
  }

  /** `POST /api/einstellungen/sicherung` `{ passphrase, passphrase2 }`: die verschlüsselte Sicherung als Datei. */
  async function backupApi(req, res, url, session) {
    const form = await readApiForm(req, res, session);
    if (!form) return;
    const passphrase = form.get('passphrase') ?? '';
    let file;
    try {
      try {
        checkPassphrase(passphrase);
      } catch (err) {
        if (err instanceof BackupError) err.field = 'passphrase';
        throw err;
      }
      if (passphrase !== (form.get('passphrase2') ?? '')) throw Object.assign(new BackupError('Die beiden Passphrasen stimmen nicht überein'), { field: 'passphrase2' });
      file = await backup.create(passphrase, { repeat: form.get('passphrase2') ?? '' });
    } catch (err) {
      if (err instanceof BackupError) return invalid(res, err);
      throw err;
    }
    logger.info?.(`Sicherung heruntergeladen von ${session.sub} (${file.files.join(', ')})`);
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="${file.filename}"`,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    return res.end(file.body);
  }

  /**
   * `POST /api/einstellungen/sicherung/wiederherstellen` (multipart: `datei`, `passphrase`,
   * `ersetzen=1`): wie die Seite, Antwort als JSON, danach Neustart. `relogin`: Das
   * Sitzungs-Secret kam mit, Cookies gelten nicht mehr; `tokensReplaced`: Die API-Tokens kamen
   * mit, der Geräte-Token gilt nach dem Neustart nur, wenn er in der Sicherung stand.
   */
  async function restoreBackupApi(req, res, url, session) {
    if (foreignOrigin(req)) return json(res, 403, { error: 'forbidden', error_description: 'fremde Herkunft' });
    let form;
    try {
      form = await readMultipart(req, { limit: MAX_BACKUP + 64 * 1024 });
    } catch (err) {
      if (!(err instanceof FormError)) throw err;
      return res.destroyed ? undefined : json(res, err.status, { error: 'bad_form', message: err.message });
    }
    if (!session.app && !csrfOk(req, form.fields.get('csrf'))) return json(res, 403, { error: 'csrf', message: 'Die Seite ist veraltet. Bitte neu laden und noch einmal versuchen.' });
    let result;
    try {
      result = await backup.restore(form.files.get('datei')?.data ?? null, form.fields.get('passphrase') ?? '', { replace: form.fields.get('ersetzen') === '1' });
    } catch (err) {
      if (err instanceof BackupError) return invalid(res, err);
      throw err;
    }
    logger.info?.(`Sicherung vom ${result.createdAt} wiederhergestellt von ${session.sub} (${result.files.join(', ')}), Neustart`);
    const msg = restoredMessage(result, settings.get().tz);
    const relogin = result.files.includes('session-secret');
    res.once('finish', () => restart());
    if (relogin && !session.app) res.appendHeader('set-cookie', sessions.clear());
    return json(res, 200, { ok: true, message: msg.text, title: msg.title, createdAt: result.createdAt, files: result.files, skipped: result.skipped, restart: true, relogin, tokensReplaced: result.files.includes('api-tokens.json') });
  }

  /** Pfad → Methode → Handler; alle nur angemeldet (Sitzung oder Geräte-Token). */
  const SETTINGS_API = {
    '/api/einstellungen': { GET: settingsApi, POST: saveSettingsApi },
    '/api/einstellungen/abmelden': { POST: revokeSessionsApi },
    '/api/einstellungen/kurzbefehle': { GET: (req, res) => json(res, 200, { shortcuts: shortcutsJson(shortcuts), captureEnabled: captureOn(), intro: shortcutsIntro(captureOn()) }) },
    ...(tokens
      ? {
          '/api/einstellungen/tokens': { GET: (req, res, url, session) => json(res, 200, tokenList(session)), POST: createTokenApi },
          '/api/einstellungen/tokens/widerrufen': { POST: revokeTokenApi },
        }
      : {}),
    ...(backup
      ? {
          '/api/einstellungen/sicherung': { GET: (req, res) => json(res, 200, backupJson(backup.status())), POST: backupApi },
          '/api/einstellungen/sicherung/wiederherstellen': { POST: restoreBackupApi },
        }
      : {}),
  };

  async function graphPage(req, res, url, session) {
    const path = url.searchParams.get('pfad');
    const user = session.name ?? session.sub;
    if (!path) {
      const q = (url.searchParams.get('q') ?? '').trim().slice(0, 500);
      const result = q && search ? await search(q) : { results: [], total: 0 };
      return send(res, 200, renderSearch(q, result, { user, notes: Boolean(notes), whole: Boolean(wholeGraph) }));
    }
    const g = graph ? await graph.around(path) : null;
    if (!g) return send(res, 404, renderMessage('Notiz nicht gefunden', `„${path}“ gibt es nicht im Index.`, { link: { href: '/graph', label: 'Zur Suche' } }));
    const { vaultName, tz } = settings.get();
    return send(res, 200, renderGraph(g, { vaultName, user, tz, write: writeContext(req), back: url.pathname + url.search, flash: takeFlash(req, res), notes: Boolean(notes), whole: Boolean(wholeGraph) }));
  }

  /**
   * Ganzer Vault (VCP-40): Knoten mit vorberechneten Positionen. Der Stand
   * ändert sich nur mit dem Index, deshalb ETag (304 ohne Daten) und gzip,
   * wenn der Browser es kann; ein paar tausend Notizen gehen so in wenigen
   * hundert Kilobyte übers Netz.
   */
  async function wholeGraphApi(req, res) {
    const s = await wholeGraph.get();
    const head = { 'content-type': 'application/json', 'cache-control': 'private, no-cache', etag: s.etag, vary: 'accept-encoding', 'x-content-type-options': 'nosniff' };
    if (String(req.headers['if-none-match'] ?? '').split(/,\s*/).includes(s.etag)) {
      res.writeHead(304, head);
      return res.end();
    }
    const gzip = /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''));
    res.writeHead(200, { ...head, ...(gzip ? { 'content-encoding': 'gzip' } : {}) });
    return res.end(gzip ? s.gzip : s.body);
  }

  /**
   * Live-Suche: die besten Treffer, knapp; `type` filtert nach Frontmatter-`type` (z. B. `synthesis`).
   * Mit `alle=1` alle Treffer wie auf der Suchseite (`/graph?q=…`); `notes` sagt, ob ein Treffer
   * die Notiz öffnet (sonst den Graphen).
   */
  async function searchApi(req, res, url) {
    const q = (url.searchParams.get('q') ?? '').trim().slice(0, 500);
    const all = url.searchParams.get('alle') === '1';
    if (!q || !search) return json(res, 200, { query: q, results: [], total: 0, degraded: null, notes: Boolean(notes) });
    const r = await search(q, { type: url.searchParams.get('type') || null });
    const results = (all ? r.results : r.results.slice(0, 8)).map((x) => ({ path: x.path, title: x.title ?? x.path, snippet: x.snippet ?? null, streams: x.streams ?? [] }));
    return json(res, 200, { query: q, results, total: r.total, degraded: r.degraded ?? null, notes: Boolean(notes) });
  }

  /** Vorschau der Schnelleingabe („Aufgabe · morgen · Gesundheit“), dieselbe Logik wie beim Anlegen. */
  async function capturePreviewApi(req, res, url) {
    try {
      return json(res, 200, await actions.previewCapture(url.searchParams.get('text') ?? ''));
    } catch (err) {
      if (!(err instanceof ActionError)) throw err;
      return json(res, err.status, { error: 'preview_failed', message: err.message });
    }
  }

  async function graphApi(req, res, url) {
    const g = graph ? await graph.around(url.searchParams.get('pfad') ?? '') : null;
    if (!g) return json(res, 404, { error: 'not_found', error_description: 'Notiz nicht im Index' });
    return json(res, 200, graphJson(g, { vaultName: settings.get().vaultName, link: Boolean(actions && notes), notes: Boolean(notes) }));
  }

  /** Seite aus dem Bereich Lesen (src/lesen/http.js). */
  async function readingPage(req, res, url, session) {
    const r = await READING_PAGES[url.pathname]({ url, range: req.headers.range ?? null, user: session.name ?? session.sub, tz: settings.get().tz, write: { csrf: csrfOf(req), back: url.pathname + url.search }, flash: takeFlash(req, res), nav: reading.nav ?? null });
    if (r.redirect) return redirect(res, r.redirect);
    // Leseansicht und Stapel darf der Service Worker für offline behalten (VCP-80); welche Artikel, sagt `/api/lesen/offline`.
    const offline = r.html && (r.status ?? 200) === 200 && (url.pathname === '/lesen/doc' || (url.pathname === '/lesen/stapel' && !url.search)) ? { [OFFLINE_MARK]: 'lesen' } : {};
    return send(res, r.status ?? 200, r.html ?? r.body, { ...r.headers, ...offline });
  }

  const TOKEN_ROUTES = { '/einstellungen/tokens': createToken, '/einstellungen/tokens/widerrufen': revokeToken };
  const BACKUP_ROUTES = backup ? { '/einstellungen/sicherung': downloadBackup, '/einstellungen/sicherung/wiederherstellen': restoreBackup } : {};
  const ACTION_ROUTES = new Set(Object.keys(ACTIONS));
  const SHORTCUT_ROUTES = new Map(shortcuts.map((s) => [`/kurzbefehle/${s.slug}.shortcut`, s]));
  const ROUTES = new Set([...ACTION_ROUTES, ...SHORTCUT_ROUTES.keys(), ...Object.keys(SETTINGS_API), ...PUBLIC.keys(), '/', '/api/woche', '/api/rueckblick', ...(plan ? ['/api/planen'] : []), '/api/sitzung', '/api/suche', ...(actions ? ['/api/erfassen/vorschau'] : []), '/rueckblick', ...(notes ? ['/notiz', '/notiz/bild'] : []), ...(plan ? ['/planen'] : []), '/graph', '/api/graph', ...(wholeGraph ? ['/graph/alles', '/api/graph/alles'] : []), ...Object.keys(READING_PAGES), '/einstellungen', ...(health ? ['/zustand'] : []), ...(tokens ? Object.keys(TOKEN_ROUTES) : []), ...Object.keys(BACKUP_ROUTES), '/einstellungen/abmelden', '/login', '/auth/callback', '/logout']);
  if (notes) for (const p of ['/wissen', '/api/wissen', '/api/notiz']) ROUTES.add(p);
  if (health) ROUTES.add('/api/zustand');
  if (notes || reading) ROUTES.add('/api/lesen/offline');
  for (const p of appAccess ? [...appAccess.paths, SITE_ASSOCIATION_PATH, APP_CALLBACK_PATH] : []) ROUTES.add(p);
  if (reading?.shared) ROUTES.add(reading.shared.path);

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
          ...file.headers,
        });
        return res.end(file.body);
      }
      // Ohne Anmeldung: Einmal-Link eines Transkripts; der Token im Link ist der Schlüssel, HEAD verbraucht ihn nicht.
      if (reading?.shared && path === reading.shared.path && method === 'GET') {
        const r = await reading.shared.get(url.searchParams.get('t'), { consume: req.method === 'GET' });
        res.writeHead(r.status, r.headers);
        return res.end(r.body);
      }
      // Ohne Anmeldung: Apple holt die Datei für Universal Links; `/app/angemeldet` sieht nur, wer den Link im Browser öffnet, der Code darin bleibt unbenutzt.
      if (appAccess && method === 'GET' && path === SITE_ASSOCIATION_PATH) return json(res, 200, appAccess.siteAssociation);
      if (appAccess && method === 'GET' && path === APP_CALLBACK_PATH) return send(res, 200, renderMessage('Zurück zur App …', 'Die Anmeldung ist fertig. Die Cockpit-App übernimmt sie, dieses Fenster kann zu.'));
      if (path === '/login' && method === 'GET') return login(req, res, url);
      if (path === '/auth/callback' && method === 'GET') return callback(req, res, url);
      // Mit Geräte-Token statt Sitzung (src/web/app-access.js).
      if (appAccess?.paths.includes(path)) return appAccess.handle(req, res, url);
      if (path === '/logout' && method === 'POST') {
        return redirect(res, '/login', [sessions.clear()]);
      }
      const cookieSession = sessionOf(req);
      if (cookieSession) sessions.renew(res, cookieSession);
      // Schickt die App ihren Geräte-Token, gilt er, auch wenn ein Cookie mitkommt: Sonst
      // verlangten die Aktionen ein CSRF-Token, das die App nicht hat.
      const session = appSessionOf(req, path) ?? cookieSession;
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
          return expiredAction(req, res, path);
        }
        return action(req, res, path, session);
      }
      if (SETTINGS_API[path]) {
        if (!session) return unauthorized(res);
        const run = SETTINGS_API[path][method];
        if (!run) return json(res, 405, { error: 'method_not_allowed' });
        return run(req, res, url, session);
      }
      if (path === '/einstellungen/abmelden') {
        if (!session) return redirect(res, '/login?next=%2Feinstellungen');
        if (method === 'POST') return revokeSessions(req, res, session);
        return redirect(res, '/einstellungen');
      }
      if (tokens && TOKEN_ROUTES[path]) {
        if (!session) return redirect(res, '/login?next=%2Feinstellungen');
        if (method === 'POST') return TOKEN_ROUTES[path](req, res, session);
        return redirect(res, '/einstellungen');
      }
      if (BACKUP_ROUTES[path]) {
        if (!session) return redirect(res, '/login?next=%2Feinstellungen');
        if (method === 'POST') return BACKUP_ROUTES[path](req, res, session);
        return redirect(res, '/einstellungen#sicherung');
      }
      if (method !== 'GET') return json(res, 405, { error: 'method_not_allowed' });

      if (SHORTCUT_ROUTES.has(path)) {
        // Die App lädt mit Geräte-Token; ein abgelehnter Token bekommt 401 statt der Login-Seite.
        if (!session && /^Bearer /.test(String(req.headers.authorization ?? ''))) return unauthorized(res);
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
      if (path === '/api/rueckblick' || (path === '/api/planen' && plan)) {
        if (!session) return json(res, 401, { error: 'unauthorized', error_description: 'Anmeldung unter /login nötig' });
        const id = url.searchParams.get('woche') || null;
        const p = (k) => url.searchParams.get(k) ?? '';
        const model = path === '/api/planen' ? await plan.view(id, { q: p('q'), area: p('bereich'), from: p('aus') }) : await cockpit.review?.(id);
        if (!model) return json(res, 400, { error: 'invalid_week', error_description: 'Kalenderwoche wie 2026-W42 erwartet' });
        return json(res, 200, model);
      }
      if (path === '/api/graph') {
        if (!session) return json(res, 401, { error: 'unauthorized', error_description: 'Anmeldung unter /login nötig' });
        return graphApi(req, res, url);
      }
      if (path === '/api/graph/alles' && wholeGraph) {
        if (!session) return json(res, 401, { error: 'unauthorized', error_description: 'Anmeldung unter /login nötig' });
        return wholeGraphApi(req, res);
      }
      if (path === '/api/sitzung') {
        if (!session) return json(res, 401, { error: 'unauthorized', message: 'Die Anmeldung ist abgelaufen. Bitte neu anmelden.' });
        return json(res, 200, { ok: true, csrf: csrfOf(req) });
      }
      if (path === '/api/lesen/offline') {
        if (!session) return json(res, 401, { error: 'unauthorized', message: 'Die Anmeldung ist abgelaufen. Bitte neu anmelden.' });
        return json(res, 200, { ok: true, urls: readingOfflineUrls({ reading, notes }) });
      }
      if (path === '/api/suche') {
        if (!session) return json(res, 401, { error: 'unauthorized', error_description: 'Anmeldung unter /login nötig' });
        return searchApi(req, res, url);
      }
      if (path === '/api/erfassen/vorschau') {
        if (!session) return json(res, 401, { error: 'unauthorized', error_description: 'Anmeldung unter /login nötig' });
        return capturePreviewApi(req, res, url);
      }
      if (path === '/notiz/bild') {
        if (!session) {
          res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
          return res.end('Anmeldung nötig');
        }
        return noteImage(req, res, url);
      }
      // JSON aus dem Bereich Lesen (`/api/lesen/…`): ohne Sitzung 401 statt Login-Seite.
      if (!session && path.startsWith('/api/')) return json(res, 401, { error: 'unauthorized', message: 'Die Anmeldung ist abgelaufen. Bitte neu anmelden.' });
      // JSON für die App: Notiz, Wissen, Zustand (dieselben Daten wie die Seiten).
      if (path === '/api/notiz') return noteApi(req, res, url);
      if (path === '/api/wissen') return json(res, 200, await wissenView({ notes, search, evidence }, wissenQuery(url)));
      if (path === '/api/zustand') return json(res, 200, await healthApi());
      if (!session) return redirect(res, `/login?next=${encodeURIComponent(url.pathname + url.search)}`);
      if (path === '/graph') return graphPage(req, res, url, session);
      if (path === '/graph/alles' && wholeGraph) return send(res, 200, renderWholeGraph({ user: session.name ?? session.sub, notes: Boolean(notes), focus: url.searchParams.get('pfad') || null }));
      if (READING_PAGES[path]) return readingPage(req, res, url, session);
      if (path === '/notiz') return notePage(req, res, url, session);
      if (path === '/wissen') return send(res, 200, await wissenPage({ notes, search, evidence, url, user: session.name ?? session.sub, nav: reading?.nav ?? null }), url.search ? {} : { [OFFLINE_MARK]: 'lesen' });
      if (path === '/rueckblick') return reviewPage(req, res, url, session);
      if (path === '/planen' && plan) return planPage(req, res, url, session);
      if (path === '/zustand' && health) return healthPage(req, res, session);
      return page(req, res, url, session);
    },
  };
}
