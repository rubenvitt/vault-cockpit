import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import vm from 'node:vm';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWebHttp } from '../src/web/http.js';
import { offlineFiles, OFFLINE_MARK } from '../src/web/offline.js';
import { assets } from '../src/web/layout.js';
import { createCookieSigner } from '../src/web/session.js';
import { createSettingsStore } from '../src/cockpit/settings.js';
import { createCockpitActions } from '../src/cockpit/actions.js';
import { createStateStore } from '../src/capture/state.js';
import { createCaptureRouter } from '../src/capture/router.js';
import { compilePolicy } from '../src/vault/policy.js';

const SECRET = 'x'.repeat(40);
const quiet = { info() {}, warn() {}, error() {} };

const cockpit = {
  async week(id) {
    return {
      tz: 'Europe/Berlin',
      vaultName: null,
      week: { id: '2026-W42', year: 2026, week: 42, monday: '2026-10-12', sunday: '2026-10-18', prev: '2026-W41', next: '2026-W43', current: !id, past: false },
      today: '2026-10-14',
      feuer: { ok: true, data: null },
      burning: null,
      flames: { ok: true, data: [] },
      rocks: { ok: true, data: [] },
      calendar: { ok: true, data: [] },
      tasks: { ok: true, data: [] },
      inbox: { vault: { ok: true, data: [] }, zunder: { ok: true, data: [] }, targets: [], folder: 'inbox' },
    };
  },
  async review() {
    return { tz: 'Europe/Berlin', week: { id: '2026-W42', week: 42, monday: '2026-10-12', sunday: '2026-10-18', prev: '2026-W41', next: '2026-W43' }, ok: true, areas: [], totals: { planned: 0, done: 0, extra: 0, minutes: 0 }, flames: [] };
  },
};

const notes = {
  get: (path) => (path === 'inbox/a.md' ? { path, title: 'A', html: '<p>vertraulich genug</p>', tags: [], checkboxes: [], frontmatter: {} } : null),
  targets: () => [],
  archiveFolder: () => null,
};

/** Zunder-Attrappe, die sich beim Anlegen Zeit lässt, damit gleichzeitige Anfragen sich überlappen. */
function slowZunder() {
  const created = [];
  return {
    created,
    async createTask(args) {
      created.push(args);
      await new Promise((r) => setTimeout(r, 30));
      return { id: `t${created.length}`, ref: `ZUN-${created.length}`, url: `https://zunder.test/#/aufgabe/t${created.length}` };
    },
  };
}

