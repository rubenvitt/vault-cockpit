import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';
import { createReadingStore } from '../src/lesen/store.js';
import { readingRoutes } from '../src/lesen/http.js';
import { sanitizeHtml } from '../src/lesen/extract.js';
import { htmlText, anchorAt } from '../src/lesen/anchor.js';
import { sentences } from '../src/lesen/listen.js';

const said = (html) => sentences(html).map(({ start, end }) => htmlText(html).slice(start, end));

test('Hören: Sätze an Satzzeichen und Blockgrenzen, Positionen im Lesetext', () => {
  const html = sanitizeHtml('<h2>Anfang</h2><p>Der Stapel wächst &amp; wächst. Er wächst weiter!</p><ul><li>Eins</li><li>Zwei? Drei.</li></ul>');
  assert.deepEqual(said(html), ['Anfang', 'Der Stapel wächst & wächst.', 'Er wächst weiter!', 'Eins', 'Zwei?', 'Drei.']);
  const text = htmlText(html);
  for (const { start, end } of sentences(html)) {
    assert.ok(/\S/.test(text[start]) && /\S/.test(text[end - 1]), 'ohne Leerraum am Rand');
  }
});

test('Hören: Abkürzungen, Daten und Zahlen beenden keinen Satz', () => {
  const html = '<p>Am 3. Oktober kam z. B. Dr. Müller, ca. 3.5 Stunden zu spät. Im Jahr 2020. Dann „Hallo.“ Ende</p>';
  assert.deepEqual(said(html), ['Am 3. Oktober kam z. B. Dr. Müller, ca. 3.5 Stunden zu spät.', 'Im Jahr 2020.', 'Dann „Hallo.“', 'Ende']);
  assert.deepEqual(sentences(''), []);
  assert.deepEqual(sentences('<p> </p>'), []);
});

/** Lesestapel mit einem Text aus zwei Absätzen, Seiten und Aktionen direkt aufgerufen. */
function setup() {
  const store = createReadingStore({ path: ':memory:' });
  const html = sanitizeHtml('<h2>Anfang</h2><p>Der Stapel wächst &amp; wächst.</p><p>Ein zweiter Absatz. Mit einem Satz, den man sich merkt.</p>');
  const { doc } = store.addDocument({ url: 'https://blatt.test/a', title: 'Vom Lesen', status: 'stapel', reading_minutes: 5, content_html: html });
  const routes = readingRoutes({ store, logger: { info() {}, warn() {}, error() {} } });
  const ctx = (path) => ({ url: new URL(`https://vault.test${path}`), user: 'ruben', tz: 'Europe/Berlin', write: { csrf: 'c', back: path }, flash: null });
  const page = (path) => routes.pages[new URL(`https://vault.test${path}`).pathname](ctx(path));
  const act = (path, fields) => routes.actions[path](new URLSearchParams(fields), { sub: 'ruben' });
  const sentence = (prefix) => sentences(html).find(({ start }) => htmlText(html).startsWith(prefix, start));
  return { store, doc, html, page, act, sentence };
}

test('Hören: gespeicherter Anker setzt #weiter in der Leseansicht an den gehörten Satz', async () => {
  const { store, doc, page, act, sentence } = setup();
  for (const [prefix, expected] of [
    ['Ein zweiter', /<p><span id="weiter" class="lesen-weiter"><\/span>Ein zweiter Absatz\./],
    ['Mit einem', /<p>Ein zweiter Absatz\. <span id="weiter" class="lesen-weiter"><\/span>Mit einem Satz/],
  ]) {
    const s = sentence(prefix);
    await act('/aktion/lesen/doc/fortschritt', { id: doc.id, fortschritt: '0.6', anker: String(s.start) });
    assert.equal(Number(store.get(doc.id).scroll_anchor), s.start);
    const { html } = await page(`/lesen/doc?id=${doc.id}`);
    assert.match(html, expected);
  }
});

test('Hören: „Das hier merken“ markiert genau den gesprochenen Satz in der Leseansicht', async () => {
  const { doc, html: content, page, act, sentence } = setup();
  const s = sentence('Mit einem');
  // So bildet /static/lesen-hoeren.js die Felder: Anker wie `anchorAt`, `start_hint` als `start`.
  const { quote, prefix, suffix, start_hint } = anchorAt(htmlText(content), s.start, s.end);
  const res = await act('/aktion/lesen/markierung/neu', { id: doc.id, quote, prefix, suffix, start: String(start_hint) });
  const { html } = await page(`/lesen/doc?id=${doc.id}`);
  assert.match(html, new RegExp(`Ein zweiter Absatz\\. <mark id="h-${res.highlight.id}" class="hl" data-hl="${res.highlight.id}">Mit einem Satz, den man sich merkt\\.</mark></p>`));
  assert.ok(!html.includes('Stelle nicht mehr im Text'));
});

