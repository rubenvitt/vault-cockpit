import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, renameSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildIndex, openIndex } from '../src/vault/index.js';
import { compilePolicy } from '../src/vault/policy.js';
import { createEditor } from '../src/vault/edit.js';
import { createSettingsStore } from '../src/cockpit/settings.js';
import { createReadingStore } from '../src/lesen/store.js';
import { readingRoutes } from '../src/lesen/http.js';
import { createReadingExport, noteContent, blockId, parseLinks, slugOf, DEFAULT_FOLDER, TEXT_SECTION, SECTION as SECTION_NAME } from '../src/lesen/vault-export.js';
import { findSection } from '../src/vault/generated-section.js';
import { sanitizeHtml } from '../src/lesen/extract.js';

const quiet = { info() {}, warn() {}, error() {} };
const FOLDER = 'raw';
let root, idx, editor, settings, store, policy, exporter, doc;

const read = (p) => readFileSync(join(root, p), 'utf8');
const make = (opts = {}) =>
  createReadingExport({ vaultPath: root, index: idx, editor, policy, store, settings, now: () => new Date('2026-10-23T10:00:00Z'), delayMs: 60_000, logger: quiet, ...opts });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'lesestapel-vault-'));
  mkdirSync(join(root, 'inbox'));
  writeFileSync(join(root, 'inbox/Start.md'), '# Start\n');
  policy = compilePolicy({ sensitive: { '20-bereiche/Gesundheit': 'gesundheit' }, readwise: '30-ressourcen/readwise' });
  buildIndex({ vaultPath: root, dbPath: ':memory:', policy, logger: quiet, persist: (db, vp) => (idx = openIndex(db, { vaultPath: vp, policy })) });
  editor = createEditor({ vaultPath: root, index: idx });
  settings = createSettingsStore({ defaults: { tz: 'Europe/Berlin' }, logger: quiet });
  store = createReadingStore({ path: ':memory:', now: () => Date.parse('2026-10-20T08:00:00Z') });
  ({ doc } = store.addDocument({ url: 'https://blatt.test/a', title: 'Vom Lesen: Über Stapel', site: 'Blatt', status: 'stapel', topics: ['Lesen', 'Gewohnheit'] }));
  exporter = make();
});
afterEach(() => {
  exporter.stop();
  idx.close();
  rmSync(root, { recursive: true, force: true });
});

const pathOf = () => exporter.notePath(doc.id);

test('Policy: der Lesestapel-Ordner fällt nicht unter Readwise und ist nicht vertraulich (sonst keine Embeddings)', () => {
  const example = compilePolicy(JSON.parse(readFileSync(new URL('../policy.example.json', import.meta.url), 'utf8')));
  for (const p of [example, compilePolicy({ readwise: '30-ressourcen/readwise' }), policy]) {
    assert.equal(p.classify(`${DEFAULT_FOLDER}/vom-lesen.md`), 'core');
    assert.equal(p.sensitivityOf(`${DEFAULT_FOLDER}/vom-lesen.md`), null);
    assert.equal(p.isExcluded(`${DEFAULT_FOLDER}/vom-lesen.md`), false);
  }
  assert.equal(settings.get().readingNotes.folder, DEFAULT_FOLDER);
});

test('Archivieren: Markierung erscheint als Notiz mit Block-ID; vorher und ohne Markierungen nichts', () => {
  exporter.changed(doc.id);
  assert.deepEqual(exporter.flush().map((r) => r.state), ['wartet']);
  store.setStatus(doc.id, 'archiv');
  exporter.changed(doc.id);
  assert.deepEqual(exporter.flush().map((r) => r.state), ['wartet']);
  assert.ok(!existsSync(join(root, FOLDER)));

  const h = store.addHighlight({ doc_id: doc.id, quote: 'Ein Satz,\nden man sich merkt.', note: 'Stimmt.', start_hint: 10 });
  exporter.changed(doc.id);
  const [r] = exporter.flush();
  assert.equal(r.state, 'angelegt');
  assert.equal(r.path, `${FOLDER}/2026-10-20_vom-lesen-ueber-stapel.md`);
  const id = blockId(h.id);
  assert.match(id, /^hl-[0-9a-f]{8}$/);
  const text = read(r.path);
  assert.equal(
    text.replace(/ende [0-9a-f]{8}/, 'ende X'),
    `---
type: lesestapel
lesestapel_id: "${doc.id}"
quelle: "Blatt"
url: "https://blatt.test/a"
gespeichert: 2026-10-20
lesestatus: gelesen
gelesen: 2026-10-20
themen:
  - "Lesen"
  - "Gewohnheit"
---

# Vom Lesen: Über Stapel

[Original](<https://blatt.test/a>)

## Markierungen

<!-- cockpit:markierungen:start · aus dem Lesestapel, das Cockpit schreibt bis zum Endmarker neu -->

> Ein Satz,
> den man sich merkt.

^${id}

Stimmt.

<!-- cockpit:markierungen:ende X -->

## Eigene Gedanken
`,
  );
  // Im Index: eigene Notiz (wird eingebettet), Frontmatter gelesen, über die ID auffindbar.
  const note = idx.getNote(r.path);
  assert.equal(note.class, 'core');
  assert.deepEqual([note.frontmatter.type, note.frontmatter.lesestapel_id, note.frontmatter.themen], ['lesestapel', doc.id, ['Lesen', 'Gewohnheit']]);
  assert.equal(pathOf(), r.path);
  assert.equal(exporter.status().lastWrite.path, r.path);
});

test('Fortschritt 1 allein legt nichts an (erst die Entscheidung, VCP-96); Titel doppelt → eigener Dateiname', () => {
  const { doc: other } = store.addDocument({ url: 'https://blatt.test/b', title: 'Vom Lesen: über Stapel!' });
  for (const d of [doc, other]) {
    store.setProgress(d.id, 1);
    store.addHighlight({ doc_id: d.id, quote: 'Satz' });
    exporter.changed(d.id);
  }
  assert.deepEqual(exporter.flush().map((r) => r.state), ['wartet', 'wartet']);
  for (const d of [doc, other]) {
    store.setStatus(d.id, 'archiv');
    exporter.changed(d.id);
  }
  const paths = exporter.flush().map((r) => r.path);
  assert.deepEqual(paths, [`${FOLDER}/2026-10-20_vom-lesen-ueber-stapel.md`, `${FOLDER}/2026-10-20_vom-lesen-ueber-stapel-${blockId(other.id).slice(3)}.md`]);
  assert.match(read(paths[0]), /^gelesen: 2026-10-20$/m);
  assert.equal(slugOf('  ?? '), 'text');
});