/** Web-Cockpit mit echten Aktionen auf einem Vault im Temp-Ordner; die Sitzung wird direkt signiert. */
async function withCockpit(run) {
  const root = mkdtempSync(join(tmpdir(), 'cockpit-offline-'));
  const settings = createSettingsStore({ defaults: { tz: 'Europe/Berlin', inboxFolder: 'inbox' }, logger: quiet });
  const zunder = slowZunder();
  const actions = createCockpitActions({ vaultPath: root, settings, policy: compilePolicy({}), state: createStateStore(null), zunder: () => zunder, logger: quiet });
  const web = createWebHttp({
    cockpit,
    settings,
    actions,
    notes,
    oidc: { start: async () => ({ url: 'https://id.test/authorize', pending: {} }), finish: async () => ({ subject: 'ruben' }) },
    sessionSecret: SECRET,
    publicUrl: 'https://vault.test',
    allowedSubjects: ['ruben'],
    logger: quiet,
  });
  const server = http.createServer((req, res) => web.handle(req, res, new URL(req.url, 'https://vault.test')));
  server.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const t = Math.floor(Date.now() / 1000);
  const session = createCookieSigner(SECRET).seal({ sub: 'ruben', sid: 's1', gen: 0, iat: t, seen: t, exp: t + 3600 });
  const call = (path, { method = 'GET', form = null, anon = false, accept = null } = {}) =>
    fetch(base + path, {
      method,
      redirect: 'manual',
      headers: { ...(anon ? {} : { cookie: `vc_session=${session}` }), ...(accept ? { accept } : {}), ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
      body: form ? new URLSearchParams(form).toString() : undefined,
    });
  const inbox = () => {
    try {
      return readdirSync(join(root, 'inbox'));
    } catch {
      return [];
    }
  };
  try {
    await run({ call, zunder, inbox, root });
  } finally {
    server.close();
    rmSync(root, { recursive: true, force: true });
  }
}

const swConfig = (body) => JSON.parse(/^self\.CONFIG = (.*);\n/.exec(body)[1]);

test('Service Worker: ohne Sitzung, nie aus dem HTTP-Cache, eigene CSP, App-Hülle mit Versionen', async () => {
  await withCockpit(async ({ call }) => {
    const sw = await call('/sw.js', { anon: true });
    assert.equal(sw.status, 200);
    assert.match(sw.headers.get('content-type'), /text\/javascript/);
    assert.equal(sw.headers.get('cache-control'), 'no-cache');
    assert.equal(sw.headers.get('content-security-policy'), "default-src 'none'; connect-src 'self'");
    const body = await sw.text();
    const config = swConfig(body);
    assert.match(config.version, /^[\w-]{10}$/);
    assert.equal(config.mark, OFFLINE_MARK);

    // Die Hülle nennt genau die Dateien, die die Seiten laden, mit denselben Versionen.
    const html = await (await call('/')).text();
    for (const src of [/href="(\/static\/cockpit\.css\?v=[\w-]{10})"/, /src="(\/static\/cockpit\.js\?v=[\w-]{10})"/, /src="(\/static\/offline\.js\?v=[\w-]{10})"/]) {
      assert.ok(config.shell.includes(html.match(src)[1]), src);
    }
    assert.ok(config.shell.includes('/offline'));
    assert.ok(config.shell.includes('/manifest.webmanifest'));
    // Alles davon gibt es ohne Sitzung; Seiten mit Inhalten gehören nicht dazu.
    for (const path of config.shell) {
      assert.equal((await call(path, { anon: true })).status, 200, path);
      assert.ok(path === '/offline' || path === '/manifest.webmanifest' || path.startsWith('/static/'), path);
    }
    const pinned = await call(config.shell.find((p) => p.startsWith('/static/offline.js')), { anon: true });
    assert.match(pinned.headers.get('cache-control'), /immutable/);
  });
});

test('Versions-Hash: ändert sich mit jeder Datei der App-Hülle, sonst nicht', () => {
  const files = new Map([assets.css, assets.ui, assets.player, assets.js, assets.offline, assets.lesenDoc, assets.lesenLinks, '/manifest.webmanifest', '/static/icon.svg', '/static/icons/icon-192.png', '/static/icons/icon-512.png', '/static/icons/icon-maskable-512.png', '/static/icons/apple-touch-icon.png'].map((p) => [p.split('?')[0], { body: `Inhalt von ${p}` }]));
  const html = { 'content-type': 'text/html; charset=utf-8' };
  const a = offlineFiles(files, { html });
  assert.equal(offlineFiles(files, { html }).version, a.version);
  files.set('/static/icon.svg', { body: '<svg>neu</svg>' });
  const b = offlineFiles(files, { html });
  assert.notEqual(b.version, a.version);
  assert.equal(swConfig(b.entries.find(([p]) => p === '/sw.js')[1].body).version, b.version);
  files.delete('/static/icon.svg');
  assert.throws(() => offlineFiles(files, { html }), /icon\.svg fehlt/);
});

test('App-Hülle /offline: ohne Sitzung und ohne Nutzerdaten, mit Schnelleingabe ohne Token und ID', async () => {
  await withCockpit(async ({ call }) => {
    const res = await call('/offline', { anon: true });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-cache');
    assert.match(res.headers.get('content-security-policy'), /worker-src 'self'/);
    const html = await res.text();
    assert.match(html, /<body class="page-week page-offline">/);
    assert.match(html, /action="\/aktion\/erfassen" class="capture"/);
    assert.match(html, /name="csrf" value=""/);
    assert.match(html, /name="cid" value=""/);
    assert.match(html, /<script src="\/static\/offline\.js\?v=[\w-]{10}" defer><\/script>/);
    assert.doesNotMatch(html, /ruben/);
  });
});

test('CSP erlaubt Manifest und Service Worker nur von der eigenen Herkunft', async () => {
  await withCockpit(async ({ call }) => {
    const csp = (await call('/')).headers.get('content-security-policy');
    assert.match(csp, /manifest-src 'self'/);
    assert.match(csp, /worker-src 'self'/);
    assert.match(csp, /script-src 'self'; style-src 'self'; connect-src 'self'/);
  });
});

test('Offline-Cache: nur die laufende Woche ist freigegeben, keine Notiz, Suche oder API', async () => {
  await withCockpit(async ({ call }) => {
    assert.equal((await call('/')).headers.get(OFFLINE_MARK), 'woche');
    assert.equal((await call('/?erfassen=1')).headers.get(OFFLINE_MARK), 'woche');
    for (const path of ['/?woche=2026-W41', '/notiz?pfad=inbox%2Fa.md', '/graph', '/rueckblick', '/einstellungen', '/api/woche', '/api/sitzung', '/offline']) {
      const res = await call(path);
      assert.ok(res.status < 400, `${path}: ${res.status}`);
      assert.equal(res.headers.get(OFFLINE_MARK), null, path);
    }
    const anon = await call('/', { anon: true });
    assert.equal(anon.status, 303);
    assert.equal(anon.headers.get(OFFLINE_MARK), null);
  });
});

test('/api/sitzung: frisches CSRF-Token für den Puffer, ohne Sitzung 401', async () => {
  await withCockpit(async ({ call }) => {
    const anon = await call('/api/sitzung', { anon: true });
    assert.equal(anon.status, 401);
    assert.match((await anon.json()).message, /Anmeldung ist abgelaufen/);
    const res = await call('/api/sitzung');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const { csrf } = await res.json();
    const page = await (await call('/')).text();
    assert.equal(csrf, page.match(/name="csrf" value="([^"]+)"/)[1]);
    assert.equal((await call('/api/sitzung', { method: 'POST', form: {} })).status, 405);
  });
});

test('Nachsenden aus dem Puffer: Notiz und !-Aufgabe landen genau einmal, auch gleichzeitig und doppelt', async () => {
  await withCockpit(async ({ call, zunder, inbox, root }) => {
    const { csrf } = await (await call('/api/sitzung')).json();
    const send = (text, cid) => call('/aktion/erfassen', { method: 'POST', form: { text, cid, csrf, back: '/' }, accept: 'application/json' });

    // Zwei Tabs senden denselben Puffer gleichzeitig, danach kommt eine Antwort nicht an und es geht noch einmal raus.
    const entries = [['Idee aus dem Zug', '1b4e28ba-2fa1-11d2-883f-0016d3cca427'], ['! Fahrkarte erstatten lassen\nBeleg im Rucksack', '6fa459ea-ee8a-3ca4-894e-db77e160355e']];
    const first = await Promise.all(entries.flatMap(([text, cid]) => [send(text, cid), send(text, cid)]));
    for (const res of first) assert.equal(res.status, 200);
    const bodies = await Promise.all(first.map((r) => r.json()));
    const again = await Promise.all(entries.map(([text, cid]) => send(text, cid).then((r) => r.json())));

    assert.equal(inbox().length, 1, 'eine Notiz in der Vault-Inbox');
    assert.match(readFileSync(join(root, 'inbox', inbox()[0]), 'utf8'), /capture_id: 1b4e28ba-2fa1-11d2-883f-0016d3cca427\n[^]*Idee aus dem Zug/);
    assert.equal(zunder.created.length, 1, 'eine Aufgabe in der Zunder-Inbox');
    assert.equal(zunder.created[0].title, 'Fahrkarte erstatten lassen');
    assert.equal(bodies.filter((b) => b.result.kind === 'task' && !b.result.duplicate).length, 1);
    assert.ok(again.every((b) => b.ok && b.result.duplicate && /^Schon erfasst/.test(b.message)));
  });
});

test('Schnelleingabe: ungültige Erfassungs-ID wird abgewiesen, der Weg ohne JavaScript bleibt', async () => {
  await withCockpit(async ({ call, zunder, inbox }) => {
    const html = await (await call('/')).text();
    const csrf = html.match(/name="csrf" value="([^"]+)"/)[1];
    const cid = html.match(/name="cid" value="([^"]+)"/)[1];
    for (const bad of ['a b', 'x'.repeat(129), '../etc']) {
      const res = await call('/aktion/erfassen', { method: 'POST', form: { text: '! Aufgabe', cid: bad, csrf }, accept: 'application/json' });
      assert.equal(res.status, 400, bad);
      assert.match((await res.json()).message, /Ungültige Capture-ID/);
    }
    assert.equal(zunder.created.length, 0);
    // Formular ohne JavaScript: Server-ID, Weiterleitung, beim Neusenden kein Doppel.
    for (let i = 0; i < 2; i++) {
      const res = await call('/aktion/erfassen', { method: 'POST', form: { text: 'Ohne Script', cid, csrf, back: '/' } });
      assert.equal(res.status, 303);
      assert.equal(res.headers.get('location'), '/');
    }
    assert.equal(inbox().length, 1);
  });
});

