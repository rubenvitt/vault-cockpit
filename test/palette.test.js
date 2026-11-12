import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';
import { createWebHttp } from '../src/web/http.js';
import { createCookieSigner } from '../src/web/session.js';
import { createSettingsStore } from '../src/cockpit/settings.js';
import { appHeader } from '../src/web/layout.js';

const UI = readFileSync(new URL('../src/web/static/ui.js', import.meta.url), 'utf8');
const quiet = { info() {}, warn() {}, error() {} };

const storage = (init = {}) => {
  const map = new Map(Object.entries(init));
  return { map, getItem: (k) => map.get(k) ?? null, setItem: (k, v) => map.set(k, String(v)), removeItem: (k) => map.delete(k) };
};

/**
 * Seite mit Kopfzeile und /static/ui.js in einer VM. `routes`: Pfad (ohne Query) → JSON-Antwort
 * von `fetch`, alles andere scheitert wie ohne Netz. Zeitgeber laufen erst mit `flush()`.
 */
function load(body = '', { session = {}, local = {}, routes = {}, platform = 'Linux x86_64' } = {}) {
  const { document, Event, Element, HTMLElement, HTMLFormElement } = parseHTML(`<!doctype html><html><body>${appHeader()}${body}</body></html>`);
  const on = {};
  const window = { addEventListener: (type, fn) => (on[type] ??= []).push(fn) };
  window.parent = window;
  const fetched = [];
  const fetch = async (url) => {
    fetched.push(url);
    const reply = routes[url.split('?')[0]];
    if (!reply) throw new TypeError('kein Netz');
    return { ok: true, status: 200, json: async () => (typeof reply === 'function' ? reply(url) : reply) };
  };
  let timers = [];
  const context = {
    window,
    document,
    Event,
    Element,
    HTMLElement,
    HTMLFormElement,
    navigator: { platform },
    location: new URL('https://cockpit.test/lesen/stapel'),
    sessionStorage: storage(session),
    localStorage: storage(local),
    fetch,
    AbortController,
    console,
    addEventListener: window.addEventListener,
    setTimeout: (fn) => timers.push(fn),
    clearTimeout: (id) => {
      if (id) timers[id - 1] = null;
    },
  };
  vm.runInNewContext(UI, context);
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  const page = {
    palette: window.cockpitPalette,
    document,
    fetched,
    sessionStorage: context.sessionStorage,
    localStorage: context.localStorage,
    /** Fällige Zeitgeber (Entprellen der Suche) laufen lassen und Antworten abwarten. */
    async flush() {
      const due = timers;
      timers = [];
      for (const fn of due) fn?.();
      await settle();
    },
    settle,
    key(key, mods = {}) {
      const e = { key, prevented: false, preventDefault: () => (e.prevented = true), ...mods };
      for (const fn of on.keydown ?? []) fn(e);
      return e;
    },
    type(text) {
      const input = document.querySelector('.palette-input');
      input.value = text;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    },
    press(key) {
      const e = new Event('keydown', { bubbles: true, cancelable: true });
      e.key = key;
      document.querySelector('.palette-input').dispatchEvent(e);
    },
    open: () => document.querySelector('dialog.palette')?.hasAttribute('open') ?? false,
    rows: () => [...document.querySelectorAll('.palette [role=option]')].map((a) => `${a.getAttribute('aria-selected') === 'true' ? '>' : ' '} ${a.querySelector('.palette-title').textContent} → ${a.getAttribute('href')}`),
    labels: () => [...document.querySelectorAll('.palette-label')].map((l) => l.textContent),
  };
  return page;
}

// Werte aus der VM gehören zu einem anderen Realm: für `deepEqual` hier in eigene Arrays aus Zeichenketten umfüllen.
const names = (targets) => Array.from(targets, (t) => t.label);
const hrefs = (targets) => Array.from(targets, (t) => t.href);
const shape = (groups) => Array.from(groups, (g) => `${g.label}${g.status ? ` (${g.status})` : ''}: ${Array.from(g.items, (i) => `${i.stale ? '~' : ''}${i.title} → ${i.href}`).join(' | ')}`);

