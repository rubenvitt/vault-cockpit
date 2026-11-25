import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildIndex, openIndex } from '../src/vault/index.js';
import { compilePolicy } from '../src/vault/policy.js';
import { createJournal, normalizeEntry, renderEntry, fileHeader, redactSecrets, JournalError } from '../src/journal/journal.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/journal-entry.json', import.meta.url), 'utf8'));
const fixtureMd = readFileSync(new URL('./fixtures/journal-entry.md', import.meta.url), 'utf8');

let root, idx, journal, clock;
const read = (p) => readFileSync(join(root, p), 'utf8');
const input = (over = {}) => ({ ...fixture, source: 'chat', ...over });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'vault-journal-'));
  mkdirSync(join(root, 'notes'), { recursive: true });
  writeFileSync(join(root, 'notes/a.md'), '# A\n');
  buildIndex({ vaultPath: root, dbPath: ':memory:', policy: compilePolicy({}), persist: (db, vp) => (idx = openIndex(db, { vaultPath: vp, policy: compilePolicy({}) })) });
  clock = Date.UTC(2026, 0, 5, 9, 0);
  journal = createJournal({ vaultPath: root, index: idx, now: () => clock });
});

afterEach(() => {
  idx.close();
  rmSync(root, { recursive: true, force: true });
});

test('fixture: renderEntry entspricht dem Format des Mods (plus Quelle)', () => {
  const out = renderEntry(normalizeEntry(input()));
  assert.equal(out.replace(' · manual · chat', ' · manual'), fixtureMd);
  assert.ok(out.includes('· **Session:** `abcdef12` · manual · chat\n'));
});

test('legt die Tagesdatei mit Kopf an', () => {
  const r = journal.write(input());
  assert.equal(r.written, true);
  assert.equal(r.path, '_System/journal/privat/2026-01-05.md');
  const entry = normalizeEntry(input());
  assert.equal(read(r.path), fileHeader('2026-01-05', entry.to, 'privat') + renderEntry(entry));
  assert.ok(read(r.path).startsWith('---\ntype: journal\ndate: 2026-01-05\nsphere: privat\n---\n\n# Journal Montag, 05.01.2026 · privat\n\n### '));
});

test('hängt an eine bestehende Datei mit einer Leerzeile Abstand an', () => {
  const p = '_System/journal/privat/2026-01-05.md';
  mkdirSync(join(root, '_System/journal/privat'), { recursive: true });
  writeFileSync(join(root, p), '# Von Hand\n\n### 07:00–07:30 · Früh\n- a');
  journal.write(input());
  assert.equal(read(p), '# Von Hand\n\n### 07:00–07:30 · Früh\n- a\n\n' + renderEntry(normalizeEntry(input())));
});

test('wählt den Tag nach Berlin-Zeit', () => {
  const r = journal.write(input({ from: '2026-01-05T23:00:00Z', to: '2026-01-05T23:30:00Z' }));
  assert.equal(r.path, '_System/journal/privat/2026-01-06.md');
});

test('über Mitternacht: Datei nach to, Überschrift mit beiden Zeiten', () => {
  const r = journal.write(input({ from: '2026-01-05T22:10:00Z', to: '2026-01-05T23:20:00Z' }));
  assert.equal(r.path, '_System/journal/privat/2026-01-06.md');
  assert.ok(read(r.path).includes('### 23:10–00:20 · Beispielblock'));
});

test('ohne to gilt die Uhr des Servers', () => {
  const r = journal.write(input({ to: undefined }));
  assert.ok(read(r.path).includes('### 09:00–10:00 · Beispielblock'));
});

test('schreibt denselben Eintrag nicht doppelt', () => {
  journal.write(input());
  const before = read('_System/journal/privat/2026-01-05.md');
  assert.deepEqual(journal.write(input()), { written: false, reason: 'duplicate' });
  assert.equal(read('_System/journal/privat/2026-01-05.md'), before);
});

test('gleiche Endzeit, andere Session: kein Duplikat', () => {
  journal.write(input());
  assert.equal(journal.write(input({ session: 'zzzzzzzz99' })).written, true);
});

test('maskiert Zugangsdaten in allen Feldern', () => {
  const r = journal.write(input({ titel: 'Token vct_abc123def456', punkte: ['nutzte ghp_ABCdef1234567890xyz', 'Header Bearer eyJhbGciOi.xyz'] }));
  const text = read(r.path);
  assert.ok(!/vct_abc|ghp_ABC|eyJhbGci/.test(text));
  assert.equal(text.match(/\[maskiert\]/g).length, 3);
});

test('redactSecrets lässt normalen Text in Ruhe', () => {
  assert.equal(redactSecrets('Skill für Passwortregeln besprochen'), 'Skill für Passwortregeln besprochen');
  assert.equal(redactSecrets('password=hunter2 und sk-ant-api03-abcdefghijkl'), 'password=[maskiert] und [maskiert]');
});

test('kürzt wie der Mod', () => {
  const e = normalizeEntry(input({ titel: 'x'.repeat(100), projekt: '', punkte: ['  a  \n b ', '', '1', '2', '3', '4', '5'] }));
  assert.equal(e.titel.length, 80);
  assert.equal(e.projekt, 'unbekannt');
  assert.deepEqual(e.punkte, ['a b', '1', '2', '3', '4']);
});

test('lehnt ungültige Sphäre, leere Punkte, Art, Quelle und Zeiten ab', () => {
  const field = (over) => { try { normalizeEntry(input(over)); } catch (e) { assert.ok(e instanceof JournalError); return e.field; } return null; };
  assert.equal(field({ sphaere: 'kunde' }), 'sphaere');
  assert.equal(field({ punkte: [] }), 'punkte');
  assert.equal(field({ titel: ' ' }), 'titel');
  assert.equal(field({ kind: 'nebenbei' }), 'kind');
  assert.equal(field({ source: 'mac' }), 'source');
  assert.equal(field({ from: 'gestern' }), 'from');
  assert.equal(field({ from: '2026-01-05T09:00:00Z', to: '2026-01-05T08:00:00Z' }), 'from');
  assert.equal(field({ session: '' }), 'session');
});

test('neue Tagesdatei steht danach im Index', () => {
  const r = journal.write(input());
  assert.ok(idx.getNote(r.path));
  assert.ok(!existsSync(join(root, '_System/journal/arbeit')));
});
