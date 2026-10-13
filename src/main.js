import { createApp } from './http/app.js';
import { createTokenVerifier } from './oauth/verifier.js';
import { createPrincipalCache } from './oauth/principal-cache.js';
import { createIndexManager } from './vault/manager.js';
import { loadPolicy } from './vault/policy.js';
import { createCapture } from './vault/capture.js';
import { createEditor } from './vault/edit.js';
import { createSyncAdapter } from './sync/index.js';
import { createVaultMcpHandler } from './mcp/server.js';
import { toWebRequest, writeWebResponse } from './http/bridge.js';

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Umgebungsvariable ${name} fehlt`);
  return v;
}

const PUBLIC_URL = required('PUBLIC_URL').replace(/\/+$/, '');
const ISSUER = required('OIDC_ISSUER').replace(/\/+$/, '');
const VAULT_PATH = process.env.VAULT_PATH ?? '/vault';
const INDEX_DB = process.env.INDEX_DB ?? '/data/index.db';
const PORT = Number(process.env.PORT ?? 3000);
const POLICY = loadPolicy(process.env.POLICY_FILE);
// Pflicht, damit ein leerer Wert nicht jeden Account des Authorization Servers durchlässt.
const ALLOWED_SUBJECTS = required('ALLOWED_SUBJECTS').split(',').map((s) => s.trim()).filter(Boolean);
if (!ALLOWED_SUBJECTS.length) throw new Error('ALLOWED_SUBJECTS enthält kein Subject');

const config = {
  publicUrl: PUBLIC_URL,
  resource: `${PUBLIC_URL}/mcp`,
  issuer: ISSUER,
  supportedScopes: ['vault:read', 'vault:capture', 'vault:edit'],
  allowedHosts: (process.env.ALLOWED_HOSTS ?? new URL(PUBLIC_URL).hostname).split(',').map((h) => h.trim()),
  trustProxy: process.env.TRUST_PROXY !== 'false',
};

/** JWKS des Authorization Servers, über dessen Discovery-Dokument gefunden. */
async function loadJwks() {
  const discovery = await fetch(`${ISSUER}/.well-known/openid-configuration`);
  if (!discovery.ok) throw new Error(`Discovery fehlgeschlagen: HTTP ${discovery.status}`);
  const { jwks_uri: jwksUri } = await discovery.json();
  const res = await fetch(jwksUri);
  if (!res.ok) throw new Error(`JWKS-Abruf fehlgeschlagen: HTTP ${res.status}`);
  return res.json();
}

const verifier = createTokenVerifier({
  issuer: ISSUER,
  resource: config.resource,
  loadJwks,
  allowedSubjects: ALLOWED_SUBJECTS,
});

const principals = createPrincipalCache();
setInterval(() => principals.sweep(), 5 * 60_000).unref();

const index = createIndexManager({
  vaultPath: VAULT_PATH,
  dbPath: INDEX_DB,
  policy: POLICY,
  intervalMinutes: Number(process.env.REINDEX_INTERVAL_MIN ?? 15),
});
const SYNC_ADAPTER = process.env.SYNC_ADAPTER ?? 'obsidian-headless';
const sync = createSyncAdapter({
  kind: SYNC_ADAPTER,
  vaultPath: VAULT_PATH,
  statusFile: process.env.SYNC_STATUS_FILE || null,
});
sync.start({
  onChanges({ paths, full }) {
    if (full) index.rebuild();
    else index.applyChanges(paths);
  },
});

const CAPTURE_FOLDER = process.env.CAPTURE_FOLDER ?? 'inbox';
const capture = createCapture({ vaultPath: VAULT_PATH, folder: CAPTURE_FOLDER });
const editor = createEditor({ vaultPath: VAULT_PATH, index });

const mcpHttp = createVaultMcpHandler({
  index,
  capture,
  editor,
  sync,
  captureFolder: CAPTURE_FOLDER,
  layoutHint: POLICY.layoutHint,
  // Synchron: die Prüfung ist in der HTTP-Schicht bereits gelaufen.
  verifyToken: (token) => principals.get(token),
});

const app = createApp({
  config,
  async verifyToken(token) {
    const principal = await verifier.verify(token);
    principals.put(token, principal);
    return principal;
  },
  mcpHandler: async (req, res, principal, body) => {
    await writeWebResponse(res, await mcpHttp.fetch(toWebRequest(req, body, PUBLIC_URL)));
  },
});

app.listen(PORT, '0.0.0.0', () => {
  const s = index.stats();
  console.log(`Vault Cockpit läuft auf Port ${PORT}`);
  console.log(`  öffentlich  : ${config.resource}`);
  console.log(`  Vault       : ${VAULT_PATH} (${s.total} Notizen, davon ${s.byClass.core ?? 0} eigene)`);
  console.log(`  Auth-Server : ${ISSUER} (wir sind reiner Resource Server)`);
  console.log(`  Scopes      : ${config.supportedScopes.join(', ')}`);
  console.log(`  Reindex     : alle ${process.env.REINDEX_INTERVAL_MIN ?? 15} Minuten${sync.name === 'none' ? '' : ', dazu bei jeder Dateiänderung'}`);
  console.log(`  Sync        : ${SYNC_ADAPTER} (${sync.status().state})`);
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    console.log(`${sig} empfangen — fahre herunter`);
    sync.stop();
    index.stop();
    app.close(() => process.exit(0));
  });
}
