import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIndexManager } from '../src/vault/manager.js';

let root, dbPath, mgr;

before(() => {
  root = mkdtempSync(join(tmpdir(), 'vault-mgr-'));
  dbPath = join(mkdtempSync(join(tmpdir(), 'vault-mgr-db-')), 'index.db');
  mkdirSync(join(root, 'projects'), { recursive: true });
  writeFileSync(join(root, 'projects/Erste.md'), '# Erste\n\nEinhorn im Nebel.');
  mgr = createIndexManager({ vaultPath: root, dbPath });
});

after(() => {
  mgr?.stop();
  rmSync(root, { recursive: true, force: true });
});

test('findet die anfangs vorhandene Notiz', () => {
  assert.equal(mgr.search('Einhorn').total, 1);
});

test('eine neu angelegte Notiz wird erst nach dem Neuaufbau gefunden', () => {
  writeFileSync(join(root, 'projects/Zweite.md'), '# Zweite\n\nEinhorn auf der Wiese.');
  assert.equal(mgr.search('Einhorn').total, 1, 'vor dem Neuaufbau noch unbekannt');
  mgr.rebuild();
  assert.equal(mgr.search('Einhorn').total, 2);
});

test('eine gelöschte Notiz verschwindet nach dem Neuaufbau', () => {
  unlinkSync(join(root, 'projects/Zweite.md'));
  mgr.rebuild();
  assert.equal(mgr.search('Einhorn').total, 1);
});

test('getNote und backlinks funktionieren auch nach einem Neuaufbau', () => {
  writeFileSync(join(root, 'projects/Dritte.md'), '# Dritte\n\nVerweist auf [[Erste]].');
  mgr.rebuild();
  assert.equal(mgr.getNote('projects/Dritte.md').title, 'Dritte');
  assert.deepEqual(mgr.backlinks('projects/Erste.md').map((b) => b.path), ['projects/Dritte.md']);
});

test('meldet den Zeitpunkt des letzten Neuaufbaus', () => {
  const before = mgr.lastBuiltAt();
  mgr.rebuild();
  assert.ok(mgr.lastBuiltAt() >= before);
  assert.ok(mgr.stats().total >= 1);
});
