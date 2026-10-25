import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';
import { episodeCard } from '../src/lesen/folgen-page.js';

const source = (file) => readFileSync(new URL(`../src/web/static/${file}`, import.meta.url), 'utf8');

class FakeAudio {
  constructor() {
    this.paused = true;
    this.currentTime = 0;
    this.duration = NaN;
    this.on = {};
    this.played = [];
    FakeAudio.all.push(this);
  }
  addEventListener(type, fn) {
    (this.on[type] ??= []).push(fn);
  }
  fire(type) {
    for (const fn of this.on[type] ?? []) fn();
  }
  play() {
    this.paused = false;
    this.played.push(this.src);
    this.fire('play');
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
    this.fire('pause');
  }
  removeAttribute(name) {
    if (name === 'src') this.src = '';
  }
  load() {}
}
FakeAudio.all = [];

/**
 * Seite mit /static/player.js (und `scripts` danach) in einer VM. `window` ist ein Objekt mit
 * eigenen Lauschern, damit Klicks und Absenden den Weg bis zum `window` nehmen.
 */
function run(body, { scripts = [], parent = null, path = '/lesen/folgen' } = {}) {
  const { document } = parseHTML(`<!doctype html><html><head><title>Folgen · Cockpit</title></head><body>${body}</body></html>`);
  const view = document.defaultView;
  const on = {};
  const storage = new Map();
  const pushed = [];
  const window = {
    addEventListener: (type, fn) => (on[type] ??= []).push(fn),
    fire(type, event) {
      for (const fn of on[type] ?? []) fn(event);
    },
  };
  window.parent = parent ?? window;
  const location = new URL(`https://cockpit.test${path}`);
  location.assign = (url) => pushed.push(['assign', url]);
  const context = vm.createContext({
    window,
    document,
    location,
    history: { state: null, pushState: (state, _, url) => pushed.push(['push', url]), replaceState: (state, _, url) => pushed.push(['replace', url]) },
    navigator: {},
    localStorage: { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, String(v)), removeItem: (k) => storage.delete(k) },
    Element: view.Element,
    // linkedom hat für <form> keine eigene Klasse.
    HTMLFormElement: { [Symbol.hasInstance]: (el) => el?.tagName === 'FORM' },
    Audio: FakeAudio,
    URL,
    URLSearchParams,
    setTimeout,
    clearTimeout,
    fetch: () => new Promise(() => {}),
  });
  for (const file of ['player.js', ...scripts]) vm.runInContext(source(file), context);
  return { window, document, storage, pushed, player: window.cockpitPlayer };
}

/** Klick, wie er am `window` ankommt; `prevented` sagt, ob der Player ihn übernommen hat. */
function click(window, target) {
  const event = { target, button: 0, defaultPrevented: false, preventDefault() {
    this.defaultPrevented = true;
  } };
  window.fire('click', event);
  return event.defaultPrevented;
}

const ctx = { tz: 'Europe/Berlin', write: { csrf: 'c' } };
const episode = { id: 'f1', status: 'fertig', kind: 'podcast', title: 'Vom Lesen', created_at: Date.parse('2026-10-24T10:00:00Z'), bytes: 1000 };
const folgenPage = `<ul class="folgen">${episodeCard(episode, { ctx })}</ul>`;

test('Player: Folge spielt über den Player des Cockpits, Karte und Leiste zeigen sie', () => {
  FakeAudio.all = [];
  const { document, player, storage } = run(folgenPage, { scripts: ['lesen-folgen.js'] });
  const li = document.querySelector('.folge');
  const play = li.querySelector('[data-play]');
  assert.equal(play.hidden, false);
  assert.equal(li.querySelector('.folge-nojs'), null, 'Link ohne JavaScript ist weg');
  assert.equal(document.querySelector('.player-bar'), null, 'ohne Wiedergabe keine Leiste');

  play.click();
  const [audio] = FakeAudio.all;
  assert.equal(audio.src, '/lesen/folgen/audio?id=f1');
  assert.deepEqual(audio.played, ['/lesen/folgen/audio?id=f1']);
  assert.equal(player.state().kind, 'folge');
  assert.ok(li.classList.contains('is-playing'));
  assert.equal(play.getAttribute('aria-pressed'), 'true');
  const bar = document.querySelector('.player-bar');
  assert.equal(bar.hidden, false);
  assert.equal(bar.querySelector('[data-part=title]').textContent, 'Vom Lesen');
  assert.equal(bar.querySelector('[data-part=info]').getAttribute('href'), '/lesen/folgen');
  assert.ok(document.documentElement.classList.contains('mit-player'));

  // Leiste: Pause, Stelle merken, schließen.
  audio.currentTime = 42;
  bar.querySelector('[data-p=toggle]').click();
  assert.equal(audio.paused, true);
  assert.equal(play.getAttribute('aria-pressed'), 'false');
  assert.equal(storage.get('folgen-stelle:f1'), '42');
  bar.querySelector('[data-p=close]').click();
  assert.equal(player.state().kind, null);
  assert.equal(bar.hidden, true);
  assert.ok(!document.documentElement.classList.contains('mit-player'));
  assert.ok(!li.classList.contains('is-current'));
});

