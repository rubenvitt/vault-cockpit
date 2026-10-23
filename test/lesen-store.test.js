import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createReadingStore, ReadingError } from '../src/lesen/store.js';
import { gzipSync } from 'node:zlib';
import { createBackup, open, seal } from '../src/cockpit/backup.js';

const clock = () => {
  let t = Date.parse('2026-10-23T08:00:00Z');
  return { now: () => t, tick: (ms = 60_000) => (t += ms) };
};

test('Lesestapel: Schema-Fassung, anlegen idempotent per client_id und Adresse', () => {
  const c = clock();
  const store = createReadingStore({ path: ':memory:', now: c.now });
  const first = store.addDocument({ url: 'https://a.test/x', canonical_url: 'https://a.test/kanon', title: 'X', site: 'a.test', client_id: 'c1', word_count: 440, reading_minutes: 2, topics: ['tech'] });
  assert.equal(first.duplicate, false);
  assert.equal(first.doc.status, 'eingang');
  assert.equal(first.doc.origin, 'formular');
  assert.equal(first.doc.kind, 'artikel');
  assert.deepEqual(first.doc.topics, ['tech']);
  assert.equal(first.doc.saved_at, '2026-10-23T08:00:00.000Z');

  // Dieselbe client_id (doppelt abgeschickt), dieselbe Adresse, die kanonische Adresse: kein neues Dokument.
  assert.equal(store.addDocument({ url: 'https://anders.test', client_id: 'c1' }).doc.id, first.doc.id);
  assert.equal(store.addDocument({ url: 'https://a.test/x' }).duplicate, true);
  assert.equal(store.addDocument({ url: 'https://a.test/kanon' }).doc.id, first.doc.id);
  assert.equal(store.find({ url: 'https://a.test/kanon' }).id, first.doc.id);
  assert.equal(store.find({ url: 'https://neu.test' }), null);

  assert.throws(() => store.addDocument({ title: 'ohne Adresse' }), ReadingError);
  assert.throws(() => store.addDocument({ url: 'https://b.test', status: 'irgendwas' }), /Unbekannter Status/);
  assert.throws(() => store.addDocument({ url: 'https://b.test', kind: 'video' }), /Unbekannte Art/);
});

test('Lesestapel: Liste nach Status, Statuswechsel mit Rückgängig-Spur, Fortschritt', () => {
  const c = clock();
  const store = createReadingStore({ path: ':memory:', now: c.now });
  const a = store.addDocument({ url: 'https://a.test', title: 'A' }).doc;
  c.tick();
  const b = store.addDocument({ url: 'https://b.test', title: 'B', origin: 'feed:f1' }).doc;
  assert.deepEqual(store.list({ status: 'eingang' }).map((d) => d.title), ['B', 'A']);
  assert.equal(store.list()[0].content_html, undefined, 'Liste ohne Inhalt');

  c.tick();
  const moved = store.setStatus(a.id, 'stapel');
  assert.equal(moved.previous, 'eingang');
  assert.equal(moved.doc.previous_status, 'eingang');
  assert.equal(moved.doc.status_changed_at, '2026-10-23T08:02:00.000Z');
  assert.deepEqual(store.list({ status: 'stapel' }).map((d) => d.id), [a.id]);
  assert.equal(store.setStatus(a.id, 'stapel').changed, false);
  // Rückgängig ist der Wechsel zurück auf `previous`.
  assert.equal(store.setStatus(a.id, moved.previous).doc.status, 'eingang');

  const archived = store.setStatus(b.id, 'archiv').doc;
  assert.ok(archived.archived_at && archived.read_at);
  store.setStatus(b.id, 'weg');
  assert.deepEqual(store.list().map((d) => d.id), [a.id], 'ohne Status alles außer weg');
  assert.deepEqual(store.counts(), { eingang: 1, stapel: 0, archiv: 0, weg: 1 });
  assert.throws(() => store.setStatus(a.id, 'gelesen'), /Unbekannter Status/);
  assert.throws(() => store.setStatus('gibtsnicht', 'archiv'), /gibt es nicht/);

  assert.equal(store.setProgress(a.id, 1.7, 'p:12').progress, 1);
  assert.equal(store.setProgress(a.id, 0.4).scroll_anchor, 'p:12');
  assert.throws(() => store.setProgress(a.id, 'viel'), /Zahl/);
  assert.equal(store.updateDocument(a.id, { title: 'A2', topics: ['x'], status: 'archiv' }).title, 'A2');
  assert.equal(store.get(a.id).status, 'eingang', 'Status nur über setStatus');
});

