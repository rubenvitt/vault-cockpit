import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { head, appHeader, assets } from './layout.js';
import { captureBar } from './render.js';
import { SYNTHESIS } from './synthesis-render.js';

/**
 * Offline-Betrieb des Web-Cockpits (VCP-46): Service Worker unter `/sw.js`,
 * App-Hülle unter `/offline` und die Regeln, was auf dem Gerät gespeichert
 * werden darf.
 *
 * - Die App-Hülle (Stylesheet, Skripte, Manifest, Icons und `/offline`) legt
 *   der Service Worker beim Installieren in einen Cache, dessen Name den
 *   Inhalts-Hash aller dieser Dateien trägt. Ändert ein Deploy eine davon,
 *   ändert sich `/sw.js`, der Browser installiert die neue Fassung, und die
 *   alte Hülle wird gelöscht.
 * - Von den Seiten mit Inhalten speichert er nur die Wochenansicht der
 *   laufenden Woche, und nur, wenn der Server sie mit `OFFLINE_MARK`
 *   kennzeichnet. Notizvorschau, Suche, Graph, Rückblick, Einstellungen und
 *   alle `/api/…`-Antworten bleiben ungespeichert, damit keine Notizinhalte
 *   auf dem Gerät liegen.
 * - Lesestoff (VCP-80): die nächsten `OFFLINE_DOCS` Artikel des Stapels, die
 *   Synthesen in `SYNTHESIS_FOLDER` (höchstens `OFFLINE_SYNTHESES`) und die
 *   Listen `/lesen/stapel` und `/wissen`. Welche genau, sagt allein
 *   `/api/lesen/offline` (`readingOfflineUrls`); der Service Worker speichert
 *   davon nur, was der Server mit `OFFLINE_MARK: lesen` ausliefert. Vertrauliche
 *   und ausgeschlossene Notizen kommen nie in die Liste (`notes.ofType`).
 * - Ohne Netz zeigt er die gespeicherte Woche bzw. Leseseite mit „offline,
 *   Stand von …“, sonst die App-Hülle. Die Schnelleingabe und die Aktionen der
 *   Leseansicht puffern dann in IndexedDB (`/static/offline.js`) und senden nach.
 */

/** Antwort-Header, mit dem der Server eine Seite für den Offline-Cache freigibt. */
export const OFFLINE_MARK = 'x-cockpit-offline';

/** Ordner der Synthesen; nur Notizen darunter dürfen offline liegen. */
export const SYNTHESIS_FOLDER = 'wiki/synthesis';
export const OFFLINE_DOCS = 30;
export const OFFLINE_SYNTHESES = 200;

/**
 * Was offline liegen darf, als Liste von Seiten für `/api/lesen/offline`.
 * `reading` sind die Routen aus src/lesen/http.js, `notes` der Schreibtisch
 * (src/cockpit/notes.js); fehlt eins, fehlt sein Teil. Synthesen: nur
 * `type: synthesis` in `SYNTHESIS_FOLDER`, zuletzt bewegte zuerst.
 */
export function readingOfflineUrls({ reading = null, notes = null }) {
  const syntheses = (notes?.ofType(SYNTHESIS) ?? [])
    .filter((n) => n.path.startsWith(`${SYNTHESIS_FOLDER}/`))
    .sort((a, b) => String(b.updated ?? '').localeCompare(String(a.updated ?? '')))
    .slice(0, OFFLINE_SYNTHESES);
  return [
    ...(reading ? ['/lesen/stapel', ...reading.offlineDocs(OFFLINE_DOCS)] : []),
    ...(notes ? ['/wissen', ...syntheses.map((n) => `/notiz?pfad=${encodeURIComponent(n.path)}`)] : []),
  ];
}

const SW_SOURCE = readFileSync(new URL('./static/sw.js', import.meta.url), 'utf8');

/** Feste Dateien der App-Hülle; Stylesheet und Skripte kommen mit Versions-Parameter aus `assets`. */
const SHELL_FILES = ['/manifest.webmanifest', '/static/icon.svg', ...['icon-192', 'icon-512', 'icon-maskable-512', 'apple-touch-icon'].map((n) => `/static/icons/${n}.png`)];

/** CSP für das Script des Service Workers: Er darf nur die eigene Herkunft abrufen. */
const SW_CSP = "default-src 'none'; connect-src 'self'";

/**
 * Seite, die der Service Worker zeigt, wenn eine Seite ohne Netz nicht im
 * Cache liegt. Ohne Nutzerdaten (gilt für jeden, liegt im Cache), aber mit
 * Schnelleingabe; CSRF-Token und Erfassungs-ID fehlen absichtlich, der Puffer
 * holt sich beim Nachsenden ein frisches Token.
 */
