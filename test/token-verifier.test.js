import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createSign } from 'node:crypto';
import { createTokenVerifier } from '../src/oauth/verifier.js';

const ISSUER = 'https://id.rubeen.dev';
const RESOURCE = 'https://mcp.rubeen.dev/mcp';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'TESTKID', alg: 'RS256', use: 'sig' };
const jwks = { keys: [jwk] };

function signJwt(payload, { kid = 'TESTKID', alg = 'RS256', typ = 'at+jwt' } = {}) {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = enc({ alg, typ, kid });
  const body = enc(payload);
  const signer = createSign('RSA-SHA256');
  signer.update(`${head}.${body}`);
  return `${head}.${body}.${signer.sign(privateKey).toString('base64url')}`;
}

const now = () => Math.floor(Date.now() / 1000);
const claims = (over = {}) => ({
  iss: ISSUER, sub: 'ruben', aud: RESOURCE, client_id: 'https://claude.ai/oauth/mcp-oauth-client-metadata',
  scope: 'vault:read', exp: now() + 600, iat: now(), jti: 'abc', ...over,
});

const verifier = () => createTokenVerifier({
  issuer: ISSUER, resource: RESOURCE,
  loadJwks: async () => jwks,
});

test('akzeptiert ein gültiges Pocket-ID-Token', async () => {
  const p = await verifier().verify(signJwt(claims()));
  assert.equal(p.subject, 'ruben');
  assert.deepEqual(p.scopes, ['vault:read']);
  assert.equal(p.clientId, 'https://claude.ai/oauth/mcp-oauth-client-metadata');
  assert.ok(p.expiresAt > Date.now() / 1000, 'expiresAt muss gesetzt sein');
});

test('liest Scopes auch aus dem scp-Array', async () => {
  // Pocket ID schreibt scope UND scp; scp ist ein Array.
  const p = await verifier().verify(signJwt(claims({ scope: undefined, scp: ['vault:read', 'vault:capture'] })));
  assert.deepEqual(p.scopes, ['vault:read', 'vault:capture']);
});

test('akzeptiert aud als Array, wenn unsere Resource enthalten ist', async () => {
  // Bei Identity-Scopes hängt Pocket ID den Issuer zusätzlich an aud an.
  const p = await verifier().verify(signJwt(claims({ aud: [RESOURCE, ISSUER] })));
  assert.equal(p.subject, 'ruben');
});

test('weist ein Token mit fremder Audience ab', async () => {
  await assert.rejects(() => verifier().verify(signJwt(claims({ aud: 'https://woanders.example' }))), /aud/);
});

test('weist ein Token ab, dessen aud nur der Issuer ist', async () => {
  // Genau das bekommt man, wenn der resource-Parameter fehlt — ein reines
  // Login-Token, das niemals für uns gedacht war.
  await assert.rejects(() => verifier().verify(signJwt(claims({ aud: ISSUER }))), /aud/);
});

test('weist einen fremden Issuer ab', async () => {
  await assert.rejects(() => verifier().verify(signJwt(claims({ iss: 'https://boese.example' }))), /iss/);
});

test('weist ein abgelaufenes Token ab', async () => {
  await assert.rejects(() => verifier().verify(signJwt(claims({ exp: now() - 5 }))), /abgelaufen/);
});

test('weist ein Token ohne sub ab', async () => {
  await assert.rejects(() => verifier().verify(signJwt(claims({ sub: undefined }))), /sub/);
});

test('weist eine gefälschte Signatur ab', async () => {
  const t = signJwt(claims());
  const gefaelscht = t.slice(0, -6) + 'AAAAAA';
  await assert.rejects(() => verifier().verify(gefaelscht), /Signatur/);
});

test('weist alg=none ab', async () => {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const t = `${enc({ alg: 'none', typ: 'at+jwt' })}.${enc(claims())}.`;
  await assert.rejects(() => verifier().verify(t), /Algorithmus/);
});

test('weist Unsinn statt eines JWT ab', async () => {
  await assert.rejects(() => verifier().verify('kein-jwt'), /Format/);
});

test('beschränkt optional auf bestimmte Subjects', async () => {
  const v = createTokenVerifier({ issuer: ISSUER, resource: RESOURCE, loadJwks: async () => jwks, allowedSubjects: ['ruben'] });
  assert.ok(await v.verify(signJwt(claims())));
  await assert.rejects(() => v.verify(signJwt(claims({ sub: 'fremder' }))), /nicht freigegeben/);
});

test('lädt das JWKS nur einmal und erneut bei unbekannter kid', async () => {
  let ladungen = 0;
  const v = createTokenVerifier({
    issuer: ISSUER, resource: RESOURCE,
    loadJwks: async () => { ladungen += 1; return jwks; },
  });
  await v.verify(signJwt(claims()));
  await v.verify(signJwt(claims()));
  assert.equal(ladungen, 1, 'JWKS wird zwischengespeichert');
  await assert.rejects(() => v.verify(signJwt(claims(), { kid: 'UNBEKANNT' })), /Schlüssel/);
  assert.equal(ladungen, 2, 'bei unbekannter kid wird einmal neu geladen (Key-Rotation)');
});
