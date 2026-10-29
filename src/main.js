import { dirname, join } from 'node:path';
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
import { createSearchHttp } from './search/http.js';
import { createMailCapture } from './capture/mail.js';
import { createZunderBridge } from './capture/bridge.js';
import { createCockpit } from './cockpit/data.js';
import { createCalendarSources, calendarForGraph } from './cockpit/calendars.js';
import { createSettingsStore, loadOrCreateSecret } from './cockpit/settings.js';
import { createTokenStore } from './cockpit/tokens.js';
import { createBackup } from './cockpit/backup.js';
import { createReadingStore } from './lesen/store.js';
import { createSecretBox } from './cockpit/secret-box.js';
import { readingRoutes } from './lesen/http.js';
import { createFeedPoller } from './lesen/feeds.js';
import { createReadingApi } from './lesen/api.js';
import { saveUrl } from './lesen/save.js';
import { createMailReader } from './lesen/mail.js';
import { createReadingExport } from './lesen/vault-export.js';
import { createEmbedCache } from './lesen/embed-cache.js';
import { createSynthesisEvidence } from './lesen/synthesis-evidence.js';
import { createSpeech, createSpeechCache } from './lesen/tts.js';
import { createClaudeWriter } from './lesen/claude.js';
import { createEpisodes } from './lesen/folgen.js';
import { createResearchVault } from './lesen/research-mcp.js';
import { createVaultChat } from './fragen/chat.js';
import { createIngest, createNightlyClock } from './lesen/ingest.js';
import { createPlanter } from './lesen/einpflanzen.js';
import { createOidcLogin } from './web/oidc.js';
import { createWebHttp } from './web/http.js';
import { APP_TEAM_ID, APP_BUNDLE_ID } from './web/app-access.js';
import { loadShortcuts } from './web/shortcuts.js';
import { createCockpitActions } from './cockpit/actions.js';
import { createWeekPlanner } from './cockpit/plan.js';
import { createNoteDesk } from './cockpit/notes.js';
import { createFlameNote } from './cockpit/flammen-notiz.js';
import { createFlameBlocks } from './cockpit/flammen-bloecke.js';
import { createOllamaEmbedder } from './semantic/embedder.js';
import { createSemanticIndex } from './semantic/index.js';
import { hybridSearch } from './semantic/search.js';
import { createGraph } from './graph/graph.js';
import { createWholeGraph } from './graph/whole.js';
import { createHealth, createRunLog } from './health/collect.js';

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

const CAPTURE_FOLDER = process.env.CAPTURE_FOLDER ?? 'inbox';
const capture = createCapture({ vaultPath: VAULT_PATH, folder: CAPTURE_FOLDER });
const editor = createEditor({ vaultPath: VAULT_PATH, index });

// Cockpit-Einstellungen (Kalender, Zunder-Zugang, Anzeige) liegen unter /data
// und werden im Browser gepflegt; leere Felder fallen auf die Umgebung zurück.
// Der Zunder-Zugang daraus gilt für alles: Wochenansicht, `!`-Capture, Brücke
// und Graph fragen ihn bei jedem Aufruf neu, ein neuer Token wirkt ohne Neustart.
const COCKPIT_SETTINGS_FILE = process.env.COCKPIT_SETTINGS_FILE ?? '/data/cockpit-settings.json';
const cockpitSettings = createSettingsStore({
  file: COCKPIT_SETTINGS_FILE,
  defaults: {
    tz: process.env.COCKPIT_TZ || 'Europe/Berlin',
    vaultName: process.env.OBSIDIAN_VAULT_NAME || null,
    inboxFolder: CAPTURE_FOLDER,
    zunderUrl: process.env.ZUNDER_URL || null,
    zunderToken: process.env.ZUNDER_TOKEN || null,
    bridgeEnabled: process.env.ZUNDER_BRIDGE !== 'off',
    bridgeTag: process.env.ZUNDER_BRIDGE_TAG || 'zunder',
    mailToken: process.env.MAIL_JMAP_TOKEN || null,
    mailSenders: (process.env.MAIL_ALLOWED_SENDERS ?? '').split(',').map((x) => x.trim()).filter(Boolean),
    mailbox: process.env.MAIL_MAILBOX || 'Vault',
    doneMailbox: process.env.MAIL_DONE_MAILBOX || 'Archive',
    mailPollMinutes: Number(process.env.MAIL_POLL_MIN) || 5,
    embedUrl: process.env.EMBED_URL || null,
    embedModel: process.env.EMBED_MODEL || 'bge-m3',
    ttsProvider: process.env.TTS_PROVIDER || null,
    elevenlabsKey: process.env.ELEVENLABS_API_KEY || null,
    ...(process.env.ELEVENLABS_VOICE_ID ? { elevenlabsVoice: process.env.ELEVENLABS_VOICE_ID } : {}),
    ...(process.env.ELEVENLABS_MODEL ? { elevenlabsModel: process.env.ELEVENLABS_MODEL } : {}),
  },
});