export function renderOfflinePage() {
  return `<!doctype html>
<html lang="de">
${head('Offline', { script: true })}
<body class="page-week page-offline">
${appHeader({ current: 'woche' })}
<div class="capture-wrap">${captureBar({ write: { csrf: '', captureId: '' }, back: '/' }, null)}</div>
<main>
<section class="offline-shell">
  <h2>Offline</h2>
  <p>Das Cockpit ist gerade nicht erreichbar, und diese Seite liegt nicht auf dem Gerät.</p>
  <p>Die Schnelleingabe geht trotzdem: Notizen und Aufgaben mit <code>!</code> warten auf dem Gerät und gehen raus, sobald wieder Netz da ist.</p>
  <p>Artikel vom Stapel und Synthesen liegen auch auf dem Gerät, sofern sie schon geladen wurden.</p>
  <p><a href="/" class="btn">Zur gespeicherten Woche</a> <a href="/lesen/stapel" class="btn quiet">Zum Stapel</a> <a href="/wissen" class="btn quiet">Zu den Synthesen</a></p>
</section>
</main>
<div class="toasts" aria-live="polite"></div>
</body>
</html>`;
}

/**
 * `/sw.js` und `/offline` für die Tabelle der öffentlichen Dateien.
 * `files` ist diese Tabelle (Pfad → `{ body }`), `html` die Header der
 * HTML-Seiten (CSP). Der Versions-Hash läuft über den Service Worker selbst
 * und über alles, was er vorab speichert.
 */
export function offlineFiles(files, { html }) {
  const page = renderOfflinePage();
  const shell = [assets.css, assets.js, assets.offline, assets.lesenDoc, assets.lesenLinks, ...SHELL_FILES].map((path) => {
    const file = files.get(path.split('?')[0]);
    if (!file) throw new Error(`App-Hülle: ${path} fehlt`);
    return [path, file.body];
  });
  shell.push(['/offline', page]);
  const h = createHash('sha256').update(SW_SOURCE);
  for (const [path, body] of shell) h.update(`\0${path}\0`).update(body);
  const version = h.digest('base64url').slice(0, 10);
  const config = { version, shell: shell.map(([path]) => path), mark: OFFLINE_MARK, synthesis: SYNTHESIS_FOLDER };
  return {
    version,
    entries: [
      ['/sw.js', {
        type: 'text/javascript; charset=utf-8',
        body: `self.CONFIG = ${JSON.stringify(config)};\n${SW_SOURCE}`,
        // Nie aus dem HTTP-Cache: Nur so sieht der Browser nach einem Deploy die neue Fassung.
        headers: { 'cache-control': 'no-cache', 'content-security-policy': SW_CSP, 'service-worker-allowed': '/' },
      }],
      ['/offline', { type: html['content-type'], body: page, headers: { ...html, 'cache-control': 'no-cache' } }],
    ],
  };
}

/** Banner, Puffer-Zähler und gesperrte Formulare ohne Netz (`/static/offline.js`). */
export const OFFLINE_CSS = `
/* --- Offline --- */
.offline-bar { display: flex; flex-wrap: wrap; align-items: center; gap: var(--s-2) var(--s-3); margin: 0; padding: var(--s-3) var(--s-4);
  border-radius: var(--r-md); background: var(--warn-soft); border-left: 3px solid var(--warn); color: var(--text); }
.offline-bar.back { background: var(--ok-soft); border-left-color: var(--ok); }
.offline-bar-text { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.offline-bar-text strong { font-weight: 650; }
.puffer { background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-lg); box-shadow: var(--shadow-1); padding: var(--s-3) var(--s-4); }
.puffer > summary { cursor: pointer; font-weight: 600; }
.puffer > summary::marker { color: var(--text-3); }
.puffer .puffer-failed { color: var(--danger); }
.puffer-login { margin: var(--s-2) 0 0; color: var(--warn); }
.puffer-login a { color: var(--accent); }
.puffer ul { margin-top: var(--s-2); }
.puffer li { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: start; gap: 2px var(--s-2); padding: 6px 0; border-top: 1px solid var(--line); }
.puffer-text { overflow-wrap: anywhere; white-space: pre-line; padding-top: 3px; }
.puffer-item-actions { display: flex; gap: 6px; }
.puffer li .meta { grid-column: 1 / -1; font-size: var(--t-xs); }
.puffer li.failed .meta { color: var(--danger); }
.puffer-actions { display: flex; gap: 6px; margin-top: var(--s-2); }
html.is-offline form.offline-off, html.is-offline .menu-button { opacity: .4; pointer-events: none; }
.offline-shell p { margin: 0 0 var(--s-3); max-width: 60ch; }
`;