test('Capture-Router: Capture-ID gilt für Aufgaben wie für Notizen', async () => {
  const created = [];
  const router = createCaptureRouter({ capture: { write: () => assert.fail('keine Notiz') }, zunder: { createTask: async (t) => (created.push(t), { id: 't1' }) }, state: createStateStore(null), logger: quiet });
  await assert.rejects(router.route({ text: '! Aufgabe', source: 'api', captureId: 'mit leerzeichen' }), (e) => e.status === 400 && /Capture-ID/.test(e.message));
  assert.equal(created.length, 0);
  assert.equal((await router.route({ text: '! Aufgabe', source: 'api', captureId: 'funke-0123abcd' })).kind, 'task');
});

// --- Service Worker im Sandkasten -----------------------------------------------
// Der Browser fehlt, aber die Regeln des Workers lassen sich mit nachgebauten
// Caches und `fetch` prüfen: Es läuft genau die Datei, die `/sw.js` ausliefert.

function fakeCaches() {
  const stores = new Map();
  const key = (k) => new URL(typeof k === 'string' ? k : k.url, 'https://vault.test').href;
  const open = async (name) => {
    if (!stores.has(name)) stores.set(name, new Map());
    const m = stores.get(name);
    return {
      async match(k, { ignoreSearch = false } = {}) {
        const want = key(k);
        for (const [stored, res] of m) if (stored === want || (ignoreSearch && stored.split('?')[0] === want.split('?')[0])) return res.clone();
        return undefined;
      },
      async put(k, res) {
        m.set(key(k), res);
      },
      async addAll(urls) {
        for (const u of urls) m.set(key(u), new Response(`Hülle ${u}`));
      },
      keys: async () => [...m.keys()].map((url) => ({ url })),
      delete: async (k) => m.delete(key(k)),
    };
  };
  return { stores, open, keys: async () => [...stores.keys()], delete: async (name) => stores.delete(name) };
}

