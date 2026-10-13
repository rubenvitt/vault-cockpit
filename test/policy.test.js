import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compilePolicy, loadPolicy, DEFAULT_POLICY } from '../src/vault/policy.js';

const policy = compilePolicy({
  exclude: ['^privat/geheim'],
  sensitive: { 'leben/Gesundheit/': 'gesundheit' },
  readwise: 'quellen/readwise',
  layoutHint: 'PARA-Struktur.',
});

test('Ausschlüsse greifen per Regex und ohne Rücksicht auf Groß-/Kleinschreibung', () => {
  assert.ok(policy.isExcluded('privat/geheim.md'));
  assert.ok(policy.isExcluded('Privat/Geheim-2.md'));
  assert.ok(!policy.isExcluded('privat/offen.md'));
});

test('.obsidian, .git und node_modules sind immer ausgeschlossen', () => {
  for (const p of ['.obsidian/app.json', '.git/HEAD', 'node_modules/x/README.md']) {
    assert.ok(DEFAULT_POLICY.isExcluded(p), p);
  }
});

test('vertrauliche Ordner gelten nur für den Ordner selbst, nicht für Namensvettern', () => {
  assert.equal(policy.sensitivityOf('leben/Gesundheit/Werte.md'), 'gesundheit');
  assert.equal(policy.sensitivityOf('leben/Gesundheitswesen/Artikel.md'), null);
});

test('Readwise-Ordner wird als eigene Klasse erkannt', () => {
  assert.equal(policy.classify('quellen/readwise/Artikel.md'), 'readwise');
  assert.equal(policy.classify('quellen/eigenes.md'), 'core');
  assert.equal(DEFAULT_POLICY.classify('quellen/readwise/Artikel.md'), 'core');
});

test('ohne Datei gilt die leere Policy', () => {
  const p = loadPolicy(undefined, { logger: {} });
  assert.equal(p, DEFAULT_POLICY);
  assert.equal(p.sensitivityOf('leben/Gesundheit/Werte.md'), null);
  assert.equal(p.layoutHint, null);
});

test('lädt die Policy aus einer JSON-Datei', () => {
  const dir = mkdtempSync(join(tmpdir(), 'policy-'));
  try {
    const file = join(dir, 'policy.json');
    writeFileSync(file, JSON.stringify({ sensitive: { finanzen: 'finanzen' }, layoutHint: 'Hinweis.' }));
    const p = loadPolicy(file);
    assert.equal(p.sensitivityOf('finanzen/Konto.md'), 'finanzen');
    assert.equal(p.layoutHint, 'Hinweis.');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