// Vorlesen mit ElevenLabs („Unterwegs hören“): aus, bis unter Einstellungen →
// Vorlesen ein Key steht. Jeder Satz landet einmal im Cache unter /data.
const speech = createSpeech({
  settings: () => cockpitSettings.get().tts,
  cache: createSpeechCache({ dir: process.env.TTS_CACHE_DIR ?? '/data/tts-cache', maxBytes: (Number(process.env.TTS_CACHE_MB) || 500) * 1024 * 1024 }),
});

// Semantische Suche: Embeddings über einen Ollama-Server, eigener Vektorspeicher
// neben dem Index. Aus, bis in den Einstellungen ein Embedding-Server steht;
// eine neue Adresse oder ein neues Modell baut den Index ohne Neustart neu auf.
const VECTOR_DB = process.env.VECTOR_DB ?? '/data/vectors.db';
let semantic = null;
let semanticKey = null;
// Derselbe Embedder bettet Markierungen ein (Wiedersehen, Querverbindungen), über einen gemeinsamen Speicher.
let embedder = null;
const embedCache = createEmbedCache({ embedder: () => embedder });
function applyEmbed() {
  const e = cockpitSettings.get().embed;
  const key = e ? `${e.url}\n${e.model}` : null;
  if (key === semanticKey) return;
  semantic?.close();
  semantic = null;
  embedder = null;
  semanticKey = key;
  if (!e) return console.log('Semantik: aus (Einstellungen → Embeddings)');
  embedder = createOllamaEmbedder({ url: e.url, model: e.model });
  semantic = createSemanticIndex({
    dbPath: VECTOR_DB,
    vaultPath: VAULT_PATH,
    index,
    embedder,
  });
  semantic.schedule();
  console.log(`Semantik: ${e.model} über ${e.url}`);
}
const currentSemantic = () => semantic;
index.onChange(({ full, paths }) => semantic?.schedule(full ? null : paths));
const calendars = createCalendarSources({ settings: cockpitSettings });
// Ob Zunder den Zugang annimmt, merkt sich der Client bei jedem Aufruf (Seite
// „Zustand“); ein neuer Zugang fängt von vorn an.
const zunderAccess = createRunLog();
// Verlauf der Flammen, geteilt von Wochenansicht, Rückblick und Feuer-Notiz (VCP-118).
const flameBlocks = createFlameBlocks();
const cockpit = createCockpit({
  flameBlocks,
  index,
  settings: cockpitSettings,
  calendars,
  zunderFor: ({ url, token }) => {
    zunderAccess.reset();
    return createZunderClient({ url, token, monitor: zunderAccess });
  },
});
const zunder = () => cockpit.zunder();
const zunderSource = () => {
  const z = cockpitSettings.get().zunder;
  return z ? `${z.url} aus ${z.source === 'einstellungen' ? 'den Einstellungen' : 'der Umgebung'}` : null;
};

