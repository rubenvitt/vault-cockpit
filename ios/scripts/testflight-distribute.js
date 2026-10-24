#!/usr/bin/env node
/**
 * Verteilt einen hochgeladenen Build an TestFlight-Gruppen (App Store Connect API).
 *
 *   BUILD_NUMBER=20261024.0812 TESTFLIGHT_GROUPS=Extern node ios/scripts/testflight-distribute.js
 *
 * Wartet, bis App Store Connect den Build verarbeitet hat, setzt „Was testen“, hängt ihn an die
 * Gruppen und reicht ihn zur Beta-Prüfung ein, sobald eine externe Gruppe dabei ist.
 *
 * Umgebung:
 *   ASC_KEY_ID, ASC_ISSUER_ID   Pflicht
 *   ASC_KEY_PATH                Standard ~/.appstoreconnect/private_keys/AuthKey_${ASC_KEY_ID}.p8
 *   BUILD_NUMBER                Pflicht, CFBundleVersion des Builds
 *   TESTFLIGHT_GROUPS           Gruppennamen, kommagetrennt; leer: nichts tun
 *   WHATS_NEW                   Text für „Was testen“ (höchstens 4000 Zeichen)
 *   WHATS_NEW_LOCALE            Sprache, falls der Build noch keine hat; Standard de-DE
 *   BUNDLE_ID                   Standard dev.rubeen.cockpit
 *   WAIT_MINUTES                so lange auf die Verarbeitung warten; Standard 45
 */
import { sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';

const API = 'https://api.appstoreconnect.apple.com';
const WHATS_NEW_MAX = 4000;

const b64url = (value) => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');

/** JWT für die API (ES256), höchstens 20 Minuten gültig. */
export function token({ keyId, issuerId, privateKey, now = Date.now() }) {
  const iat = Math.floor(now / 1000);
  const unsigned = `${b64url({ alg: 'ES256', kid: keyId, typ: 'JWT' })}.${b64url({ iss: issuerId, iat, exp: iat + 15 * 60, aud: 'appstoreconnect-v1' })}`;
  const signature = sign('sha256', Buffer.from(unsigned), { key: privateKey, dsaEncoding: 'ieee-p1363' });
  return `${unsigned}.${signature.toString('base64url')}`;
}

/** `request(method, path, body)` gegen die API; wirft bei Fehlern mit Status und Apples Begründung. */
export function client({ keyId, issuerId, privateKey, fetch = globalThis.fetch }) {
  return async (method, path, body) => {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token({ keyId, issuerId, privateKey })}`,
        ...(body && { 'Content-Type': 'application/json' }),
      },
      body: body && JSON.stringify(body),
    });
    const text = await res.text();
    const json = text ? JSON.parse(text) : null;
    if (!res.ok) {
      const detail = json?.errors?.map((e) => e.detail || e.title).join('; ') || text;
      throw Object.assign(new Error(`${method} ${path}: ${res.status} ${detail}`), { status: res.status });
    }
    return json;
  };
}

const q = (params) => new URLSearchParams(params).toString();

export async function distribute({
  request, bundleId, buildNumber, groups, whatsNew = '', locale = 'de-DE',
  waitMs = 45 * 60_000, pollMs = 30_000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log = console.log,
}) {
  const apps = await request('GET', `/v1/apps?${q({ 'filter[bundleId]': bundleId })}`);
  const app = apps.data.find((a) => a.attributes.bundleId === bundleId);
  if (!app) throw new Error(`App ${bundleId} nicht in App Store Connect`);

  // Gruppen vor dem Warten prüfen: Ein Tippfehler soll nicht erst nach einer halben Stunde auffallen.
  const all = (await request('GET', `/v1/apps/${app.id}/betaGroups?limit=200`)).data;
  const targets = groups.map((name) => {
    const group = all.find((g) => g.attributes.name === name);
    if (!group) throw new Error(`Gruppe „${name}“ fehlt; vorhanden: ${all.map((g) => g.attributes.name).join(', ') || 'keine'}`);
    return group;
  });

  const build = await waitForBuild({ request, appId: app.id, buildNumber, waitMs, pollMs, sleep, log });

  const text = whatsNew.trim().slice(0, WHATS_NEW_MAX);
  if (text) {
    const existing = (await request('GET', `/v1/builds/${build.id}/betaBuildLocalizations`)).data;
    for (const loc of existing) {
      await request('PATCH', `/v1/betaBuildLocalizations/${loc.id}`, {
        data: { type: 'betaBuildLocalizations', id: loc.id, attributes: { whatsNew: text } },
      });
    }
    if (!existing.length) {
      await request('POST', '/v1/betaBuildLocalizations', {
        data: {
          type: 'betaBuildLocalizations',
          attributes: { locale, whatsNew: text },
          relationships: { build: { data: { type: 'builds', id: build.id } } },
        },
      });
    }
    log('„Was testen“ gesetzt');
  }

  for (const group of targets) {
    await request('POST', `/v1/betaGroups/${group.id}/relationships/builds`, { data: [{ type: 'builds', id: build.id }] });
    log(`An Gruppe „${group.attributes.name}“ gehängt`);
  }

  // Externe Tester sehen den Build erst nach der Beta-Prüfung; weitere Builds derselben Version gibt Apple meist sofort frei.
  if (targets.some((g) => !g.attributes.isInternalGroup)) {
    const submitted = await request('GET', `/v1/builds/${build.id}/betaAppReviewSubmission`).then(
      (res) => res?.data,
      (err) => { if (err.status === 404) return null; throw err; },
    );
    if (submitted) {
      log(`Beta-Prüfung läuft schon (${submitted.attributes.betaReviewState})`);
    } else {
      await request('POST', '/v1/betaAppReviewSubmissions', {
        data: { type: 'betaAppReviewSubmissions', relationships: { build: { data: { type: 'builds', id: build.id } } } },
      });
      log('Zur Beta-Prüfung eingereicht');
    }
  }
  return build;
}

/** Der Build taucht erst einige Minuten nach dem Upload auf und ist dann eine Weile PROCESSING. */
async function waitForBuild({ request, appId, buildNumber, waitMs, pollMs, sleep, log }) {
  const path = `/v1/builds?${q({ 'filter[app]': appId, 'filter[version]': buildNumber, limit: '1' })}`;
  for (let waited = 0; ; waited += pollMs) {
    const [build] = (await request('GET', path)).data;
    const state = build?.attributes.processingState;
    if (state === 'VALID') {
      log(`Build ${buildNumber} verarbeitet`);
      return build;
    }
    if (state === 'FAILED' || state === 'INVALID') throw new Error(`Build ${buildNumber}: ${state}`);
    if (waited >= waitMs) throw new Error(`Build ${buildNumber} nach ${Math.round(waitMs / 60_000)} Minuten nicht verarbeitet (${state ?? 'nicht gefunden'})`);
    log(`Build ${buildNumber}: ${state ?? 'noch nicht da'}, warte …`);
    await sleep(pollMs);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const env = process.env;
  const groups = (env.TESTFLIGHT_GROUPS ?? '').split(',').map((g) => g.trim()).filter(Boolean);
  if (!groups.length) {
    console.log('TESTFLIGHT_GROUPS leer, nichts zu verteilen');
    process.exit(0);
  }
  for (const name of ['ASC_KEY_ID', 'ASC_ISSUER_ID', 'BUILD_NUMBER']) {
    if (!env[name]) {
      console.error(`${name} fehlt`);
      process.exit(1);
    }
  }
  const keyPath = env.ASC_KEY_PATH || `${homedir()}/.appstoreconnect/private_keys/AuthKey_${env.ASC_KEY_ID}.p8`;
  const request = client({ keyId: env.ASC_KEY_ID, issuerId: env.ASC_ISSUER_ID, privateKey: readFileSync(keyPath, 'utf8') });
  try {
    await distribute({
      request,
      bundleId: env.BUNDLE_ID || 'dev.rubeen.cockpit',
      buildNumber: env.BUILD_NUMBER,
      groups,
      whatsNew: env.WHATS_NEW,
      locale: env.WHATS_NEW_LOCALE || 'de-DE',
      waitMs: Number(env.WAIT_MINUTES || 45) * 60_000,
    });
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
