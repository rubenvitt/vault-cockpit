import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, unlinkSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildIndex, openIndex } from '../src/vault/index.js';
import { compilePolicy } from '../src/vault/policy.js';
import { createEditor } from '../src/vault/edit.js';

const policy = compilePolicy({
  exclude: ['^privat/'],
  sensitive: { 'areas/Gesundheit': 'gesundheit' },
  readwise: 'resources/readwise',
});

let root, outside, idx, editor;
const read = (p) => readFileSync(join(root, p), 'utf8');
const put = (p, text) => {
  mkdirSync(join(root, p, '..'), { recursive: true });
  writeFileSync(join(root, p), text);
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'vault-edit-'));
  outside = mkdtempSync(join(tmpdir(), 'vault-edit-outside-'));
  put('projects/Alpha.md', '---\ntitle: Alpha\nstatus: active\ntags:\n  - ai\n  - projekt\n---\n# Alpha\n\nErster Absatz.\n\n## Aufgaben\n\n- [ ] eins\n- [ ] zwei\n\n## Notizen\n\nText.\n');
  put('projects/Ohne.md', '# Ohne Frontmatter\n\nNur Text');
  put('projects/Doppelt.md', 'Hallo Welt. Hallo Welt.\n');
  put('areas/Gesundheit/Werte.md', '# Werte\n\nVertraulich.\n');
  put('resources/readwise/Artikel.md', '# Artikel\n\nFremdtext.\n');
  put('privat/geheim.md', '# Geheim\n');
  writeFileSync(join(outside, 'fremd.md'), '# Fremd\n\nAußerhalb.\n');

  buildIndex({ vaultPath: root, dbPath: ':memory:', policy, persist: (db, vp) => (idx = openIndex(db, { vaultPath: vp, policy })) });
  editor = createEditor({ vaultPath: root, index: idx });
});