const CAPTURE = '<form class="capture"><textarea name="text"></textarea></form>';
const ALWAYS = ['/', '/rueckblick', '/lesen/weiter', '/lesen/eingang', '/lesen/stapel', '/lesen/markiert', '/lesen/wiedersehen', '/lesen/feeds', '/graph', '/wissen', '/einstellungen'];
const OPTIONAL = ['/planen', '/lesen/folgen', '/lesen/ingest', '/fragen', '/zustand'];

test('Palette: Umlaute sind egal, „ue“ zählt wie „ü“ und wie „u“', () => {
  const { fold, rank } = load().palette;
  assert.equal(fold('Rückblick'), 'ruckblick');
  assert.equal(fold('Rueckblick'), 'ruckblick');
  assert.equal(fold('Größe Straße'), 'grosse strasse');
  for (const q of ['rück', 'Rück', 'rueck', 'ruck', 'RÜCKBLICK', 'rueckblick']) assert.deepEqual(names(rank(q)), ['Rückblick'], q);
  // Mitten in einem Umlaut-Ersatz getippt („rue“) passt es auch schon.
  assert.equal(names(rank('rue'))[0], 'Rückblick');
  assert.deepEqual(names(rank('störung')), ['Zustand']);
  assert.deepEqual(names(rank('stoerung')), ['Zustand']);
  assert.deepEqual(names(rank('zugänge')), ['Einstellungen']);
});

test('Palette: Wortanfang zählt mehr als Wortmitte, der Name mehr als Bereich und Suchwörter', () => {
  const { rank } = load().palette;
  // Zwei Zeichen treffen nur Wortanfänge: „st“ meint den Stapel, nicht „Einstellungen“ oder „Wiedersehen“.
  assert.deepEqual(names(rank('st')), ['Stapel', 'Zustand']);
  // Ab drei Zeichen zählt auch die Wortmitte, aber hinter jedem Wortanfang.
  assert.deepEqual(names(rank('ein')), ['Eingang', 'Einstellungen', 'Zustand']);
  assert.deepEqual(names(rank('stell')), ['Einstellungen', 'Zustand']);
  // Der Name selbst schlägt den Bereich: „woche“ ist zuerst die Woche, dann ihre Ansichten.
  assert.deepEqual(names(rank('woche')), ['Woche', 'Planen', 'Rückblick']);
  assert.deepEqual(names(rank('wo')).slice(0, 3), ['Woche', 'Planen', 'Rückblick']);
  // Bereich: alle Seiten unter „Lesen“ in der Reihenfolge der Liste, „Weiter“ zuerst.
  assert.deepEqual(names(rank('lesen')).slice(0, 8), ['Weiter', 'Eingang', 'Stapel', 'Folgen', 'Ingest', 'Markiert', 'Wiedersehen', 'Feeds']);
  // Name vor Hinweis: „Feeds“ vor dem Eingang, dessen Hinweis die Feeds nennt.
  assert.deepEqual(names(rank('feeds')), ['Feeds', 'Eingang']);
  // Suchwörter: wonach man sucht, wenn man den Namen nicht kennt. Der Hinweis daneben ist nur Anzeige.
  assert.deepEqual(names(rank('di')), ['Zustand']);
  assert.deepEqual(names(rank('podcast')), ['Folgen']);
  assert.deepEqual(names(rank('synth')), ['Wissen']);
  assert.deepEqual(names(rank('claude')), ['Ingest', 'Fragen']);
  // Mehrere Wörter müssen alle passen.
  assert.deepEqual(names(rank('lesen st')), ['Stapel']);
  assert.deepEqual(names(rank('lesen woche')), []);
  assert.deepEqual(names(rank('xyz')), []);
  // Ohne Eingabe (oder nur Zeichen ohne Buchstaben) die ganze Liste in ihrer Reihenfolge.
  assert.equal(rank('').length, 16);
  assert.equal(names(rank('  '))[0], 'Woche');
});

