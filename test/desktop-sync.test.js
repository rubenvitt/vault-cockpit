import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSyncJournal } from '../src/sync/server/journal.js';
import { createSyncHttp } from '../src/sync/server/http.js';
import { createTokenStore } from '../src/cockpit/tokens.js';
import { createNodeFs, createRequest, createDaemon } from '../desktop-sync/cockpit-sync.mjs';

const require = createRequire(import.meta.url);
const { createApi } = require('../obsidian-plugin/main.js');
const quiet = { info() {}, warn() {}, error() {} };
let serverVault, macVault, data, journal, server, base, token;

before(async () => {
  serverVault = mkdtempSync(join(tmpdir(), 'ds-server-'));
  macVault = mkdtempSync(join(tmpdir(), 'ds-mac-'));
  data = mkdtempSync(join(tmpdir(), 'ds-data-'));
  writeFileSync(join(serverVault, 'Server.md'), '# Server\n');
  mkdirSync(join(macVault, '.obsidian'));
  writeFileSync(join(macVault, '.obsidian/app.json'), '{}');
  writeFileSync(join(macVault, 'Mac.md'), '# Mac\n');
  journal = createSyncJournal({ vaultPath: serverVault, dbPath: join(data, 'sync.db'), blobDir: join(data, 'blobs'), logger: quiet });
  journal.scan();
  const tokens = createTokenStore({});
  token = tokens.create('r-mac', 'sync').token;
  const syncHttp = createSyncHttp({ tokens, journal, logger: quiet });
  server = http.createServer((req, res) => syncHttp.handle(req, res, new URL(req.url, 'http://localhost')));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server?.close();
  journal?.close();
  for (const d of [serverVault, macVault, data]) rmSync(d, { recursive: true, force: true });
});

test('Dienst gleicht den Ordner auf der Platte ab: hoch, runter, Löschen in .trash, versteckte Pfade bleiben', async () => {
  const api = createApi(createRequest(base, token));
  const state = { cursor: null, files: {} };
  const daemon = createDaemon({ fs: createNodeFs(macVault), api, state, save: async () => {}, log: quiet });

  await daemon.syncNow();
  assert.equal(readFileSync(join(macVault, 'Server.md'), 'utf8'), '# Server\n');
  assert.equal(readFileSync(join(serverVault, 'Mac.md'), 'utf8'), '# Mac\n');
  assert.equal(existsSync(join(serverVault, '.obsidian/app.json')), false);

  // Ein anderes Gerät ändert und löscht; Long-Polling weckt, der Abgleich holt.
  const since = state.cursor;
  const waiting = api.waitForChanges(since, 5);
  const other = createApi(createRequest(base, token));
  const server_ = (await other.state()).files.find((f) => f.path === 'Server.md');
  await other.put('Server.md', Buffer.from('# Server\nneu\n'), server_.hash);
  assert.ok((await waiting).cursor > since);
  await daemon.syncNow();
  assert.equal(readFileSync(join(macVault, 'Server.md'), 'utf8'), '# Server\nneu\n');

  const mac = (await other.state()).files.find((f) => f.path === 'Mac.md');
  await other.del('Mac.md', mac.hash);
  await daemon.syncNow();
  assert.equal(existsSync(join(macVault, 'Mac.md')), false);
  assert.equal(readFileSync(join(macVault, '.trash/Mac.md'), 'utf8'), '# Mac\n');
});

test('Node-Dateisystem weist Pfade außerhalb des Vaults und versteckte Pfade ab', async () => {
  const fs = createNodeFs(macVault);
  for (const p of ['../draußen.md', 'a/../../draußen.md', '/etc/passwd', '.obsidian/app.json', 'a//b.md']) {
    await assert.rejects(fs.write(p, Buffer.from('x')), /Ungültiger Pfad|außerhalb/, p);
  }
  await assert.rejects(fs.remove('../draußen.md'), /Ungültiger Pfad/);
});
