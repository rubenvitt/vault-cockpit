#!/usr/bin/env node
// Sidecar „vault-sync“: richtet Obsidian Headless beim ersten Start ein,
// übernimmt Einstellungen aus der Umgebung und hält `ob sync --continuous`
// am Laufen. Nebenbei schreibt er eine Statusdatei für das Cockpit.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { createStatusTracker, writeStatusFile } from './status.mjs';

const VAULT = process.env.VAULT_PATH ?? '/vault';
const STATUS_FILE = process.env.STATUS_FILE ?? '/status/sync.json';
const HEARTBEAT_MS = Number(process.env.HEARTBEAT_SEC ?? 30) * 1000;
const CLIENT_VERSION = process.env.OBSIDIAN_HEADLESS_VERSION ?? null;

function die(message) {
  console.error(`[vault-sync] ${message}`);
  process.exit(1);
}

/** `ob` ausführen und auf das Ende warten. Ausgabe geht ins Container-Log. */
function ob(args, { quiet = false } = {}) {
  const res = spawnSync('ob', args, { stdio: quiet ? 'ignore' : 'inherit', env: process.env });
  if (res.error) die(`ob konnte nicht gestartet werden: ${res.error.message}`);
  return res.status;
}

// Token aus der Umgebung oder aus einem früheren `ob login` im Config-Volume.
const TOKEN_FILE = join(process.env.XDG_CONFIG_HOME ?? '/config', 'obsidian-headless', 'auth_token');
if (!process.env.OBSIDIAN_AUTH_TOKEN && !existsSync(TOKEN_FILE)) {
  die('Nicht angemeldet: OBSIDIAN_AUTH_TOKEN setzen oder einmalig `ob login` ausführen (siehe README, Abschnitt Sync).');
}

// 1. Einrichtung nur beim ersten Start: Ohne lokale Sync-Konfiguration endet
//    `ob sync-status` mit Code 3.
if (ob(['sync-status', '--path', VAULT], { quiet: true }) === 3) {
  if (!process.env.VAULT_NAME) die('Vault ist noch nicht eingerichtet und VAULT_NAME fehlt.');
  console.log(`[vault-sync] richte ${VAULT} für den Remote-Vault „${process.env.VAULT_NAME}“ ein`);
  // --json schaltet Rückfragen ab; fehlt etwa das E2E-Passwort, scheitert die
  // Einrichtung sofort, statt auf eine Eingabe zu warten.
  const setup = ['sync-setup', '--vault', process.env.VAULT_NAME, '--path', VAULT, '--json'];
  if (process.env.DEVICE_NAME) setup.push('--device-name', process.env.DEVICE_NAME);
  if (process.env.VAULT_PASSWORD) setup.push('--password', process.env.VAULT_PASSWORD);
  if (ob(setup) !== 0) die('Einrichtung fehlgeschlagen');
}

// 2. Einstellungen bei jedem Start anwenden, damit die Compose-Datei gilt.
const config = [
  ['--mode', process.env.SYNC_MODE],
  ['--conflict-strategy', process.env.CONFLICT_STRATEGY],
  ['--excluded-folders', process.env.EXCLUDED_FOLDERS],
  ['--file-types', process.env.FILE_TYPES],
  ['--configs', process.env.SYNC_CONFIGS],
  ['--device-name', process.env.DEVICE_NAME],
].filter(([, value]) => value !== undefined);
if (config.length && ob(['sync-config', '--path', VAULT, ...config.flat()]) !== 0) {
  die('Sync-Einstellungen konnten nicht gesetzt werden');
}

// 3. Dauerhafter Sync mit Statusdatei.
const tracker = createStatusTracker({ clientVersion: CLIENT_VERSION });
const persist = () => {
  try {
    writeStatusFile(STATUS_FILE, tracker.snapshot());
  } catch (err) {
    console.error(`[vault-sync] Statusdatei ${STATUS_FILE} nicht schreibbar: ${err.message}`);
  }
};
persist();

const child = spawn('ob', ['sync', '--path', VAULT, '--continuous'], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: process.env,
});

for (const [stream, stderr] of [[child.stdout, false], [child.stderr, true]]) {
  createInterface({ input: stream }).on('line', (line) => {
    (stderr ? process.stderr : process.stdout).write(`${line}\n`);
    if (tracker.onLine(line, { stderr })) persist();
  });
}

const heartbeat = setInterval(() => {
  tracker.heartbeat();
  persist();
}, HEARTBEAT_MS);

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => child.kill(sig));
}

child.on('exit', (code, signal) => {
  clearInterval(heartbeat);
  tracker.onExit(code, signal);
  persist();
  // Mit dem Client endet der Container; Docker startet ihn neu (restart: unless-stopped).
  process.exit(code ?? 0);
});
