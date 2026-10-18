/**
 * Gemeinsamer Rahmen aller Cockpit-Seiten: `<head>` (Stylesheet mit
 * Versions-Parameter, PWA-Manifest, Icons) und die Kopfzeile mit Navigation,
 * die auf dem iPhone als Leiste unten erscheint.
 */

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/**
 * Adressen der eigenen Dateien. `createWebHttp` hängt beim Start einen
 * Inhalts-Hash an, damit nach einem Deploy kein altes CSS aus dem Cache kommt.
 */
export const assets = { css: '/static/cockpit.css', js: '/static/cockpit.js', graph: '/static/graph.js', graphLib: '/static/vendor/graph-lib.js' };

export function versionAssets(versions) {
  for (const [key, v] of Object.entries(versions)) if (v && assets[key]) assets[key] = `${assets[key].split('?')[0]}?v=${v}`;
}

/** Farbe der Statusleiste, passend zu `--bg` in cockpit.css. */
export const THEME = { light: '#f7f5f1', dark: '#141311' };

/** `script` lädt `/static/cockpit.js`, `scripts` weitere eigene Dateien (z. B. den Graphen). */
export function head(title, { script = false, scripts = [] } = {}) {
  return `<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(title)} · Cockpit</title>
<meta name="theme-color" content="${THEME.light}" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="${THEME.dark}" media="(prefers-color-scheme: dark)">
<meta name="color-scheme" content="light dark">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Cockpit">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="icon" href="/static/icon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/static/icons/apple-touch-icon.png">
<link rel="stylesheet" href="${esc(assets.css)}">
${script ? `<script src="${esc(assets.js)}" defer></script>` : ''}
${scripts.map((src) => `<script src="${esc(src)}" defer></script>`).join('\n')}
</head>`;
}

const svg = (path, cls = '') => `<svg viewBox="0 0 24 24" class="icon${cls ? ` ${cls}` : ''}" aria-hidden="true">${path}</svg>`;

export const ICONS = {
  flame: '<path class="fill" d="M12 2C12 2 6 8 6 14a6 6 0 0 0 12 0c0-2.6-1.2-4.6-2.6-6.2-.3 1.6-1.1 2.6-2.2 3.1C13.6 8.4 13.2 5 12 2z"/><path class="fill core" d="M12 11s-3 3-3 5.5a3 3 0 0 0 6 0c0-2-1.6-3.6-3-5.5z"/>',
  week: '<rect x="3.5" y="5" width="17" height="15" rx="3"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
  review: '<path d="M4 20V10M10 20V4M16 20v-7M21 20H3"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M5.5 18.5l1.7-1.7M16.8 7.2l1.7-1.7"/>',
  logout: '<path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4M10 16l-4-4 4-4M6 12h10"/>',
};
export const icon = (name, cls) => svg(ICONS[name], cls);

const NAV = [
  ['woche', '/', 'Woche', 'week'],
  ['rueckblick', '/rueckblick', 'Rückblick', 'review'],
  ['graph', '/graph', 'Suche', 'search'],
  ['einstellungen', '/einstellungen', 'Einstellungen', 'settings'],
];

/**
 * Kopfzeile mit Marke und Hauptnavigation, darunter (in `body`) dieselbe
 * Navigation als Leiste für schmale Bildschirme. `links` überschreibt Ziele,
 * z. B. den Rückblick der angezeigten Woche. `alert` (fertiges HTML, siehe
 * health-render.js) steht vor dem Abmelden, etwa der Hinweis auf gestörte Dienste.
 */
export function appHeader({ current = null, user = null, links = {}, alert = '' } = {}) {
  const items = NAV.map(([key, href, label, ic]) => ({ key, href: links[key] ?? href, label, ic }));
  const link = (i, cls) =>
    `<a href="${esc(i.href)}" class="${cls}"${i.key === current ? ' aria-current="page"' : ''}>${icon(i.ic)}<span>${i.label}</span></a>`;
  return `<header class="app-header">
  <a href="/" class="brand" aria-label="Cockpit, zur Woche">${icon('flame', 'brand-mark')}<span class="brand-name">Cockpit</span></a>
  <nav class="app-nav" aria-label="Hauptnavigation">${items.map((i) => link(i, 'nav-link')).join('')}</nav>${alert}
  <form method="post" action="/logout" class="logout"><button type="submit" class="nav-link quiet" title="${esc(user ? `Abmelden (${user})` : 'Abmelden')}">${icon('logout')}<span>Abmelden</span></button></form>
</header>
<nav class="tabbar" aria-label="Hauptnavigation unten">${items.map((i) => link(i, 'tab')).join('')}</nav>`;
}
