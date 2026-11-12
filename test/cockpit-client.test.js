// Aufklappbares der Wochenansicht im Browser (src/web/static/cockpit.js, VCP-145)
// im Sandkasten: DOM aus linkedom, `fetch` nachgebaut. Es läuft genau die
// Datei, die der Browser lädt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { parseHTML } from 'linkedom';

const SOURCE = readFileSync(new URL('../src/web/static/cockpit.js', import.meta.url), 'utf8');
const settle = () => new Promise((r) => setTimeout(r, 5));

const task = (id, title) => `<li class="task status-open" data-id="${id}" data-status="open" data-title="${title}">
  <form method="post" action="/aktion/zuordnen" class="act"><input type="hidden" name="csrf" value="c"><input type="hidden" name="id" value="${id}"><input type="hidden" name="ziel" value="area:a1"><button type="submit">Zuordnen</button></form>
</li>`;

/** `main` der Woche, so weit cockpit.js es braucht: Bereiche, „weitere“ in Aufgaben und Inbox. */
const week = ({ inbox = ['t1', 't2', 't3'], extra = '' } = {}) => `<main class="week-main today-first">
  <section class="big-rocks"><div class="rocks">
    <details class="rock" data-keep="rock:Selbstverwirklichung" open><summary><h3>Selbstverwirklichung</h3></summary><ul></ul></details>
    <details class="rock" data-keep="rock:Arbeit" open data-fold><summary><h3>Arbeit</h3></summary><ul></ul></details>
    <details class="rock all-done" data-keep="rock:Freundschaften"><summary><h3>Freundschaften</h3></summary><ul></ul></details>
    ${extra}
  </div></section>
  <section class="tasks"><ul></ul><details class="more-items" data-keep="aufgaben-mehr"><summary>2 weitere</summary><ul></ul></details></section>
  <section id="inbox" class="inbox"><ul data-list="zunder-inbox">${task('t0', 'Vorn')}</ul>
    <details class="more-items" data-keep="zunder-inbox-mehr"><summary>${inbox.length} weitere</summary><ul data-list="zunder-inbox">${inbox.map((id) => task(id, id)).join('')}</ul></details>
  </section>
</main>`;

/** Lädt cockpit.js in eine Seite. `narrow`: Bildschirm bis 900 px. `pages`: was `GET /` nacheinander liefert. */
async function loadPage({ narrow = false, html = week(), pages = [] } = {}) {
  const page = parseHTML(`<!doctype html><html lang="de"><body class="page-week">${html}<div class="toasts"></div></body></html>`);
  const { document } = page;
  // linkedom kennt weder `details.open` noch Formular-Sammlungen: so viel nachbauen, wie cockpit.js braucht.
  const detailsProto = Object.getPrototypeOf(document.createElement('details'));
  if (!Object.getOwnPropertyDescriptor(detailsProto, 'open')) {
    Object.defineProperty(detailsProto, 'open', {
      configurable: true,
      get() {
        return this.hasAttribute('open');
      },
      set(v) {
        if (v) this.setAttribute('open', '');
        else this.removeAttribute('open');
      },
    });
  }
  const formProto = Object.getPrototypeOf(document.createElement('form'));
  for (const [name, get] of Object.entries({
    action: function () {
      return this.getAttribute('action');
    },
    elements: function () {
      const list = [...this.querySelectorAll('input, textarea, button, select')];
      for (const f of list) if (f.getAttribute('name')) list[f.getAttribute('name')] = f;
      return list;
    },
  })) {
    if (!(name in formProto)) Object.defineProperty(formProto, name, { get, configurable: true });
  }
  if (!document.adoptNode) document.adoptNode = (node) => node;

  const requests = [];
  const queue = [...pages];
  const fetch = async (url, init = {}) => {
    const method = init.method ?? 'GET';
    requests.push(`${method} ${url}`);
    if (method === 'POST') return new Response(JSON.stringify({ ok: true, message: 'Zugeordnet' }), { status: 200, headers: { 'content-type': 'application/json' } });
    return new Response(`<!doctype html><html><body>${queue.shift() ?? week()}</body></html>`, { status: 200, headers: { 'content-type': 'text/html' } });
  };
  const is = (name) => ({ [Symbol.hasInstance]: (v) => v?.localName === name });
  const ctx = vm.createContext({
    document,
    location: { href: 'https://vault.test/', assign() {} },
    history: { state: null, replaceState() {} },
    navigator: { onLine: true },
    fetch,
    matchMedia: (query) => ({ matches: narrow && query === '(max-width: 900px)' }),
    DOMParser: page.DOMParser,
    URL,
    URLSearchParams,
    Date,
    CSS: { escape: (v) => v },
    Element: page.Element,
    HTMLElement: page.HTMLElement,
    HTMLFormElement: is('form'),
    HTMLDetailsElement: is('details'),
    HTMLTextAreaElement: is('textarea'),
    FormData: class {
      constructor(form) {
        this.list = [...form.querySelectorAll('input[name]')].map((f) => [f.getAttribute('name'), f.getAttribute('value') ?? '']);
      }
      [Symbol.iterator]() {
        return this.list[Symbol.iterator]();
      }
    },
    // Meldungen blenden sich nach Sekunden selbst aus: Der Test wartet darauf nicht.
    setTimeout: (fn, ms) => setTimeout(fn, ms).unref(),
    clearTimeout,
    setInterval() {},
    confirm: () => true,
  });
  ctx.window = ctx;
  vm.runInContext(SOURCE, ctx);
  const open = () => Object.fromEntries([...document.querySelectorAll('details[data-keep]')].map((d) => [d.getAttribute('data-keep'), d.hasAttribute('open')]));
  const details = (keep) => [...document.querySelectorAll('details[data-keep]')].find((d) => d.getAttribute('data-keep') === keep);
  /** Schickt das Aktionsformular einer Aufgabe ab und wartet, bis cockpit.js `main` getauscht hat. */
  const act = async (id) => {
    const before = document.querySelector('main');
    document.querySelector(`li[data-id="${id}"] form.act`).dispatchEvent(new page.Event('submit', { bubbles: true, cancelable: true }));
    for (let i = 0; i < 200 && document.querySelector('main') === before; i++) await settle();
    assert.notEqual(document.querySelector('main'), before, 'main wurde getauscht');
  };
  return { document, requests, open, details, act };
}