test('Update: nur der Bereich ändert sich, eigener Text darunter bleibt, Umbenennen und Verschieben schaden nicht', () => {
  store.setStatus(doc.id, 'archiv');
  const h1 = store.addHighlight({ doc_id: doc.id, quote: 'Erste Stelle', start_hint: 1 });
  exporter.changed(doc.id);
  const [{ path }] = exporter.flush();

  // In Obsidian umbenannt und verschoben, darunter eigene Gedanken.
  const moved = '30-ressourcen/gelesen/Über Stapel.md';
  mkdirSync(join(root, '30-ressourcen/gelesen'), { recursive: true });
  renameSync(join(root, path), join(root, moved));
  writeFileSync(join(root, moved), `${read(moved)}\nMein Gedanke mit [[Start]].\n\n## Noch was\n\nText.\n`);
  idx.refresh(path);
  idx.refresh(moved);

  store.updateHighlight(h1.id, { note: 'Notiz dazu' });
  const h2 = store.addHighlight({ doc_id: doc.id, quote: 'Zweite Stelle', start_hint: 2 });
  exporter.changed(doc.id);
  assert.deepEqual(exporter.flush().map((r) => [r.state, r.path]), [['geschrieben', moved]]);
  const text = read(moved);
  assert.match(text, new RegExp(`> Erste Stelle\\n\\n\\^${blockId(h1.id)}\\n\\nNotiz dazu\\n\\n> Zweite Stelle\\n\\n\\^${blockId(h2.id)}\\n\\n<!-- cockpit:markierungen:ende`));
  assert.ok(text.endsWith('## Eigene Gedanken\n\nMein Gedanke mit [[Start]].\n\n## Noch was\n\nText.\n'));
  assert.ok(!existsSync(join(root, path)), 'keine zweite Notiz');

  // Unverändert: kein Schreibvorgang. Alle Markierungen weg: Bereich sagt es.
  exporter.changed(doc.id);
  assert.equal(exporter.flush()[0].state, 'aktuell');
  store.deleteHighlight(h1.id);
  store.deleteHighlight(h2.id);
  exporter.changed(doc.id);
  exporter.flush();
  assert.match(read(moved), /start[^\n]*-->\n\nKeine Markierungen\.\n\n<!-- cockpit:markierungen:ende/);
  assert.match(read(moved), /Mein Gedanke mit \[\[Start\]\]\./);
});

test('Sync ändert gleichzeitig: Schreiben bricht ab, nichts geht verloren, der nächste Lauf holt es nach', () => {
  store.setStatus(doc.id, 'archiv');
  store.addHighlight({ doc_id: doc.id, quote: 'Erste Stelle', start_hint: 1 });
  exporter.changed(doc.id);
  const [{ path }] = exporter.flush();
  const older = read(path);
  store.addHighlight({ doc_id: doc.id, quote: 'Zweite Stelle', start_hint: 2 });
  exporter.changed(doc.id);
  exporter.flush();

  // Ein anderes Gerät liefert zwischen Planen und Schreiben seinen Stand: alter Bereich, neuer eigener Gedanke.
  const synced = `${older}\nVom iPhone.\n`;
  let raced = false;
  const racing = {
    ...editor,
    replace(args) {
      if (!raced) {
        raced = true;
        writeFileSync(join(root, path), synced);
      }
      return editor.replace(args);
    },
  };
  const svc = make({ editor: racing });
  store.addHighlight({ doc_id: doc.id, quote: 'Dritte Stelle', start_hint: 3 });
  svc.changed(doc.id);
  assert.equal(svc.flush()[0].state, 'fehler');
  assert.equal(read(path), synced);
  assert.deepEqual(svc.pending(), [doc.id]);
  assert.match(svc.status().lastError.message, /kommt in der Notiz nicht vor/);

  assert.equal(svc.flush()[0].state, 'geschrieben');
  assert.deepEqual(svc.pending(), []);
  const text = read(path);
  assert.match(text, /> Erste Stelle[^]*> Zweite Stelle[^]*> Dritte Stelle/);
  assert.ok(text.endsWith('## Eigene Gedanken\n\nVom iPhone.\n'));
  svc.stop();
});

test('Entprellt: ohne flush schreibt der Zeitgeber, nach einem Fehler noch einmal', async () => {
  const wait = (ms) => new Promise((res) => setTimeout(res, ms));
  store.setStatus(doc.id, 'archiv');
  store.addHighlight({ doc_id: doc.id, quote: 'Erste Stelle', start_hint: 1 });
  let calls = 0;
  const flaky = {
    ...editor,
    create(args) {
      if (!calls++) throw new Error('gerade anderweitig geändert');
      return editor.create(args);
    },
  };
  const svc = make({ editor: flaky, delayMs: 5 });
  svc.changed(doc.id);
  svc.changed(doc.id);
  await wait(30);
  await wait(30);
  assert.equal(calls, 2);
  assert.deepEqual(svc.pending(), []);
  assert.match(read(svc.notePath(doc.id)), /> Erste Stelle/);
  svc.stop();
});

test('Von Hand im Bereich geschrieben: Notiz bleibt stehen, kein Dauerversuch', () => {
  store.setStatus(doc.id, 'archiv');
  store.addHighlight({ doc_id: doc.id, quote: 'Stelle' });
  exporter.changed(doc.id);
  const [{ path }] = exporter.flush();
  const edited = read(path).replace('> Stelle', '> Stelle, ergänzt');
  writeFileSync(join(root, path), edited);
  store.addHighlight({ doc_id: doc.id, quote: 'Noch eine' });
  exporter.changed(doc.id);
  const [r] = exporter.flush();
  assert.equal(r.state, 'übersprungen');
  assert.match(r.reason, /von Hand/);
  assert.equal(read(path), edited);
  assert.deepEqual(exporter.pending(), []);
});