test('Player: während der Wiedergabe laden Links und Formulare im Rahmen, Anmelden und Fremdes nicht', () => {
  FakeAudio.all = [];
  const { window, document, player, pushed } = run(
    `${folgenPage}<a id="woche" href="/">Woche</a><a id="sprung" href="#oben">Oben</a><a id="raus" href="/logout">Ab</a><a id="fremd" href="https://example.org/">Fremd</a><form id="aktion" method="post" action="/aktion/lesen/doc/weg"></form>`,
    { scripts: ['lesen-folgen.js'] },
  );
  const a = (id) => document.getElementById(id);
  assert.equal(click(window, a('woche')), false, 'ohne Wiedergabe ein normaler Seitenwechsel');

  document.querySelector('[data-play]').click();
  assert.equal(click(window, a('sprung')), false, 'Sprung in der Seite bleibt');
  assert.equal(click(window, a('raus')), false, 'Abmelden verlässt das Cockpit');
  assert.equal(click(window, a('fremd')), false, 'fremde Seiten nicht im Rahmen');
  assert.equal(document.querySelector('iframe'), null);

  assert.equal(click(window, a('woche')), true);
  const frame = document.querySelector('iframe[name=cockpit-seite]');
  assert.ok(frame, 'Rahmen angelegt');
  assert.equal(frame.src, 'https://cockpit.test/');
  assert.ok(document.documentElement.classList.contains('player-shell'));
  assert.deepEqual(pushed, [['push', 'https://cockpit.test/lesen/folgen']], 'Zurück führt wieder zur alten Seite');
  assert.equal(player.state().playing, true, 'spielt weiter');

  // Formular: Der Browser schickt es selbst, nur in den Rahmen.
  const form = a('aktion');
  window.fire('submit', { target: form, defaultPrevented: false });
  assert.equal(form.target, 'cockpit-seite');

  // Wechsel aus Scripten (Weiterleitung nach einer Aktion).
  window.cockpitWechsel('/lesen?x=1');
  assert.equal(frame.src, 'https://cockpit.test/lesen?x=1');
  assert.equal(pushed.some(([kind]) => kind === 'assign'), false);
});

test('Player im Rahmen: nimmt den Player der Hülle, Abos enden mit der Seite', () => {
  FakeAudio.all = [];
  const shell = run(folgenPage, { scripts: ['lesen-folgen.js'] });
  const framed = run(`${folgenPage}<a id="raus" href="/logout">Ab</a>`, { scripts: ['lesen-folgen.js'], parent: shell.window, path: '/lesen/folgen' });
  assert.equal(FakeAudio.all.length, 0, 'kein eigenes Audio im Rahmen');

  // Knopf im Rahmen spielt im Player der Hülle.
  framed.document.querySelector('[data-play]').click();
  assert.equal(FakeAudio.all.length, 1);
  assert.equal(shell.player.state().kind, 'folge');
  assert.ok(framed.document.querySelector('.folge').classList.contains('is-playing'), 'Karte im Rahmen zeigt den Stand');
  assert.equal(framed.document.querySelector('.player-bar'), null, 'Leiste nur in der Hülle');
  assert.ok(framed.document.documentElement.classList.contains('mit-player'), 'Seite im Rahmen macht Platz');

  framed.window.fire('pagehide', {});
  shell.player.toggle();
  assert.ok(framed.document.querySelector('.folge').classList.contains('is-playing'), 'nach dem Verlassen keine Updates mehr');
});