test('cockpit.js: schmal klappen Bereiche ohne offenen Phönix-Schritt zu, breit bleibt alles, wie der Server es liefert', async () => {
  const wide = await loadPage();
  assert.deepEqual(wide.open(), { 'rock:Selbstverwirklichung': true, 'rock:Arbeit': true, 'rock:Freundschaften': false, 'aufgaben-mehr': false, 'zunder-inbox-mehr': false });
  const phone = await loadPage({ narrow: true });
  assert.deepEqual(phone.open(), { 'rock:Selbstverwirklichung': true, 'rock:Arbeit': false, 'rock:Freundschaften': false, 'aufgaben-mehr': false, 'zunder-inbox-mehr': false });
});

test('cockpit.js: aufgeklapptes „weitere“ und der Stand der Bereiche überleben den Tausch von main nach einer Aktion', async () => {
  // Nach dem Zuordnen von t2 liefert der Server die Inbox ohne t2, alles wieder im Ausgangszustand.
  const fresh = week({ inbox: ['t1', 't3'], extra: '<details class="rock" data-keep="rock:Neu" open data-fold><summary><h3>Neu</h3></summary><ul></ul></details>' });
  const page = await loadPage({ narrow: true, pages: [fresh, week({ inbox: ['t3'] })] });
  // Die Inbox aufklappen, einen zugeklappten Bereich öffnen, einen offenen schließen.
  page.details('zunder-inbox-mehr').open = true;
  page.details('rock:Arbeit').open = true;
  page.details('rock:Selbstverwirklichung').open = false;

  await page.act('t2');
  assert.deepEqual(page.requests, ['POST /aktion/zuordnen', 'GET https://vault.test/']);
  assert.equal(page.document.querySelector('li[data-id="t2"]'), null, 'die neue Ansicht steht da');
  assert.deepEqual(page.open(), {
    'rock:Selbstverwirklichung': false,
    'rock:Arbeit': true,
    'rock:Freundschaften': false,
    // Ein Bereich, den es vorher nicht gab, folgt der Regel für schmale Bildschirme.
    'rock:Neu': false,
    'aufgaben-mehr': false,
    'zunder-inbox-mehr': true,
  });

  // Die nächste Aufgabe aus dem aufgeklappten Rest: bleibt wieder offen.
  await page.act('t1');
  assert.equal(page.details('zunder-inbox-mehr').hasAttribute('open'), true);
  assert.equal(page.details('rock:Arbeit').hasAttribute('open'), true);
});