test('Hören: Seite listet das Zeitfenster ohne JavaScript, Text als JSON, Link vom Stapel', async () => {
  const { store, doc, html: content, page } = setup();
  store.addDocument({ url: 'https://blatt.test/lang', title: 'Zu lang', status: 'stapel', reading_minutes: 40 });
  const done = store.addDocument({ url: 'https://blatt.test/fertig', title: 'Schon gehört', status: 'stapel', reading_minutes: 2 }).doc;
  store.setProgress(done.id, 1);
  const { html } = await page('/lesen/hoeren?zeit=15');
  assert.ok(!/style=|<script>/.test(html), 'keine Inline-Styles oder -Skripte');
  assert.match(html, /<script src="\/static\/lesen-hoeren\.js(\?v=[\w-]+)?" defer><\/script>/);
  assert.match(html, new RegExp(`<li class="lesen-item" data-doc="${doc.id}">\\s*<a href="/lesen/doc\\?id=${doc.id}" class="lesen-title">Vom Lesen</a>`));
  assert.ok(!html.includes('Zu lang'), 'nur, was ins Fenster passt');
  assert.ok(!html.includes('Schon gehört'), 'Fertiges nicht noch einmal');
  assert.match(html, /class="meta hoeren-nojs">Abspielen braucht JavaScript/);
  assert.match(html, /<div class="hoeren-player" hidden>[^]*name="csrf" value="c"[^]*data-cmd="play"[^]*data-cmd="next"[^]*Das hier merken[^]*data-rate/);
  assert.match(html, /href="\/lesen\/hoeren\?zeit=15" class="chip" aria-current="true"/);

  const r = await page(`/lesen/hoeren/text?id=${doc.id}`);
  assert.match(r.headers['content-type'], /^application\/json/);
  const body = JSON.parse(r.body);
  assert.equal(body.text, htmlText(content));
  assert.deepEqual(body.sentences, sentences(content).map((s) => [s.start, s.end]));
  assert.deepEqual([body.id, body.title, body.progress, body.anchor], [doc.id, 'Vom Lesen', 0, 0]);
  assert.equal((await page('/lesen/hoeren/text?id=gibtsnicht')).status, 404);

  assert.match((await page('/lesen/stapel?zeit=30')).html, /<a href="\/lesen\/hoeren\?zeit=30" class="btn quiet">Unterwegs hören<\/a>/);
  assert.match((await page('/lesen/stapel')).html, /href="\/lesen\/hoeren\?zeit=15"/);
});

/** /static/lesen-hoeren.js auf der gerenderten Seite ausführen; `window` sind die Browser-Fähigkeiten. */
async function runPlayerScript(window) {
  const { page } = setup();
  const { document } = parseHTML((await page('/lesen/hoeren?zeit=30')).html);
  const context = { window, document, location: { search: '?zeit=30' }, URLSearchParams, Element: document.defaultView.Element, localStorage: { getItem: () => null, setItem() {} }, navigator: {}, fetch: () => new Promise(() => {}) };
  vm.runInNewContext(readFileSync(new URL('../src/web/static/lesen-hoeren.js', import.meta.url), 'utf8'), context);
  return document.querySelector('.hoeren-player');
}

test('Hören: in der iOS-App geht „Abspielen“ an die Brücke statt an die Sprachausgabe', async () => {
  const posted = [];
  const spoken = [];
  const speechSynthesis = { getVoices: () => [], speak: (u) => spoken.push(u), cancel() {} };
  const player = await runPlayerScript({ webkit: { messageHandlers: { cockpit: { postMessage: (m) => posted.push({ ...m }) } } }, speechSynthesis, cockpit: {} });
  assert.equal(player.hidden, false);
  assert.equal(player.querySelector('[data-cmd=next]').hidden, true);
  player.querySelector('[data-cmd=play]').click();
  assert.deepEqual(posted, [{ type: 'hoeren', zeit: 30 }]);
  assert.deepEqual(spoken, []);
});

test('Hören: im Browser bleibt die Sprachausgabe, ohne Brücke', async () => {
  const speechSynthesis = { getVoices: () => [], speak() {}, cancel() {} };
  const player = await runPlayerScript({ speechSynthesis, cockpit: { toast() {}, send() {}, csrf: () => 'c' } });
  assert.equal(player.hidden, false);
  assert.equal(player.querySelector('[data-cmd=next]').hidden, false);
});
