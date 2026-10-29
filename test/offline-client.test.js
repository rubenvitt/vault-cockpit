// Offline-Puffer im Browser (src/web/static/offline.js, VCP-87) im Sandkasten:
// DOM aus linkedom, IndexedDB, Caches und `fetch` nachgebaut. Es läuft genau
// die Datei, die der Browser lädt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { parseHTML } from 'linkedom';

const script = (name) => readFileSync(new URL(`../src/web/static/${name}`, import.meta.url), 'utf8');
const SOURCE = script('offline.js');

/**
 * IndexedDB mit einem Speicher `eintraege`: Anfragen einer Transaktion laufen
 * der Reihe nach und asynchron, `oncomplete` erst nach der letzten (auch nach
 * denen, die ein `onsuccess` noch anhängt), wie im Browser.
 */
function fakeIndexedDB() {
  const data = new Map();
  const clone = (v) => (v === undefined ? undefined : structuredClone(v));
  const transaction = () => {
    const queue = [];
    const tx = { oncomplete: null, onerror: null, onabort: null, error: null };
    const op = (run) => {
      const req = { result: undefined, onsuccess: null };
      queue.push({ req, run });
      return req;
    };
    setImmediate(() => {
      while (queue.length) {
        const { req, run } = queue.shift();
        req.result = run();
        req.onsuccess?.();
      }
      tx.oncomplete?.();
    });
    tx.objectStore = () => ({
      getAll: () => op(() => [...data.values()].map(clone)),
      get: (id) => op(() => clone(data.get(id))),
      put: (entry) => op(() => (data.set(entry.id, clone(entry)), entry.id)),
      delete: (id) => op(() => void data.delete(id)),
      clear: () => op(() => data.clear()),
    });
    return tx;
  };
  const db = { createObjectStore() {}, transaction };
  return {
    data,
    open() {
      const req = { result: db };
      setImmediate(() => {
        req.onupgradeneeded?.();
        req.onsuccess?.();
      });
      return req;
    },
  };
}

/** Caches mit Schlüsseln wie in sw.js (Pfad samt Suche, ohne Herkunft). */
function fakeCaches(pages = []) {
  const stores = new Map([['cockpit-seiten', new Set(pages)]]);
  return {
    stores,
    open: async (name) => {
      if (!stores.has(name)) stores.set(name, new Set());
      const keys = stores.get(name);
      return { match: async (key) => (keys.has(key) ? new Response('gespeichert') : undefined) };
    },
    delete: async (name) => stores.delete(name),
  };
}

const settle = () => new Promise((r) => setTimeout(r, 5));
async function until(check, what, ms = 1000) {
  for (let i = 0; i < ms / 5; i++) {
    if (check()) return;
    await settle();
  }
  assert.fail(`Wartet vergeblich: ${what}`);
}

/**
 * Lädt offline.js in eine Seite. `server(path, fields)` antwortet auf jede
 * Anfrage ({ status, body }) oder wirft für „kein Netz“.
 */
