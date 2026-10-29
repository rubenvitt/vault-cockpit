import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSyncJournal } from '../src/sync/server/journal.js';
import { createSyncHttp } from '../src/sync/server/http.js';
import { createTokenStore } from '../src/cockpit/tokens.js';

const require = createRequire(import.meta.url);
const { createSyncEngine, createApi } = require('../obsidian-plugin/main.js');

const quiet = { info() {}, warn() {}, error() {} };
let vault, data, journal, tokens, server, base;

before(async () => {
  vault = mkdtempSync(join(tmpdir(), 'plugin-vault-'));
  data = mkdtempSync(join(tmpdir(), 'plugin-data-'));
  writeFileSync(join(vault, 'Start.md'), '# Start\n');
  journal = createSyncJournal({ vaultPath: vault, dbPath: join(data, 'sync.db'), blobDir: join(data, 'blobs'), logger: quiet });
  journal.scan();
  tokens = createTokenStore({});
  const syncHttp = createSyncHttp({ tokens, journal, logger: quiet });
  server = http.createServer((req, res) => syncHttp.handle(req, res, new URL(req.url, 'http://localhost')));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server?.close();
  journal?.close();
  rmSync(vault, { recursive: true, force: true });
  rmSync(data, { recursive: true, force: true });
});

/** Ein Gerät: Vault im Speicher, Zustand wie in data.json. */
function device(name, files = {}) {
  const token = tokens.create(name, 'sync').token;
  let clock = 1_000;
  const mem = new Map(Object.entries(files).map(([p, t]) => [p, { data: Buffer.from(t), mtime: (clock += 1) }]));
  const trash = [];
  const fs = {
    list: async () => [...mem].map(([path, f]) => ({ path, size: f.data.length, mtime: f.mtime })),
    stat: async (p) => (mem.has(p) ? { size: mem.get(p).data.length, mtime: mem.get(p).mtime } : null),
    read: async (p) => mem.get(p).data,
    write: async (p, d, mtime) => void mem.set(p, { data: Buffer.from(d), mtime: mtime ?? (clock += 1) }),
    remove: async (p) => {
      trash.push(p);
      mem.delete(p);
    },
  };
  const request = async (method, path, params = {}, body) => {
    if (path === '/sync/v1/file' && method === 'GET' && dev.raceOnGet) {
      dev.raceOnGet();
      dev.raceOnGet = null;
    }
    const r = await fetch(`${base}${path}?${new URLSearchParams(params)}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'x-sync-client': 'obsidian-plugin/test' },
      body,
    });
    return { status: r.status, headers: Object.fromEntries(r.headers), body: await r.arrayBuffer() };
  };
  const state = {};
  const engine = createSyncEngine({ fs, api: createApi(request), state });
  const dev = {
    sync: () => engine.sync(),
    text: (p) => (mem.has(p) ? mem.get(p).data.toString('utf8') : null),
    edit: (p, t) => void mem.set(p, { data: Buffer.from(t), mtime: (clock += 1) }),
    del: (p) => void mem.delete(p),
    paths: () => [...mem.keys()].sort(),
    state,
    trash,
    raceOnGet: null,
  };
  return dev;
}

const onServer = (p) => (existsSync(join(vault, p)) ? readFileSync(join(vault, p), 'utf8') : null);

test('Erstabgleich: gleiche Dateien bleiben, fehlende kommen, neue gehen hoch', async () => {
  const mac = device('Mac', { 'Start.md': '# Start\n', 'Mac.md': 'vom Mac\n' });
  const s = await mac.sync();
  assert.equal(s.down, 0);
  assert.equal(s.up, 1);
  assert.equal(onServer('Mac.md'), 'vom Mac\n');

  const phone = device('iPhone');
  await phone.sync();
  assert.deepEqual(phone.paths(), ['Mac.md', 'Start.md']);
  assert.equal(phone.text('Mac.md'), 'vom Mac\n');
  // Nichts geändert: der nächste Abgleich tut nichts.
  assert.deepEqual(await phone.sync(), { down: 0, up: 0, removed: 0, conflicts: [], problems: [] });
});

test('Desktop und iPhone gleichen eine Notiz ab, auch Anhänge und Löschen', async () => {
  const mac = device('Mac2');
  const phone = device('iPhone2');
  await mac.sync();
  await phone.sync();

  mac.edit('Ordner/Notiz.md', 'eins\n');
  mac.edit('bild.png', '\u0000\u0001');
  await mac.sync();
  await phone.sync();
  assert.equal(phone.text('Ordner/Notiz.md'), 'eins\n');
  assert.equal(phone.text('bild.png'), '\u0000\u0001');

  phone.edit('Ordner/Notiz.md', 'eins\nzwei\n');
  await phone.sync();
  await mac.sync();
  assert.equal(mac.text('Ordner/Notiz.md'), 'eins\nzwei\n');

  mac.del('bild.png');
  await mac.sync();
  assert.equal(onServer('bild.png'), null);
  await phone.sync();
  assert.equal(phone.text('bild.png'), null);
  assert.deepEqual(phone.trash, ['bild.png'], 'gelöscht wird in den Papierkorb');
});

test('offline auf beiden Geräten geändert: zusammengeführt bzw. als Konfliktkopie, nichts geht verloren', async () => {
  const mac = device('Mac3');
  const phone = device('iPhone3');
  mac.edit('Plan.md', '# Plan\n\nMontag\n\nDienstag\n');
  await mac.sync();
  await phone.sync();

  // Getrennte Absätze, beide offline.
  mac.edit('Plan.md', '# Plan\n\nMontag: Hund\n\nDienstag\n');
  phone.edit('Plan.md', '# Plan\n\nMontag\n\nDienstag: Sport\n');
  await mac.sync();
  await phone.sync();
  await mac.sync();
  const merged = '# Plan\n\nMontag: Hund\n\nDienstag: Sport\n';
  assert.equal(phone.text('Plan.md'), merged);
  assert.equal(mac.text('Plan.md'), merged);
  assert.equal(onServer('Plan.md'), merged);

  // Dieselbe Zeile: Server behält die erste Fassung, die zweite liegt als Kopie daneben.
  mac.edit('Plan.md', '# Plan\n\nMontag: Tierarzt\n\nDienstag: Sport\n');
  phone.edit('Plan.md', '# Plan\n\nMontag: Spaziergang\n\nDienstag: Sport\n');
  await mac.sync();
  const s = await phone.sync();
  assert.equal(s.conflicts.length, 1);
  const copy = s.conflicts[0];
  assert.match(copy, /^Plan \(Konflikt iPhone3 .*\)\.md$/);
  assert.equal(phone.text('Plan.md'), '# Plan\n\nMontag: Tierarzt\n\nDienstag: Sport\n');
  assert.equal(phone.text(copy), '# Plan\n\nMontag: Spaziergang\n\nDienstag: Sport\n');
  await mac.sync();
  assert.equal(mac.text(copy), '# Plan\n\nMontag: Spaziergang\n\nDienstag: Sport\n');
});

test('Löschen gegen Ändern: Ändern gewinnt in beide Richtungen', async () => {
  const mac = device('Mac4');
  const phone = device('iPhone4');
  mac.edit('A.md', 'a\n');
  mac.edit('B.md', 'b\n');
  await mac.sync();
  await phone.sync();

  // A: Mac löscht, iPhone ändert. B: Mac ändert, iPhone löscht.
  mac.del('A.md');
  phone.edit('A.md', 'a geändert\n');
  mac.edit('B.md', 'b geändert\n');
  phone.del('B.md');
  await mac.sync();
  await phone.sync();
  await mac.sync();
  for (const d of [mac, phone]) {
    assert.equal(d.text('A.md'), 'a geändert\n');
    assert.equal(d.text('B.md'), 'b geändert\n');
  }
});

test('ein neu aufgebauter Server-Stand führt zu einem vollen Abgleich, nicht zu Verlust', async () => {
  const mac = device('Mac5', { 'Eigen.md': 'eigen\n' });
  await mac.sync();
  mac.state.cursor = 10 ** 9; // Server „vergisst“ seinen Zähler
  await mac.sync();
  assert.equal(mac.text('Eigen.md'), 'eigen\n');
  assert.ok(mac.state.cursor <= journal.cursor());
});

test('ohne gültigen Token bricht der Abgleich mit klarer Meldung ab', async () => {
  const api = createApi(async () => ({ status: 401, headers: {}, body: new ArrayBuffer(0) }));
  const engine = createSyncEngine({ fs: { list: async () => [], stat: async () => null }, api, state: {} });
  await assert.rejects(engine.sync(), /Token ungültig/);
});

test('Schattenbetrieb: vergleichen schreibt nichts und meldet Abweichungen mit Dauer', async () => {
  const { createCompare } = require('../obsidian-plugin/main.js');
  const { shadowItems, shadowMarkdown } = await import('../src/sync/shadow-report.js');
  const v = mkdtempSync(join(tmpdir(), 'shadow-vault-'));
  const d = mkdtempSync(join(tmpdir(), 'shadow-data-'));
  writeFileSync(join(v, 'Gleich.md'), 'gleich\n');
  writeFileSync(join(v, 'Anders.md'), 'server\n');
  writeFileSync(join(v, 'NurServer.md'), 'x\n');
  let clock = Date.parse('2026-10-29T10:00:00Z');
  const j = createSyncJournal({ vaultPath: v, dbPath: join(d, 'sync.db'), blobDir: join(d, 'blobs'), logger: quiet, readOnly: true, now: () => clock });
  j.scan();
  const t = tokens.create('iPhone-Schatten', 'sync');
  const h = createSyncHttp({ tokens, journal: j, logger: quiet });
  const srv = http.createServer((req, res) => h.handle(req, res, new URL(req.url, 'http://localhost')));
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const at = `http://127.0.0.1:${srv.address().port}`;
  const request = async (method, path, params = {}, body) => {
    const r = await fetch(`${at}${path}?${new URLSearchParams(params)}`, { method, headers: { authorization: `Bearer ${t.token}` }, body });
    return { status: r.status, headers: Object.fromEntries(r.headers), body: await r.arrayBuffer() };
  };
  const api = createApi(request);

  // Schreiben ist im Schattenbetrieb gesperrt, auch für ein Gerät im Modus „Synchronisieren“.
  assert.equal((await api.put('Neu.md', Buffer.from('x'), null)).status, 403);
  assert.ok(!existsSync(join(v, 'Neu.md')));
  const mem = new Map([['Gleich.md', 'gleich\n'], ['Anders.md', 'gerät\n'], ['NurLokal.md', 'y\n']]);
  const fs = {
    list: async () => [...mem].map(([path, text]) => ({ path, size: text.length, mtime: 1 })),
    stat: async (p) => (mem.has(p) ? { size: mem.get(p).length, mtime: 1 } : null),
    read: async (p) => Buffer.from(mem.get(p)),
    write: async () => assert.fail('Schattenbetrieb darf nicht schreiben'),
    remove: async () => assert.fail('Schattenbetrieb darf nicht löschen'),
  };
  const engine = createSyncEngine({ fs, api, state: {} });
  await assert.rejects(engine.sync(), /Schattenbetrieb/);

  const state = {};
  const cmp = createCompare({ fs, api, state, now: () => clock });
  const first = await cmp.compare();
  assert.equal(first.compared, 3);
  assert.deepEqual(first.diffs.map((x) => [x.path, x.kind]), [['Anders.md', 'different'], ['NurLokal.md', 'only_local'], ['NurServer.md', 'only_server']]);

  // 20 Minuten später: NurServer hat Obsidian Sync inzwischen gebracht, der Rest ist ein Problem.
  clock += 20 * 60_000;
  mem.set('NurServer.md', 'x\n');
  const second = await cmp.compare();
  assert.equal(second.diffs.length, 2);
  const shadow = j.shadow();
  assert.equal(shadow.length, 1);
  assert.equal(shadow[0].name, 'iPhone-Schatten');
  assert.equal(shadow[0].diffs.filter((x) => x.resolvedAt).length, 1);
  const [item] = shadowItems(shadow, clock);
  assert.equal(item.state, 'error');
  assert.match(item.summary, /2 Abweichungen länger als 10 min: Anders\.md \(Inhalt verschieden, seit 20 min\)/);
  const md = shadowMarkdown(shadow, { now: clock });
  assert.match(md, /## iPhone-Schatten/);
  assert.match(md, /\| `NurServer\.md` \| only_server \|/);

  srv.close();
  j.close();
  rmSync(v, { recursive: true, force: true });
  rmSync(d, { recursive: true, force: true });
});

test('eine lokale Änderung während des Holens wird nicht überschrieben', async () => {
  const mac = device('Mac6');
  const phone = device('iPhone6');
  mac.edit('Race.md', 'eins\n');
  await mac.sync();
  await phone.sync();
  mac.edit('Race.md', 'zwei\n');
  await mac.sync();
  // Das iPhone schreibt, während seine Anfrage nach der neuen Fassung unterwegs ist.
  phone.raceOnGet = () => phone.edit('Race.md', 'eins\nlokal\n');
  const s = await phone.sync();
  // Dieselbe Stelle geändert: Server behält „zwei“, die lokale Fassung liegt als Kopie daneben.
  assert.equal(s.conflicts.length, 1);
  assert.equal(phone.text('Race.md'), 'zwei\n');
  assert.equal(phone.text(s.conflicts[0]), 'eins\nlokal\n', 'die lokale Änderung ist nicht verloren');
});
