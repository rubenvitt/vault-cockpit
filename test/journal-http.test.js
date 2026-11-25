import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildIndex, openIndex } from '../src/vault/index.js';
import { compilePolicy } from '../src/vault/policy.js';
import { createApp } from '../src/http/app.js';
import { createTokenStore } from '../src/cockpit/tokens.js';
import { createJournal } from '../src/journal/journal.js';
import { createJournalHttp } from '../src/journal/http.js';
import { createCaptureHttp } from '../src/capture/http.js';

const quiet = { info() {}, warn() {}, error() {}, log() {} };
const entry = {
  titel: 'Remote-Block', sphaere: 'arbeit', projekt: 'demo', kontext: 'Test.', punkte: ['eins'],
  from: '2026-01-05T08:00:00Z', to: '2026-01-05T08:45:00Z', session: 'abcdef1234', kind: 'auto', source: 'code-web',
};

let root, idx, tokens, journalToken, captureToken, app, base;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'vault-journal-http-'));
  mkdirSync(join(root, 'inbox'));
  writeFileSync(join(root, 'a.md'), '# A\n');
  buildIndex({ vaultPath: root, dbPath: ':memory:', policy: compilePolicy({}), persist: (db, vp) => (idx = openIndex(db, { vaultPath: vp, policy: compilePolicy({}) })) });
  tokens = createTokenStore({ logger: quiet });
  journalToken = tokens.create('session-journal', 'journal').token;
  captureToken = tokens.create('kurzbefehl', 'capture').token;
  const router = { route: async () => ({ kind: 'note', path: 'inbox/x.md' }) };
  app = createApp({
    config: { publicUrl: 'https://vault.test', resource: 'https://vault.test/mcp', issuer: 'https://id.test', supportedScopes: [], allowedHosts: ['vault.test'], trustProxy: true },
    verifyToken: async () => { throw new Error('nicht benutzt'); },
    mcpHandler: async () => {},
    captureHttp: createCaptureHttp({ tokens, router }),
    journalHttp: createJournalHttp({ tokens, journal: createJournal({ vaultPath: root, index: idx }) }),
    logger: quiet,
  });
  app.listen(0, '127.0.0.1');
  await new Promise((r) => app.once('listening', r));
  base = `http://127.0.0.1:${app.address().port}`;
});

afterEach(() => {
  app.close();
  idx.close();
  rmSync(root, { recursive: true, force: true });
});

const call = (path, { method = 'POST', body = entry, token = journalToken } = {}) =>
  fetch(base + path, {
    method,
    headers: { 'x-forwarded-host': 'vault.test', 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: method === 'GET' ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });

test('201 und Datei geschrieben mit journal-Token', async () => {
  const res = await call('/journal');
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.written, true);
  assert.equal(body.path, '_System/journal/arbeit/2026-01-05.md');
  assert.match(readFileSync(join(root, body.path), 'utf8'), /· auto · code-web\n/);
});

test('200 duplicate beim zweiten Mal', async () => {
  await call('/journal');
  const res = await call('/journal');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { written: false, reason: 'duplicate' });
});

test('401 ohne Token und mit capture-Token', async () => {
  assert.equal((await call('/journal', { token: null })).status, 401);
  assert.equal((await call('/journal', { token: captureToken })).status, 401);
  assert.ok(!existsSync(join(root, '_System')));
});

test('400 mit Feld bei ungültiger Eingabe und kaputtem JSON', async () => {
  const res = await call('/journal', { body: { ...entry, sphaere: 'kunde' } });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).field, 'sphaere');
  assert.equal((await call('/journal', { body: '{kaputt' })).status, 400);
});

test('GET /journal ist ein Verbindungstest', async () => {
  const res = await call('/journal', { method: 'GET' });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});

test('ein journal-Token kommt nicht an /capture', async () => {
  assert.equal((await call('/capture', { token: journalToken, body: { text: 'x' } })).status, 401);
});