async function loadPage({ html = '<main></main>', stand = null, onLine = true, server, pages = [], confirm = () => true, before = [], cockpit = {} } = {}) {
  const page = parseHTML(`<!doctype html><html lang="de"${stand ? ` data-offline-stand="${stand}"` : ''}><body>${html}<div class="toasts"></div></body></html>`);
  const { document } = page;
  // linkedom kennt keine Formular-Sammlungen: so viel nachbauen, wie offline.js braucht.
  const proto = Object.getPrototypeOf(document.createElement('form'));
  Object.defineProperty(document, 'forms', { get: () => document.querySelectorAll('form') });
  const submitted = [];
  for (const [name, get] of Object.entries({
    method: function () {
      return (this.getAttribute('method') ?? 'get').toLowerCase();
    },
    elements: function () {
      const list = [...this.querySelectorAll('input, textarea, button, select')];
      for (const f of list) if (f.getAttribute('name')) list[f.getAttribute('name')] = f;
      return list;
    },
  })) {
    if (!(name in proto)) Object.defineProperty(proto, name, { get, configurable: true });
  }
  proto.submit = function () {
    submitted.push(this.getAttribute('action'));
  };

  const idb = fakeIndexedDB();
  const caches = fakeCaches(pages);
  const toasts = [];
  const requests = [];
  const confirms = [];
  const fetch = async (path, init = {}) => {
    const fields = init.body ? Object.fromEntries(new URLSearchParams(String(init.body))) : null;
    requests.push({ path, fields });
    const { status = 200, body = {} } = await server(path, fields);
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  };
  const ctx = vm.createContext({
    document,
    navigator: { onLine },
    location: { href: 'https://vault.test/', reload() {} },
    indexedDB: idb,
    caches,
    fetch,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    crypto: globalThis.crypto,
    URL,
    URLSearchParams,
    Event: page.Event,
    HTMLFormElement: { [Symbol.hasInstance]: (v) => v?.localName === 'form' },
    addEventListener() {},
    setInterval() {},
    setTimeout,
    clearTimeout,
    cockpit: { toast: (message) => toasts.push(message), ...cockpit },
    confirm: (text) => (confirms.push(text), confirm(text)),
    // Für lesen-doc.js:
    CSS: { escape: (v) => v },
    FormData: class {
      constructor(form) {
        const named = [...form.querySelectorAll('input[name], textarea[name]')].filter((f) => f.getAttribute('type') !== 'checkbox' || f.hasAttribute('checked'));
        this.list = named.map((f) => [f.getAttribute('name'), f.getAttribute('value') ?? f.textContent]);
      }
      [Symbol.iterator]() {
        return this.list[Symbol.iterator]();
      }
    },
    CustomEvent: page.CustomEvent,
    getSelection: () => ({ isCollapsed: true, rangeCount: 0, removeAllRanges() {} }),
    innerHeight: 800,
    Element: page.Element,
  });
  ctx.window = ctx;
  for (const name of before) vm.runInContext(script(name), ctx);
  vm.runInContext(SOURCE, ctx);
  await settle();
  const logout = () => document.querySelector('form.logout').dispatchEvent(new page.Event('submit', { cancelable: true }));
  return { ctx, document, puffer: ctx.cockpitPuffer, idb, caches, toasts, requests, confirms, submitted, logout };
}

/** Cockpit mit gültiger Sitzung: Token `t1`, jede Aktion klappt. */
const happy = (path) => (path === '/api/sitzung' ? { body: { csrf: 't1' } } : { body: { ok: true, message: `ok ${path}` } });

test('Nachsenden: eine neuere Fassung, die während des Sendens kommt, bleibt im Puffer und geht danach raus', async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  let sends = 0;
  const page = await loadPage({
    onLine: false,
    server: async (path, fields) => {
      if (path === '/api/sitzung') return { body: { csrf: 't1' } };
      sends += 1;
      if (sends === 1) await gate;
      return { body: { ok: true, message: `Notiz ${fields.notiz}` } };
    },
  });
  const { puffer, idb, requests } = page;
  const entry = (notiz) => ({ id: '/aktion/lesen/markierung/notiz:h1', action: '/aktion/lesen/markierung/notiz', fields: { id: 'h1', notiz }, label: 'Notiz: A' });

  assert.equal(await puffer.queue(entry('alt')), true);
  assert.equal(requests.length, 0, 'ohne Netz fragt der Puffer nicht einmal nach dem Token');

  page.ctx.navigator.onLine = true;
  const first = puffer.flush();
  await until(() => sends === 1, 'erste Fassung unterwegs');
  // Während die alte Fassung unterwegs ist, ändert sich die Notiz noch einmal.
  await puffer.queue(entry('neu'));
  release();
  await first;
  assert.deepEqual(
    [...idb.data.values()].map((e) => e.fields.notiz),
    ['neu'],
    'die Antwort auf die alte Fassung löscht die neue nicht',
  );

  await puffer.flush();
  assert.deepEqual(
    requests.filter((r) => r.path !== '/api/sitzung').map((r) => r.fields),
    [
      { id: 'h1', notiz: 'alt', csrf: 't1' },
      { id: 'h1', notiz: 'neu', csrf: 't1' },
    ],
  );
  assert.equal(idb.data.size, 0);
});