test('Palette: Ziele, die es nicht in jeder Installation gibt, fehlen ohne Antwort des Servers', () => {
  const { available, rank, build } = load().palette;
  assert.deepEqual(hrefs(available()), ALWAYS);
  assert.deepEqual(hrefs(available(null)), ALWAYS);
  // Mit Antwort gilt, was der Server nennt, in der Reihenfolge der Palette.
  assert.deepEqual(hrefs(available(['/zustand', '/', '/planen', '/graph'])), ['/', '/planen', '/graph', '/zustand']);
  for (const href of OPTIONAL) assert.ok(!hrefs(available()).includes(href), href);
  // Gefiltert wird nur, was es gibt: „planen“ findet ohne Zunder nichts.
  assert.deepEqual(names(rank('planen', available())), []);
  assert.deepEqual(shape(build('planen', { urls: ['/', '/planen'] }))[0], 'Ziele: Planen → /planen');
  assert.deepEqual(shape(build('zust'))[0].startsWith('Ziele'), false);
});

test('Palette: Ziele, dann Notizen, zuletzt die Suche im ganzen Vault und Festhalten', () => {
  const { build } = load().palette;
  // Leer: nur die Ziele.
  assert.deepEqual(Array.from(build(''), (g) => g.label), ['Ziele']);
  assert.equal(build('')[0].items.length, ALWAYS.length);

  const found = { q: 'stapel', results: [{ path: 'wiki/Stapel & Co.md', title: 'Stapel & Co' }], total: 12, notes: true, degraded: null };
  assert.deepEqual(shape(build('stapel', { found })), [
    'Ziele: Stapel → /lesen/stapel',
    'Notizen: Stapel & Co → /notiz?pfad=wiki%2FStapel%20%26%20Co.md | Im ganzen Vault suchen: „stapel“ → /graph?q=stapel',
    'Festhalten: Als Notiz festhalten: „stapel“ → /?erfassen=1',
  ]);
  assert.equal(build('stapel', { found })[1].items[1].hint, '12 Treffer');
  // Ohne Notizseite führt ein Treffer in den Graphen, wie in der Live-Suche.
  assert.match(shape(build('stapel', { found: { ...found, notes: false } }))[1], /Stapel & Co → \/graph\?pfad=wiki%2FStapel/);
  // Treffer zu einer älteren Eingabe bleiben stehen, bis die neuen da sind, aber als veraltet.
  assert.deepEqual(shape(build('stapelx', { found }))[0], 'Notizen (sucht …): ~Stapel & Co → /notiz?pfad=wiki%2FStapel%20%26%20Co.md | Im ganzen Vault suchen: „stapelx“ → /graph?q=stapelx');
  assert.match(shape(build('zzz', { found: { ...found, q: 'zzz', results: [], total: 0 } }))[0], /^Notizen \(nichts gefunden\): Im ganzen Vault suchen/);
  assert.match(shape(build('zzz', { failed: true }))[0], /^Notizen \(gerade nicht erreichbar\)/);
  // Ein Zeichen sucht noch nicht; die Suche im Vault und Festhalten gibt es trotzdem.
  assert.deepEqual(shape(build('x')), ['Notizen (ab zwei Zeichen): Im ganzen Vault suchen: „x“ → /graph?q=x', 'Festhalten: Als Notiz festhalten: „x“ → /?erfassen=1']);
  // Ohne Schnelleingabe (Cockpit ohne Schreibrechte) fehlt Festhalten.
  assert.deepEqual(Array.from(build('stapel', { capture: false }), (g) => g.label), ['Ziele', 'Notizen']);

  // `!` und `>` vorn: nur Festhalten, der ganze Text geht in die Schnelleingabe.
  const task = build('!  Zahnarzt anrufen morgen');
  assert.deepEqual(shape(task), ['Festhalten: Als Aufgabe festhalten: „Zahnarzt anrufen morgen“ → /?erfassen=1']);
  assert.equal(task[0].items[0].capture, '!  Zahnarzt anrufen morgen');
  assert.deepEqual(shape(build('> https://example.org/text')), ['Festhalten: Für den Lesestapel festhalten: „https://example.org/text“ → /?erfassen=1']);
  assert.deepEqual(shape(build('> Ein kluger Satz')), ['Festhalten: Als Notiz festhalten: „> Ein kluger Satz“ → /?erfassen=1']);
  assert.deepEqual(shape(build('!')), ['Festhalten (nach dem ! die Aufgabe): ']);
  assert.deepEqual(shape(build('! Milch', { capture: false })), ['Festhalten (hier gibt es keine Schnelleingabe): ']);
  // Lange Texte stehen gekürzt in der Zeile, ganz im Entwurf.
  const long = `Gedanke ${'sehr '.repeat(30)}lang`;
  const row = build(long).at(-1).items[0];
  assert.ok(row.title.length < 90 && row.title.endsWith('…“'));
  assert.equal(row.capture, long);
});

