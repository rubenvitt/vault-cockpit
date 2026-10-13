import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/http/app.js';
import { createPrincipalCache } from '../src/oauth/principal-cache.js';
import { openIndex, buildIndex } from '../src/vault/index.js';
import { createCapture } from '../src/vault/capture.js';
import { createEditor } from '../src/vault/edit.js';
import { createVaultMcpHandler } from '../src/mcp/server.js';
import { toWebRequest, writeWebResponse } from '../src/http/bridge.js';

const PUBLIC_URL = 'https://mcp.rubeen.dev';
const RESOURCE = `${PUBLIC_URL}/mcp`;

let root, server, base, readToken, captureToken, editToken, principals;

function issue(scopes, token) {
  principals.put(token, { subject: 'ruben', scopes, aud: RESOURCE, expiresAt: Math.floor(Date.now() / 1000) + 600 });
  return token;
}

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'vault-e2e-'));
  mkdirSync(join(root, 'wiki/concepts'), { recursive: true });
  mkdirSync(join(root, 'inbox'), { recursive: true });
  writeFileSync(join(root, 'wiki/concepts/contract-first.md'),
    '---\ntype: concept\ntags: [ai]\n---\n# Contract First\n\nVertrag vor Prompt.');

  let index;
  buildIndex({ vaultPath: root, dbPath: ':memory:', persist: (db, vp) => (index = openIndex(db, { vaultPath: vp })) });
  const capture = createCapture({ vaultPath: root });
  principals = createPrincipalCache();
  readToken = issue(['vault:read'], 'token-nur-lesen');
  captureToken = issue(['vault:read', 'vault:capture'], 'token-mit-capture');
  editToken = issue(['vault:read', 'vault:edit'], 'token-mit-edit');

  const mcpHttp = createVaultMcpHandler({
    index,
    capture,
    editor: createEditor({ vaultPath: root, index }),
    verifyToken: (token) => principals.get(token),
  });

  const app = createApp({
    config: {
      publicUrl: PUBLIC_URL,
      resource: RESOURCE,
      issuer: 'https://id.rubeen.dev',
      supportedScopes: ['vault:read', 'vault:capture'],
      allowedHosts: ['mcp.rubeen.dev'],
      trustProxy: true,
    },
    verifyToken: async (token) => {
      const p = principals.get(token);
      if (!p) throw new Error('Signatur ist ungültig');
      return p;
    },
    mcpHandler: async (req, res, principal, body) => {
      await writeWebResponse(res, await mcpHttp.fetch(toWebRequest(req, body, PUBLIC_URL)));
    },
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server?.close();
  rmSync(root, { recursive: true, force: true });
});

let id = 0;
async function rpc(method, params, token = readToken) {
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'x-forwarded-host': 'mcp.rubeen.dev',
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
  });
  const text = await res.text();
  // Streamable HTTP darf mit SSE antworten — dann die data-Zeile auspacken.
  const line = text.split('\n').find((l) => l.startsWith('data: '));
  return { status: res.status, body: JSON.parse(line ? line.slice(6) : text) };
}

test('initialize beantwortet den Handshake', async () => {
  const r = await rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test', version: '1' },
  });
  assert.equal(r.status, 200);
  assert.ok(r.body.result.serverInfo.name === 'vault-cockpit');
});

test('tools/list nennt alle Vault-Werkzeuge', async () => {
  const r = await rpc('tools/list', {});
  const names = r.body.result.tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    'vault_append', 'vault_capture', 'vault_edit', 'vault_links', 'vault_list',
    'vault_read', 'vault_search', 'vault_set_frontmatter', 'vault_stats',
  ]);
});

test('jedes Werkzeug trägt Titel und readOnly-Kennzeichnung', async () => {
  const tools = (await rpc('tools/list', {})).body.result.tools;
  for (const t of tools) {
    assert.ok(t.title || t.annotations?.title, `${t.name} hat keinen Titel`);
    assert.equal(typeof t.annotations?.readOnlyHint, 'boolean', `${t.name} ohne readOnlyHint`);
    assert.ok(t.name.length <= 64, `${t.name} überschreitet 64 Zeichen`);
  }
});