async function loadWorker(swBody, network) {
  const listeners = {};
  const caches = fakeCaches();
  const self = {
    location: new URL('https://vault.test/sw.js'),
    addEventListener: (type, fn) => (listeners[type] = fn),
    skipWaiting: async () => {},
    clients: { claim: async () => {} },
  };
  const ctx = vm.createContext({ self, caches, fetch: (req) => network(req), Response, Headers, URL, Date, JSON });
  vm.runInContext(swBody, ctx);
  const dispatch = async (type, event = {}) => {
    const waits = [];
    let response = null;
    listeners[type]({ ...event, waitUntil: (p) => waits.push(p), respondWith: (p) => (response = p) });
    const res = await response;
    await Promise.all(waits);
    return res;
  };
  const request = (path, { method = 'GET', mode = 'navigate' } = {}) => ({ url: `https://vault.test${path}`, method, mode });
  return { dispatch, request, caches };
}

test('Service Worker: speichert nur die freigegebene Woche, zeigt sie offline mit Stand, vergisst sie beim Abmelden', async () => {
  await withCockpit(async ({ call }) => {
    const body = await (await call('/sw.js', { anon: true })).text();
    const config = swConfig(body);
    let online = true;
    let next = null;
    const network = async (req) => {
      if (!online) throw new TypeError('Failed to fetch');
      return next(req);
    };
    const sw = await loadWorker(body, network);

    // Installieren legt die Hülle unter der Version ab, Aktivieren räumt alte Versionen weg.
    sw.caches.stores.set('cockpit-shell-alt', new Map());
    await sw.dispatch('install');
    await sw.dispatch('activate');
    assert.deepEqual([...sw.caches.stores.keys()], [`cockpit-shell-${config.version}`]);
    assert.equal([...sw.caches.stores.get(`cockpit-shell-${config.version}`).keys()].length, config.shell.length);

    const week = (mark = true) => new Response('<!doctype html>\n<html lang="de"><body>KW 42</body></html>', { headers: { 'content-type': 'text/html; charset=utf-8', ...(mark ? { [OFFLINE_MARK]: 'woche' } : {}) } });
    next = () => new Response('<html>Notiz</html>', { headers: { 'content-type': 'text/html' } });
    await sw.dispatch('fetch', { request: sw.request('/notiz?pfad=inbox%2Fa.md') });
    next = () => week(false);
    await sw.dispatch('fetch', { request: sw.request('/?woche=2026-W41') });
    assert.equal(sw.caches.stores.has('cockpit-seiten'), false, 'ohne Freigabe nichts gespeichert');

    next = () => week();
    assert.match(await (await sw.dispatch('fetch', { request: sw.request('/') })).text(), /KW 42/);
    assert.deepEqual([...sw.caches.stores.get('cockpit-seiten').keys()], ['https://vault.test/']);

    // Ohne Netz: Woche mit Stand, andere Seiten zeigen die Hülle, Dateien kommen aus dem Cache.
    online = false;
    const offline = await (await sw.dispatch('fetch', { request: sw.request('/?erfassen=1') })).text();
    assert.match(offline, /<html data-offline-stand="\d{4}-\d{2}-\d{2}T[\d:.]+Z" lang="de">/);
    assert.equal(await (await sw.dispatch('fetch', { request: sw.request('/graph') })).text(), 'Hülle /offline');
    const css = config.shell.find((p) => p.startsWith('/static/cockpit.css'));
    assert.equal(await (await sw.dispatch('fetch', { request: sw.request(css, { mode: 'no-cors' }) })).text(), `Hülle ${css}`);
    // Eine ältere Seite fragt nach einer früheren Version: Die aktuelle passt.
    assert.equal(await (await sw.dispatch('fetch', { request: sw.request('/static/cockpit.css?v=alt', { mode: 'no-cors' }) })).text(), `Hülle ${css}`);
    // API und Aktionen fasst der Worker nicht an.
    assert.equal(await sw.dispatch('fetch', { request: sw.request('/api/woche', { mode: 'cors' }) }), null);
    assert.equal(await sw.dispatch('fetch', { request: sw.request('/aktion/erfassen', { method: 'POST', mode: 'cors' }) }), null);

    // Abmelden (auch ohne Netz) und jeder Login löschen die Woche.
    assert.equal(await (await sw.dispatch('fetch', { request: sw.request('/logout', { method: 'POST' }) })).text(), 'Hülle /offline');
    assert.equal(sw.caches.stores.has('cockpit-seiten'), false);
    online = true;
    await sw.dispatch('fetch', { request: sw.request('/') });
    assert.ok(sw.caches.stores.has('cockpit-seiten'));
    next = () => new Response('', { status: 303, headers: { location: 'https://id.test/authorize' } });
    await sw.dispatch('fetch', { request: sw.request('/login') });
    assert.equal(sw.caches.stores.has('cockpit-seiten'), false);

    // Abgelaufene Sitzung: Weiterleitung zum Login statt Woche, auch dann ist sie weg.
    next = () => week();
    await sw.dispatch('fetch', { request: sw.request('/') });
    next = () => ({ type: 'opaqueredirect', ok: false, status: 0, headers: new Headers() });
    await sw.dispatch('fetch', { request: sw.request('/') });
    assert.equal(sw.caches.stores.has('cockpit-seiten'), false);
  });
});

