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
import { createGraph } from '../src/graph/graph.js';
import { compilePolicy } from '../src/vault/policy.js';

const PUBLIC_URL = 'https://mcp.rubeen.dev';
const RESOURCE = `${PUBLIC_URL}/mcp`;

let root, server, base, readToken, captureToken, editToken, principals, index;

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

  buildIndex({ vaultPath: root, dbPath: ':memory:', persist: (db, vp) => (index = openIndex(db, { vaultPath: vp })) });
  const capture = createCapture({ vaultPath: root });
  principals = createPrincipalCache();
  readToken = issue(['vault:read'], 'token-nur-lesen');
  captureToken = issue(['vault:read', 'vault:capture'], 'token-mit-capture');
  editToken = issue(['vault:read', 'vault:edit'], 'token-mit-edit');
  issue(['vault:capture'], 'token-nur-capture');

  const mcpHttp = createVaultMcpHandler({
    index,
    capture,
    editor: createEditor({ vaultPath: root, index }),
    policy: compilePolicy({ sensitive: { 'areas/Gesundheit': 'gesundheit' } }),
    graph: createGraph({ index, logger: { warn() {} } }),
    health: { services: () => [{ id: 'mail', name: 'Mail-Abruf', state: 'error', summary: 'Abruf fehlgeschlagen', lastOkAt: null, lastErrorAt: '2026-10-18T12:00:00.000Z', lastError: 'HTTP 401', facts: [{ label: 'Ordner', value: 'Vault' }] }] },
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
    'vault_append', 'vault_capture', 'vault_edit', 'vault_graph', 'vault_links', 'vault_list',
    'vault_move', 'vault_read', 'vault_search', 'vault_set_frontmatter', 'vault_similar', 'vault_stats',
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

test('vault_search: ohne Embeddings hybrid mit Hinweis, mode text bleibt UND-Suche', async () => {
  const hybrid = (await rpc('tools/call', { name: 'vault_search', arguments: { query: 'Vertrag Unsinnswort' } })).body.result.structuredContent;
  assert.equal(hybrid.mode, 'hybrid');
  assert.match(hybrid.degraded, /Embeddings/);
  assert.equal(hybrid.results[0].path, 'wiki/concepts/contract-first.md');
  assert.deepEqual(hybrid.results[0].streams, ['text']);
  const text = (await rpc('tools/call', { name: 'vault_search', arguments: { query: 'Vertrag Unsinnswort', mode: 'text' } })).body.result.structuredContent;
  assert.equal(text.total, 0);
});

test('vault_graph liefert den Graphen, vault_similar meldet fehlende Embeddings', async () => {
  const g = (await rpc('tools/call', { name: 'vault_graph', arguments: { path: 'wiki/concepts/contract-first.md' } })).body.result.structuredContent;
  assert.equal(g.center, 'note:wiki/concepts/contract-first.md');
  assert.equal(g.nodes[0].label, 'Contract First');
  const missing = await rpc('tools/call', { name: 'vault_graph', arguments: { path: 'gibt/es/nicht.md' } });
  assert.equal(missing.body.result.isError, true);
  const sim = await rpc('tools/call', { name: 'vault_similar', arguments: { path: 'wiki/concepts/contract-first.md' } });
  assert.equal(sim.body.result.isError, true);
  assert.match(sim.body.result.content[0].text, /Embeddings/);
  const stats = (await rpc('tools/call', { name: 'vault_stats', arguments: {} })).body.result.structuredContent;
  assert.equal(stats.semantic.state, 'disabled');
  assert.equal(stats.zunder.state, 'disabled');
  // Dieselben Dienste wie /zustand, ohne Anzeigedetails (VCP-60).
  assert.deepEqual(stats.services, [{ id: 'mail', name: 'Mail-Abruf', state: 'error', summary: 'Abruf fehlgeschlagen', lastOkAt: null, lastErrorAt: '2026-10-18T12:00:00.000Z', lastError: 'HTTP 401' }]);
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

test('Lesewerkzeuge werden ohne den Scope vault:read verweigert', async () => {
  const calls = [
    ['vault_search', { query: 'Vertrag' }],
    ['vault_read', { path: 'wiki/concepts/contract-first.md' }],
    ['vault_list', {}],
    ['vault_links', { path: 'wiki/concepts/contract-first.md' }],
    ['vault_stats', {}],
    ['vault_graph', { path: 'wiki/concepts/contract-first.md' }],
    ['vault_similar', { path: 'wiki/concepts/contract-first.md' }],
  ];
  for (const [name, args] of calls) {
    const r = await rpc('tools/call', { name, arguments: args }, 'token-nur-capture');
    assert.equal(r.body.result.isError, true, name);
    assert.match(r.body.result.content[0].text, /vault:read/, name);
  }
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

test('vault_move legt eine Inbox-Notiz in einen Ordner ab, vertrauliche Ziele werden abgelehnt', async () => {
  writeFileSync(join(root, 'inbox/Ablegen.md'), '# Ablegen\n\nNoch im Posteingang.');
  index.refresh('inbox/Ablegen.md');
  const denied = await rpc('tools/call', { name: 'vault_move', arguments: { path: 'inbox/Ablegen.md', folder: 'wiki' } }, readToken);
  assert.equal(denied.body.result.isError, true);
  assert.match(denied.body.result.content[0].text, /vault:edit/);

  const secret = await rpc('tools/call', { name: 'vault_move', arguments: { path: 'inbox/Ablegen.md', folder: 'areas/Gesundheit' } }, editToken);
  assert.equal(secret.body.result.isError, true);
  assert.match(secret.body.result.content[0].text, /^Die Notiz wurde nicht verschoben: "areas\/Gesundheit" ist ein vertraulicher/);
  assert.ok(readFileSync(join(root, 'inbox/Ablegen.md'), 'utf8'));

  const r = await rpc('tools/call', { name: 'vault_move', arguments: { path: 'inbox/Ablegen.md', folder: 'wiki/concepts' } }, editToken);
  assert.equal(r.body.result.isError, undefined);
  assert.deepEqual(r.body.result.structuredContent, { old_path: 'inbox/Ablegen.md', new_path: 'wiki/concepts/Ablegen.md', changed: true });
  const found = await rpc('tools/call', { name: 'vault_read', arguments: { path: 'wiki/concepts/Ablegen.md' } });
  assert.match(found.body.result.structuredContent.content, /Noch im Posteingang/);
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