// Capture von außen (Schritt 2): Weiterleitung an Zunder, Capture-Endpunkte,
// Mail-Abruf und Zunder-Brücke. Eingerichtet wird alles in den Einstellungen.
const captureState = createStateStore(process.env.CAPTURE_STATE_FILE ?? '/data/capture-state.json');
const captureRouter = createCaptureRouter({ capture, zunder, state: captureState, tz: () => cockpitSettings.get().tz });

// API-Tokens werden im Web-Cockpit unter Einstellungen → API-Tokens angelegt und
// liegen neben den Einstellungen: Recht „Suche“ für /api/search, „Capture“ für
// /capture und /funke. CAPTURE_TOKEN aus älteren Deployments gilt daneben weiter.
const apiTokens = createTokenStore({ file: join(dirname(COCKPIT_SETTINGS_FILE), 'api-tokens.json') });
const LEGACY_CAPTURE_TOKEN = process.env.CAPTURE_TOKEN || null;

// Lesestapel (VCP-77): Artikel, Markierungen und Feeds, neben den Einstellungen
// unter /data. Lässt sich nicht neu bauen, gehört deshalb in die Sicherung.
// Zugangsdaten privater Feeds liegen darin verschlüsselt, mit einem eigenen,
// beim ersten Start erzeugten Schlüssel (`credentials-key`, ebenfalls in der Sicherung).
const reading = createReadingStore({
  path: join(dirname(COCKPIT_SETTINGS_FILE), 'lesestapel.db'),
  secrets: createSecretBox(loadOrCreateSecret(join(dirname(COCKPIT_SETTINGS_FILE), 'credentials-key'))),
});
// Feeds (VCP-78): jede Minute nachsehen, welche dran sind; jeder Feed hat seinen
// eigenen Abstand (Standard 30 min), Fehler verlängern ihn.
const feedPoller = createFeedPoller({ store: reading });
feedPoller.start();
// Texte als Notiz in den Vault (VCP-75, VCP-96), Markierungen entprellt;
// `readingExport.addLink` schreibt Wikilinks zu einer Markierung dorthin.
const readingExport = createReadingExport({ vaultPath: VAULT_PATH, index, editor, policy: POLICY, store: reading, settings: cockpitSettings });
const captureHttp = createCaptureHttp({ token: LEGACY_CAPTURE_TOKEN, tokens: apiTokens, router: captureRouter, zunderEnabled: () => Boolean(zunder()) });
const captureEnabled = () => Boolean(LEGACY_CAPTURE_TOKEN) || apiTokens.has('capture');
// Kurzbefehl „Zum Lesestapel“: nur API-Tokens mit dem Recht „Lesestapel“.
const readingApi = createReadingApi({ tokens: apiTokens, store: reading });
const searchHttp = createSearchHttp({ tokens: apiTokens, index, semantic: currentSemantic });

// Mail-Abruf: läuft, sobald Token und Absender in den Einstellungen stehen;
// jede Änderung dort startet ihn mit dem neuen Stand neu.
let mail = null;
let mailKey = null;
// Scheitert schon der Start, zeigt die Zustandsseite das statt eines Abrufs.
let mailStartError = null;
function applyMail() {
  const m = cockpitSettings.get().mail;
  const key = m ? JSON.stringify([m.token, m.senders, m.mailbox, m.doneMailbox, m.pollMinutes]) : null;
  if (key === mailKey) return;
  mail?.stop();
  mail = null;
  mailStartError = null;
  mailKey = key;
  if (!m) return;
  try {
    mail = createMailCapture({
      token: m.token,
      sessionUrl: process.env.MAIL_JMAP_SESSION_URL || undefined,
      mailbox: m.mailbox,
      doneMailbox: m.doneMailbox,
      allowedSenders: m.senders,
      router: captureRouter,
      // `[lesen]` im Betreff: Artikel oder Newsletter in den Lesestapel.
      readingMail: createMailReader({ store: reading }),
    });
    mail.start(m.pollMinutes);
    console.log(`Mail-Capture: „${m.mailbox}“ alle ${m.pollMinutes} Minuten`);
  } catch (err) {
    mailStartError = { state: 'error', mailbox: m.mailbox, lastError: `Start fehlgeschlagen: ${err.message}`, lastErrorAt: new Date().toISOString() };
    console.error(`Mail-Capture aus: ${err.message}`);
  }
}