test('Wikilinks zur Markierung: addLink schreibt „Verknüpft“, Neuschreiben behält sie', () => {
  const h = store.addHighlight({ doc_id: doc.id, quote: 'Stelle', start_hint: 1 });
  // Noch nicht gelesen: Verknüpfen legt die Notiz trotzdem an.
  const r = exporter.addLink({ highlightId: h.id, target: 'Start' });
  assert.equal(r.state, 'angelegt');
  assert.equal(exporter.addLink({ highlightId: h.id, target: 'Synthese Lesen#Stapel|Lesen' }).state, 'geschrieben');
  assert.equal(exporter.addLink({ highlightId: h.id, target: 'Start' }).state, 'aktuell');
  assert.throws(() => exporter.addLink({ highlightId: h.id, target: 'a]]b' }), /Ungültiges Ziel/);
  assert.throws(() => exporter.addLink({ highlightId: 'gibt-es-nicht', target: 'Start' }), /gibt es nicht/);

  store.addHighlight({ doc_id: doc.id, quote: 'Später', start_hint: 2 });
  exporter.changed(doc.id);
  assert.equal(exporter.flush()[0].state, 'geschrieben');
  const text = read(r.path);
  assert.match(text, new RegExp(`\\^${blockId(h.id)}\\n\\nVerknüpft: \\[\\[Start\\]\\] · \\[\\[Synthese Lesen#Stapel\\|Lesen\\]\\]\\n\\n> Später`));
  assert.deepEqual(parseLinks(text).get(blockId(h.id)), ['Start', 'Synthese Lesen#Stapel|Lesen']);
  // Der Link zeigt in Obsidian auf die Notiz (der Index kennt ihn).
  assert.ok(idx.outgoingLinks(r.path).some((l) => l.path === 'inbox/Start.md'));
});

test('Vertraulich: kein Anlegen im vertraulichen Ordner, keine zweite Notiz nach Verschieben dorthin', () => {
  store.setStatus(doc.id, 'archiv');
  store.addHighlight({ doc_id: doc.id, quote: 'Stelle' });
  for (const folder of ['20-bereiche/Gesundheit/lesen', '30-ressourcen/readwise/x']) {
    settings.save({ readingNotes: { folder }, calendars: [] });
    exporter.changed(doc.id);
    assert.equal(exporter.flush()[0].state, 'übersprungen');
    assert.ok(!existsSync(join(root, folder)));
  }
  settings.save({ readingNotes: { folder: null }, calendars: [] });
  exporter.changed(doc.id);
  const [{ path }] = exporter.flush();

  const secret = '20-bereiche/Gesundheit/Stapel.md';
  mkdirSync(join(root, '20-bereiche/Gesundheit'), { recursive: true });
  renameSync(join(root, path), join(root, secret));
  idx.refresh(path);
  idx.refresh(secret);
  const before = read(secret);
  store.addHighlight({ doc_id: doc.id, quote: 'Neu' });
  exporter.changed(doc.id);
  assert.deepEqual(exporter.flush().map((r) => [r.state, r.path]), [['übersprungen', secret]]);
  assert.equal(read(secret), before);
  assert.deepEqual(readdirSync(join(root, FOLDER)), []);
  for (const folder of ['../raus', '.ablage/x']) assert.throws(() => settings.save({ readingNotes: { folder }, calendars: [] }), /Pfad im Vault/);
});

test('Verdrahtung: Statuswechsel und Markierungs-Aktionen melden das Dokument, Fortschritt nicht', async () => {
  const seen = [];
  const routes = readingRoutes({ store, onChange: (id) => seen.push(id), logger: quiet });
  const act = (path, fields) => routes.actions[path](new URLSearchParams(fields), { sub: 'ruben' });
  await act('/aktion/lesen/doc/fortschritt', { id: doc.id, fortschritt: '0.5' });
  assert.deepEqual(seen, []);
  await act('/aktion/lesen/doc/fortschritt', { id: doc.id, fortschritt: '1' });
  await act('/aktion/lesen/doc/status', { id: doc.id, status: 'archiv' });
  await act('/aktion/lesen/doc/status', { id: doc.id, status: 'archiv' });
  const { highlight } = await act('/aktion/lesen/markierung/neu', { id: doc.id, quote: 'Satz' });
  await act('/aktion/lesen/markierung/notiz', { id: highlight.id, notiz: 'Gut' });
  await act('/aktion/lesen/markierung/loeschen', { id: highlight.id });
  assert.deepEqual(seen, Array(4).fill(doc.id));
});

test('Lesedatum: vorzeitig angelegte Notiz hat kein „gelesen“, beim Abschluss wird es nachgetragen', () => {
  const h = store.addHighlight({ doc_id: doc.id, quote: 'Stelle', start_hint: 1 });
  const r = exporter.addLink({ highlightId: h.id, target: 'Start' });
  assert.doesNotMatch(read(r.path), /^gelesen:/m);
  store.setStatus(doc.id, 'archiv');
  exporter.changed(doc.id);
  exporter.flush();
  assert.match(read(r.path), /^gelesen: 2026-10-2\d$/m);
  assert.match(read(r.path), /Verknüpft: \[\[Start\]\]/);
});

// --- Entscheiden nach dem Lesen (VCP-96) -------------------------------------------

const ARTICLE = sanitizeHtml('<h2>Erster Teil</h2><p>Der Stapel *wächst* &amp; wächst.</p><ul><li>eins</li><li>zwei</li></ul>');
const decideRoutes = () => {
  const routes = readingRoutes({ store, exporter, logger: quiet });
  const act = (path, fields) => routes.actions[path](new URLSearchParams(fields), { sub: 'ruben' });
  const page = (path, query = '') => routes.pages[path]({ url: new URL(`https://vault.test${path}${query}`), user: 'ruben', tz: 'Europe/Berlin', write: { csrf: 'c', back: path }, flash: null });
  return { act, page };
};
const textOf = (path) => findSection(read(path), TEXT_SECTION)?.inner ?? null;
const ids = (status) => store.list({ status }).map((d) => d.id);

