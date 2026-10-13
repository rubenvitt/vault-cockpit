import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildIndex, openIndex } from '../src/vault/index.js';
import { compilePolicy } from '../src/vault/policy.js';

const policy = compilePolicy({
  exclude: ['^privat/nachlass/', '^wiki/log\\.md$'],
  sensitive: { 'areas/Gesundheit': 'gesundheit' },
  readwise: 'resources/readwise',
});

import { createCapture } from '../src/vault/capture.js';
import { readNote, MAX_RESULT_CHARS } from '../src/mcp/read.js';

let root, idx, capture;

before(() => {
  root = mkdtempSync(join(tmpdir(), 'vault-tools-'));
  mkdirSync(join(root, 'projects'), { recursive: true });
  mkdirSync(join(root, 'inbox'), { recursive: true });
  mkdirSync(join(root, 'areas/Gesundheit'), { recursive: true });
  writeFileSync(join(root, 'projects/Alpha.md'), '---\ntags: [ai]\n---\n# Alpha\n\nInhalt.');
  writeFileSync(join(root, 'projects/Riesig.md'), '# Riesig\n\n' + 'wort '.repeat(60000));
  writeFileSync(join(root, 'areas/Gesundheit/Werte.md'), '# Werte\n\nVertraulich.');
  writeFileSync(join(root, 'geheim.txt'), 'kein markdown');

  buildIndex({ vaultPath: root, dbPath: ':memory:', policy, persist: (db, vp) => (idx = openIndex(db, { vaultPath: vp })) });
  capture = createCapture({ vaultPath: root, folder: 'inbox' });
});

after(() => rmSync(root, { recursive: true, force: true }));

test('readNote liefert Inhalt und Metadaten', () => {
  const r = readNote(idx, 'projects/Alpha.md');
  assert.equal(r.title, 'Alpha');
  assert.match(r.content, /Inhalt\./);
  assert.equal(r.truncated, false);
});

test('readNote kürzt übergroße Notizen und sagt es deutlich', () => {
  const r = readNote(idx, 'projects/Riesig.md');
  assert.equal(r.truncated, true);
  assert.ok(r.content.length <= MAX_RESULT_CHARS);
  assert.ok(r.total_chars > MAX_RESULT_CHARS);
});

test('readNote erlaubt einen Offset für den Rest langer Notizen', () => {
  const first = readNote(idx, 'projects/Riesig.md');
  const second = readNote(idx, 'projects/Riesig.md', { offset: first.content.length });
  assert.notEqual(second.content.slice(0, 50), first.content.slice(0, 50));
});

test('readNote verweigert Pfade außerhalb des Index', () => {
  assert.equal(readNote(idx, '../../etc/passwd'), null);
  assert.equal(readNote(idx, 'geheim.txt'), null);
});

test('readNote gibt sensible Notizen nur auf ausdrückliche Anforderung heraus', () => {
  assert.equal(readNote(idx, 'areas/Gesundheit/Werte.md'), null);
  const r = readNote(idx, 'areas/Gesundheit/Werte.md', { allowSensitive: true });
  assert.equal(r.sensitivity, 'gesundheit');
});

test('capture legt eine neue Notiz im Quick-Capture-Ordner an', () => {
  const r = capture.write({ title: 'Neue Idee', text: 'Der Inhalt.' });
  assert.match(r.path, /^inbox\/.*Neue Idee\.md$/);
  const content = readFileSync(join(root, r.path), 'utf8');
  assert.match(content, /Der Inhalt\./);
  assert.match(content, /source: claude-mcp/);
});

test('capture setzt ein Erstellungsdatum ins Frontmatter', () => {
  const r = capture.write({ title: 'Mit Datum', text: 'x' });
  assert.match(readFileSync(join(root, r.path), 'utf8'), /created: \d{4}-\d{2}-\d{2}/);
});

test('capture wehrt Pfad-Traversal im Titel ab', () => {
  assert.throws(() => capture.write({ title: '../../../etc/passwd', text: 'x' }), /Titel/);
  assert.throws(() => capture.write({ title: 'a/b', text: 'x' }), /Titel/);
});

test('capture verlangt einen Titel und Text', () => {
  assert.throws(() => capture.write({ title: '', text: 'x' }), /Titel/);
  assert.throws(() => capture.write({ title: 'ok', text: '' }), /Text/);
});

test('capture überschreibt keine bestehende Datei', () => {
  const a = capture.write({ title: 'Doppelt', text: 'erste' });
  const b = capture.write({ title: 'Doppelt', text: 'zweite' });
  assert.notEqual(a.path, b.path, 'zweiter Aufruf bekommt einen eigenen Dateinamen');
  assert.equal(readdirSync(join(root, 'inbox')).filter((f) => f.includes('Doppelt')).length, 2);
});

test('capture schreibt ausschließlich in den Quick-Capture-Ordner', () => {
  const r = capture.write({ title: 'Irgendwas', text: 'x' });
  assert.ok(r.absolute.startsWith(join(root, 'inbox')));
});
