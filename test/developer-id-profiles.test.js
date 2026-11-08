import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ensureProfiles, exportEntry } from '../ios/scripts/developer-id-profiles.js';

const CERTS = [
  { id: 'old', attributes: { certificateType: 'DEVELOPER_ID_APPLICATION', serialNumber: '315F3BED16790AC' } },
  { id: 'g2', attributes: { certificateType: 'DEVELOPER_ID_APPLICATION_G2', serialNumber: '73DAB8D3BC611D469D90CBBAF20F9C84' } },
];

function fakeApi(profiles) {
  const calls = [];
  const request = async (method, path, body) => {
    calls.push(`${method} ${decodeURIComponent(path)}`);
    if (method === 'GET' && path.startsWith('/v1/certificates')) return { data: CERTS };
    if (method === 'GET' && path.startsWith('/v1/bundleIds')) {
      // wie Apple: Der Filter findet auch die längere ID der Share Extension
      return { data: [{ id: 'b-app', attributes: { identifier: 'app' } }, { id: 'b-share', attributes: { identifier: 'app.share' } }] };
    }
    if (method === 'GET' && path.startsWith('/v1/profiles')) {
      const name = new URLSearchParams(path.split('?')[1]).get('filter[name]');
      return { data: profiles.filter((p) => p.attributes.name === name) };
    }
    if (method === 'POST') return { data: { id: 'new', attributes: { ...body.data.attributes, uuid: `uuid-${body.data.relationships.bundleId.data.id}`, profileContent: 'Y29udGVudA==' } } };
    return null;
  };
  return { request, calls };
}

const profile = (id, name, profileState) => ({ id, attributes: { name, profileState, uuid: `uuid-${id}`, profileContent: 'eA==' } });

test('Profile: findet das Zertifikat auch mit führender Null, legt fehlende Profile an', async () => {
  const api = fakeApi([profile('p1', 'Cockpit Developer ID app g2', 'ACTIVE')]);
  const result = await ensureProfiles({ request: api.request, serial: 'serial=073DAB8D3BC611D469D90CBBAF20F9C84', identifiers: ['app', 'app.share'], log: () => {} });
  assert.deepEqual(result.map((p) => [p.identifier, p.uuid]), [['app', 'uuid-p1'], ['app.share', 'uuid-b-share']]);
  const post = api.calls.filter((c) => c.startsWith('POST'));
  assert.deepEqual(post, ['POST /v1/profiles']);
});

test('Profile: ersetzt ein ungültiges Profil', async () => {
  const api = fakeApi([profile('p1', 'Cockpit Developer ID app g2', 'INVALID')]);
  const result = await ensureProfiles({ request: api.request, serial: '73DAB8D3BC611D469D90CBBAF20F9C84', identifiers: ['app'], log: () => {} });
  assert.equal(result[0].uuid, 'uuid-b-app');
  assert.ok(api.calls.includes('DELETE /v1/profiles/p1'));
});

test('Profile: bricht ab ohne passendes Zertifikat', async () => {
  const api = fakeApi([]);
  await assert.rejects(ensureProfiles({ request: api.request, serial: 'ABC', identifiers: ['app'], log: () => {} }), /Seriennummer ABC/);
});

test('Profile: Eintrag für die ExportOptions.plist', () => {
  assert.equal(exportEntry([{ identifier: 'app', uuid: 'u1' }]), '<key>provisioningProfiles</key><dict><key>app</key><string>u1</string></dict>');
});