afterEach(() => {
  idx.close();
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

test('replace ersetzt eine eindeutige Textstelle und lässt den Rest unberührt', () => {
  const before = read('projects/Alpha.md');
  const r = editor.replace({ path: 'projects/Alpha.md', oldText: 'Erster Absatz.', newText: 'Neuer Absatz.' });
  assert.equal(r.changed, true);
  assert.equal(r.replacements, 1);
  assert.equal(read('projects/Alpha.md'), before.replace('Erster Absatz.', 'Neuer Absatz.'));
});

test('replace verweigert mehrdeutige Stellen ohne replace_all', () => {
  assert.throws(() => editor.replace({ path: 'projects/Doppelt.md', oldText: 'Hallo', newText: 'Tschüss' }), /2-mal/);
  assert.equal(read('projects/Doppelt.md'), 'Hallo Welt. Hallo Welt.\n');
  const r = editor.replace({ path: 'projects/Doppelt.md', oldText: 'Hallo', newText: 'Tschüss', replaceAll: true });
  assert.equal(r.replacements, 2);
  assert.equal(read('projects/Doppelt.md'), 'Tschüss Welt. Tschüss Welt.\n');
});

test('replace meldet fehlenden Text und interpretiert $-Muster nicht', () => {
  assert.throws(() => editor.replace({ path: 'projects/Alpha.md', oldText: 'gibt es nicht', newText: 'x' }), /nicht vor/);
  editor.replace({ path: 'projects/Alpha.md', oldText: 'Text.', newText: "$& und $1 und $'" });
  assert.match(read('projects/Alpha.md'), /\$& und \$1 und \$'\n$/);
});

test('replace mit leerem new_text löscht die Stelle', () => {
  editor.replace({ path: 'projects/Alpha.md', oldText: '- [ ] zwei\n', newText: '' });
  assert.doesNotMatch(read('projects/Alpha.md'), /zwei/);
});

test('vertrauliche, importierte, ausgeschlossene und unbekannte Notizen sind gesperrt', () => {
  const tryEdit = (path) => editor.replace({ path, oldText: '#', newText: '##' });
  assert.throws(() => tryEdit('areas/Gesundheit/Werte.md'), /vertraulich/);
  assert.throws(() => tryEdit('resources/readwise/Artikel.md'), /importiert/);
  assert.throws(() => tryEdit('privat/geheim.md'), /nicht gefunden/);
  assert.throws(() => tryEdit('../../etc/passwd'), /nicht gefunden/);
  assert.equal(read('areas/Gesundheit/Werte.md'), '# Werte\n\nVertraulich.\n');
  assert.equal(read('privat/geheim.md'), '# Geheim\n');
});

test('ein nachträglich untergeschobener Symlink führt nicht aus dem Vault heraus', () => {
  unlinkSync(join(root, 'projects/Ohne.md'));
  symlinkSync(join(outside, 'fremd.md'), join(root, 'projects/Ohne.md'));
  assert.throws(() => editor.append({ path: 'projects/Ohne.md', text: 'x' }), /aus dem Vault/);
  assert.equal(readFileSync(join(outside, 'fremd.md'), 'utf8'), '# Fremd\n\nAußerhalb.\n');
});

test('append hängt ans Ende an und sorgt für einen abschließenden Zeilenumbruch', () => {
  editor.append({ path: 'projects/Ohne.md', text: '\nNachtrag.' });
  assert.equal(read('projects/Ohne.md'), '# Ohne Frontmatter\n\nNur Text\n\nNachtrag.\n');
});

test('append setzt eine Liste unter einer Überschrift nahtlos fort', () => {
  editor.append({ path: 'projects/Alpha.md', text: '- [ ] drei', heading: 'Aufgaben' });
  assert.match(read('projects/Alpha.md'), /- \[ \] zwei\n- \[ \] drei\n\n## Notizen/);
});

test('append akzeptiert die Überschrift mit Rauten und meldet unbekannte', () => {
  editor.append({ path: 'projects/Alpha.md', text: 'Mehr.', heading: '## Notizen' });
  assert.match(read('projects/Alpha.md'), /Text\.\nMehr\.\n$/);
  assert.throws(
    () => editor.append({ path: 'projects/Alpha.md', text: 'x', heading: 'Fehlt' }),
    /nicht gefunden\. Vorhanden: # Alpha, ## Aufgaben, ## Notizen/,
  );
});

test('append ignoriert Überschriften in Code-Blöcken', () => {
  put('projects/Code.md', '# Code\n\n```bash\n# Aufgaben\necho hi\n```\n\n## Aufgaben\n\n- a\n');
  idx.refresh('projects/Code.md');
  editor.append({ path: 'projects/Code.md', text: '- b', heading: 'Aufgaben' });
  assert.equal(read('projects/Code.md'), '# Code\n\n```bash\n# Aufgaben\necho hi\n```\n\n## Aufgaben\n\n- a\n- b\n');
});

test('append behält Windows-Zeilenenden bei', () => {
  put('projects/Crlf.md', '# Crlf\r\n\r\nZeile\r\n');
  idx.refresh('projects/Crlf.md');
  editor.append({ path: 'projects/Crlf.md', text: 'Neu' });
  assert.equal(read('projects/Crlf.md'), '# Crlf\r\n\r\nZeile\r\nNeu\r\n');
});

test('setFrontmatter ändert, ergänzt und entfernt Felder und lässt den Rest stehen', () => {
  const r = editor.setFrontmatter({
    path: 'projects/Alpha.md',
    set: { status: 'done', priority: 2, review: true, tags: ['#ai', 'archiv'], title: null },
  });
  assert.deepEqual(r.updated, ['status', 'priority', 'review', 'tags']);
  assert.deepEqual(r.removed, ['title']);
  assert.equal(
    read('projects/Alpha.md'),
    '---\nstatus: done\ntags:\n  - ai\n  - archiv\npriority: 2\nreview: true\n---\n# Alpha\n\nErster Absatz.\n\n## Aufgaben\n\n- [ ] eins\n- [ ] zwei\n\n## Notizen\n\nText.\n',
  );
});

test('setFrontmatter legt ein Frontmatter an, wenn keins existiert', () => {
  editor.setFrontmatter({ path: 'projects/Ohne.md', set: { type: 'concept' } });
  assert.equal(read('projects/Ohne.md'), '---\ntype: concept\n---\n# Ohne Frontmatter\n\nNur Text');
});

test('setFrontmatter quotet, was YAML sonst anders lesen würde', () => {
  editor.setFrontmatter({
    path: 'projects/Ohne.md',
    set: { a: 'true', b: '42', c: 'Titel: mit Doppelpunkt', d: '[[Link]]', e: '2026-10-03', f: 'ganz normal' },
  });
  assert.match(
    read('projects/Ohne.md'),
    /^---\na: "true"\nb: "42"\nc: "Titel: mit Doppelpunkt"\nd: "\[\[Link\]\]"\ne: 2026-10-03\nf: ganz normal\n---\n/,
  );
});

test('setFrontmatter respektiert deutsche Schlüssel-Aliasse', () => {
  put('projects/Typ.md', '---\ntyp: idee\n---\nText\n');
  idx.refresh('projects/Typ.md');
  editor.setFrontmatter({ path: 'projects/Typ.md', set: { type: 'concept' } });
  assert.equal(read('projects/Typ.md'), '---\ntyp: concept\n---\nText\n');
});

test('setFrontmatter lehnt ungültige Schlüssel und Zeilenumbrüche ab', () => {
  assert.throws(() => editor.setFrontmatter({ path: 'projects/Alpha.md', set: { 'a b': 'x' } }), /Feldname/);
  assert.throws(() => editor.setFrontmatter({ path: 'projects/Alpha.md', set: { a: 'x\nevil: 1' } }), /Zeilenumbrüche/);
  assert.throws(() => editor.setFrontmatter({ path: 'projects/Alpha.md', set: {} }), /Mindestens/);
});

test('nach einer Bearbeitung sind Suche und Frontmatter sofort aktuell', () => {
  editor.append({ path: 'projects/Alpha.md', text: 'Quokka gesichtet.' });
  editor.setFrontmatter({ path: 'projects/Alpha.md', set: { status: 'done' } });
  assert.equal(idx.search('Quokka').total, 1);
  assert.equal(idx.getNote('projects/Alpha.md').status, 'done');
  assert.equal(idx.search('Alpha').total, 1, 'die Notiz steht nicht doppelt im Index');
});

test('eine unveränderte Notiz wird nicht geschrieben', () => {
  const r = editor.setFrontmatter({ path: 'projects/Ohne.md', set: { gibtsnicht: null } });
  assert.equal(r.changed, false);
});

test('move: legt eine Notiz in einen anderen Ordner, ohne zu überschreiben', () => {
  const r = editor.move({ path: 'projects/Ohne.md', folder: 'archiv/2026/' });
  assert.deepEqual(r, { path: 'archiv/2026/Ohne.md', from: 'projects/Ohne.md', changed: true });
  assert.match(read('archiv/2026/Ohne.md'), /Nur Text/);
  assert.equal(idx.getNote('projects/Ohne.md'), null);
  assert.equal(idx.getNote('archiv/2026/Ohne.md').title, 'Ohne Frontmatter');

  put('projects/Ohne.md', 'neu');
  idx.refresh('projects/Ohne.md');
  assert.throws(() => editor.move({ path: 'projects/Ohne.md', folder: 'archiv/2026' }), /schon eine Notiz/);
  for (const bad of ['', '../raus', 'a/../b', '.obsidian', 'a\nb']) {
    assert.throws(() => editor.move({ path: 'projects/Alpha.md', folder: bad }), /kein gültiger Ordner/);
  }
  assert.throws(() => editor.move({ path: 'areas/Gesundheit/Werte.md', folder: 'x' }), /vertraulichen/);
});

test('move: mit name wird umbenannt, .md ergänzt und ungültige Namen abgelehnt', () => {
  const r = editor.move({ path: 'projects/Ohne.md', folder: 'archiv', name: 'Neuer Name' });
  assert.deepEqual(r, { path: 'archiv/Neuer Name.md', from: 'projects/Ohne.md', changed: true });
  assert.match(read('archiv/Neuer Name.md'), /Nur Text/);
  assert.equal(idx.getNote('archiv/Neuer Name.md').title, 'Ohne Frontmatter');

  // Nur umbenennen, im selben Ordner; eine vorhandene .md-Endung bleibt, wie sie ist.
  assert.equal(editor.move({ path: 'archiv/Neuer Name.md', folder: 'archiv', name: 'Final.MD' }).path, 'archiv/Final.MD');
  assert.throws(() => editor.move({ path: 'projects/Alpha.md', folder: 'projects', name: 'Doppelt' }), /schon eine Notiz/);
  for (const bad of ['', '   ', 'a/b', 'a\\b', '.versteckt', 'Zeile\nzwei', 'Frage?', 'Link [[x]]', 'mit#raute', 'Punkt.', 'x'.repeat(201)]) {
    assert.throws(() => editor.move({ path: 'projects/Alpha.md', folder: 'archiv', name: bad }), /kein gültiger Dateiname/, JSON.stringify(bad));
  }
  assert.match(read('projects/Alpha.md'), /Erster Absatz/);
});

test('move: bricht ab, wenn der Sync die Notiz zwischendurch ändert', (t) => {
  // existsSync läuft zwischen dem ersten Lesen und dem Verschieben; dort schreibt hier „der Sync“.
  const original = fs.existsSync;
  t.mock.method(fs, 'existsSync', (p) => {
    if (String(p).endsWith('archiv/Alpha.md')) writeFileSync(join(root, 'projects/Alpha.md'), 'vom Sync geändert\n');
    return original(p);
  });
  syncBuiltinESMExports();
  try {
    assert.throws(() => editor.move({ path: 'projects/Alpha.md', folder: 'archiv' }), /anderweitig geändert/);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
  assert.equal(read('projects/Alpha.md'), 'vom Sync geändert\n');
  assert.equal(original(join(root, 'archiv/Alpha.md')), false);
});

test('move: Zielordner per Symlink außerhalb des Vaults wird abgelehnt', () => {
  symlinkSync(outside, join(root, 'raus'));
  assert.throws(() => editor.move({ path: 'projects/Alpha.md', folder: 'raus/neu' }), /aus dem Vault heraus/);
  assert.match(read('projects/Alpha.md'), /Erster Absatz/);
});

test('create: legt eine neue Notiz an, überschreibt nie und bleibt im Vault', () => {
  const r = editor.create({ folder: 'feuer/2026', name: 'Feuer W3.md', content: '# Feuer W3\n' });
  assert.deepEqual(r, { path: 'feuer/2026/Feuer W3.md', changed: true });
  assert.equal(read('feuer/2026/Feuer W3.md'), '# Feuer W3\n');
  assert.equal(idx.getNote('feuer/2026/Feuer W3.md').title, 'Feuer W3');

  assert.throws(() => editor.create({ folder: 'projects', name: 'Alpha.md', content: 'weg' }), /schon eine Notiz/);
  assert.match(read('projects/Alpha.md'), /Erster Absatz/);
  for (const bad of ['', '../raus', '.obsidian']) {
    assert.throws(() => editor.create({ folder: bad, name: 'x.md', content: '' }), /kein gültiger Ordner/);
  }
  for (const bad of ['a/b.md', '.x.md', '', 'A#B.md', 'Leer .md']) {
    assert.throws(() => editor.create({ folder: 'projects', name: bad, content: '' }), /kein gültiger Dateiname/);
  }
  symlinkSync(outside, join(root, 'raus'));
  assert.throws(() => editor.create({ folder: 'raus/neu', name: 'x.md', content: '' }), /aus dem Vault heraus/);
});

test('toggleTask: n-te Checkbox ab- und aufhaken, nur wenn die Zeile noch passt', () => {
  put('projects/Liste.md', '# Liste\n\n```\n- [ ] im Code\n```\n- [ ] eins\n  - [x] zwei\n');
  idx.refresh('projects/Liste.md');
  editor.toggleTask({ path: 'projects/Liste.md', n: 0, line: '- [ ] eins', done: true });
  assert.match(read('projects/Liste.md'), /^- \[x\] eins$/m);
  assert.match(read('projects/Liste.md'), /^- \[ \] im Code$/m);
  editor.toggleTask({ path: 'projects/Liste.md', n: 1, line: '- [x] zwei', done: false });
  assert.match(read('projects/Liste.md'), /^ {2}- \[ \] zwei$/m);
  assert.throws(() => editor.toggleTask({ path: 'projects/Liste.md', n: 0, line: '- [ ] anders', done: true }), /nicht mehr an dieser Stelle/);
  assert.throws(() => editor.toggleTask({ path: 'projects/Liste.md', n: 5, done: true }), /nicht mehr an dieser Stelle/);
});

test('setSectionParagraph: ersetzt nur den ersten Absatz, legt fehlende Abschnitte an', () => {
  put('projects/Feuer.md', '---\ntype: 1-wochen-feuer\n---\n# KW 42\n\n## Feuer-Ziel\nAltes Ziel\nzweite Zeile\n\nZweiter Absatz bleibt.\n\n## Erster Zug\n\n## Rückblick\nText\n');
  idx.refresh('projects/Feuer.md');
  const r = editor.setSectionParagraph({ path: 'projects/Feuer.md', heading: 'Feuer-Ziel', text: 'Neues **Ziel**\n' });
  assert.equal(r.previous, 'Altes Ziel zweite Zeile');
  assert.match(read('projects/Feuer.md'), /## Feuer-Ziel\nNeues \*\*Ziel\*\*\n\nZweiter Absatz bleibt\./);
  editor.setSectionParagraph({ path: 'projects/Feuer.md', heading: 'Erster Zug', text: 'Loslegen' });
  assert.match(read('projects/Feuer.md'), /## Erster Zug\n\nLoslegen\n\n## Rückblick\nText\n$/);
  editor.setSectionParagraph({ path: 'projects/Feuer.md', heading: 'Notizen', text: 'neu' });
  assert.match(read('projects/Feuer.md'), /## Rückblick\nText\n\n## Notizen\n\nneu\n$/);
  assert.throws(() => editor.setSectionParagraph({ path: 'projects/Feuer.md', heading: 'Notizen', text: '  ' }), /leer/);
});
