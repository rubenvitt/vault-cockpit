import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanup, fromCi } from '../ios/scripts/certificates-cleanup.js';

const cert = (id, certificateType, name) => ({ id, attributes: { certificateType, name, expirationDate: '2027-10-24T08:29:00.000+0000' } });

function fakeApi(certs) {
  const calls = [];
  const request = async (method, path) => {
    calls.push(`${method} ${path}`);
    return method === 'GET' ? { data: certs } : null;
  };
  return { request, calls };
}

const CERTS = [
  cert('c1', 'DEVELOPMENT', 'Apple Development: Created via API (ABC123)'),
  cert('c2', 'IOS_DEVELOPMENT', 'iPhone Developer: Created via API (DEF456)'),
  cert('c3', 'DEVELOPMENT', 'Apple Development: Ruben Vitt (XYZ789)'),
  cert('c4', 'DISTRIBUTION', 'Apple Distribution: Created via API (GHI012)'),
];

test('Zertifikate: nur Entwicklungszertifikate, die über die API entstanden sind', () => {
  assert.deepEqual(CERTS.filter(fromCi).map((c) => c.id), ['c1', 'c2']);
});

test('Zertifikate: widerruft die aus CI-Läufen, fragt nur nach Entwicklungszertifikaten', async () => {
  const api = fakeApi(CERTS);
  const log = [];
  assert.equal(await cleanup({ request: api.request, log: (m) => log.push(m) }), 2);
  assert.deepEqual(api.calls, [
    'GET /v1/certificates?filter%5BcertificateType%5D=DEVELOPMENT%2CIOS_DEVELOPMENT&limit=200',
    'DELETE /v1/certificates/c1',
    'DELETE /v1/certificates/c2',
  ]);
  assert.equal(log[0], '4 Entwicklungszertifikate, davon 2 aus CI-Läufen');
  assert.match(log[1], /^Widerrufen: Apple Development: Created via API \(ABC123\) \(bis 2027-10-24\)$/);
});

test('Zertifikate: DRY_RUN listet nur', async () => {
  const api = fakeApi(CERTS);
  const log = [];
  await cleanup({ request: api.request, dryRun: true, log: (m) => log.push(m) });
  assert.deepEqual(api.calls.filter((c) => !c.startsWith('GET')), []);
  assert.match(log[1], /^Würde widerrufen: /);
});