test('Lesestapel: Markierungen und Feeds', () => {
  const store = createReadingStore({ path: ':memory:' });
  const doc = store.addDocument({ url: 'https://a.test', title: 'A' }).doc;
  const h = store.addHighlight({ doc_id: doc.id, quote: 'der Kern', prefix: 'Das ist ', suffix: ' der Sache', start_hint: 120 });
  assert.equal(h.color, 'gelb');
  assert.equal(h.review_state, 'aktiv');
  assert.equal(store.updateHighlight(h.id, { note: 'wichtig', review_state: 'losgelassen' }).note, 'wichtig');
  assert.throws(() => store.updateHighlight(h.id, { review_state: 'weg' }), /Unbekannter Zustand/);
  assert.equal(store.listHighlights()[0].doc_title, 'A');
  assert.equal(store.listHighlights({ docId: doc.id }).length, 1);
  assert.throws(() => store.addHighlight({ doc_id: 'nix', quote: 'x' }), /gibt es nicht/);

  const { feed } = store.addFeed({ url: 'https://a.test/feed.xml', title: 'A', to_stack: true });
  assert.equal(feed.to_stack, true);
  assert.equal(feed.paused, false);
  assert.equal(store.addFeed({ url: 'https://a.test/feed.xml' }).duplicate, true);
  assert.equal(store.updateFeed(feed.id, { paused: true, error_count: 2 }).paused, true);
  assert.equal(store.rememberEntry(feed.id, 'guid-1', doc.id), true);
  assert.equal(store.rememberEntry(feed.id, 'guid-1'), false);
  assert.equal(store.listFeeds().length, 1);

  // Dokument weg: seine Markierungen auch.
  assert.equal(store.deleteDocument(doc.id), true);
  assert.equal(store.listHighlights().length, 0);
  assert.equal(store.deleteFeed(feed.id), true);
});

test('Lesestapel: Sicherung bei offener Datenbank, Wiederherstellen öffnet neu', async () => {
  const source = mkdtempSync(join(tmpdir(), 'vc-lesen-'));
  const target = mkdtempSync(join(tmpdir(), 'vc-lesen-'));
  const cost = { N: 2 ** 10, r: 8, p: 1 };
  const PASS = 'korrekt pferd batterie';
  try {
    const store = createReadingStore({ path: join(source, 'lesestapel.db') });
    store.addDocument({ url: 'https://a.test', title: 'Gesichert', content_text: 'Text '.repeat(2000) });
    const live = (s) => ({ 'lesestapel.db': { read: () => s.snapshot(), write: (buf) => s.replaceWith(buf) } });
    const { body, files } = await createBackup({ dir: source, live: live(store), cost }).create(PASS);
    assert.deepEqual(files, ['lesestapel.db']);
    // In der Sicherung liegt die Datenbank gepackt.
    assert.equal((await open(body, PASS)).files['lesestapel.db'].subarray(0, 2).toString('hex'), '1f8b');

    const other = createReadingStore({ path: join(target, 'lesestapel.db') });
    other.addDocument({ url: 'https://alt.test', title: 'Alt' });
    await createBackup({ dir: target, live: live(other), cost }).restore(body, PASS);
    // Derselbe Store liest nach dem Wiederherstellen den neuen Stand.
    assert.deepEqual(other.list().map((d) => d.title), ['Gesichert']);
    assert.ok(!existsSync(join(target, 'lesestapel.db-journal')));
    other.addDocument({ url: 'https://neu.test' });
    other.close();
    assert.equal(createReadingStore({ path: join(target, 'lesestapel.db') }).list().length, 2);
    store.close();

    // Fremde Bytes statt SQLite werden abgewiesen, bevor etwas geschrieben wird.
    const bad = await seal({ 'lesestapel.db': gzipSync(Buffer.from('kein sqlite')) }, PASS, { cost });
    await assert.rejects(createBackup({ dir: target, cost }).restore(bad, PASS), /keine SQLite-Datei/);
    const raw = await seal({ 'lesestapel.db': Buffer.from('ungepackt') }, PASS, { cost });
    await assert.rejects(createBackup({ dir: target, cost }).restore(raw, PASS), /beschädigt/);
  } finally {
    rmSync(source, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});

test('Lesestapel: neuere Schema-Fassung wird nicht still überschrieben', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vc-lesen-'));
  try {
    const file = join(dir, 'lesestapel.db');
    createReadingStore({ path: file }).close();
    const db = new DatabaseSync(file);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 1);
    db.exec('PRAGMA user_version = 99');
    db.close();
    assert.throws(() => createReadingStore({ path: file }), /Fassung 99/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
