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
import { createReadingExport, blockId, parseLinks, slugOf, DEFAULT_FOLDER } from '../src/lesen/vault-export.js';

const quiet = { info() {}, warn() {}, error() {} };
const FOLDER = '30-ressourcen/lesestapel';
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
  assert.equal(r.path, `${FOLDER}/vom-lesen-ueber-stapel.md`);
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

test('Fertig gelesen (Fortschritt 1) reicht auch; Titel doppelt → eigener Dateiname', () => {
  const { doc: other } = store.addDocument({ url: 'https://blatt.test/b', title: 'Vom Lesen: über Stapel!' });
  for (const d of [doc, other]) {
    store.setProgress(d.id, 1);
    store.addHighlight({ doc_id: d.id, quote: 'Satz' });
    exporter.changed(d.id);
  }
  const paths = exporter.flush().map((r) => r.path);
  assert.deepEqual(paths, [`${FOLDER}/vom-lesen-ueber-stapel.md`, `${FOLDER}/vom-lesen-ueber-stapel-${blockId(other.id).slice(3)}.md`]);
  assert.match(read(paths[0]), /^gelesen: 2026-10-23$/m);
  assert.equal(slugOf('  ?? '), 'text');
});

test('Update: nur der Bereich ändert sich, eigener Text darunter bleibt, Umbenennen und Verschieben schaden nicht', () => {
  store.setStatus(doc.id, 'archiv');
  const h1 = store.addHighlight({ doc_id: doc.id, quote: 'Erste Stelle', start_hint: 1 });
  exporter.changed(doc.id);
  const [{ path }] = exporter.flush();

  // In Obsidian umbenannt und verschoben, darunter eigene Gedanken.
  const moved = '30-ressourcen/gelesen/Über Stapel.md';
  mkdirSync(join(root, '30-ressourcen/gelesen'));
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

test('Verdrahtung: Archivieren, Fortschritt 1 und Markierungs-Aktionen melden das Dokument', async () => {
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
  assert.deepEqual(seen, Array(5).fill(doc.id));
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