test('Service Worker: Lesestoff nur nach Liste und Freigabe, offline mit Stand, weg beim Abmelden (VCP-80)', async () => {
  await withCockpit(async ({ call }) => {
    const body = await (await call('/sw.js', { anon: true })).text();
    assert.equal(swConfig(body).synthesis, 'wiki/synthesis');
    let online = true;
    let listStatus = 200;
    let gate = null;
    const fetched = [];
    const page = (text, mark = 'lesen') => new Response(`<!doctype html>\n<html lang="de"><body>${text}</body></html>`, { headers: { 'content-type': 'text/html; charset=utf-8', ...(mark ? { [OFFLINE_MARK]: mark } : {}) } });
    const urls = [
      '/lesen/stapel',
      '/lesen/doc?id=a',
      '/lesen/doc?id=ohne-freigabe',
      '/wissen',
      '/notiz?pfad=wiki%2Fsynthesis%2FA.md',
      // Schummelt sich etwas in die Liste, bleibt es trotzdem draußen.
      '/notiz?pfad=inbox%2Fa.md',
      '/notiz?pfad=wiki%2Fsynthesis%2F..%2F..%2Fprivat%2Fx.md',
      '/einstellungen',
    ];
    const sw = await loadWorker(body, async (req) => {
      if (!online) throw new TypeError('Failed to fetch');
      const u = new URL(typeof req === 'string' ? req : req.url, 'https://vault.test');
      const path = u.pathname + u.search;
      fetched.push(path);
      if (u.pathname === '/api/lesen/offline') return new Response(JSON.stringify({ ok: true, urls }), { status: listStatus, headers: { 'content-type': 'application/json' } });
      if (gate && u.pathname !== '/logout') await gate;
      if (path === '/') return page('KW 42', 'woche');
      if (path === '/lesen/doc?id=ohne-freigabe') return page('Artikel ohne Freigabe', null);
      return page(`Seite ${path}`);
    });
    const stored = () => [...(sw.caches.stores.get('cockpit-seiten')?.keys() ?? [])].map((k) => k.replace('https://vault.test', '')).sort();
    const fill = () => sw.dispatch('message', { data: { type: 'lesen-offline' } });

    await sw.dispatch('install');
    await sw.dispatch('fetch', { request: sw.request('/') });
    await (await sw.caches.open('cockpit-seiten')).put('/lesen/doc?id=archiviert', page('alt'));
    await fill();
    assert.deepEqual(stored(), ['/', '/lesen/doc?id=a', '/lesen/stapel', '/notiz?pfad=wiki%2Fsynthesis%2FA.md', '/wissen']);
    assert.ok(!fetched.some((p) => p.includes('inbox') || p.includes('privat') || p === '/einstellungen'), 'nicht freigegebene Seiten werden nicht einmal geholt');

    // Noch frisch: Ein zweites Befüllen holt nur die Liste und, was noch fehlt.
    fetched.length = 0;
    await fill();
    assert.deepEqual(fetched, ['/api/lesen/offline', '/lesen/doc?id=ohne-freigabe']);

    // Mit Netz frischt Öffnen nur Gespeichertes auf; ein Artikel außerhalb der Liste kommt nicht dazu.
    await sw.dispatch('fetch', { request: sw.request('/lesen/doc?id=neu') });
    assert.ok(!stored().includes('/lesen/doc?id=neu'));

    // Ohne Netz: gespeicherte Leseseite mit Stand (gleich wie verlinkt), andere Notizen zeigen die Hülle.
    online = false;
    const offline = await (await sw.dispatch('fetch', { request: sw.request('/lesen/doc?id=a') })).text();
    assert.match(offline, /<html data-offline-stand="\d{4}-\d{2}-\d{2}T[\d:.]+Z" lang="de"><body>Seite \/lesen\/doc\?id=a/);
    assert.match(await (await sw.dispatch('fetch', { request: sw.request('/notiz?pfad=wiki/synthesis/A.md') })).text(), /Seite \/notiz/);
    assert.equal(await (await sw.dispatch('fetch', { request: sw.request('/notiz?pfad=inbox%2Fa.md') })).text(), 'Hülle /offline');

    // Abmelden löscht Woche und Lesestoff.
    await sw.dispatch('fetch', { request: sw.request('/logout', { method: 'POST' }) });
    assert.equal(sw.caches.stores.has('cockpit-seiten'), false);

    // Abmelden während des Befüllens: Danach landet nichts mehr im Cache.
    online = true;
    let release;
    gate = new Promise((r) => (release = r));
    const running = fill();
    await new Promise((r) => setTimeout(r, 10));
    await sw.dispatch('fetch', { request: sw.request('/logout', { method: 'POST' }) });
    release();
    gate = null;
    await running;
    assert.deepEqual(stored(), []);

    // Sitzung abgelaufen: Die Liste antwortet 401, alles Gespeicherte verschwindet.
    await fill();
    assert.ok(stored().length > 0);
    listStatus = 401;
    await fill();
    assert.equal(sw.caches.stores.has('cockpit-seiten'), false);
  });
});