test('Palette: Strg+K öffnet (auf dem Mac ⌘K), der Auslöser in der Kopfzeile auch; Ziele kommen einmal vom Server', async () => {
  const page = load('', { routes: { '/api/palette': { ok: true, urls: [...ALWAYS, '/planen', '/zustand'], capture: true } } });
  const trigger = page.document.querySelector('a[data-palette]');
  assert.equal(trigger.getAttribute('href'), '/graph');
  assert.equal(trigger.querySelector('kbd').textContent, 'Strg K');
  assert.equal(trigger.querySelector('kbd').hasAttribute('hidden'), false);
  assert.equal(trigger.getAttribute('aria-keyshortcuts'), 'Control+K');

  // Andere Tasten und ⌘K auf einem PC gehören der Seite.
  for (const mods of [{}, { metaKey: true }, { ctrlKey: true, shiftKey: true }, { ctrlKey: true, altKey: true }]) assert.equal(page.key('k', mods).prevented, false);
  assert.equal(page.key('j', { ctrlKey: true }).prevented, false);
  assert.equal(page.open(), false);
  assert.equal(page.document.querySelector('dialog.palette'), null, 'vor dem ersten Öffnen steht nichts in der Seite');

  assert.equal(page.key('k', { ctrlKey: true }).prevented, true);
  assert.equal(page.open(), true);
  // Sofort da: die Ziele, die es immer gibt; die erste Zeile ist gewählt.
  assert.equal(page.rows().length, ALWAYS.length);
  assert.equal(page.rows()[0], '> Woche → /');
  const input = page.document.querySelector('.palette-input');
  assert.equal(input.getAttribute('role'), 'combobox');
  assert.equal(input.getAttribute('aria-controls'), page.document.querySelector('.palette [role=listbox]').id);
  assert.equal(input.getAttribute('aria-activedescendant'), page.document.querySelector('.palette [aria-selected=true]').id);

  await page.settle();
  assert.deepEqual(page.fetched, ['/api/palette']);
  assert.ok(page.rows().includes('  Planen → /planen'));
  assert.ok(page.rows().includes('  Zustand → /zustand'));
  assert.ok(!page.rows().some((r) => r.includes('/fragen')));
  assert.deepEqual(JSON.parse(page.localStorage.map.get('cockpit-palette')).urls.slice(-2), ['/planen', '/zustand']);

  // Strg+K schließt wieder; noch einmal öffnen fragt nicht noch einmal.
  page.key('k', { ctrlKey: true });
  assert.equal(page.open(), false);
  page.palette.open();
  await page.settle();
  assert.deepEqual(page.fetched, ['/api/palette']);
  page.press('Escape');
  assert.equal(page.open(), false);

  // Klick auf den Auslöser öffnet, statt zur Suche zu wechseln.
  const click = new (page.document.defaultView.Event)('click', { bubbles: true, cancelable: true });
  click.button = 0;
  trigger.dispatchEvent(click);
  assert.equal(click.defaultPrevented, true);
  assert.equal(page.open(), true);

  // Mac: ⌘K, und Strg+K bleibt dem Textfeld.
  const mac = load('', { platform: 'MacIntel' });
  assert.equal(mac.document.querySelector('a[data-palette] kbd').textContent, '⌘K');
  assert.equal(mac.key('k', { ctrlKey: true }).prevented, false);
  assert.equal(mac.open(), false);
  assert.equal(mac.key('k', { metaKey: true }).prevented, true);
  assert.equal(mac.open(), true);
});

