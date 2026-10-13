import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/http/app.js';

const PUBLIC_URL = 'https://mcp.rubeen.dev';
const RESOURCE = `${PUBLIC_URL}/mcp`;
const ISSUER = 'https://id.rubeen.dev';

let server, base, gesehenerPrincipal;

before(async () => {
  const app = createApp({
    config: {
      publicUrl: PUBLIC_URL,
      resource: RESOURCE,
      issuer: ISSUER,
      supportedScopes: ['vault:read', 'vault:capture'],
      allowedHosts: ['mcp.rubeen.dev'],
      trustProxy: true,
    },
    verifyToken: async (token) => {
      if (token !== 'gueltig') throw new Error('Signatur ist ungültig');
      return { subject: 'ruben', scopes: ['vault:read'], aud: RESOURCE, expiresAt: 9999999999 };
    },
    mcpHandler: async (req, res, principal) => {
      gesehenerPrincipal = principal;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    },
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server?.close());

const H = { 'x-forwarded-host': 'mcp.rubeen.dev' };
const get = (p, h = {}) => fetch(base + p, { headers: { ...H, ...h } });
const postMcp = (h = {}) =>
  fetch(base + '/mcp', { method: 'POST', headers: { ...H, 'content-type': 'application/json', ...h }, body: '{}' });

test('Protected Resource Metadata verweist auf Pocket ID als Authorization Server', async () => {
  const m = await (await get('/.well-known/oauth-protected-resource/mcp')).json();
  assert.equal(m.resource, RESOURCE);
  assert.deepEqual(m.authorization_servers, [ISSUER], 'nicht mehr wir selbst');
  assert.deepEqual(m.scopes_supported, ['vault:read', 'vault:capture']);
});

test('Protected Resource Metadata liegt auch am Wurzelpfad', async () => {
  assert.equal((await get('/.well-known/oauth-protected-resource')).status, 200);
});

test('wir stellen keine Authorization-Server-Metadata mehr bereit', async () => {
  // Die kommt jetzt von Pocket ID; eigene Metadaten wären irreführend.
  assert.equal((await get('/.well-known/oauth-authorization-server')).status, 404);
});

test('die Endpunkte des alten eigenen Auth-Servers sind weg', async () => {
  for (const p of ['/register', '/token', '/authorize', '/revoke', '/oauth/pocketid/callback']) {
    const res = await fetch(base + p, { method: 'POST', headers: H });
    assert.equal(res.status, 404, `${p} darf es nicht mehr geben`);
  }
});

test('/mcp ohne Token antwortet 401 mit resource_metadata-Zeiger', async () => {
  const res = await postMcp();
  assert.equal(res.status, 401);
  const h = res.headers.get('www-authenticate');
  assert.match(h, /^Bearer /);
  assert.match(h, /error="invalid_token"/);
  assert.match(h, /resource_metadata="https:\/\/mcp\.rubeen\.dev\/\.well-known\/oauth-protected-resource\/mcp"/);
});

test('/mcp mit ungültigem Token antwortet 401', async () => {
  const res = await postMcp({ authorization: 'Bearer kaputt' });
  assert.equal(res.status, 401);
  assert.match(res.headers.get('www-authenticate'), /invalid_token/);
});

test('/mcp mit gültigem Token reicht den Principal durch', async () => {
  const res = await postMcp({ authorization: 'Bearer gueltig' });
  assert.equal(res.status, 200);
  assert.equal(gesehenerPrincipal.subject, 'ruben');
  assert.deepEqual(gesehenerPrincipal.scopes, ['vault:read']);
});

test('ein Nicht-Bearer-Schema wird abgelehnt', async () => {
  const res = await postMcp({ authorization: 'Basic cnViZW46Z2VoZWlt' });
  assert.equal(res.status, 401);
});

test('/health antwortet ohne gültigen Host-Header', async () => {
  assert.equal((await fetch(base + '/health')).status, 200);
});

test('fremder Host-Header wird abgewiesen', async () => {
  assert.equal((await get('/.well-known/oauth-protected-resource', { 'x-forwarded-host': 'angreifer.example' })).status, 403);
});