test('Nachsenden: veraltetes CSRF-Token (403) holt einmal ein neues und sendet noch einmal', async () => {
  let token = 0;
  const page = await loadPage({
    onLine: false,
    server: (path, fields) => {
      if (path === '/api/sitzung') return { body: { csrf: `t${++token}` } };
      if (fields.csrf !== 't2') return { status: 403, body: { ok: false, error: 'csrf', message: 'Formular veraltet' } };
      return { body: { ok: true, message: 'Markiert' } };
    },
  });
  await page.puffer.queue({ id: 'c1', action: '/aktion/lesen/markierung/neu', fields: { id: 'd1', quote: 'Satz', cid: 'c1' }, label: 'Markierung: A' });
  page.ctx.navigator.onLine = true;
  await page.puffer.flush();
  assert.deepEqual(
    page.requests.map((r) => [r.path, r.fields?.csrf ?? null]),
    [
      ['/api/sitzung', null],
      ['/aktion/lesen/markierung/neu', 't1'],
      ['/api/sitzung', null],
      ['/aktion/lesen/markierung/neu', 't2'],
    ],
  );
  assert.equal(page.idb.data.size, 0);
  assert.deepEqual(page.toasts.slice(-1), ['Nachgesendet: Markiert']);
});

test('Nachsenden: abgelaufene Sitzung (401) hält an, nichts geht verloren, der Puffer bittet um Anmeldung', async () => {
  for (const where of ['sitzung', 'aktion']) {
    const page = await loadPage({
      onLine: false,
      server: (path) => {
        if (path === '/api/sitzung') return where === 'sitzung' ? { status: 401, body: { ok: false } } : { body: { csrf: 't1' } };
        return { status: 401, body: { ok: false, message: 'Nicht angemeldet' } };
      },
    });
    for (const id of ['a', 'b']) await page.puffer.queue({ id, action: '/aktion/lesen/doc/status', fields: { id, status: 'stapel' }, label: `Status: ${id}` });
    page.ctx.navigator.onLine = true;
    await page.puffer.flush();
    const sent = page.requests.filter((r) => r.path !== '/api/sitzung');
    assert.equal(sent.length, where === 'sitzung' ? 0 : 1, `${where}: nach dem ersten 401 nichts mehr`);
    assert.deepEqual([...page.idb.data.keys()].sort(), ['a', 'b'], `${where}: beide bleiben, ohne Fehler`);
    assert.ok([...page.idb.data.values()].every((e) => e.error === null));
    assert.match(page.document.querySelector('.puffer-login')?.textContent ?? '', /Anmeldung ist abgelaufen/);
  }
});

test('Nachsenden: ohne Netz beim Senden (Funkloch) bleibt alles stehen, ohne Fehler', async () => {
  const page = await loadPage({
    server: (path) => {
      if (path === '/api/sitzung') return { body: { csrf: 't1' } };
      throw new TypeError('Failed to fetch');
    },
  });
  await page.puffer.queue({ id: 'x', action: '/aktion/lesen/markierung/loeschen', fields: { id: 'h1' }, label: 'Entfernen: A' });
  await page.puffer.flush();
  assert.equal(page.idb.data.get('x').error, null);
  assert.equal(page.puffer.offline(), true, 'danach gilt die Seite als offline, weitere Aktionen gehen gleich in den Puffer');
});

const LOGOUT = '<main><form method="post" action="/logout" class="logout"><button type="submit">Abmelden</button></form></main>';

test('Abmelden: sendet erst, was geht, und leert dann Puffer und gespeicherte Seiten', async () => {
  const page = await loadPage({ html: LOGOUT, onLine: false, server: happy, pages: ['/lesen/doc?id=a'] });
  await page.puffer.queue({ id: 'n', action: '/aktion/lesen/markierung/notiz', fields: { id: 'h1', notiz: 'Gedanke' }, label: 'Notiz: A' });
  page.ctx.navigator.onLine = true;
  page.logout();
  await until(() => page.submitted.length, 'Abmelden geht raus');
  assert.deepEqual(page.submitted, ['/logout']);
  assert.ok(
    page.requests.some((r) => r.path === '/aktion/lesen/markierung/notiz'),
    'die Notiz ging vorher noch raus',
  );
  assert.deepEqual(page.confirms, [], 'nichts mehr da, keine Rückfrage');
  assert.equal(page.idb.data.size, 0);
  assert.equal(page.caches.stores.has('cockpit-seiten'), false);
});