test('Palette: die gemerkte Antwort gilt sofort und auch ohne Netz', async () => {
  const page = load('', { local: { 'cockpit-palette': JSON.stringify({ urls: ['/', '/planen', '/graph'], capture: false }) } });
  page.palette.open();
  assert.deepEqual(page.rows(), ['> Woche → /', '  Planen → /planen', '  Suche → /graph']);
  await page.settle();
  assert.deepEqual(page.rows(), ['> Woche → /', '  Planen → /planen', '  Suche → /graph']);
  page.type('idee');
  assert.deepEqual(page.labels(), ['Notizen · sucht …']);
});

test('Palette: Tippen filtert sofort und sucht entprellt; Pfeile wählen, Enter klickt die Zeile', async () => {
  const hits = { kontext: [{ path: 'wiki/Kontext.md', title: 'Kontext' }], kon: [{ path: 'wiki/Konzept.md', title: 'Konzept' }] };
  const page = load('', { routes: { '/api/suche': (url) => ({ query: '', results: hits[new URL(url, 'https://x').searchParams.get('q')] ?? [], total: 1, degraded: null, notes: true }) } });
  const clicks = [];
  page.document.addEventListener('click', (e) => clicks.push(`${e.target.closest('a').getAttribute('href')}${e.defaultPrevented ? ' (verhindert)' : ''}`));
  page.palette.open();

  page.type('rück');
  assert.deepEqual(page.rows(), ['> Rückblick → /rueckblick', '  Im ganzen Vault suchen: „rück“ → /graph?q=r%C3%BCck', '  Als Notiz festhalten: „rück“ → /?erfassen=1']);
  assert.deepEqual(page.labels(), ['Ziele', 'Notizen · sucht …', 'Festhalten']);

  // Schnell getippt: nur die letzte Eingabe geht an den Server.
  page.type('ko');
  page.type('kon');
  await page.flush();
  assert.deepEqual(page.fetched.filter((u) => u.startsWith('/api/suche')), ['/api/suche?q=kon']);
  assert.deepEqual(page.rows(), ['> Konzept → /notiz?pfad=wiki%2FKonzept.md', '  Im ganzen Vault suchen: „kon“ → /graph?q=kon', '  Als Notiz festhalten: „kon“ → /?erfassen=1']);

  // Weitergetippt: Der alte Treffer bleibt stehen, vorgewählt ist aber die Suche, nicht das Veraltete.
  page.type('kontext');
  assert.deepEqual(page.rows().slice(0, 2), ['  Konzept → /notiz?pfad=wiki%2FKonzept.md', '> Im ganzen Vault suchen: „kontext“ → /graph?q=kontext']);
  assert.ok(page.document.querySelector('.palette [role=option]').classList.contains('stale'));
  await page.flush();
  assert.deepEqual(page.rows()[0], '> Kontext → /notiz?pfad=wiki%2FKontext.md');

  // Pfeile laufen im Kreis; die Wahl bleibt, wenn die Liste neu aufgebaut wird.
  page.press('ArrowUp');
  assert.equal(page.rows().at(-1), '> Als Notiz festhalten: „kontext“ → /?erfassen=1');
  page.press('ArrowDown');
  page.press('ArrowDown');
  assert.equal(page.rows()[1], '> Im ganzen Vault suchen: „kontext“ → /graph?q=kontext');
  page.press('Enter');
  assert.deepEqual(clicks, ['/graph?q=kontext']);
  assert.equal(page.open(), false, 'nach der Wahl ist die Palette zu');

  // Mit `!` vorn wird nicht gesucht.
  page.palette.open();
  page.type('! kontext');
  await page.flush();
  assert.deepEqual(page.fetched.filter((u) => u.startsWith('/api/suche')), ['/api/suche?q=kon', '/api/suche?q=kontext']);

  // Suche ohne Netz: Die Zeilen ohne Server bleiben.
  const offline = load();
  offline.palette.open();
  offline.type('idee');
  await offline.flush();
  assert.deepEqual(offline.labels(), ['Notizen · gerade nicht erreichbar', 'Festhalten']);
  assert.deepEqual(offline.rows(), ['> Im ganzen Vault suchen: „idee“ → /graph?q=idee', '  Als Notiz festhalten: „idee“ → /?erfassen=1']);
});