test('In den Vault: gelesen ohne Markierungen → Notiz mit Kurzfassung, ohne Volltext; mit Häkchen mit Volltext; Rückgängig lässt die Notiz stehen', async () => {
  store.updateDocument(doc.id, { excerpt: 'Kurz # gesagt, mit [[Link]].', content_html: ARTICLE });
  const { act, page } = decideRoutes();
  const { html } = await page('/lesen/doc', `?id=${doc.id}`);
  assert.match(html, /data-decide="vault">[^]*?<input type="checkbox" name="volltext" value="1" checked> mit Volltext<\/label><button type="submit" class="btn primary">In den Vault <kbd>V<\/kbd>/);

  const r = await act('/aktion/lesen/doc/vault', { id: doc.id });
  assert.equal(r.message, 'Im Vault: Vom Lesen: Über Stapel');
  assert.equal(store.get(doc.id).status, 'archiv');
  const path = pathOf();
  const text = read(path);
  assert.match(text, /^lesestatus: gelesen\ngelesen: 2026-10-20$/m);
  assert.match(text, /\[Original\]\(<https:\/\/blatt\.test\/a>\)\n\nKurz \\# gesagt, mit \\\[\\\[Link\\\]\\\]\.\n\n## Markierungen\n\n<!-- cockpit:markierungen:start[^]*Keine Markierungen\.[^]*## Eigene Gedanken\n$/);
  assert.equal(textOf(path), null, 'ohne Häkchen kein Volltext');

  // Rückgängig: zurück auf den Stapel, die Notiz bleibt (und die Meldung sagt es).
  const undone = await act(r.undo.action, r.undo.fields);
  assert.equal(store.get(doc.id).status, 'stapel');
  assert.match(undone.message, /die Notiz im Vault bleibt/);
  assert.equal(read(path), text);

  const { doc: other } = store.addDocument({ url: 'https://blatt.test/c', title: 'Mit Text', status: 'stapel', content_html: ARTICLE });
  assert.equal((await act('/aktion/lesen/doc/vault', { id: other.id, volltext: '1' })).message, 'Mit Volltext im Vault: Mit Text');
  const full = read(exporter.notePath(other.id));
  assert.match(full, /## Markierungen\n[^]*\n## Text\n\n<!-- cockpit:text:start · Volltext[^]*-->\n\n#### Erster Teil\n\nDer Stapel \\\*wächst\\\* & wächst\.\n\n- eins\n- zwei\n\n<!-- cockpit:text:ende [0-9a-f]{8} -->\n\n## Eigene Gedanken\n$/);
});

test('Fertig, weg: keine Notiz, auch nach Fortschritt 1 mit Markierungen; raus aus dem Stapel; Rückgängig stellt ihn wieder her', async () => {
  const { act } = decideRoutes();
  store.addHighlight({ doc_id: doc.id, quote: 'Stelle' });
  await act('/aktion/lesen/doc/fortschritt', { id: doc.id, fortschritt: '1' });
  const r = await act('/aktion/lesen/doc/fertig', { id: doc.id });
  assert.equal(r.message, 'Fertig, weg: Vom Lesen: Über Stapel');
  const done = store.get(doc.id);
  assert.equal(done.status, 'weg');
  assert.ok(done.read_at, 'gelesen, anders als „Weg“ im Eingang');
  exporter.changed(doc.id);
  exporter.flush();
  assert.equal(pathOf(), null);
  assert.ok(!existsSync(join(root, FOLDER)));
  assert.deepEqual(ids('stapel'), []);

  await act(r.undo.action, r.undo.fields);
  assert.deepEqual(ids('stapel'), [doc.id]);

  // Eine schon geschriebene Notiz bleibt unangetastet.
  await act('/aktion/lesen/doc/vault', { id: doc.id });
  const before = read(pathOf());
  await act('/aktion/lesen/doc/fertig', { id: doc.id });
  exporter.changed(doc.id);
  exporter.flush();
  assert.equal(read(pathOf()), before);
});

test('Im Vault ablegen aus dem Eingang: Volltext, lesestatus ungelesen, ohne gelesen; weder im Eingang noch im Stapel; Rückgängig', async () => {
  const { act, page } = decideRoutes();
  const { doc: fresh } = store.addDocument({ url: 'https://blatt.test/neu', title: 'Neu im Eingang', excerpt: 'Anriss.', content_html: ARTICLE });
  const inbox = (await page('/lesen/eingang')).html;
  assert.match(inbox, /<form method="post" action="\/aktion\/lesen\/ablegen" class="act inbox-ablegen">[^]*?name="id" value="[^"]+"[^]*?Im Vault ablegen <kbd aria-hidden="true">A<\/kbd>/);
  assert.match((await page('/lesen/stapel')).html, /<li class="lesen-item">[^]*?<form method="post" action="\/aktion\/lesen\/ablegen" class="act lesen-ablegen">/);

  const r = await act('/aktion/lesen/ablegen', { id: fresh.id });
  assert.equal(r.message, 'Im Vault abgelegt: Neu im Eingang');
  assert.equal(store.get(fresh.id).status, 'abgelegt');
  assert.equal(store.get(fresh.id).read_at, null);
  assert.ok(!ids('eingang').includes(fresh.id) && !ids('stapel').includes(fresh.id));
  const path = exporter.notePath(fresh.id);
  const text = read(path);
  assert.match(text, /^lesestatus: ungelesen$/m);
  assert.doesNotMatch(text, /^gelesen:/m);
  assert.match(text, /\nAnriss\.\n/);
  assert.match(textOf(path), /^#### Erster Teil/);
  assert.equal(idx.getNote(path).frontmatter.lesestatus, 'ungelesen');
  assert.equal(idx.getNote(path).frontmatter.ingest, 'offen', 'Volltext: offen für den Ingest');

  // Rückgängig über den Eingang (Taste Z): wieder im Eingang, die Notiz bleibt.
  const back = await act('/aktion/lesen/sortieren', { id: fresh.id, ziel: 'eingang' });
  assert.equal(back.message, 'Zurück im Eingang: Neu im Eingang (die Notiz im Vault bleibt)');
  assert.ok(ids('eingang').includes(fresh.id));
  assert.equal(read(path), text);
  // Nur aus Eingang und Stapel.
  store.setStatus(fresh.id, 'archiv');
  await assert.rejects(act('/aktion/lesen/ablegen', { id: fresh.id }), /Liegt nicht mehr in Eingang oder Stapel/);
});

test('Später gelesen und In den Vault: lesestatus gelesen, gelesen nachgetragen, Volltext unverändert, eigene Gedanken bleiben', async () => {
  const { act } = decideRoutes();
  store.updateDocument(doc.id, { content_html: ARTICLE });
  await act('/aktion/lesen/ablegen', { id: doc.id });
  const path = pathOf();
  writeFileSync(join(root, path), `${read(path)}\nMein Gedanke mit [[Start]].\n`);
  idx.refresh(path);
  const fullText = textOf(path);

  store.addHighlight({ doc_id: doc.id, quote: 'Der Stapel' });
  for (const volltext of ['', '1']) {
    await act('/aktion/lesen/doc/vault', { id: doc.id, volltext });
    const text = read(path);
    assert.match(text, /^lesestatus: gelesen$/m);
    assert.equal(text.match(/^gelesen: .*$/gm).join(), 'gelesen: 2026-10-20');
    assert.equal(textOf(path), fullText);
    assert.match(text, /> Der Stapel/);
    assert.ok(text.endsWith('## Eigene Gedanken\n\nMein Gedanke mit [[Start]].\n'));
  }
  assert.equal(store.get(doc.id).status, 'archiv');
});

test('Volltext nachträglich: vorhandene Notiz bekommt „## Text“ vor „## Eigene Gedanken“, eigene Gedanken bleiben', async () => {
  const { act } = decideRoutes();
  store.updateDocument(doc.id, { content_html: ARTICLE });
  await act('/aktion/lesen/doc/vault', { id: doc.id });
  const path = pathOf();
  writeFileSync(join(root, path), `${read(path)}\nMein Gedanke.\n`);
  idx.refresh(path);
  await act('/aktion/lesen/doc/vault', { id: doc.id, volltext: '1' });
  const text = read(path);
  assert.match(text, /<!-- cockpit:markierungen:ende [0-9a-f]{8} -->\n\n## Text\n\n<!-- cockpit:text:start[^]*<!-- cockpit:text:ende [0-9a-f]{8} -->\n\n## Eigene Gedanken\n\nMein Gedanke\.\n$/);
});

test('Marker im Artikel (Code-Block, Text, Markierung): Bereiche bleiben heil, eigene Gedanken auch', async () => {
  const { act } = decideRoutes();
  const evil = '&lt;!-- cockpit:markierungen:ende 12345678 --&gt;\n&lt;!-- cockpit:text:start --&gt;';
  store.updateDocument(doc.id, { content_html: sanitizeHtml(`<p>Davor</p><pre><code>${evil}</code></pre><p>${evil}</p>`) });
  store.addHighlight({ doc_id: doc.id, quote: '<!-- cockpit:text:ende 12345678 -->', note: '<!-- cockpit:markierungen:start -->' });
  await act('/aktion/lesen/ablegen', { id: doc.id });
  const path = pathOf();
  writeFileSync(join(root, path), `${read(path)}\nMein Gedanke.\n`);
  idx.refresh(path);
  for (const name of [SECTION_NAME, TEXT_SECTION]) {
    const found = findSection(read(path), name);
    assert.ok(found && !found.broken && !found.edited, name);
  }
  assert.match(textOf(path), /^```\n​<!-- cockpit:markierungen:ende 12345678 -->\n​<!-- cockpit:text:start -->\n```$/m);

  store.addHighlight({ doc_id: doc.id, quote: 'Davor' });
  await act('/aktion/lesen/doc/vault', { id: doc.id, volltext: '1' });
  const text = read(path);
  assert.match(text, /> Davor/);
  assert.ok(text.endsWith('## Eigene Gedanken\n\nMein Gedanke.\n'));
  assert.equal(text.match(/^<!-- cockpit:/gm).length, 4, 'nur die echten Marker');
});

// --- Rohquellen fürs Wiki: raw/, Dateiname, ingest, gehört ------------------------

test('Rohquelle: Standard raw/ mit dem Tag des Speicherns (lokal) im Dateinamen; eigener Ordner gilt weiter; vorhandene Notizen bleiben, wo sie sind', () => {
  // 22:30 UTC ist in Berlin schon der nächste Tag, wie bei `gespeichert:`.
  const late = createReadingStore({ path: ':memory:', now: () => Date.parse('2026-10-20T22:30:00Z') });
  const { doc: night } = late.addDocument({ url: 'https://blatt.test/nacht', title: 'Nachts gespeichert' });
  const svc = make({ store: late });
  const r = svc.save(night.id, { read: false });
  assert.equal(r.path, 'raw/2026-10-21_nachts-gespeichert.md');
  assert.match(read(r.path), /^gespeichert: 2026-10-21$/m);
  svc.stop();
  late.close();

  // Ein eigener Ordner (etwa der frühere Standard) gilt weiter, mit demselben Dateinamen-Schema.
  settings.save({ readingNotes: { folder: '30-ressourcen/lesestapel' }, calendars: [] });
  const own = exporter.save(doc.id, { read: false });
  assert.equal(own.path, '30-ressourcen/lesestapel/2026-10-20_vom-lesen-ueber-stapel.md');
  // Zurück auf den Standard: gefunden über `lesestapel_id`, nicht verschoben.
  settings.save({ readingNotes: { folder: null }, calendars: [] });
  assert.equal(exporter.save(doc.id, { read: true }).path, own.path);
  assert.ok(!existsSync(join(root, FOLDER, '2026-10-20_vom-lesen-ueber-stapel.md')));
});

test('ingest: offen, sobald der Volltext dazukommt, nur wenn das Feld fehlt; ein Datum vom Skill bleibt', async () => {
  const { act } = decideRoutes();
  store.updateDocument(doc.id, { content_html: ARTICLE });
  await act('/aktion/lesen/doc/vault', { id: doc.id });
  const path = pathOf();
  assert.doesNotMatch(read(path), /^ingest:/m, 'ohne Volltext kein ingest');
  await act('/aktion/lesen/doc/vault', { id: doc.id, volltext: '1' });
  assert.match(read(path), /^ingest: offen$/m);
  assert.ok(textOf(path));

  // Der Skill hat die Rohquelle verarbeitet: sein Datum bleibt, auch wenn der Volltext neu geschrieben wird.
  editor.setFrontmatter({ path, set: { ingest: '2026-10-24' } });
  await act('/aktion/lesen/doc/vault', { id: doc.id, volltext: '1' });
  await act('/aktion/lesen/doc/vault', { id: doc.id });
  assert.equal(read(path).match(/^ingest: .*$/gm).join(), 'ingest: 2026-10-24');

  // Gleich mit Volltext angelegt: im Frontmatter der neuen Notiz.
  const { doc: other } = store.addDocument({ url: 'https://blatt.test/c', title: 'Mit Text', status: 'stapel', content_html: ARTICLE });
  await act('/aktion/lesen/doc/vault', { id: other.id, volltext: '1' });
  assert.equal(idx.getNote(exporter.notePath(other.id)).frontmatter.ingest, 'offen');
});

test('markIngest: false (Ingest des Cockpits) lässt `ingest: offen` weg, beim Anlegen wie beim Nachtragen', () => {
  store.updateDocument(doc.id, { content_html: ARTICLE });
  const { path } = exporter.save(doc.id, { read: true, fullText: true, markIngest: false });
  assert.doesNotMatch(read(path), /^ingest:/m);
  assert.ok(textOf(path));
  const { doc: other } = store.addDocument({ url: 'https://blatt.test/d', title: 'Später', status: 'stapel', content_html: ARTICLE });
  const first = exporter.save(other.id, { read: false });
  exporter.save(other.id, { read: true, fullText: true, markIngest: false });
  assert.doesNotMatch(read(first.path), /^ingest:/m);
  assert.ok(textOf(first.path));
});

test('Markierungen: `<…>`, fremde Bilder und Code-Blöcke in Zitat und Notiz erscheinen als Text', () => {
  store.addHighlight({ doc_id: doc.id, quote: 'Davor <b>fett</b>\n```dataviewjs\ndv.paragraph(1)\n```', note: 'Siehe <img src="https://evil.example/?d=notiz"> ![](https://evil.example/n)' });
  store.setStatus(doc.id, 'archiv');
  exporter.changed(doc.id);
  exporter.flush();
  const text = read(pathOf());
  assert.match(text, /^> Davor &lt;b>fett&lt;\/b>\n> ```text\n> dv\.paragraph\(1\)\n> ```$/m);
  assert.match(text, /^Siehe &lt;img src="https:\/\/evil\.example\/\?d=notiz"> \[\]\(https:\/\/evil\.example\/n\)$/m);
  assert.doesNotMatch(text, /<b>|<img|```dataviewjs|!\[\]/);
});

test('Gehört: heard vermerkt im Lesestapel, schreibt gehoert in eine vorhandene Notiz, eine neue bekommt es beim Anlegen', () => {
  const { doc: other } = store.addDocument({ url: 'https://blatt.test/g', title: 'Gehört' });
  exporter.save(doc.id, { read: false });
  const path = pathOf();
  assert.equal(exporter.notePath(other.id), null);

  const r = exporter.heard([doc.id, other.id, doc.id, 'gibt-es-nicht']);
  assert.deepEqual(r.map((x) => [x.state, x.doc]), [['geschrieben', doc.id], ['vermerkt', other.id], ['weg', 'gibt-es-nicht']]);
  assert.equal(r[0].path, path);
  assert.equal(store.get(other.id).heard_at, '2026-10-23T10:00:00.000Z');
  assert.match(read(path), /^gehoert: 2026-10-23$/m);
  assert.equal(idx.getNote(path).frontmatter.gehoert, '2026-10-23');
  assert.equal(exporter.heard([doc.id])[0].state, 'aktuell');

  // Ohne Notiz: das Anlegen trägt es ein.
  const created = exporter.save(other.id, { read: false, fullText: true });
  assert.match(read(created.path), /^gehoert: 2026-10-23\ningest: offen$/m);

  // Später noch einmal gehört: der neuere Tag ersetzt den älteren.
  const later = make({ now: () => new Date('2026-10-25T09:00:00Z') });
  assert.equal(later.heard([doc.id])[0].state, 'geschrieben');
  assert.equal(read(path).match(/^gehoert: .*$/gm).join(), 'gehoert: 2026-10-25');
  later.stop();
});

test('Gehört: der Export trägt gehoert nach; scheitert der Editor, später; vertrauliche Notiz bleibt unberührt', () => {
  exporter.save(doc.id, { read: false });
  const path = pathOf();
  // 21:00 UTC am 22.10. ist in Berlin noch der 22.10.
  store.markHeard([doc.id], '2026-10-22T21:00:00Z');
  exporter.changed(doc.id);
  exporter.flush();
  assert.match(read(path), /^gehoert: 2026-10-22$/m);

  // Der Sync ändert gleichzeitig: vorgemerkt, der nächste Lauf schreibt.
  let calls = 0;
  const flaky = {
    ...editor,
    setFrontmatter(args) {
      if (!calls++) throw new Error('gerade anderweitig geändert');
      return editor.setFrontmatter(args);
    },
  };
  const svc = make({ editor: flaky });
  const [r] = svc.heard([doc.id]);
  assert.equal(r.state, 'fehler');
  assert.deepEqual(svc.pending(), [doc.id]);
  svc.flush();
  assert.equal(read(path).match(/^gehoert: .*$/gm).join(), 'gehoert: 2026-10-23');
  svc.stop();

  // In einen vertraulichen Ordner verschoben: nur der Lesestapel.
  const secret = '20-bereiche/Gesundheit/Stapel.md';
  mkdirSync(join(root, '20-bereiche/Gesundheit'), { recursive: true });
  renameSync(join(root, path), join(root, secret));
  idx.refresh(path);
  idx.refresh(secret);
  const before = read(secret);
  const later = make({ now: () => new Date('2026-10-25T09:00:00Z') });
  assert.deepEqual(later.heard([doc.id]).map((x) => [x.state, x.path]), [['übersprungen', secret]]);
  assert.equal(read(secret), before);
  assert.equal(store.get(doc.id).heard_at, '2026-10-25T09:00:00.000Z');
  later.stop();
});

test('blockId: verschieden auch bei Client-IDs mit gleichem Anfang', () => {
  const ids = ['mh2x3k1a-00aa', 'mh2x3k1a-00ab', 'cap-1', 'cap-2'].map(blockId);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) assert.match(id, /^hl-[0-9a-f]{8}$/);
});

test('Notiz: Feed-Eintrag mit Diskussion verlinkt Original und Kommentare', () => {
  const text = noteContent(
    { id: 'd1', url: 'https://kuehn.test/a', comments_url: 'https://news.ycombinator.com/item?id=1', title: 'Kühn', author: 'Ann', topics: [], saved_at: '2026-10-20T08:00:00Z' },
    '',
    { tz: 'Europe/Berlin' },
  );
  assert.match(text, /^\[Original\]\(<https:\/\/kuehn\.test\/a>\) · \[Kommentare\]\(<https:\/\/news\.ycombinator\.com\/item\?id=1>\) · Ann$/m);
});

test('Verknüpfen rückgängig (VCP-85): removeLink nimmt nur diesen Wikilink heraus, legt nie eine Notiz an', () => {
  const h = store.addHighlight({ doc_id: doc.id, quote: 'Stelle', start_hint: 1 });
  assert.deepEqual(exporter.removeLink({ highlightId: h.id, target: 'Start' }).state, 'aktuell');
  assert.equal(pathOf(), null, 'ohne Notiz legt das Lösen keine an');

  const { path } = exporter.addLink({ highlightId: h.id, target: 'Start' });
  exporter.addLink({ highlightId: h.id, target: 'Andere' });
  assert.equal(exporter.removeLink({ highlightId: h.id, target: 'Start' }).state, 'geschrieben');
  assert.deepEqual(parseLinks(read(path)).get(blockId(h.id)), ['Andere']);
  assert.equal(exporter.removeLink({ highlightId: h.id, target: 'Start' }).state, 'aktuell');
  assert.throws(() => exporter.removeLink({ highlightId: 'gibt-es-nicht', target: 'Start' }), /gibt es nicht/);
});

test('Vorgemerktes übersteht einen Absturz (VCP-85): ein neuer Export holt es aus der Datenbank nach', async () => {
  const wait = (ms) => new Promise((res) => setTimeout(res, ms));
  store.setStatus(doc.id, 'archiv');
  store.addHighlight({ doc_id: doc.id, quote: 'Stelle' });
  exporter.changed(doc.id);
  exporter.stop(); // „Absturz“: der Zeitgeber läuft nie
  assert.deepEqual(store.listExportPending().map((r) => r.doc_id), [doc.id]);

  const restarted = make({ delayMs: 5 });
  await wait(40);
  assert.deepEqual(restarted.pending(), []);
  assert.match(read(restarted.notePath(doc.id)), /> Stelle/);
  restarted.stop();
});

test('Bleibende Fehler (VCP-85): wachsende Abstände, ab dem zweiten Fehlversuch auf /zustand, eine Änderung setzt zurück', () => {
  store.setStatus(doc.id, 'archiv');
  store.addHighlight({ doc_id: doc.id, quote: 'Stelle' });
  const broken = { ...editor, create() { throw new Error('beide Dateinamen schon vergeben'); } };
  const svc = make({ editor: broken, delayMs: 30_000 });
  assert.equal(svc.health().state, 'unknown');
  svc.changed(doc.id);
  const gaps = [];
  for (let i = 0; i < 4; i += 1) {
    const before = Date.now();
    assert.equal(svc.flush()[0].state, 'fehler');
    const [row] = store.listExportPending();
    gaps.push(Math.round((Date.parse(row.next_at) - before) / 30_000));
    if (i === 0) assert.equal(svc.health().state, 'unknown', 'ein Fehlversuch allein ist meist der Sync');
  }
  assert.deepEqual(gaps, [1, 2, 4, 8]);
  const h = svc.health();
  assert.equal(h.id, 'reading-export');
  assert.equal(h.state, 'error');
  assert.match(h.summary, /„Vom Lesen: Über Stapel“ kommt nicht in den Vault/);
  assert.match(h.lastError, /beide Dateinamen schon vergeben/);
  assert.ok(h.facts.some((f) => f.label === 'Nächster Versuch'));

  // Eine neue Änderung setzt die Fehlversuche zurück und versucht es entprellt wieder.
  svc.changed(doc.id);
  assert.equal(store.listExportPending()[0].attempts, 0);
  assert.equal(svc.health().state, 'unknown');
  svc.stop();
});

// --- Nacharbeiten (VCP-98) ----------------------------------------------------------

test('Kurzfassung nachtragen: alte Notiz bekommt sie als eigenen Bereich vor „## Markierungen“, einmal; eigener Text bleibt', async () => {
  const { act } = decideRoutes();
  // Wie vor VCP-96: archiviert mit Markierung, ohne Kurzfassung angelegt.
  store.setStatus(doc.id, 'archiv');
  store.addHighlight({ doc_id: doc.id, quote: 'Stelle' });
  exporter.changed(doc.id);
  exporter.flush();
  const path = pathOf();
  writeFileSync(join(root, path), read(path).replace('## Markierungen', 'Mein Satz oben.\n\n## Markierungen') + '\nMein Gedanke.\n');
  idx.refresh(path);
  const summary = () => findSection(read(path), 'kurzfassung');

  // Die Kurzfassung steht auch im Volltext: Das zählt nicht als vorhanden.
  store.updateDocument(doc.id, { excerpt: 'Der Stapel *wächst* & wächst.', content_html: ARTICLE });
  await act('/aktion/lesen/doc/vault', { id: doc.id, volltext: '1' });
  const text = read(path);
  assert.equal(summary().inner, 'Der Stapel \\*wächst\\* & wächst.');
  assert.match(text, /\nMein Satz oben\.\n\n<!-- cockpit:kurzfassung:start · [^\n]*-->\nDer Stapel \\\*wächst\\\* & wächst\.\n<!-- cockpit:kurzfassung:ende [0-9a-f]{8} -->\n\n## Markierungen\n/);
  assert.ok(text.endsWith('## Eigene Gedanken\n\nMein Gedanke.\n'));

  // Noch einmal: nichts doppelt; eine geänderte Kurzfassung frischt nur den Bereich auf.
  await act('/aktion/lesen/doc/vault', { id: doc.id });
  assert.equal(read(path), text);
  store.updateDocument(doc.id, { excerpt: 'Neu gesagt.' });
  await act('/aktion/lesen/doc/vault', { id: doc.id });
  assert.equal(summary().inner, 'Neu gesagt.');
  assert.equal(read(path).match(/cockpit:kurzfassung:start/g).length, 1);
  assert.match(read(path), /Mein Satz oben\./);

  // Eine neue Notiz hat die Kurzfassung im Kopf und bekommt keinen Bereich dazu.
  const { doc: fresh } = store.addDocument({ url: 'https://blatt.test/neu', title: 'Neu', status: 'stapel', excerpt: 'Schon da.' });
  await act('/aktion/lesen/doc/vault', { id: fresh.id });
  await act('/aktion/lesen/doc/vault', { id: fresh.id });
  const own = read(exporter.notePath(fresh.id));
  assert.match(own, /\n\nSchon da\.\n\n## Markierungen/);
  assert.equal(findSection(own, 'kurzfassung'), null);
});

test('Gesperrte Notiz: In den Vault und Ablegen melden es, schreiben nichts und lassen Status und Lesedatum', async () => {
  const { act } = decideRoutes();
  await act('/aktion/lesen/doc/vault', { id: doc.id });
  await act('/aktion/lesen/doc/status', { id: doc.id, status: 'stapel' });
  const path = pathOf();
  const secret = '20-bereiche/Gesundheit/Stapel.md';
  mkdirSync(join(root, '20-bereiche/Gesundheit'), { recursive: true });
  renameSync(join(root, path), join(root, secret));
  idx.refresh(path);
  idx.refresh(secret);
  const before = read(secret);
  const readAt = store.get(doc.id).read_at;
  assert.match(exporter.locked(doc.id), /„20-bereiche\/Gesundheit\/Stapel\.md“ liegt in einem vertraulichen/);

  for (const [action, fields] of [['/aktion/lesen/doc/vault', { volltext: '1' }], ['/aktion/lesen/ablegen', {}]]) {
    await assert.rejects(act(action, { id: doc.id, ...fields }), (err) => err.status === 409 && /^Nicht in den Vault geschrieben: Die Notiz „20-bereiche\/Gesundheit\/Stapel\.md“/.test(err.message));
    assert.equal(store.get(doc.id).status, 'stapel', action);
  }
  assert.equal(store.get(doc.id).read_at, readAt);
  assert.equal(read(secret), before);
  assert.deepEqual(readdirSync(join(root, FOLDER)), []);
  assert.equal(exporter.locked('gibt-es-nicht'), null);
});

test('Kurzfassung nachtragen: gleicht sie dem Titel, kommt sie trotzdem; ohne eindeutiges „## Markierungen“ bleibt die Notiz', async () => {
  const { act } = decideRoutes();
  const old = (d) => {
    store.setStatus(d.id, 'archiv');
    store.addHighlight({ doc_id: d.id, quote: 'Stelle' });
    exporter.changed(d.id);
    exporter.flush();
    return exporter.notePath(d.id);
  };
  const path = old(doc);
  store.updateDocument(doc.id, { excerpt: 'Vom Lesen: Über Stapel' });
  await act('/aktion/lesen/doc/vault', { id: doc.id });
  assert.equal(findSection(read(path), 'kurzfassung').inner, 'Vom Lesen: Über Stapel');

  for (const [n, change] of [
    ['ohne', (t) => t.replace('## Markierungen', '## Zitate')],
    ['doppelt', (t) => `${t}\n## Markierungen\n`],
    ['nur im Code-Block', (t) => `${t.replace('## Markierungen', '## Zitate')}\n\`\`\`\n## Markierungen\n\`\`\`\n`],
    ['schon in eigenem Abschnitt davor', (t) => t.replace('## Markierungen', '## Kurzfassung\n\nKurz.\n\n## Markierungen')],
  ]) {
    const { doc: d } = store.addDocument({ url: `https://blatt.test/${n}`, title: n, status: 'stapel' });
    const p = old(d);
    writeFileSync(join(root, p), change(read(p)));
    idx.refresh(p);
    store.updateDocument(d.id, { excerpt: 'Kurz.' });
    await act('/aktion/lesen/doc/vault', { id: d.id });
    assert.equal(findSection(read(p), 'kurzfassung'), null, n);
  }
});

test('Kurzfassung nachtragen: dieselbe Zeile in einem Zitat stört die eindeutige Überschrift nicht', async () => {
  const { act } = decideRoutes();
  store.setStatus(doc.id, 'archiv');
  store.addHighlight({ doc_id: doc.id, quote: 'Stelle' });
  exporter.changed(doc.id);
  exporter.flush();
  const path = pathOf();
  writeFileSync(join(root, path), `${read(path)}\n> ## Markierungen\n`);
  idx.refresh(path);
  store.updateDocument(doc.id, { excerpt: 'Kurz.' });
  await act('/aktion/lesen/doc/vault', { id: doc.id });
  assert.match(read(path), /<!-- cockpit:kurzfassung:ende [0-9a-f]{8} -->\n\n## Markierungen\n/);
});
