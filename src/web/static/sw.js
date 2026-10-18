// Service Worker des Web-Cockpits. Der Server stellt beim Ausliefern unter
// `/sw.js` die Zeile `self.CONFIG = {…}` voran (src/web/offline.js): Version
// (Inhalts-Hash der App-Hülle), die Dateien der App-Hülle und den Header, mit
// dem er eine Seite für den Offline-Cache freigibt.
//
// Gespeichert werden nur die App-Hülle und die Wochenansicht der laufenden
// Woche, nie Notizvorschau, Suche, Einstellungen oder `/api/…`. Abmelden und
// jeder neue Login löschen die gespeicherte Woche.
'use strict';

const { version, shell, mark } = self.CONFIG;
const SHELL = `cockpit-shell-${version}`;
const PAGES = 'cockpit-seiten';
const WEEK = '/';
const SHELL_PATHS = new Set(shell.map((p) => p.split('?')[0]));

// Zählt jedes Vergessen mit, damit eine noch laufende Speicherung danach nichts mehr ablegt.
let generation = 0;

self.addEventListener('install', (event) => {
  // Neue Fassung sofort übernehmen: Die Seiten laden ihre Dateien ohnehin mit Versions-Parameter.
  event.waitUntil(caches.open(SHELL).then((c) => c.addAll(shell)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) if (name.startsWith('cockpit-shell-') && name !== SHELL) await caches.delete(name);
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (req.method !== 'GET') {
    if (url.pathname === '/logout') event.respondWith(logout(req));
    return;
  }
  if (req.mode === 'navigate') event.respondWith(navigate(event, req, url));
  else if (SHELL_PATHS.has(url.pathname)) event.respondWith(shellFile(req));
});

async function navigate(event, req, url) {
  // Login heißt: Die Sitzung ist neu oder weg. Die gespeicherte Woche gehört zur alten.
  if (url.pathname === '/login' || url.pathname === '/auth/callback') await forget();
  let res;
  try {
    res = await fetch(req);
  } catch {
    return (url.pathname === '/' && (await savedWeek())) || offlinePage();
  }
  if (url.pathname === '/') {
    if (res.ok && res.headers.get(mark) === 'woche') event.waitUntil(remember(res.clone()));
    // Weiterleitung zum Login: keine gültige Sitzung mehr, also auch keine Woche auf dem Gerät.
    else if (res.type === 'opaqueredirect' || res.status === 401) await forget();
    // Dienst gerade weg (Deploy, Proxy meldet 502–504): lieber den letzten Stand zeigen.
    else if (res.status >= 502 && res.status <= 504) return (await savedWeek()) || res;
  }
  return res;
}

async function logout(req) {
  await forget();
  try {
    return await fetch(req);
  } catch {
    return offlinePage();
  }
}

async function remember(res) {
  const gen = generation;
  const headers = new Headers(res.headers);
  headers.set('x-cockpit-stand', new Date().toISOString());
  const body = await res.blob();
  if (gen !== generation) return;
  await (await caches.open(PAGES)).put(WEEK, new Response(body, { status: 200, headers }));
}

async function forget() {
  generation += 1;
  await caches.delete(PAGES);
}

/** Die gespeicherte Woche mit dem Zeitpunkt der Speicherung an `<html>`, für den Hinweis „offline, Stand von …“. */
async function savedWeek() {
  const res = await (await caches.open(PAGES)).match(WEEK);
  if (!res) return null;
  const stand = (res.headers.get('x-cockpit-stand') ?? '').replace(/[^0-9TZ:.-]/g, '');
  const html = (await res.text()).replace(/<html\b/, `<html data-offline-stand="${stand}"`);
  return new Response(html, { status: 200, headers: res.headers });
}

async function offlinePage() {
  const page = await (await caches.open(SHELL)).match('/offline');
  return page ?? new Response('Offline. Das Cockpit ist gerade nicht erreichbar.', { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' } });
}

async function shellFile(req) {
  const cache = await caches.open(SHELL);
  const hit = await cache.match(req);
  if (hit) return hit;
  try {
    return await fetch(req);
  } catch {
    // Eine ältere gespeicherte Seite fragt nach einer früheren Version; die aktuelle passt meist.
    return (await cache.match(req, { ignoreSearch: true })) ?? Response.error();
  }
}
