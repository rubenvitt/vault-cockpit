#!/usr/bin/env node
/**
 * Widerruft die Entwicklungszertifikate, die CI-Läufe angelegt haben (App Store Connect API).
 *
 *   node ios/scripts/certificates-cleanup.js
 *
 * Jeder TestFlight-Lauf startet auf einem frischen Mac ohne Zertifikat; das automatische Signieren
 * legt dann mit dem API-Key ein neues „Apple Development“-Zertifikat an. Nach einigen Läufen ist
 * Apples Höchstzahl erreicht und das Archivieren scheitert. Dieses Skript läuft vor und nach dem
 * Archivieren und entfernt nur Zertifikate, die über die API entstanden sind („Created via API“):
 * die eigenen aus Xcode am Mac und das Distributionszertifikat bleiben.
 *
 * Umgebung:
 *   ASC_KEY_ID, ASC_ISSUER_ID   Pflicht
 *   ASC_KEY_PATH                Standard ~/.appstoreconnect/private_keys/AuthKey_${ASC_KEY_ID}.p8
 *   DRY_RUN=1                   nur auflisten, nichts widerrufen
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { client } from './testflight-distribute.js';

const DEVELOPMENT = ['DEVELOPMENT', 'IOS_DEVELOPMENT'];
const VIA_API = 'Created via API';

/** Zertifikate, die ein CI-Lauf angelegt hat: Entwicklung und über die API erstellt. */
export const fromCi = (cert) => DEVELOPMENT.includes(cert.attributes.certificateType) && String(cert.attributes.name ?? '').includes(VIA_API);

export async function cleanup({ request, dryRun = false, log = console.log }) {
  const all = (await request('GET', `/v1/certificates?${new URLSearchParams({ 'filter[certificateType]': DEVELOPMENT.join(','), limit: '200' })}`)).data;
  const stale = all.filter(fromCi);
  log(`${all.length} Entwicklungszertifikate, davon ${stale.length} aus CI-Läufen`);
  for (const cert of stale) {
    const { name, expirationDate } = cert.attributes;
    if (dryRun) {
      log(`Würde widerrufen: ${name} (bis ${expirationDate?.slice(0, 10) ?? '?'})`);
      continue;
    }
    await request('DELETE', `/v1/certificates/${cert.id}`);
    log(`Widerrufen: ${name} (bis ${expirationDate?.slice(0, 10) ?? '?'})`);
  }
  return stale.length;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const env = process.env;
  for (const name of ['ASC_KEY_ID', 'ASC_ISSUER_ID']) {
    if (!env[name]) {
      console.error(`${name} fehlt`);
      process.exit(1);
    }
  }
  const keyPath = env.ASC_KEY_PATH || `${homedir()}/.appstoreconnect/private_keys/AuthKey_${env.ASC_KEY_ID}.p8`;
  const request = client({ keyId: env.ASC_KEY_ID, issuerId: env.ASC_ISSUER_ID, privateKey: readFileSync(keyPath, 'utf8') });
  try {
    await cleanup({ request, dryRun: env.DRY_RUN === '1' });
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