test('vault_search findet die Notiz', async () => {
  const r = await rpc('tools/call', { name: 'vault_search', arguments: { query: 'Vertrag Prompt' } });
  const data = r.body.result.structuredContent;
  assert.equal(data.total, 1);
  assert.equal(data.results[0].path, 'wiki/concepts/contract-first.md');
});

test('vault_read liefert den Inhalt', async () => {
  const r = await rpc('tools/call', { name: 'vault_read', arguments: { path: 'wiki/concepts/contract-first.md' } });
  assert.match(r.body.result.structuredContent.content, /Vertrag vor Prompt/);
});

test('vault_read meldet einen unbekannten Pfad verständlich', async () => {
  const r = await rpc('tools/call', { name: 'vault_read', arguments: { path: 'gibt/es/nicht.md' } });
  assert.equal(r.body.result.isError, true);
  assert.match(r.body.result.content[0].text, /nicht gefunden/);
});

test('vault_capture wird ohne den Scope vault:capture verweigert', async () => {
  const r = await rpc('tools/call', { name: 'vault_capture', arguments: { title: 'Test', text: 'x' } }, readToken);
  assert.equal(r.body.result.isError, true);
  assert.match(r.body.result.content[0].text, /vault:capture/);
});

test('vault_capture legt mit passendem Scope eine Notiz an', async () => {
  const r = await rpc(
    'tools/call',
    { name: 'vault_capture', arguments: { title: 'Aus dem Gespräch', text: 'Ein Gedanke.', tags: ['idee'] } },
    captureToken,
  );
  assert.equal(r.body.result.isError, undefined);
  const files = readdirSync(join(root, 'inbox'));
  assert.equal(files.length, 1);
  assert.match(files[0], /Aus dem Gespräch\.md$/);
});

test('Bearbeitungswerkzeuge werden ohne den Scope vault:edit verweigert', async () => {
  for (const token of [readToken, captureToken]) {
    const r = await rpc(
      'tools/call',
      { name: 'vault_append', arguments: { path: 'wiki/concepts/contract-first.md', text: 'x' } },
      token,
    );
    assert.equal(r.body.result.isError, true);
    assert.match(r.body.result.content[0].text, /vault:edit/);
  }
  assert.doesNotMatch(readFileSync(join(root, 'wiki/concepts/contract-first.md'), 'utf8'), /\nx\n/);
});

test('vault_edit ersetzt mit passendem Scope eine Textstelle', async () => {
  const r = await rpc(
    'tools/call',
    { name: 'vault_edit', arguments: { path: 'wiki/concepts/contract-first.md', old_text: 'vor Prompt', new_text: 'vor jedem Prompt' } },
    editToken,
  );
  assert.equal(r.body.result.isError, undefined);
  assert.equal(r.body.result.structuredContent.replacements, 1);
  assert.match(readFileSync(join(root, 'wiki/concepts/contract-first.md'), 'utf8'), /Vertrag vor jedem Prompt/);
});

test('vault_set_frontmatter setzt Felder über MCP', async () => {
  const r = await rpc(
    'tools/call',
    { name: 'vault_set_frontmatter', arguments: { path: 'wiki/concepts/contract-first.md', set: { status: 'reviewed', tags: null } } },
    editToken,
  );
  assert.equal(r.body.result.isError, undefined);
  const content = readFileSync(join(root, 'wiki/concepts/contract-first.md'), 'utf8');
  assert.match(content, /^---\ntype: concept\nstatus: reviewed\n---\n/);
});

test('ein Bearbeitungsfehler kommt als verständliche Meldung zurück', async () => {
  const r = await rpc(
    'tools/call',
    { name: 'vault_edit', arguments: { path: 'wiki/concepts/contract-first.md', old_text: 'gibt es nicht', new_text: 'x' } },
    editToken,
  );
  assert.equal(r.body.result.isError, true);
  assert.match(r.body.result.content[0].text, /nicht geändert: old_text kommt in der Notiz nicht vor/);
});

test('ein unbekanntes Token wird abgewiesen', async () => {
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'x-forwarded-host': 'mcp.rubeen.dev', 'content-type': 'application/json', authorization: 'Bearer frei-erfunden' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'tools/list', params: {} }),
  });
  assert.equal(res.status, 401, 'ungeprüfte Tokens dürfen nie durchkommen');
  assert.match(res.headers.get('www-authenticate'), /invalid_token/);
});