test('Palette: Festhalten gibt den Text an die Schnelleingabe ab und speichert nichts selbst', async () => {
  // Auf der Woche: direkt ins Feld, ohne Seitenwechsel; cockpit.js erfährt es über `input`.
  const week = load(CAPTURE);
  const field = week.document.querySelector('form.capture textarea');
  let inputs = 0;
  field.addEventListener('input', () => inputs++);
  week.palette.open();
  week.type('! Zahnarzt anrufen morgen');
  assert.deepEqual(week.rows(), ['> Als Aufgabe festhalten: „Zahnarzt anrufen morgen“ → /?erfassen=1']);
  const clicks = [];
  week.document.addEventListener('click', (e) => clicks.push(e.defaultPrevented));
  week.press('Enter');
  assert.equal(field.value, '! Zahnarzt anrufen morgen');
  assert.equal(inputs, 1);
  assert.deepEqual(clicks, [true]);
  assert.equal(week.open(), false);
  assert.equal(week.sessionStorage.map.size, 0);
  // Steht schon etwas im Feld, kommt der Text in eine neue Zeile.
  week.palette.open();
  week.type('Noch ein Gedanke');
  week.press('ArrowUp');
  week.press('Enter');
  assert.equal(field.value, '! Zahnarzt anrufen morgen\nNoch ein Gedanke');
  assert.deepEqual(week.fetched.filter((u) => u.startsWith('/aktion/')), []);

  // Auf einer anderen Seite: Der Text wartet in `sessionStorage`, der Link führt zur Schnelleingabe.
  const stack = load();
  const went = [];
  stack.document.addEventListener('click', (e) => went.push(`${e.target.closest('a').getAttribute('href')}${e.defaultPrevented ? ' (verhindert)' : ''}`));
  stack.palette.open();
  stack.type('> https://example.org/text');
  stack.press('Enter');
  assert.deepEqual(went, ['/?erfassen=1']);
  const draft = JSON.parse(stack.sessionStorage.map.get('cockpit-palette-entwurf'));
  assert.equal(draft.text, '> https://example.org/text');

  // Ankunft auf der Woche: Der Text steht im Feld und ist verbraucht.
  const arrived = load(CAPTURE, { session: { 'cockpit-palette-entwurf': JSON.stringify(draft) } });
  assert.equal(arrived.document.querySelector('form.capture textarea').value, '> https://example.org/text');
  assert.equal(arrived.sessionStorage.map.size, 0);
  // Eine Seite ohne Schnelleingabe (Zwischenseite beim Anmelden) lässt ihn liegen.
  const between = load('', { session: { 'cockpit-palette-entwurf': JSON.stringify(draft) } });
  assert.equal(between.sessionStorage.map.size, 1);
  // Ein alter Entwurf taucht nicht Stunden später auf.
  const stale = load(CAPTURE, { session: { 'cockpit-palette-entwurf': JSON.stringify({ text: 'alt', at: Date.now() - 3_600_000 }) } });
  assert.equal(stale.document.querySelector('form.capture textarea').value, '');
  assert.equal(stale.sessionStorage.map.size, 0);
  const broken = load(CAPTURE, { session: { 'cockpit-palette-entwurf': '{kaputt' } });
  assert.equal(broken.document.querySelector('form.capture textarea').value, '');

  // Kann das Gerät nichts merken, bleibt man in der Palette, statt mit leerem Feld anzukommen.
  const full = load();
  full.sessionStorage.setItem = () => {
    throw new Error('voll');
  };
  const stayed = [];
  full.document.addEventListener('click', (e) => stayed.push(e.defaultPrevented));
  full.palette.open();
  full.type('Gedanke');
  full.press('ArrowUp');
  full.press('Enter');
  assert.deepEqual(stayed, [true]);
  assert.equal(full.open(), true);
});