test('Abmelden ohne Netz: Rückfrage, wenn noch etwas wartet; Abbrechen behält alles, Bestätigen löscht es', async () => {
  let answer = false;
  const page = await loadPage({ html: LOGOUT, onLine: false, server: happy, pages: ['/lesen/doc?id=a'], confirm: () => answer });
  await page.puffer.queue({ id: 'c1', action: '/aktion/lesen/markierung/neu', fields: { id: 'a', quote: 'vertraulich', cid: 'c1' }, label: 'Markierung: A' });
  await page.puffer.queue({ id: 'p', action: '/aktion/lesen/doc/fortschritt', fields: { id: 'a', fortschritt: '0.5' }, label: 'Lesefortschritt: A', quiet: true });

  page.logout();
  await until(() => page.confirms.length === 1, 'Rückfrage');
  await settle();
  assert.match(page.confirms[0], /^Ein Eintrag wartet noch auf Netz\. Beim Abmelden wird er von diesem Gerät gelöscht und nicht gesendet\./);
  assert.deepEqual(page.submitted, []);
  assert.equal(page.idb.data.size, 2, 'Abbrechen: alles bleibt');
  assert.ok(page.caches.stores.has('cockpit-seiten'));

  answer = true;
  page.logout();
  await until(() => page.submitted.length, 'Abmelden geht raus');
  assert.equal(page.idb.data.size, 0, 'auch der stille Fortschritt ist weg');
  assert.equal(page.caches.stores.has('cockpit-seiten'), false);
  assert.equal(page.requests.length, 0, 'ohne Netz kein Versuch zu senden');
});

test('Abmelden während eines hängenden Nachsendens: Nach dem Bestätigen geht nichts mehr raus', async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const page = await loadPage({
    html: LOGOUT,
    onLine: false,
    server: async (path) => {
      if (path === '/api/sitzung') return { body: { csrf: 't1' } };
      await gate;
      return { body: { ok: true, message: 'ok' } };
    },
  });
  for (const id of ['a', 'b']) await page.puffer.queue({ id, action: '/aktion/lesen/markierung/notiz', fields: { id, notiz: id }, label: `Notiz: ${id}` });
  page.ctx.navigator.onLine = true;
  page.logout();
  // Die erste Notiz hängt, nach der Wartezeit fragt die Seite und löscht.
  await until(() => page.submitted.length, 'Abmelden geht raus', 6000);
  assert.equal(page.confirms.length, 1);
  assert.equal(page.idb.data.size, 0);
  release();
  await settle();
  await settle();
  assert.deepEqual(
    page.requests.filter((r) => r.path !== '/api/sitzung').map((r) => r.fields.id),
    ['a'],
    'b geht nach dem Bestätigen nicht mehr raus',
  );
});

test('Gespeicherte Leseseite: Stapel und Seitenleiste zeigen nur Artikel, die offline vorliegen', async () => {
  const html = `<main class="lesen-doc">
    <nav class="lesen-stack"><ol>
      <li><a href="/lesen/doc?id=a" aria-current="page">A</a></li>
      <li><a href="/lesen/doc?id=b#weiter">B</a></li>
      <li><a href="/lesen/doc?id=c%20d">C D</a></li>
      <li><a href="/lesen/doc?id=e">E</a></li>
    </ol></nav>
    <ul class="lesen-notes"><li data-hl="h1"><a href="#h-h1">Zitat</a></li></ul>
  </main>`;
  const page = await loadPage({ html, stand: '2026-10-29T08:00:00.000Z', onLine: false, server: happy, pages: ['/lesen/doc?id=a', '/lesen/doc?id=c%20d'] });
  const visible = [...page.document.querySelectorAll('.lesen-stack li')].filter((li) => !li.hidden).map((li) => li.textContent.trim());
  assert.deepEqual(visible, ['A', 'C D']);
  assert.equal(page.document.querySelector('.offline-missing')?.textContent, '2 Artikel sind nicht offline gespeichert.');
  assert.equal(page.document.querySelector('.lesen-notes li').hidden, false, 'Sprungmarken im Artikel bleiben');

  // Mit Netz vom Server geladen: nichts ausgeblendet.
  const live = await loadPage({ html, server: happy, pages: [] });
  assert.equal([...live.document.querySelectorAll('.lesen-stack li')].filter((li) => li.hidden).length, 0);
});

