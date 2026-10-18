import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIndexManager } from '../src/vault/manager.js';
import { compilePolicy } from '../src/vault/policy.js';
import { createEditor } from '../src/vault/edit.js';
import { moveNote } from '../src/mcp/move.js';

const policy = compilePolicy({
  exclude: ['^privat/'],
  sensitive: { 'areas/Gesundheit': 'gesundheit' },
  readwise: 'resources/readwise',
});

let root, index, deps;
const put = (p, text) => {
  mkdirSync(join(root, p, '..'), { recursive: true });
  writeFileSync(join(root, p), text);
};
const move = (args) => moveNote(deps, args);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'vault-move-'));
  put('inbox/Idee.md', '# Idee\n\nWärmepumpe prüfen.\n');
  put('projects/Alpha/Plan.md', '# Plan\n\nSiehe [[Idee]] und [[inbox/Idee|die Idee]].\n');
  put('projects/Beta.md', '# Beta\n\n![[inbox/Idee.md#Abschnitt]]\n');
  put('areas/Gesundheit/Werte.md', '# Werte\n\nVgl. [[inbox/Idee]].\n');
  put('resources/readwise/Artikel.md', '# Artikel\n');
  put('privat/geheim.md', '# Geheim\n');
  index = createIndexManager({ vaultPath: root, dbPath: ':memory:', policy, logger: { info() {}, warn() {} } });
  deps = { index, editor: createEditor({ vaultPath: root, index }), policy };
});

afterEach(() => {
  index.stop();
  rmSync(root, { recursive: true, force: true });
});

test('legt eine Inbox-Notiz ab; der Index kennt danach den neuen Pfad', () => {
  const r = move({ path: 'inbox/Idee.md', folder: 'projects/Alpha' });
  assert.equal(r.old_path, 'inbox/Idee.md');
  assert.equal(r.new_path, 'projects/Alpha/Idee.md');
  assert.equal(r.changed, true);
  assert.equal(r.new_folder, undefined);
  assert.equal(existsSync(join(root, 'inbox/Idee.md')), false);
  assert.match(readFileSync(join(root, 'projects/Alpha/Idee.md'), 'utf8'), /Wärmepumpe/);
  assert.equal(index.getNote('inbox/Idee.md'), null);
  assert.equal(index.getNote('projects/Alpha/Idee.md').title, 'Idee');
  assert.equal(index.search('Wärmepumpe').results[0].path, 'projects/Alpha/Idee.md');
  // Der Link per Name trifft weiter, die Links per Pfad nicht mehr.
  assert.deepEqual(index.backlinks('projects/Alpha/Idee.md').map((b) => b.path), ['projects/Alpha/Plan.md']);
});

test('nennt Links per Pfad, verschweigt aber vertrauliche Quellen', () => {
  const r = move({ path: 'inbox/Idee.md', folder: 'projects/Alpha/' });
  assert.deepEqual(r.links_to_update, [
    { path: 'projects/Beta.md', title: 'Beta', old_target: 'inbox/Idee.md', new_target: 'projects/Alpha/Idee.md' },
    { path: 'projects/Alpha/Plan.md', title: 'Plan', old_target: 'inbox/Idee', new_target: 'projects/Alpha/Idee' },
  ].sort((a, b) => a.title.localeCompare(b.title)));
  assert.match(r.hint, /per Pfad statt per Name/);
  assert.match(r.hint, /1 Notiz\(en\) in vertraulichen Ordnern/);
  assert.doesNotMatch(JSON.stringify(r), /Gesundheit|Werte/);
});

test('beim Umbenennen zählen auch Links per Name, der neue Name wird vorgeschlagen', () => {
  const r = move({ path: 'inbox/Idee.md', folder: 'areas/Haushalt', name: 'Wärmepumpe' });
  assert.equal(r.new_path, 'areas/Haushalt/Wärmepumpe.md');
  assert.equal(r.new_folder, true);
  const plan = r.links_to_update.filter((l) => l.path === 'projects/Alpha/Plan.md');
  assert.deepEqual(plan.map((l) => [l.old_target, l.new_target]), [['Idee', 'Wärmepumpe'], ['inbox/Idee', 'areas/Haushalt/Wärmepumpe']]);
  assert.match(r.hint, /umbenannt/);
});

test('ohne eingehende Links gibt es keinen Hinweis; derselbe Pfad ändert nichts', () => {
  put('inbox/Allein.md', '# Allein\n');
  index.applyChanges(['inbox/Allein.md']);
  const same = move({ path: 'inbox/Allein.md', folder: 'inbox' });
  assert.equal(same.changed, false);
  const r = move({ path: 'inbox/Allein.md', folder: 'projects' });
  assert.equal(r.links_to_update, undefined);
  assert.equal(r.hint, undefined);
});

test('in vertrauliche, ausgeschlossene oder Readwise-Ordner wird nicht verschoben', () => {
  assert.throws(() => move({ path: 'inbox/Idee.md', folder: 'areas/Gesundheit' }), /vertraulicher oder ausgeschlossener Ordner/);
  assert.throws(() => move({ path: 'inbox/Idee.md', folder: 'areas/Gesundheit/Unterordner' }), /vertraulicher/);
  assert.throws(() => move({ path: 'inbox/Idee.md', folder: 'privat/neu' }), /ausgeschlossener Ordner/);
  assert.throws(() => move({ path: 'inbox/Idee.md', folder: 'resources/readwise' }), /Readwise/);
  assert.throws(() => move({ path: 'inbox/Idee.md', folder: '' }), /Zielordner angeben/);
  assert.ok(existsSync(join(root, 'inbox/Idee.md')));
});

test('aus vertraulichen, ausgeschlossenen und importierten Ordnern wird nicht verschoben', () => {
  assert.throws(() => move({ path: 'areas/Gesundheit/Werte.md', folder: 'projects' }), /vertraulichen oder ausgeschlossenen Ordner/);
  assert.throws(() => move({ path: 'privat/geheim.md', folder: 'projects' }), /vertraulichen oder ausgeschlossenen Ordner/);
  assert.throws(() => move({ path: 'resources/readwise/Artikel.md', folder: 'projects' }), /importierter Text/);
  assert.throws(() => move({ path: 'inbox/gibtsnicht.md', folder: 'projects' }), /nicht gefunden/);
  assert.ok(existsSync(join(root, 'areas/Gesundheit/Werte.md')));
  assert.ok(existsSync(join(root, 'privat/geheim.md')));
});

test('ein ungültiger neuer Name oder ein belegtes Ziel wird abgelehnt', () => {
  assert.throws(() => move({ path: 'inbox/Idee.md', folder: 'projects', name: 'a/b' }), /kein gültiger Dateiname/);
  assert.throws(() => move({ path: 'inbox/Idee.md', folder: 'projects', name: 'Beta' }), /schon eine Notiz/);
  assert.ok(existsSync(join(root, 'inbox/Idee.md')));
});