// Die Brücke ruht, solange sie in den Einstellungen aus ist oder kein
// Zunder-Zugang da ist, und legt los, sobald beides passt. Tag und Vault-Name
// liest sie bei jedem Durchlauf neu.
const bridge = createZunderBridge({
  index,
  editor,
  zunder,
  state: captureState,
  tag: () => cockpitSettings.get().bridge.tag,
  vaultName: () => cockpitSettings.get().vaultName,
  enabled: () => cockpitSettings.get().bridge.enabled,
});
const bridgeRound = () => {
  if (!bridge.active()) return;
  bridge.scanAll();
  bridge.syncBack();
};
const bridgeState = () => (bridge.enabled() ? `#${bridge.tag}${bridge.active() ? '' : ' ruht'}` : 'aus');
setInterval(bridgeRound, Number(process.env.REINDEX_INTERVAL_MIN ?? 15) * 60_000).unref();

// Neuer Stand in den Einstellungen: Embeddings und Mail neu aufbauen, bei
// geändertem Zugang, Schalter oder Tag gleich eine Brückenrunde.
let lastBridge = `${zunderSource()} ${bridgeState()}`;
cockpitSettings.onChange(() => {
  applyEmbed();
  applyMail();
  const now = `${zunderSource()} ${bridgeState()}`;
  if (now === lastBridge) return;
  lastBridge = now;
  console.log(`Zunder-Brücke: ${bridge.active() ? `#${bridge.tag}, Zugang ${zunderSource()}` : bridge.enabled() ? 'ruht (kein Zunder-Zugang)' : 'aus'}`);
  bridgeRound();
});
applyEmbed();
applyMail();
bridgeRound();

sync.start({
  onChanges({ paths, full }) {
    if (full) index.rebuild();
    else index.applyChanges(paths);
    if (bridge.active()) (full ? bridge.scanAll() : bridge.scan(paths));
  },
});

// Flammen der Woche mit gemessener Zeit in die Feuer-Notiz (VCP-52): nach
// Start/Stopp im Cockpit und im Reindex-Intervall, abschaltbar in den Einstellungen.
const flameNote = createFlameNote({ vaultPath: VAULT_PATH, index, editor, policy: POLICY, settings: cockpitSettings, zunder, flameBlocks });
setInterval(() => flameNote.round(), Number(process.env.REINDEX_INTERVAL_MIN ?? 15) * 60_000).unref();
flameNote.round();
// Eingeschaltet in den Einstellungen: gleich schreiben, nicht erst im nächsten Intervall (VCP-61).
let flameNoteOn = Boolean(cockpitSettings.get().flameNote?.enabled);
cockpitSettings.onChange(() => {
  const on = Boolean(cockpitSettings.get().flameNote?.enabled);
  if (on && !flameNoteOn) flameNote.round();
  flameNoteOn = on;
});
// Zustand der Hintergrunddienste: Seite /zustand, Hinweis in der Kopfzeile und
// `degraded` in /health. Dieselben Quellen wie vault_stats.
const health = createHealth({
  settings: cockpitSettings,
  sync,
  index,
  semantic: currentSemantic,
  mail: () => mail?.status() ?? mailStartError,
  bridge,
  zunder,
  zunderAccess,
  calendars,
  flameNote,
  feeds: () => feedPoller.health(),
  readingExport: () => readingExport.health(),
  // Letzter Erfolg und Fehler je Dienst überstehen einen Neustart (VCP-60).
  file: join(dirname(COCKPIT_SETTINGS_FILE), 'dienste-zustand.json'),
});
// Festhalten, was die Dienste melden, auch wenn gerade niemand /zustand ansieht.
setInterval(() => health.services(), 60_000).unref();

const graph = createGraph({ index, semantic: currentSemantic, zunder, calendar: calendarForGraph(calendars), tz: () => cockpitSettings.get().tz });
// Ganzer Vault als Graph (VCP-40): Layout im Worker, Positionen neben dem Index gespeichert.
const wholeGraph = createWholeGraph({ index, file: join(dirname(INDEX_DB), 'graph-layout.json') });
wholeGraph.warm();

// Abhaken und Schnelleingabe: Zunder-Zugang und Inbox-Ordner aus den Einstellungen.
const cockpitActions = createCockpitActions({
  vaultPath: VAULT_PATH,
  settings: cockpitSettings,
  policy: POLICY,
  state: captureState,
  zunder,
  index,
  // `> https://…` in der Schnelleingabe geht in den Lesestapel.
  saveArticle: ({ url, clientId }) => saveUrl({ store: reading, url, origin: 'schnelleingabe', clientId }),
  onFlame: (task) => flameNote.afterFlame(task),
});

// Folgen aus dem Stapel (Vorlesen, Podcast, Report): ElevenLabs aus den
// Einstellungen, Claude über die CLI mit CLAUDE_CODE_OAUTH_TOKEN; die MP3s und
// der Stand liegen unter /data/folgen. Podcast und Report kommen als Transkript
// unter 30-ressourcen/audio-reports in den Vault, die Texte bekommen „gehört“.
// Zu einem Thema recherchiert Claude als Agent im ganzen Vault (eigener MCP-Server
// je Lauf auf 127.0.0.1, nur lesend, ohne vertrauliche Ordner) und im Internet.
const researchVault = createResearchVault({ index, semantic: currentSemantic, layoutHint: POLICY.layoutHint });
const episodes = createEpisodes({
  dir: process.env.FOLGEN_DIR ?? '/data/folgen',
  store: reading,
  tts: () => cockpitSettings.get().tts,
  speech,
  voices: () => cockpitSettings.get().episodes,
  writer: createClaudeWriter({ model: () => cockpitSettings.get().episodes.model }),
  // Wie beim Exporter: nicht in vertrauliche, ausgeschlossene oder Readwise-Ordner. Scheitert es, läuft die Folge ohne Transkript.
  createNote: (input) => {
    const probe = `${String(input.folder ?? '').replace(/\/+$/, '')}/_.md`;
    if (POLICY.isExcluded(probe) || POLICY.sensitivityOf(probe) || POLICY.classify(probe) !== 'core') throw new Error(`„${input.folder}“ ist vertraulich, ausgeschlossen oder Readwise`);
    return editor.create(input);
  },
  sourceNote: (docId) => readingExport.notePath(docId),
  heard: (docIds) => readingExport.heard(docIds),
  research: researchVault,
  // Als Funktion: Eine geänderte Zeitzone oder Sprache gilt ohne Neustart.
  tz: () => cockpitSettings.get().tz,
  language: () => cockpitSettings.get().episodes.language,
});

// Ingest ins Mycel-Wiki: Claude entwirft (eigenes Modell unter Einstellungen →
// Lesestapel), der Nutzer hakt unter Lesen → Ingest ab, erst dann schreibt das
// Cockpit über den Editor. Nachts entstehen Entwürfe für den Stapel: alle 10
// Minuten nachsehen, ob die eingestellte Stunde da ist; der letzte Tag liegt unter /data.
const ingestClaude = createClaudeWriter({ model: () => cockpitSettings.get().ingest.model });
const ingest = createIngest({
  store: reading,
  writer: ingestClaude,
  search: (query, opts) => hybridSearch({ index, semantic: currentSemantic, query, ...opts }),
  index,
  exporter: readingExport,
  editor,
  policy: POLICY,
  settings: cockpitSettings,
  vaultPath: VAULT_PATH,
  // Nach dem Übernehmen pflanzt ein Agent die Quelle ein (Einstellungen → Lesestapel, Standard an).
  onApplied: (docId) => planter.request(docId, { auto: true }),
});
// Der Agent arbeitet über die Vault-Werkzeuge, auf einem eigenen MCP-Server nur an 127.0.0.1:
// ohne vertrauliche Ordner, mit einem Editor, der nur unter wiki/ ergänzt (src/lesen/einpflanzen.js).
const planter = createPlanter({
  store: reading,
  claude: ingestClaude,
  mcp: ({ editor: guarded, verifyToken }) =>
    createVaultMcpHandler({ index, capture: null, editor: guarded, policy: POLICY, semantic: currentSemantic, graph, verifyToken, captureFolder: CAPTURE_FOLDER, layoutHint: POLICY.layoutHint, allowSensitive: false }),
  editor,
  index,
  settings: cockpitSettings,
  log: (entry) => ingest.log(entry),
});
const ingestClock = createNightlyClock({ ingest, settings: cockpitSettings, file: join(dirname(COCKPIT_SETTINGS_FILE), 'ingest-nacht.txt') });
setInterval(() => ingestClock.tick(), 10 * 60_000).unref();

// Fragen an den ganzen Vault (src/fragen): Claude sucht über denselben nur
// lesenden Zugang wie bei den Folgen und antwortet mit Bausteinen. Neue Notizen
// legt es direkt in der Inbox an (wie die Schnelleingabe), Änderungen an
// bestehenden schlägt es vor, geschrieben wird erst nach „Übernehmen“.
const noteVisible = (path) => {
  const row = index.getNote(String(path ?? ''));
  return row && !row.sensitivity && !POLICY.isExcluded(row.path) ? row : null;
};
const vaultChat = createVaultChat({
  dir: process.env.FRAGEN_DIR ?? '/data/fragen',
  writer: createClaudeWriter({ model: () => cockpitSettings.get().episodes.model }),
  research: researchVault,
  // Ein Text, der mit `!` oder `>` anfängt, wäre in der Schnelleingabe eine Aufgabe oder ein Artikel.
  inbox: ({ title, text }) => cockpitActions.capture({ title, text: /^\s*[!>]/.test(text) ? `\u200b${text}` : text }),
  task: (text) => cockpitActions.capture({ text }),
  editor,
  canCreate: (folder) => {
    const probe = `${String(folder ?? '').replace(/\/+$/, '')}/_.md`;
    if (POLICY.isExcluded(probe) || POLICY.sensitivityOf(probe) || POLICY.classify(probe) !== 'core') throw new Error(`„${folder}“ ist vertraulich, ausgeschlossen oder Readwise`);
  },
  tz: () => cockpitSettings.get().tz,
});

// Vault-Notizen ansehen und verarbeiten, über denselben Editor wie vault_edit;
// Bilder aus dem Vault und ähnliche Notizen für die Vorschau.
const noteDesk = createNoteDesk({ index, editor, policy: POLICY, settings: cockpitSettings, vaultPath: VAULT_PATH, semantic: currentSemantic });

// Web-Cockpit (Schritt 3): Wochenansicht mit eigenem Browser-Login. Aus, bis
// WEB_CLIENT_ID gesetzt ist.
const webHttp = process.env.WEB_CLIENT_ID
  ? createWebHttp({
      cockpit,
      actions: cockpitActions,
      // Woche planen: Zunder-Aufgaben holen, Flammen einplanen (VCP-47).
      plan: createWeekPlanner({ settings: cockpitSettings, zunder }),
      notes: noteDesk,
      settings: cockpitSettings,
      tokens: apiTokens,
      shortcuts: loadShortcuts(),
      captureEnabled,
      calendars,
      graph,
      wholeGraph,
      search: (query, { type = null, paths = null } = {}) => hybridSearch({ index, semantic: currentSemantic, query, type, paths, limit: 30 }),
      // Synthesen: passende neue Markierungen als Belege anhängen (VCP-82).
      evidence: createSynthesisEvidence({ notes: noteDesk, index, store: reading, exporter: readingExport, embedCache, semantic: currentSemantic, vaultPath: VAULT_PATH, editor }),
      health,
      // Lesen: Eingang, Stapel, Markiert; Artikel holt src/lesen/fetch.js (SSRF-geschützt).
      // „In Inbox“ aus der Leseansicht nutzt die Schnelleingabe des Cockpits.
      reading: readingRoutes({
        store: reading,
        capture: (input) => cockpitActions.capture(input),
        embedCache,
        speech,
        episodes,
        // Text der Transkripte zum Kopieren und für Einmal-Links: nur Notizen, die das Cockpit zeigen darf;
        // false: vertraulich oder ausgeschlossen, dann auch nicht aus Claudes Skript; null: (noch) nicht im Index.
        readNote: (path) => {
          const p = String(path ?? '');
          if (POLICY.isExcluded(p) || POLICY.sensitivityOf(p)) return false;
          const row = index.getNote(p);
          if (row?.sensitivity) return false;
          return row?.content ?? null;
        },
        publicUrl: PUBLIC_URL,
        // Querverbindungen in der Leseansicht (VCP-73): Wikilinks nur in die Lesestapel-Notiz.
        connections: { index, semantic: currentSemantic, policy: POLICY, exporter: readingExport },
        // „In den Vault“ und „Im Vault ablegen“ (VCP-96) schreiben die Lesestapel-Notiz sofort.
        exporter: readingExport,
        // Ingest ins Wiki: Entwürfe prüfen, abhaken, übernehmen.
        ingest,
        planter,
        fragen: { chat: vaultChat, index, visible: noteVisible },
        onChange: (id) => readingExport.changed(id),
      }),
      oidc: createOidcLogin({
        issuer: ISSUER,
        clientId: process.env.WEB_CLIENT_ID,
        clientSecret: process.env.WEB_CLIENT_SECRET || null,
        redirectUri: `${PUBLIC_URL}/auth/callback`,
        allowedSubjects: ALLOWED_SUBJECTS,
      }),
      // Ohne SESSION_SECRET erzeugt der Dienst eins und legt es unter /data ab.
      sessionSecret: loadOrCreateSecret(process.env.SESSION_SECRET_FILE ?? '/data/session-secret', process.env.SESSION_SECRET || null),
      // Sicherung der Dateien unter /data (Einstellungen → Sicherung). Nach dem
      // Wiederherstellen fährt der Dienst herunter, Docker startet ihn neu
      // (`restart: unless-stopped`), und alle Teile lesen den neuen Stand.
      backup: createBackup({
        dir: dirname(COCKPIT_SETTINGS_FILE),
        paths: {
          'cockpit-settings.json': COCKPIT_SETTINGS_FILE,
          'capture-state.json': process.env.CAPTURE_STATE_FILE ?? '/data/capture-state.json',
          'session-secret': process.env.SESSION_SECRET_FILE ?? '/data/session-secret',
        },
        // Die offene Datenbank als Schnappschuss; beim Wiederherstellen öffnet der Store sie neu.
        // Den Merkzettel hält die Brücke im Speicher: zurückgespielt gilt er sofort, sonst überschriebe sie ihn bis zum Neustart.
        live: {
          'lesestapel.db': { read: () => reading.snapshot(), write: (buf) => reading.replaceWith(buf) },
          'capture-state.json': { read: () => captureState.snapshot(), write: (buf) => captureState.replaceWith(buf) },
        },
      }),
      restart: () => {
        setTimeout(() => process.exit(0), 5000).unref();
        process.kill(process.pid, 'SIGTERM');
      },
      publicUrl: PUBLIC_URL,
      // iOS-App für Universal Link und Login-Blatt (apple-app-site-association).
      appId: `${process.env.APP_TEAM_ID || APP_TEAM_ID}.${process.env.APP_BUNDLE_ID || APP_BUNDLE_ID}`,
      // `cockpit://` nur für einen lokalen Server ohne https, nie im Container (NODE_ENV=production).
      allowDevScheme: process.env.NODE_ENV !== 'production',
      // Begrenzung beim Einlösen des App-Logins je Absender: hinter dem Proxy aus X-Forwarded-For.
      trustProxy: config.trustProxy,
      allowedSubjects: ALLOWED_SUBJECTS,
    })
  : null;

const mcpHttp = createVaultMcpHandler({
  index,
  capture,
  editor,
  // vault_move legt wie das Cockpit nie in oder aus vertraulichen Ordnern ab.
  policy: POLICY,
  sync,
  semantic: currentSemantic,
  graph,
  // vault_stats zeigt dieselben Dienste wie /zustand (VCP-60).
  health,
  zunderStatus: () => {
    const z = cockpitSettings.get().zunder;
    const b = bridge.enabled() ? `#${bridge.tag}${z ? '' : ' (ruht)'}` : 'off';
    return z ? { state: 'enabled', source: z.source, url: z.url, bridge: b } : { state: 'disabled', bridge: b };
  },
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
  readingApi,
  searchHttp,
  webHttp,
  degraded: () => health.degraded(),
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
  const tokenCount = (scope) => apiTokens.list().filter((t) => t.scope === scope).length;
  console.log(`  Capture     : /capture, /funke (${tokenCount('capture')} Capture-Tokens${LEGACY_CAPTURE_TOKEN ? ' + CAPTURE_TOKEN' : ''})${mail ? `, Mail aus „${mail.status().mailbox}“` : ''}`);
  console.log(`  Suche       : /api/search (${tokenCount('search')} Such-Tokens)`);
  console.log(`  Lesestapel  : /lesestapel/speichern (${tokenCount('lesestapel')} Lesestapel-Tokens)`);
  const z = zunderSource();
  console.log(`  Zunder      : ${z ? `${z} (! → Inbox, Brücke ${bridgeState()})` : `aus (Einstellungen → Zunder), Brücke ${bridgeState()}`}`);
  const e = cockpitSettings.get().embed;
  console.log(`  Semantik    : ${e ? `${e.model} über ${e.url}` : 'aus (Einstellungen → Embeddings)'}`);
  const t = cockpitSettings.get().tts;
  console.log(`  Folgen      : ${process.env.CLAUDE_CODE_OAUTH_TOKEN ? 'Vorlesen, Podcast und Report, auch zu einem Thema mit Recherche im Vault und Internet' : 'nur Vorlesen (Podcast und Report brauchen CLAUDE_CODE_OAUTH_TOKEN)'}`);
  const ig = cockpitSettings.get().ingest;
  console.log(`  Ingest      : ${ingest.available().ok ? `Entwürfe per Knopf${ig.nightly ? `, nachts um ${ig.hour} Uhr (höchstens ${ig.limit})` : ''}, Modell ${ig.model}${ig.agent ? ', danach einpflanzen' : ''}` : 'aus (braucht CLAUDE_CODE_OAUTH_TOKEN)'}`);
  console.log(`  Fragen      : ${vaultChat.missing() ?? '/fragen, Antworten als Bausteine, Modell wie bei den Folgen'}`);
  console.log(`  Vorlesen    : ${t ? `ElevenLabs (${t.model}, Stimme ${t.voice})` : 'Gerätestimme (Einstellungen → Vorlesen)'}`);
  console.log(`  Cockpit     : ${webHttp ? `${PUBLIC_URL}/ (${cockpitSettings.get().calendars.length} Kalender, Einstellungen unter /einstellungen)` : 'aus (WEB_CLIENT_ID)'}`);
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    console.log(`${sig} empfangen — fahre herunter`);
    sync.stop();
    mail?.stop();
    feedPoller.stop();
    readingExport.flush();
    index.stop();
    semantic?.close();
    reading.close();
    app.close(() => process.exit(0));
  });
}