// --- Server: was es in dieser Installation gibt ---------------------------------

const SECRET = 'p'.repeat(40);

/** `createWebHttp` ohne HTTP-Server: `get(path, { anon })` → `{ status, body }`. */
function server(extra = {}) {
  const settings = createSettingsStore({ defaults: { tz: 'Europe/Berlin', inboxFolder: 'inbox' }, logger: quiet });
  const web = createWebHttp({ cockpit: {}, settings, oidc: {}, sessionSecret: SECRET, publicUrl: 'https://vault.test', allowedSubjects: ['ruben'], logger: quiet, ...extra });
  const t = Math.floor(Date.now() / 1000);
  const cookie = `vc_session=${createCookieSigner(SECRET).seal({ sub: 'ruben', sid: 's1', gen: 0, iat: t, seen: t, exp: t + 3600 })}`;
  return (path, { anon = false } = {}) =>
    new Promise((resolve, reject) => {
      const res = {
        appendHeader() {},
        setHeader() {},
        writeHead(status, headers) {
          this.status = status;
          this.headers = headers;
        },
        end(body) {
          resolve({ status: this.status, headers: this.headers, body: body ? JSON.parse(body) : null });
        },
      };
      Promise.resolve(web.handle({ method: 'GET', headers: anon ? {} : { cookie } }, res, new URL(path, 'https://vault.test'))).catch(reject);
    });
}

test('/api/palette: nur angemeldet; nennt die Ziele, die es gibt, in der Reihenfolge der Palette', async () => {
  const pageOf = (paths) => Object.fromEntries(paths.map((p) => [p, async () => ({ html: '' })]));
  const { palette } = load();
  const all = hrefs(palette.targets);

  // Volle Ausstattung: genau die Ziele, die das Script kennt (Namen und Suchwörter stehen nur dort).
  const full = server({ actions: {}, notes: {}, plan: {}, health: { failing: () => [] }, reading: { pages: pageOf(['/lesen/weiter', '/lesen/eingang', '/lesen/stapel', '/lesen/folgen', '/lesen/ingest', '/lesen/markiert', '/lesen/wiedersehen', '/lesen/feeds', '/fragen']), actions: {} } });
  const res = await full('/api/palette');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true, urls: all, capture: true });
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal((await full('/api/palette', { anon: true })).status, 401);
  assert.deepEqual(hrefs(palette.available(res.body.urls)), all);

  // Lesen ohne Folgen, Ingest und Fragen, kein Zunder zum Planen, kein Zustand: Diese Ziele fehlen.
  const plain = server({ notes: {}, reading: { pages: pageOf(['/lesen/weiter', '/lesen/eingang', '/lesen/stapel', '/lesen/markiert', '/lesen/wiedersehen', '/lesen/feeds']), actions: {} } });
  const some = (await plain('/api/palette')).body;
  assert.deepEqual(some, { ok: true, urls: ALWAYS, capture: false });
  // Dasselbe nimmt die Palette an, solange sie den Server noch nicht gefragt hat.
  assert.deepEqual(hrefs(palette.available()), some.urls);

  // Nur das Nötigste: Woche, Rückblick, Suche, Einstellungen.
  assert.deepEqual((await server()('/api/palette')).body.urls, ['/', '/rueckblick', '/graph', '/einstellungen']);
});
