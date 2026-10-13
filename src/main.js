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
import { createZunderClient } from './capture/zunder.js';
import { createStateStore } from './capture/state.js';
import { createCaptureRouter } from './capture/router.js';
import { createCaptureHttp } from './capture/http.js';
import { createMailCapture } from './capture/mail.js';
import { createZunderBridge } from './capture/bridge.js';
import { createCockpit } from './cockpit/data.js';
import { createCalendarSources, calendarForGraph } from './cockpit/calendars.js';
import { createSettingsStore, loadOrCreateSecret } from './cockpit/settings.js';
import { createOidcLogin } from './web/oidc.js';
import { createWebHttp } from './web/http.js';
import { createOllamaEmbedder } from './semantic/embedder.js';
import { createSemanticIndex } from './semantic/index.js';
import { hybridSearch } from './semantic/search.js';
import { createGraph } from './graph/graph.js';

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

// Semantische Suche (Schritt 4): Embeddings über einen Ollama-Server, eigener
// Vektorspeicher neben dem Index. Aus, bis EMBED_URL gesetzt ist.
const semantic = process.env.EMBED_URL
  ? createSemanticIndex({
      dbPath: process.env.VECTOR_DB ?? '/data/vectors.db',
      vaultPath: VAULT_PATH,
      index,
      embedder: createOllamaEmbedder({ url: process.env.EMBED_URL, model: process.env.EMBED_MODEL || 'bge-m3' }),
    })
  : null;
if (semantic) {
  index.onChange(({ full, paths }) => semantic.schedule(full ? null : paths));
  semantic.schedule();
}

const SYNC_ADAPTER = process.env.SYNC_ADAPTER ?? 'obsidian-headless';
const sync = createSyncAdapter({
  kind: SYNC_ADAPTER,
  vaultPath: VAULT_PATH,
  statusFile: process.env.SYNC_STATUS_FILE || null,
});

const CAPTURE_FOLDER = process.env.CAPTURE_FOLDER ?? 'inbox';
const capture = createCapture({ vaultPath: VAULT_PATH, folder: CAPTURE_FOLDER });
const editor = createEditor({ vaultPath: VAULT_PATH, index });

// Capture von außen (Schritt 2): Weiterleitung an Zunder, Capture-Endpunkte,
// Mail-Abruf und Zunder-Brücke. Alles optional, je nach gesetzten Variablen.
const captureState = createStateStore(process.env.CAPTURE_STATE_FILE ?? '/data/capture-state.json');
const zunder =
  process.env.ZUNDER_URL && process.env.ZUNDER_TOKEN
    ? createZunderClient({ url: process.env.ZUNDER_URL, token: process.env.ZUNDER_TOKEN })
    : null;
const captureRouter = createCaptureRouter({ capture, zunder, state: captureState });

const captureHttp = process.env.CAPTURE_TOKEN
  ? createCaptureHttp({ token: process.env.CAPTURE_TOKEN, router: captureRouter, zunderEnabled: Boolean(zunder) })
  : null;

let mail = null;
if (process.env.MAIL_JMAP_TOKEN) {
  mail = createMailCapture({
    token: process.env.MAIL_JMAP_TOKEN,
    sessionUrl: process.env.MAIL_JMAP_SESSION_URL || undefined,
    mailbox: process.env.MAIL_MAILBOX || 'Vault',
    doneMailbox: process.env.MAIL_DONE_MAILBOX || 'Archive',
    // Pflicht, damit eine fremde Mail an die Adresse nichts anlegt.
    allowedSenders: required('MAIL_ALLOWED_SENDERS').split(','),
    router: captureRouter,
  });
  mail.start(Number(process.env.MAIL_POLL_MIN ?? 5));
}

const bridge =
  zunder && process.env.ZUNDER_BRIDGE !== 'off'
    ? createZunderBridge({
        index,
        editor,
        zunder,
        state: captureState,
        tag: process.env.ZUNDER_BRIDGE_TAG || 'zunder',
        vaultName: process.env.OBSIDIAN_VAULT_NAME || null,
      })
    : null;
