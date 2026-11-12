import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReadingStore } from '../src/lesen/store.js';
import { fitToWindow, remainingMinutes, stackRoutes } from '../src/lesen/stack.js';

const doc = (id, reading_minutes, progress = 0) => ({ id, reading_minutes, progress });
const ids = (r) => r.items.map((d) => d.id);

test('Stapel: Restzeit aufgerundet, mindestens eine Minute', () => {
  assert.equal(remainingMinutes(doc('a', 20, 0.5)), 10);
  assert.equal(remainingMinutes(doc('a', 7, 0.5)), 4);
  assert.equal(remainingMinutes(doc('a', 10, 1)), 1);
  assert.equal(remainingMinutes(doc('a', 0)), 1);
});

test('Stapel: fitToWindow füllt gierig, Summe nie über dem Fenster', () => {
  assert.deepEqual(fitToWindow([], 15), { items: [], total: 0 });
  assert.deepEqual(ids(fitToWindow([doc('a', 20), doc('b', 16)], 15)), [], 'nichts passt');
  const exact = fitToWindow([doc('a', 3), doc('b', 10), doc('c', 20), doc('d', 5)], 15);
  assert.deepEqual(ids(exact), ['b', 'd'], 'längste zuerst, genau passend');
  assert.equal(exact.total, 15);
  const some = fitToWindow([doc('a', 4), doc('b', 9), doc('c', 8)], 15);
  assert.deepEqual(ids(some), ['b', 'a']);
  assert.equal(some.total, 13);
});

test('Stapel: angefangene Texte zuerst und mit ihrer Restzeit', () => {
  // 20 min zur Hälfte gelesen: 10 min Rest, kommt vor dem neuen 12-Minuten-Text.
  const r = fitToWindow([doc('neu', 12), doc('kurz', 2), doc('halb', 20, 0.5)], 15);
  assert.deepEqual(ids(r), ['halb', 'kurz']);
  assert.equal(r.items[0].remaining, 10);
  assert.equal(r.total, 12);
  // Angefangen, aber zu lang für das Fenster: übersprungen.
  assert.deepEqual(ids(fitToWindow([doc('lang', 60, 0.25), doc('kurz', 5)], 15)), ['kurz']);
  // Ohne Lesezeit (nichts extrahiert) ist die Länge unbekannt: nicht im Fenster.
  assert.deepEqual(ids(fitToWindow([doc('leer', 0), doc('kurz', 5)], 15)), ['kurz']);
});

/** Seite direkt aufrufen, ohne HTTP; `ctx` wie aus src/web/http.js. */
async function page(store, query = '') {
  const ctx = { url: new URL(`https://vault.test/lesen/stapel${query}`), user: 'ruben', tz: 'Europe/Berlin', write: { csrf: 'c', back: '/lesen/stapel' }, flash: null };
  const { html } = await stackRoutes({ store }).pages['/lesen/stapel'](ctx);
  assert.ok(!/style=|<script>/.test(html), 'keine Inline-Styles oder -Skripte');
  return html;
}

function stackStore(docs) {
  const store = createReadingStore({ path: ':memory:' });
  const out = {};
  for (const [title, minutes, progress = 0] of docs) {
    const { doc: d } = store.addDocument({ url: `https://blatt.test/${encodeURIComponent(title)}`, title, reading_minutes: minutes, status: 'stapel' });
    if (progress) store.setProgress(d.id, progress);
    out[title] = d.id;
  }
  return { store, ids: out };
}

