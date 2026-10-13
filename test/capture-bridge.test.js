import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildIndex, openIndex } from '../src/vault/index.js';
import { compilePolicy } from '../src/vault/policy.js';
import { createEditor } from '../src/vault/edit.js';
import { createStateStore } from '../src/capture/state.js';
import { createZunderBridge, findMarkedTasks, findLinkedTasks, closeLine, linkLine } from '../src/capture/bridge.js';

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

const linked = (id, label = '↗ Zunder') => `[${label}](https://zunder.test/#/aufgabe/${id})`;

function backVault() {
  put('projects/Beta.md', [
    '# Beta',
    '',
    `- [ ] Erledigt in Zunder ${linked('d1', '↗ VCP-1')}`,
    `- [ ] Noch offen ${linked('o1')}`,
    `- [ ] Verworfen ${linked('x1')}`,
    `  1. [ ] Nummeriert erledigt ${linked('d2')}`,
    `- [x] Schon abgehakt ${linked('d3')}`,
    `- [ ] Fremde Instanz [↗ Zunder](https://anders.test/#/aufgabe/d1)`,
    '```',
    `- [ ] Im Code ${linked('d1')}`,
    '```',
    '',
  ].join('\n'));
  put('areas/Gesundheit/Termin.md', `# Termin\n\n- [ ] Vertraulich ${linked('d1')}\n`);
  idx.close();
  buildIndex({ vaultPath: root, dbPath: ':memory:', policy, persist: (db, vp) => (idx = openIndex(db, { vaultPath: vp, policy })) });
  editor = createEditor({ vaultPath: root, index: idx });
}

function statusZunder(statuses) {
  const asked = [];
  return {
    asked,
    taskUrl: (id) => `https://zunder.test/#/aufgabe/${id}`,
    async getTask(id) {
      asked.push(id);
      if (!(id in statuses)) throw new Error('Zunder lehnt ab: Aufgabe nicht gefunden');
      return { id, status: statuses[id] };
    },
  };
}

test('findLinkedTasks: nur offene Checkboxen mit Zunder-Link, nicht in Codeblöcken', () => {
  backVault();
  const found = findLinkedTasks(read('projects/Beta.md'), 'https://zunder.test/#/aufgabe/');
  assert.deepEqual(found.map((f) => f.id), ['d1', 'o1', 'x1', 'd2']);
  assert.equal(findLinkedTasks(read('projects/Beta.md')).length, 5, 'ohne Präfix zählt jede Zunder-Adresse');
});

test('closeLine setzt die Markierung und lässt den Rest stehen', () => {
  assert.equal(closeLine('- [ ] A [↗ Zunder](u)', 'x'), '- [x] A [↗ Zunder](u)');
  assert.equal(closeLine('  1. [ ] B', '-'), '  1. [-] B');
});

test('syncBack hakt erledigte Aufgaben ab und markiert verworfene', async () => {
  backVault();
  const z = statusZunder({ d1: 'done', d2: 'done', o1: 'in_progress', x1: 'dropped' });
  const bridge = createZunderBridge({ index: idx, editor, zunder: z, state, logger: quiet });
  assert.equal(await bridge.syncBack(), 3);

  const after = read('projects/Beta.md');
  assert.match(after, /- \[x\] Erledigt in Zunder \[↗ VCP-1\]/);
  assert.match(after, /- \[ \] Noch offen/);
  assert.match(after, /- \[-\] Verworfen/);
  assert.match(after, / {2}1\. \[x\] Nummeriert erledigt/);
  assert.match(after, /- \[ \] Fremde Instanz/, 'Links auf eine andere Zunder-Instanz bleiben unberührt');
  assert.match(after, /- \[ \] Im Code/, 'Codeblöcke bleiben unberührt');
  assert.match(read('areas/Gesundheit/Termin.md'), /- \[ \] Vertraulich/, 'vertrauliche Notizen bleiben unberührt');
  assert.deepEqual(z.asked.sort(), ['d1', 'd2', 'o1', 'x1'], 'je Aufgabe eine Abfrage, abgehakte nicht');
});

test('syncBack: nicht abrufbare Aufgaben bleiben offen, der Rest läuft weiter', async () => {
  backVault();
  const z = statusZunder({ d2: 'done' });
  const bridge = createZunderBridge({ index: idx, editor, zunder: z, state, logger: quiet });
  assert.equal(await bridge.syncBack(), 1);
  const after = read('projects/Beta.md');
  assert.match(after, /- \[ \] Erledigt in Zunder/);
  assert.match(after, /1\. \[x\] Nummeriert erledigt/);
});

test('Hinweg und Rückweg: übertragene Aufgabe wird nach dem Erledigen abgehakt', async () => {
  const statuses = {};
  const z = {
    ...statusZunder(statuses),
    async createTask(args) {
      calls.push(args);
      statuses.t1 = 'open';
      return { id: 't1', ref: 'VCP-1', url: 'https://zunder.test/#/aufgabe/t1' };
    },
  };
  const bridge = createZunderBridge({ index: idx, editor, zunder: z, state, logger: quiet });
  await bridge.scanAll();
  assert.equal(await bridge.syncBack(), 0);
  statuses.t1 = 'done';
  assert.equal(await bridge.syncBack(), 1);
  assert.match(read('projects/Alpha.md'), /- \[x\] Angebot schreiben \[↗ VCP-1\]/);
});
