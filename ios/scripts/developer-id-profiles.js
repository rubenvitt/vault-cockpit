#!/usr/bin/env node
/**
 * Holt die Developer-ID-Profile (Mac Catalyst) für App und Share Extension, legt fehlende an und
 * schreibt sie dorthin, wo xcodebuild sie sucht. Gibt den `provisioningProfiles`-Eintrag für die
 * ExportOptions.plist aus.
 *
 *   CERT_SERIAL=… node ios/scripts/developer-id-profiles.js
 *
 * Nötig für den Export mit eigenem Zertifikat (mac-direct.sh): Das automatische Signieren fragt mit
 * dem API-Key nur nach Apples Cloud-Zertifikat (403) und legt kein Profil für ein eigenes an.
 *
 * Umgebung:
 *   ASC_KEY_ID, ASC_ISSUER_ID   Pflicht
 *   ASC_KEY_PATH                Standard ~/.appstoreconnect/private_keys/AuthKey_${ASC_KEY_ID}.p8
 *   CERT_SERIAL                 Pflicht: Seriennummer des Zertifikats „Developer ID Application“ (hex)
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { client } from './testflight-distribute.js';

export const IDENTIFIERS = ['dev.rubeen.cockpit', 'dev.rubeen.cockpit.share'];
const TYPE = 'MAC_CATALYST_APP_DIRECT';
const CERT_TYPES = ['DEVELOPER_ID_APPLICATION', 'DEVELOPER_ID_APPLICATION_G2'];

// Apple lässt führende Nullen der Seriennummer weg.
const serialKey = (serial) => String(serial).toUpperCase().replace(/^SERIAL=/, '').replace(/^0+/, '');

/** Je Bundle-ID ein aktives Profil mit diesem Zertifikat: `[{ identifier, uuid, content }]`. */
export async function ensureProfiles({ request, serial, identifiers = IDENTIFIERS, log = console.log }) {
  const certs = (await request('GET', `/v1/certificates?${new URLSearchParams({ 'filter[certificateType]': CERT_TYPES.join(','), limit: '200' })}`)).data;
  const cert = certs.find((c) => serialKey(c.attributes.serialNumber) === serialKey(serial));
  if (!cert) throw new Error(`Kein Developer-ID-Zertifikat mit Seriennummer ${serial} im Team`);
  const result = [];
  for (const identifier of identifiers) {
    const bundle = (await request('GET', `/v1/bundleIds?${new URLSearchParams({ 'filter[identifier]': identifier, limit: '200' })}`)).data
      .find((b) => b.attributes.identifier === identifier); // der Filter findet auch längere IDs
    if (!bundle) throw new Error(`Bundle-ID ${identifier} fehlt im Developer-Portal`);
    // Name je Zertifikat: Ein neues Zertifikat bekommt eigene Profile, Namen bleiben eindeutig.
    const name = `Cockpit Developer ID ${identifier} ${cert.id}`;
    const found = (await request('GET', `/v1/profiles?${new URLSearchParams({ 'filter[name]': name, 'filter[profileType]': TYPE, limit: '200' })}`)).data
      .filter((p) => p.attributes.name === name);
    let profile = found.find((p) => p.attributes.profileState === 'ACTIVE');
    // Ungültig wird ein Profil z. B., wenn sich die Fähigkeiten der App-ID ändern: neu anlegen.
    for (const stale of found.filter((p) => p !== profile)) {
      await request('DELETE', `/v1/profiles/${stale.id}`);
      log(`Ungültiges Profil gelöscht: ${name}`);
    }
    if (!profile) {
      profile = (await request('POST', '/v1/profiles', {
        data: {
          type: 'profiles',
          attributes: { name, profileType: TYPE },
          relationships: {
            bundleId: { data: { type: 'bundleIds', id: bundle.id } },
            certificates: { data: [{ type: 'certificates', id: cert.id }] },
          },
        },
      })).data;
      log(`Profil angelegt: ${name}`);
    }
    result.push({ identifier, uuid: profile.attributes.uuid, content: profile.attributes.profileContent });
  }
  return result;
}

/** Eintrag `provisioningProfiles` für die ExportOptions.plist. */
export const exportEntry = (profiles) =>
  `<key>provisioningProfiles</key><dict>${profiles.map((p) => `<key>${p.identifier}</key><string>${p.uuid}</string>`).join('')}</dict>`;

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const env = process.env;
  for (const name of ['ASC_KEY_ID', 'ASC_ISSUER_ID', 'CERT_SERIAL']) {
    if (!env[name]) {
      console.error(`${name} fehlt`);
      process.exit(1);
    }
  }
  const keyPath = env.ASC_KEY_PATH || `${homedir()}/.appstoreconnect/private_keys/AuthKey_${env.ASC_KEY_ID}.p8`;
  const request = client({ keyId: env.ASC_KEY_ID, issuerId: env.ASC_ISSUER_ID, privateKey: readFileSync(keyPath, 'utf8') });
  try {
    // stdout gehört dem plist-Eintrag, Meldungen gehen nach stderr.
    const profiles = await ensureProfiles({ request, serial: env.CERT_SERIAL, log: console.error });
    const dir = `${homedir()}/Library/Developer/Xcode/UserData/Provisioning Profiles`;
    mkdirSync(dir, { recursive: true });
    for (const p of profiles) writeFileSync(`${dir}/${p.uuid}.provisionprofile`, Buffer.from(p.content, 'base64'));
    console.log(exportEntry(profiles));
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