if (bridge) {
  bridge.scanAll();
  setInterval(() => bridge.scanAll(), Number(process.env.REINDEX_INTERVAL_MIN ?? 15) * 60_000).unref();
}

sync.start({
  onChanges({ paths, full }) {
    if (full) index.rebuild();
    else index.applyChanges(paths);
    if (bridge) (full ? bridge.scanAll() : bridge.scan(paths));
  },
});

// Cockpit-Einstellungen (Kalender, Zunder-Zugang, Anzeige) liegen unter /data
// und werden im Browser gepflegt; leere Felder fallen auf die Umgebung zurück.
// Der Graph nutzt dieselben Kalender und dieselbe Zeitzone.
const cockpitSettings = createSettingsStore({
  file: process.env.COCKPIT_SETTINGS_FILE ?? '/data/cockpit-settings.json',
  defaults: {
    tz: process.env.COCKPIT_TZ || 'Europe/Berlin',
    vaultName: process.env.OBSIDIAN_VAULT_NAME || null,
    inboxFolder: CAPTURE_FOLDER,
    zunderUrl: process.env.ZUNDER_URL || null,
    zunderToken: process.env.ZUNDER_TOKEN || null,
  },
});
const calendars = createCalendarSources({ settings: cockpitSettings });
const graph = createGraph({ index, semantic, zunder, calendar: calendarForGraph(calendars), tz: () => cockpitSettings.get().tz });

// Web-Cockpit (Schritt 3): Wochenansicht mit eigenem Browser-Login. Aus, bis
// WEB_CLIENT_ID gesetzt ist.
const webHttp = process.env.WEB_CLIENT_ID
  ? createWebHttp({
      cockpit: createCockpit({
        index,
        settings: cockpitSettings,
        calendars,
        zunderFor: ({ url, token }) => createZunderClient({ url, token }),
      }),
      settings: cockpitSettings,
      calendars,
      graph,
      search: (query) => hybridSearch({ index, semantic, query, limit: 30 }),
      oidc: createOidcLogin({
        issuer: ISSUER,
        clientId: process.env.WEB_CLIENT_ID,
        clientSecret: process.env.WEB_CLIENT_SECRET || null,
        redirectUri: `${PUBLIC_URL}/auth/callback`,
        allowedSubjects: ALLOWED_SUBJECTS,
      }),
      // Ohne SESSION_SECRET erzeugt der Dienst eins und legt es unter /data ab.
      sessionSecret: loadOrCreateSecret(process.env.SESSION_SECRET_FILE ?? '/data/session-secret', process.env.SESSION_SECRET || null),
      publicUrl: PUBLIC_URL,
      allowedSubjects: ALLOWED_SUBJECTS,
    })
  : null;

const mcpHttp = createVaultMcpHandler({
  index,
  capture,
  editor,
  sync,
  semantic,
  graph,
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
  captureHttp,
  webHttp,
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
  console.log(`  Capture     : ${captureHttp ? '/capture, /funke' : 'Endpunkte aus (CAPTURE_TOKEN)'}${mail ? `, Mail aus „${mail.status().mailbox}“` : ''}`);
  console.log(`  Zunder      : ${zunder ? `${process.env.ZUNDER_URL} (! → Inbox${bridge ? `, Brücke #${bridge.tag}` : ''})` : 'aus (ZUNDER_URL, ZUNDER_TOKEN)'}`);
  console.log(`  Semantik    : ${semantic ? `${semantic.model} über ${process.env.EMBED_URL}` : 'aus (EMBED_URL)'}`);
  console.log(`  Cockpit     : ${webHttp ? `${PUBLIC_URL}/ (${cockpitSettings.get().calendars.length} Kalender, Einstellungen unter /einstellungen)` : 'aus (WEB_CLIENT_ID)'}`);
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    console.log(`${sig} empfangen — fahre herunter`);
    sync.stop();
    mail?.stop();
    index.stop();
    semantic?.close();
    app.close(() => process.exit(0));
  });
}
