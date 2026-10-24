import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { client, distribute, token } from '../ios/scripts/testflight-distribute.js';

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });

/** Nachgebaute API: antwortet je Pfad und schreibt jeden Aufruf mit. */
function fakeApi({ states = ['VALID'], groups = [{ id: 'g1', name: 'Extern', internal: false }], localizations = [], review = null } = {}) {
  const calls = [];
  const request = async (method, path, body) => {
    calls.push({ method, path, body });
    if (path.startsWith('/v1/apps?')) return { data: [{ id: 'app1', attributes: { bundleId: 'dev.rubeen.cockpit' } }] };
    if (path === '/v1/apps/app1/betaGroups?limit=200') {
      return { data: groups.map((g) => ({ id: g.id, attributes: { name: g.name, isInternalGroup: g.internal } })) };
    }
    if (path.startsWith('/v1/builds?')) {
      const state = states.length > 1 ? states.shift() : states[0];
      return { data: state ? [{ id: 'b1', attributes: { processingState: state } }] : [] };
    }
    if (path === '/v1/builds/b1/betaBuildLocalizations') return { data: localizations };
    if (path === '/v1/builds/b1/betaAppReviewSubmission') return { data: review };
    return null;
  };
  return { request, calls };
}

const run = (api, opts = {}) => distribute({
  request: api.request, bundleId: 'dev.rubeen.cockpit', buildNumber: '20261024.0812', groups: ['Extern'],
  sleep: async () => {}, log: () => {}, ...opts,
});

const writes = (calls) => calls.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${c.path}`);

test('token: ES256-JWT mit Key-ID, Issuer und Zielgruppe', () => {
  const jwt = token({ keyId: 'KEY', issuerId: 'ISS', privateKey: pem, now: 1_000_000 });
  const [header, payload, signature] = jwt.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url')), { alg: 'ES256', kid: 'KEY', typ: 'JWT' });
  assert.deepEqual(JSON.parse(Buffer.from(payload, 'base64url')), { iss: 'ISS', iat: 1000, exp: 1900, aud: 'appstoreconnect-v1' });
  const ok = verify('sha256', Buffer.from(`${header}.${payload}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url'));
  assert.ok(ok);
});

test('client: Fehler nennt Status und Apples Begründung', async () => {
  const fetch = async () => new Response(JSON.stringify({ errors: [{ detail: 'Beta App Review Information fehlt' }] }), { status: 409 });
  const request = client({ keyId: 'KEY', issuerId: 'ISS', privateKey: pem, fetch });
  await assert.rejects(request('POST', '/v1/betaAppReviewSubmissions', {}), (err) => {
    assert.equal(err.status, 409);
    assert.match(err.message, /409 Beta App Review Information fehlt/);
    return true;
  });
});

test('wartet auf die Verarbeitung, setzt „Was testen“, hängt an die Gruppe und reicht ein', async () => {
  const api = fakeApi({ states: [null, 'PROCESSING', 'VALID'] });
  await run(api, { whatsNew: '- Player merkt sich die Stelle\n' });
  assert.equal(api.calls.filter((c) => c.path.startsWith('/v1/builds?')).length, 3);
  assert.deepEqual(writes(api.calls), [
    'POST /v1/betaBuildLocalizations',
    'POST /v1/betaGroups/g1/relationships/builds',
    'POST /v1/betaAppReviewSubmissions',
  ]);
  const loc = api.calls.find((c) => c.path === '/v1/betaBuildLocalizations').body.data;
  assert.deepEqual(loc.attributes, { locale: 'de-DE', whatsNew: '- Player merkt sich die Stelle' });
  assert.equal(loc.relationships.build.data.id, 'b1');
});

test('vorhandene Sprachen werden aktualisiert statt neu angelegt', async () => {
  const api = fakeApi({ localizations: [{ id: 'l1' }, { id: 'l2' }] });
  await run(api, { whatsNew: 'x'.repeat(5000) });
  assert.deepEqual(writes(api.calls).slice(0, 2), ['PATCH /v1/betaBuildLocalizations/l1', 'PATCH /v1/betaBuildLocalizations/l2']);
  assert.equal(api.calls.find((c) => c.method === 'PATCH').body.data.attributes.whatsNew.length, 4000);
});

test('nur interne Gruppen: keine Beta-Prüfung, ohne Text kein „Was testen“', async () => {
  const api = fakeApi({ groups: [{ id: 'g2', name: 'Intern', internal: true }] });
  await run(api, { groups: ['Intern'] });
  assert.deepEqual(writes(api.calls), ['POST /v1/betaGroups/g2/relationships/builds']);
});

test('schon eingereicht: kein zweites Einreichen', async () => {
  const api = fakeApi({ review: { id: 'r1', attributes: { betaReviewState: 'WAITING_FOR_REVIEW' } } });
  await run(api);
  assert.ok(!writes(api.calls).includes('POST /v1/betaAppReviewSubmissions'));
});

test('unbekannte Gruppe fällt vor dem Warten auf', async () => {
  const api = fakeApi();
  await assert.rejects(run(api, { groups: ['Extren'] }), /Gruppe „Extren“ fehlt; vorhanden: Extern/);
  assert.ok(!api.calls.some((c) => c.path.startsWith('/v1/builds')));
});

test('ungültiger Build und Zeitüberschreitung brechen ab', async () => {
  await assert.rejects(run(fakeApi({ states: ['INVALID'] })), /INVALID/);
  await assert.rejects(run(fakeApi({ states: ['PROCESSING'] }), { waitMs: 60_000, pollMs: 30_000 }), /nach 1 Minuten nicht verarbeitet \(PROCESSING\)/);
});
