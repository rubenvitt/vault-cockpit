import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildIndex, openIndex } from '../src/vault/index.js';
import { compilePolicy } from '../src/vault/policy.js';
import { createEditor } from '../src/vault/edit.js';
import { createStateStore } from '../src/capture/state.js';
import { createZunderBridge, findMarkedTasks, linkLine } from '../src/capture/bridge.js';

const quiet = { info() {}, warn() {}, error() {} };
const policy = compilePolicy({ sensitive: { 'areas/Gesundheit': 'gesundheit' } });

let root, idx, editor, state, calls, zunder;
const put = (p, text) => {
  mkdirSync(join(root, p, '..'), { recursive: true });
  writeFileSync(join(root, p), text);
};
const read = (p) => readFileSync(join(root, p), 'utf8');

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'vault-bridge-'));
  put('projects/Alpha.md', '# Alpha\n\n- [ ] Angebot schreiben #zunder\n- [x] Erledigt #zunder\n- [ ] Ohne Marke\n\n```\n- [ ] Code #zunder\n```\n');
  put('areas/Gesundheit/Arzt.md', '# Arzt\n\n- [ ] Termin machen #zunder\n');
  buildIndex({ vaultPath: root, dbPath: ':memory:', policy, persist: (db, vp) => (idx = openIndex(db, { vaultPath: vp, policy })) });
  editor = createEditor({ vaultPath: root, index: idx });
  state = createStateStore(null);
  calls = [];
  zunder = {
    async createTask(args) {
      calls.push(args);
      const id = `t${calls.length}`;
      return { id, ref: null, url: `https://zunder.test/#/aufgabe/${id}` };
    },
  };
});

afterEach(() => {
  idx.close();
  rmSync(root, { recursive: true, force: true });
});

test('findMarkedTasks: nur offene Checkboxen mit Tag, nicht in Codeblöcken', () => {
  const found = findMarkedTasks(read('projects/Alpha.md'));
  assert.deepEqual(found.map((f) => f.title), ['Angebot schreiben']);
  assert.deepEqual(findMarkedTasks('- [ ] #zunder Vorn markiert\n- [ ] #zunderei nicht\n1. [ ] Nummer #ZUNDER.').map((f) => f.title), [
    'Vorn markiert',
    'Nummer .',
  ]);
});

test('linkLine ersetzt den Tag durch den Link', () => {
  assert.equal(
    linkLine('- [ ] Angebot #zunder', 'zunder', { ref: null, url: 'https://z/#/aufgabe/1' }),
    '- [ ] Angebot [↗ Zunder](https://z/#/aufgabe/1)',
  );
  assert.equal(linkLine('- [ ] A #zunder', 'zunder', { ref: 'VCP-3', url: 'u' }), '- [ ] A [↗ VCP-3](u)');
});

test('scanAll legt Aufgaben mit Rücklink an und ersetzt die Marke', async () => {
  const bridge = createZunderBridge({ index: idx, editor, zunder, state, vaultName: 'r-notes', logger: quiet });
  assert.equal(await bridge.scanAll(), 1, 'vertrauliche Notizen bleiben außen vor');
  assert.equal(calls[0].title, 'Angebot schreiben');
  assert.deepEqual(calls[0].vaultLinks, ['projects/Alpha.md']);
  assert.match(calls[0].description, /\[\[projects\/Alpha\]\]/);
  assert.match(calls[0].description, /obsidian:\/\/open\?vault=r-notes&file=projects%2FAlpha/);

  const after = read('projects/Alpha.md');
  assert.match(after, /- \[ \] Angebot schreiben \[↗ Zunder\]\(https:\/\/zunder\.test\/#\/aufgabe\/t1\)/);
  assert.match(after, /- \[x\] Erledigt #zunder/);
  assert.match(after, /- \[ \] Code #zunder/);
  assert.match(read('areas/Gesundheit/Arzt.md'), /#zunder/);

  assert.equal(await bridge.scanAll(), 0, 'zweiter Durchlauf legt nichts mehr an');
});

test('scan prüft nur gemeldete Notizen', async () => {
  const bridge = createZunderBridge({ index: idx, editor, zunder, state, logger: quiet });
  assert.equal(await bridge.scan(['projects/Andere.md', 'bild.png']), 0);
  assert.equal(await bridge.scan(['projects/Alpha.md']), 1);
});

test('scheitert das Zurückschreiben, entsteht beim nächsten Mal keine zweite Aufgabe', async () => {
  let fail = true;
  const flaky = {
    replace(args) {
      if (fail) throw new Error('gerade anderweitig geändert');
      return editor.replace(args);
    },
  };
  const bridge = createZunderBridge({ index: idx, editor: flaky, zunder, state, logger: quiet });
  assert.equal(await bridge.scanAll(), 1);
  assert.match(read('projects/Alpha.md'), /Angebot schreiben #zunder/);
  fail = false;
  assert.equal(await bridge.scanAll(), 0);
  assert.equal(calls.length, 1);
  assert.match(read('projects/Alpha.md'), /\[↗ Zunder\]\(https:\/\/zunder\.test\/#\/aufgabe\/t1\)/);
});

test('ist Zunder nicht erreichbar, bleibt die Marke stehen', async () => {
  const down = { createTask: async () => Promise.reject(new Error('HTTP 503')) };
  const bridge = createZunderBridge({ index: idx, editor, zunder: down, state, logger: quiet });
  assert.equal(await bridge.scanAll(), 0);
  assert.match(read('projects/Alpha.md'), /Angebot schreiben #zunder/);
});