test('Stapel-Seite: Zeitfenster mit Balken, Weiterlesen und Hinweis auf den Rest', async () => {
  const { store, ids: id } = stackStore([['Lang', 40], ['Mittel', 10], ['Halb', 8, 0.5], ['Kurz', 1], ['Extra', 3]]);
  store.addDocument({ url: 'https://blatt.test/eingang', title: 'Noch im Eingang', reading_minutes: 1 });
  const html = await page(store, '?zeit=15');
  assert.match(html, /<a href="\/lesen\/stapel\?zeit=15" class="chip" aria-current="true">15 Min\.<\/a>/);
  assert.match(html, /<progress class="stapel-bar" value="15" max="15" aria-hidden="true"><\/progress>\s*<span class="meta">15 von 15 Min\.<\/span>/);
  // Angefangen: Stand als Balken mit Prozent vor der Restzeit, „Weiterlesen“ bleibt für Screenreader.
  assert.match(html, new RegExp(`<a href="/lesen/doc\\?id=${id.Halb}#weiter" class="lesen-title">Halb</a>\\s*<span class="meta"><span class="stapel-stand"><progress max="100" value="50" aria-hidden="true"></progress><span class="sr-only">Weiterlesen, </span>50 %</span> · noch 4 Min\\.</span>`));
  assert.match(html, new RegExp(`<a href="/lesen/doc\\?id=${id.Kurz}" class="lesen-title">Kurz</a>\\s*<span class="meta">1 Min\\.</span>`), 'nicht angefangen: ohne Balken');
  // Eine Werkzeugzeile: Zeitfenster links, daneben der Füllbalken; die Sortierung gibt es nur ohne Fenster.
  assert.match(html, /<div class="stapel-werkzeug"><nav class="chips stapel-zeit" aria-label="Zeitfenster">[^]*?<\/nav><div class="stapel-fill">/);
  assert.ok(!html.includes('stapel-sort'));
  // „Unterwegs hören“ steht im Seitenkopf neben der Überschrift.
  assert.match(html, /<div class="page-head"><div class="stapel-kopfzeile"><h1>Stapel<\/h1><p class="stapel-kopf"><a href="\/lesen\/hoeren\?zeit=15" class="btn quiet">Unterwegs hören<\/a><\/p><\/div><\/div>/);
  assert.match(html, new RegExp(`/lesen/doc\\?id=${id.Mittel}"`));
  assert.match(html, new RegExp(`/lesen/doc\\?id=${id.Kurz}"`));
  assert.ok(!html.includes(id.Extra) && !html.includes(id.Lang));
  assert.ok(!html.includes('Noch im Eingang'));
  assert.match(html, /<p class="meta stapel-rest">2 weitere warten<\/p>/);
});

test('Stapel-Seite: nichts passt, dann der kürzeste längere Text als Vorschlag', async () => {
  const { store, ids: id } = stackStore([['Lang', 40], ['Länger', 90], ['Kürzer', 20]]);
  const html = await page(store, '?zeit=15');
  assert.match(html, /Nichts passt ganz – lies den Anfang eines längeren Textes/);
  assert.match(html, new RegExp(`/lesen/doc\\?id=${id.Kürzer}"`));
  assert.ok(!html.includes(id.Lang) && !html.includes('stapel-bar'));
});

test('Stapel-Seite: ohne Zeitfenster alle Texte, Sortierung umschaltbar, falsches Fenster zählt nicht', async () => {
  const { store } = stackStore([['Alt', 5], ['Halb', 30, 0.5], ['Neu', 12]]);
  const order = (html) => [...html.matchAll(/class="lesen-title">([^<]+)</g)].map((m) => m[1]);
  const def = await page(store);
  assert.deepEqual(order(def), ['Halb', 'Alt', 'Neu'], 'Passt jetzt: angefangene zuerst, dann kürzeste');
  assert.match(def, /<a href="\/lesen\/stapel" class="chip" aria-current="true">Alle<\/a>/);
  assert.match(def, /<a href="\/lesen\/stapel\?sort=passt" class="chip" aria-current="true">Passt jetzt<\/a>/);
  assert.match(def, /<div class="stapel-werkzeug"><nav class="chips stapel-zeit" aria-label="Zeitfenster">[^]*?<\/nav><nav class="chips stapel-sort" aria-label="Sortierung">/, 'Zeitfenster und Sortierung in einer Zeile');
  assert.ok(!def.includes('stapel-fill'), 'ohne Zeitfenster kein Füllbalken');
  assert.match(def, /<span class="stapel-stand"><progress max="100" value="50" aria-hidden="true"><\/progress>/);
  assert.ok(!def.includes('weitere warten'));
  assert.deepEqual(order(await page(store, '?sort=neu')), ['Neu', 'Halb', 'Alt']);
  assert.deepEqual(order(await page(store, '?sort=kurz')), ['Alt', 'Neu', 'Halb']);
  assert.deepEqual(order(await page(store, '?zeit=7&sort=quatsch')), ['Halb', 'Alt', 'Neu']);
  assert.match(await page(createReadingStore({ path: ':memory:' }), '?zeit=15'), /Auf dem Stapel liegt nichts/);
});

