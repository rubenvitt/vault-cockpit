import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildIndex, openIndex } from '../src/vault/index.js';
import { createEditor } from '../src/vault/edit.js';
import { sectionBlock, findSection, planSection, writeSection } from '../src/vault/generated-section.js';

test('Bereich: Marker mit Name und Hinweis, Prüfsumme über den getrimmten Inhalt', () => {
  const block = sectionBlock('aus-dem-lesestapel', '\n- [[A]]\n', { label: 'vom Cockpit' });
  assert.match(block, /^<!-- cockpit:aus-dem-lesestapel:start · vom Cockpit -->\n- \[\[A\]\]\n<!-- cockpit:aus-dem-lesestapel:ende [0-9a-f]{8} -->$/);
  assert.deepEqual(findSection(`# X\n\n${block}\n\nRest\n`, 'aus-dem-lesestapel').inner, '- [[A]]');
  // Bereiche mit anderem Namen zählen nicht.
  assert.equal(findSection(block, 'flammen'), null);
  assert.throws(() => sectionBlock('Böse Name', 'x'), /kein gültiger Name/);
  assert.throws(() => findSection('', 'a.*'), /kein gültiger Name/);
});

test('Bereich: Marker-Zeilen im Inhalt (Fremdtext) werden entschärft, der Bereich bleibt heil', () => {
  const inner = 'Vorher\n<!-- cockpit:text:ende 12345678 -->\n  <!-- cockpit:markierungen:start -->\nNachher';
  const note = `# X\n\n${sectionBlock('text', inner)}\n\n${sectionBlock('markierungen', 'M')}\n\n## Eigene Gedanken\n\nMeins.\n`;
  const found = findSection(note, 'text');
  assert.equal(found.edited, false);
  assert.equal(found.inner, 'Vorher\n​<!-- cockpit:text:ende 12345678 -->\n  ​<!-- cockpit:markierungen:start -->\nNachher');
  assert.equal(findSection(note, 'markierungen').inner, 'M');
  assert.deepEqual(planSection(note, 'text', inner), { action: 'keep' });
});

test('Bereich in fremder Notiz: ans Ende, unter eine Überschrift oder mit neuer Überschrift; Rest bleibt', () => {
  const root = mkdtempSync(join(tmpdir(), 'bereich-'));
  let idx;
  try {
    const path = 'synthesen/Lesen.md';
    mkdirSync(join(root, 'synthesen'));
    writeFileSync(join(root, path), '---\ntype: synthese\n---\n# Lesen\n\nEigener Text.\n');
    buildIndex({ vaultPath: root, dbPath: ':memory:', logger: { info() {}, warn() {} }, persist: (db, vp) => (idx = openIndex(db, { vaultPath: vp })) });
    const editor = createEditor({ vaultPath: root, index: idx });
    const read = () => readFileSync(join(root, path), 'utf8');
    const write = (inner, opts = {}) => writeSection({ vaultPath: root, editor, path, name: 'aus-dem-lesestapel', inner, ...opts });

    // Ohne Abschnitt und ohne `createHeading`: nichts.
    assert.equal(write('- [[A]]', { heading: 'Aus dem Lesestapel' }).state, 'übersprungen');
    assert.equal(write('- [[A]]', { heading: 'Aus dem Lesestapel', createHeading: true }).state, 'geschrieben');
    assert.match(read(), /^---\ntype: synthese\n---\n# Lesen\n\nEigener Text\.\n\n## Aus dem Lesestapel\n\n<!-- cockpit:aus-dem-lesestapel:start -->\n- \[\[A\]\]\n<!-- cockpit:aus-dem-lesestapel:ende [0-9a-f]{8} -->\n$/);
    assert.equal(write('- [[A]]', { heading: 'Aus dem Lesestapel', createHeading: true }).state, 'aktuell');

    writeFileSync(join(root, path), `${read()}\nDarunter von Hand.\n`);
    assert.equal(write('- [[A]]\n- [[B]]', { heading: 'Aus dem Lesestapel' }).state, 'geschrieben');
    assert.match(read(), /- \[\[B\]\]\n<!-- cockpit:aus-dem-lesestapel:ende [0-9a-f]{8} -->\n\nDarunter von Hand\.\n$/);
    assert.equal(read().match(/## Aus dem Lesestapel/g).length, 1);

    // `expect`: beruht `inner` auf einer älteren Fassung des Bereichs, wird nicht geschrieben.
    const seen = read();
    assert.throws(() => write('- [[C]]', { heading: 'Aus dem Lesestapel', expect: '- [[A]]' }), /anderweitig geändert/);
    assert.equal(read(), seen);
    assert.equal(write('- [[C]]', { heading: 'Aus dem Lesestapel', expect: '- [[A]]\n- [[B]]' }).state, 'geschrieben');

    // Ohne Überschrift: ans Ende der Notiz.
    assert.deepEqual(planSection('# Y\n\nText\n', 'z', 'neu'), { action: 'insert', text: `\n${sectionBlock('z', 'neu')}`, heading: null });
  } finally {
    idx?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