test('Leseansicht: Entfernen und In Inbox ohne Netz in den Puffer, Entscheidungen auch im Funkloch', async () => {
  const hidden = (fields) =>
    Object.entries(fields)
      .map(([k, v]) => `<input type="hidden" name="${k}" value="${v}">`)
      .join('');
  const html = `<main class="lesen-doc">
    <article class="lesen-reader" data-doc="d1">
      <header class="lesen-doc-head"><h1>Artikel</h1></header>
      <form method="post" action="/aktion/lesen/doc/fertig" class="act" data-decide="fertig">${hidden({ csrf: 'alt', back: '/lesen/doc?id=d1', id: 'd1' })}<button type="submit">Fertig, weg</button></form>
      <div class="lesen-text"><p>Ein <mark class="hl" data-hl="h1">Satz</mark>.</p></div>
    </article>
    <aside class="lesen-side"><ul class="lesen-notes"><li data-hl="h1"><form method="post" action="/aktion/lesen/markierung/loeschen" data-hl-form>${hidden({ csrf: 'alt', back: '/lesen/doc?id=d1', id: 'h1' })}<button type="submit">Entfernen</button></form></li></ul></aside>
  </main>
  <div class="lesen-selbar" hidden><button data-cmd="mark">M</button><button data-cmd="delete">E</button><button data-cmd="inbox">I</button></div>`;
  const send = async () => {
    throw Object.assign(new Error('Keine Verbindung'), { offline: true });
  };
  const page = await loadPage({ html, stand: '2026-10-29T08:00:00.000Z', onLine: false, server: happy, before: ['lesen-doc.js'], cockpit: { send, csrf: () => 'alt' } });
  const { document, idb } = page;

  // Entfernen in der Seitenleiste: wartet, die Markierung verliert ihre Farbe, der Eintrag verschwindet.
  document.querySelector('form[data-hl-form]').dispatchEvent(new page.ctx.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => idb.data.has('/aktion/lesen/markierung/loeschen:h1'), 'Entfernen im Puffer');
  assert.deepEqual(idb.data.get('/aktion/lesen/markierung/loeschen:h1').fields, { id: 'h1' }, 'ohne altes Token und ohne back');
  await until(() => document.querySelector('mark').hasAttribute('data-weg'), 'Markierung ausgegraut');
  assert.equal(document.querySelector('.lesen-notes li').hidden, true);

  // In Inbox: Knopf der Leiste auf einer angetippten Markierung.
  document.querySelector('mark').removeAttribute('data-weg');
  document.querySelector('mark').dispatchEvent(new page.ctx.Event('click', { bubbles: true }));
  document.querySelector('[data-cmd=inbox]').dispatchEvent(new page.ctx.Event('click', { bubbles: true }));
  await until(() => idb.data.has('/aktion/lesen/markierung/inbox:h1'), 'In Inbox im Puffer');
  assert.deepEqual(idb.data.get('/aktion/lesen/markierung/inbox:h1').fields, { markierung: 'h1' });

  // Funkloch: Die Seite hält sich für online, cockpit.js scheitert beim Senden und gibt die Entscheidung ab.
  const live = await loadPage({
    html,
    onLine: true,
    server: () => {
      throw new TypeError('Failed to fetch');
    },
    before: ['lesen-doc.js'],
    cockpit: { send, csrf: () => 'alt' },
  });
  assert.equal(live.ctx.cockpitPuffer.offline(), false);
  assert.equal(await live.ctx.cockpitLesen.decision(live.document.querySelector('form[data-decide]')), true);
  assert.deepEqual(live.idb.data.get('/aktion/lesen/doc/fertig:d1').fields, { id: 'd1' });
  assert.ok(live.toasts.includes('Fertig, weg wartet auf Netz und geht automatisch raus.'));
});