test('Service Worker: neue Version holt gespeicherte Leseansichten sofort neu, ohne Netz bleibt die alte (VCP-98)', async () => {
  await withCockpit(async ({ call }) => {
    const body = await (await call('/sw.js', { anon: true })).text();
    const { version } = swConfig(body);
    let online = true;
    const fetched = [];
    const page = (text) => new Response(`<!doctype html>\n<html lang="de"><body>${text}</body></html>`, { headers: { 'content-type': 'text/html; charset=utf-8', [OFFLINE_MARK]: 'lesen' } });
    const sw = await loadWorker(body, async (req) => {
      if (!online) throw new TypeError('Failed to fetch');
      const u = new URL(typeof req === 'string' ? req : req.url, 'https://vault.test');
      fetched.push(u.pathname + u.search);
      if (u.pathname === '/api/lesen/offline') return new Response(JSON.stringify({ ok: true, urls: ['/lesen/doc?id=a', '/lesen/doc?id=b', '/wissen'] }), { headers: { 'content-type': 'application/json' } });
      return page(`Neu ${u.pathname + u.search}`);
    });
    // Vom alten Worker gespeichert, alle noch frisch: a ohne Version (vor VCP-98), b mit alter, Wissen ist keine Leseansicht.
    const cache = await sw.caches.open('cockpit-seiten');
    const old = (text, headers = {}) => new Response(`<html lang="de"><body>${text}</body></html>`, { headers: { 'x-cockpit-stand': new Date().toISOString(), ...headers } });
    await cache.put('/lesen/doc?id=a', old('Alt a'));
    await cache.put('/lesen/doc?id=b', old('Alt b', { 'x-cockpit-version': 'alt' }));
    await cache.put('/wissen', old('Alt Wissen'));
    const text = async (key) => (await cache.match(key))?.text();

    // Ohne Netz: Aktivieren scheitert still, die alten Fassungen bleiben lesbar.
    // `activate` wartet nicht aufs Befüllen; das Befüllen danach ist dasselbe (`filling`).
    const activate = async () => {
      await sw.dispatch('activate');
      await sw.dispatch('message', { data: { type: 'lesen-offline' } });
    };
    online = false;
    await sw.dispatch('install');
    await activate();
    assert.match(await text('/lesen/doc?id=a'), /Alt a/);

    online = true;
    await activate();
    assert.deepEqual(fetched, ['/api/lesen/offline', '/lesen/doc?id=a', '/lesen/doc?id=b']);
    assert.match(await text('/lesen/doc?id=a'), /Neu \/lesen\/doc\?id=a/);
    assert.match(await text('/lesen/doc?id=b'), /Neu \/lesen\/doc\?id=b/);
    assert.match(await text('/wissen'), /Alt Wissen/);
    assert.equal((await cache.match('/lesen/doc?id=a')).headers.get('x-cockpit-version'), version);

    // Mit der aktuellen Version und frisch: nichts mehr zu holen.
    fetched.length = 0;
    await sw.dispatch('message', { data: { type: 'lesen-offline' } });
    assert.deepEqual(fetched, ['/api/lesen/offline']);
  });
});