test('Stapel-Seite: nach Gruppe gefiltert, Zeitfenster- und Sortier-Chips tragen `gruppe`, Hören nicht', async () => {
  const { store } = stackStore([['Gespeichert', 5]]);
  const tech = store.addGroup({ name: 'Tech' }).group;
  const feed = store.addFeed({ url: 'https://a.test/feed', title: 'A', group_id: tech.id }).feed;
  store.addDocument({ url: 'https://a.test/1', title: 'Aus Tech', reading_minutes: 4, status: 'stapel', origin: `feed:${feed.id}` });
  const titles = (html) => [...html.matchAll(/class="lesen-title">([^<]+)</g)].map((m) => m[1]);
  const g = `gruppe=${tech.id}`;

  const html = await page(store, `?${g}`);
  assert.deepEqual(titles(html), ['Aus Tech']);
  assert.match(html, new RegExp(`<a href="/lesen/stapel\\?${g}" class="chip" aria-current="true">Alle</a><a href="/lesen/stapel\\?zeit=5`));
  assert.match(html, new RegExp(`<a href="/lesen/stapel\\?zeit=15&amp;${g}" class="chip">15 Min\\.</a>`));
  assert.match(html, new RegExp(`<a href="/lesen/stapel\\?sort=kurz&amp;${g}" class="chip">Kürzeste</a>`));
  assert.match(html, /href="\/lesen\/hoeren\?zeit=15"/);
  assert.deepEqual(titles(await page(store, '?gruppe=ohne')), ['Gespeichert']);
  assert.deepEqual(titles(await page(store, '?gruppe=quatsch&sort=neu')), ['Aus Tech', 'Gespeichert']);

  // Gruppen-Chips behalten das Zeitfenster.
  const window = await page(store, `?zeit=15&${g}`);
  assert.match(window, new RegExp(`<a href="/lesen/stapel\\?zeit=15&amp;${g}" class="chip" aria-current="true">Tech</a>`));
  assert.match(window, /<a href="\/lesen\/stapel\?zeit=15&amp;gruppe=ohne" class="chip">Ohne Feed<\/a>/);
  assert.ok(!(await page(stackStore([['X', 5]]).store)).includes('lesen-gruppe'), 'ohne Gruppen keine Gruppen-Chips');
});

test('Stapel-Seite: Abzeichen und Menü „⋯“ rechts in der Zeile, „Im Vault ablegen“ als Formular im Menü', async () => {
  const { store, ids: id } = stackStore([['Mit Entwurf', 5], ['Ohne', 7]]);
  const ctx = { url: new URL('https://vault.test/lesen/stapel'), user: 'ruben', tz: 'Europe/Berlin', write: { csrf: 'c', back: '/lesen/stapel' }, flash: null };
  const ingest = { statusFor: () => new Map([[id['Mit Entwurf'], 'bereit']]), available: () => ({ ok: false }) };
  const { html } = await stackRoutes({ store, vault: true, folgen: true, ingest }).pages['/lesen/stapel'](ctx);
  assert.ok(!/style=|<script>/.test(html), 'keine Inline-Styles oder -Skripte');
  // Erst das Abzeichen, dann das Menü; das Formular geht auch ohne JavaScript (<details>).
  assert.match(html, new RegExp(`<div class="lesen-item-acts"><a href="/lesen/ingest/doc\\?id=${id['Mit Entwurf']}" class="ingest-badge is-ready"[^>]*>Ingest bereit<span class="sr-only">: Mit Entwurf</span></a><details class="menu stapel-mehr"><summary class="menu-button" aria-label="Mehr zu: Mit Entwurf"`));
  assert.match(html, /<div class="lesen-item-acts"><details class="menu stapel-mehr">[^]*?<form method="post" action="\/aktion\/lesen\/ablegen" class="act lesen-ablegen">[^]*?<button type="submit" class="btn">Im Vault ablegen<span class="sr-only">: Ohne<\/span><\/button><\/form>/, 'ohne Entwurf und ohne Claude: nur das Menü');
  assert.match(html, /<p class="stapel-kopf"><a href="\/lesen\/hoeren\?zeit=15" class="btn quiet">Unterwegs hören<\/a> <a href="\/lesen\/folgen\/neu\?zeit=30" class="btn quiet">Folge erzeugen<\/a><\/p>/);
  // Ohne Vault und ohne Ingest bleibt die Zeile bei Titel und Meta.
  assert.ok(!(await page(store)).includes('lesen-item-acts'));
});
