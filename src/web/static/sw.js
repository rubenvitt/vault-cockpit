// Service Worker des Web-Cockpits. Der Server stellt beim Ausliefern unter
// `/sw.js` die Zeile `self.CONFIG = {…}` voran (src/web/offline.js): Version
// (Inhalts-Hash der App-Hülle), die Dateien der App-Hülle und den Header, mit
// dem er eine Seite für den Offline-Cache freigibt.
//
// Gespeichert werden nur die App-Hülle, die Wochenansicht der laufenden
// Woche und Lesestoff für unterwegs (VCP-80: Artikel vom Stapel, Synthesen,
// die Listen dazu), nie andere Notizen, Suche, Einstellungen oder `/api/…`.
// Den Lesestoff nennt `/api/lesen/offline`; die Seite schickt dazu die
// Nachricht `lesen-offline`. Abmelden und jeder neue Login löschen alles
// außer der App-Hülle.
'use strict';

const { version, shell, mark, synthesis } = self.CONFIG;
const SHELL = `cockpit-shell-${version}`;
const PAGES = 'cockpit-seiten';
const WEEK = '/';
const SHELL_PATHS = new Set(shell.map((p) => p.split('?')[0]));

// Zählt jedes Vergessen mit, damit eine noch laufende Speicherung danach nichts mehr ablegt.
let generation = 0;
// Leseseiten holt das Befüllen erst nach einem Tag wieder; Öffnen mit Netz frischt sie sofort auf.
const FRESH_MS = 24 * 60 * 60 * 1000;

/**
 * Schlüssel einer Leseseite, die offline liegen darf, sonst `null`: Leseansicht,
 * Synthese unter `synthesis/`, `/lesen/stapel` und `/wissen` ohne Filter.
 * Einheitlich kodiert, damit derselbe Artikel über jeden Link derselbe Eintrag ist.
 */
function readingKey(url) {
  const p = url.pathname;
  if (p === '/lesen/doc') {
    const id = url.searchParams.get('id');
    return id ? `/lesen/doc?id=${encodeURIComponent(id)}` : null;
  }
  if (p === '/notiz') {
    const path = url.searchParams.get('pfad') ?? '';
    return path.startsWith(`${synthesis}/`) && !path.split('/').includes('..') ? `/notiz?pfad=${encodeURIComponent(path)}` : null;
  }
  return (p === '/lesen/stapel' || p === '/wissen') && !url.search ? p : null;
}

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

self.addEventListener('message', (event) => {
  if (event.data?.type === 'lesen-offline') event.waitUntil(fill());
});

async function navigate(event, req, url) {
  // Login heißt: Die Sitzung ist neu oder weg. Die gespeicherte Woche gehört zur alten.
  if (url.pathname === '/login' || url.pathname === '/auth/callback') await forget();
  const key = url.pathname === '/' ? WEEK : readingKey(url);
  let res;
  try {
    res = await fetch(req);
  } catch {
    return (key && (await saved(key))) || offlinePage();
  }
  if (key) {
    // Die Woche wird hier gespeichert, Leseseiten nur aufgefrischt: Welche es gibt, bestimmt `fill`.
    if (res.ok && res.headers.get(mark) === (key === WEEK ? 'woche' : 'lesen')) event.waitUntil(remember(key, res.clone(), key !== WEEK));
    // Weiterleitung zum Login: keine gültige Sitzung mehr, also auch nichts davon auf dem Gerät.
    else if (res.type === 'opaqueredirect' || res.status === 401) await forget();
    // Dienst gerade weg (Deploy, Proxy meldet 502–504): lieber den letzten Stand zeigen.
    else if (res.status >= 502 && res.status <= 504) return (await saved(key)) || res;
  }
  return res;
}

let filling = null;
/** Lesestoff nach `/api/lesen/offline` speichern: Fehlendes und Veraltetes holen, nicht mehr Genanntes löschen. */
function fill() {
  filling ??= fillReading().finally(() => (filling = null));
  return filling;
}

async function fillReading() {
  const gen = generation;
  let res;
  try {
    res = await fetch('/api/lesen/offline', { headers: { accept: 'application/json' }, credentials: 'same-origin', cache: 'no-store' });
  } catch {
    return;
  }
  if (res.status === 401) return forget();
  const data = res.ok ? await res.json().catch(() => null) : null;
  if (!Array.isArray(data?.urls) || gen !== generation) return;
  const wanted = new Set(data.urls.map((u) => readingKey(new URL(u, self.location.origin))).filter(Boolean));
  const cache = await caches.open(PAGES);
  for (const req of await cache.keys()) {
    const key = readingKey(new URL(req.url));
    if (key && !wanted.has(key)) await cache.delete(req);
  }
  for (const key of wanted) {
    const hit = await cache.match(key);
    if (hit && Date.now() - Date.parse(hit.headers.get('x-cockpit-stand') ?? '') < FRESH_MS) continue;
    let page;
    try {
      page = await fetch(key, { credentials: 'same-origin', redirect: 'manual', cache: 'no-store' });
    } catch {
      return;
    }
    if (gen !== generation) return;
    if (page.type === 'opaqueredirect' || page.status === 401) return forget();
    if (page.ok && page.headers.get(mark) === 'lesen') await remember(key, page);
  }
}

async function logout(req) {
  await forget();
  try {
    return await fetch(req);
  } catch {
    return offlinePage();
  }
}

/** Legt `res` unter `key` ab; `onlyKnown`: nur, wenn dort schon etwas liegt (Auffrischen). */
async function remember(key, res, onlyKnown = false) {
  const gen = generation;
  const headers = new Headers(res.headers);
  headers.set('x-cockpit-stand', new Date().toISOString());
  const body = await res.blob();
  if (gen !== generation) return;
  const cache = await caches.open(PAGES);
  if (onlyKnown && !(await cache.match(key))) return;
  await cache.put(key, new Response(body, { status: 200, headers }));
}

async function forget() {
  generation += 1;
  await caches.delete(PAGES);
}

/** Eine gespeicherte Seite mit dem Zeitpunkt der Speicherung an `<html>`, für den Hinweis „offline, Stand von …“. */
async function saved(key) {
  const res = await (await caches.open(PAGES)).match(key);
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
