import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

/** graph.js ohne Browser laden: ohne Graph-Bühne bleibt nur die Hilfsfunktion übrig. */
function loadGraphClient() {
  const document = { querySelector: () => null, addEventListener: () => {} };
  const window = {};
  vm.runInNewContext(readFileSync(new URL('../src/web/static/graph.js', import.meta.url), 'utf8'), { window, document });
  return window.cockpitGraph;
}

test('Graph-Client: Frontmatter-Typ einer Notiz wird nicht zum sigma-Knotentyp', () => {
  const { nodeAttrs } = loadGraphClient();
  const a = nodeAttrs({ id: 'note:wiki/Zyklus.md', kind: 'note', path: 'wiki/Zyklus.md', label: 'Zyklus', type: 'phönix-zyklus' });
  assert.equal(a.type, undefined);
  assert.equal(a.noteType, 'phönix-zyklus');
  assert.equal(a.label, 'Zyklus');
  assert.equal(nodeAttrs({ id: 'task:1', kind: 'task', label: 'Tun', status: 'done', ref: 'VCP-1' }).label, '✓ VCP-1 Tun');
});
