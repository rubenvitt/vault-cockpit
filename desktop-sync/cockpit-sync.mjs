#!/usr/bin/env node
/**
 * Cockpit Sync als Hintergrunddienst für den Desktop (VCP-152): gleicht einen
 * Vault-Ordner mit dem Cockpit ab, auch wenn Obsidian nicht läuft. Nutzt
 * dieselbe Sync-Logik wie das Obsidian-Plugin; auf dem Gerät mit diesem Dienst
 * bleibt das Plugin aus (genau ein Sync je Ordner). Obsidian sieht die
 * Änderungen über seinen eigenen Dateiwächter.
 *
 * Auslöser: Start, Dateiänderungen (entprellt), Long-Polling auf den Server und
 * alle 5 Minuten als Netz.
 *
 * Umgebung: COCKPIT_URL, VAULT_PATH, COCKPIT_SYNC_TOKEN (sonst aus dem
 * Schlüsselbund, Dienst `dev.rubeen.cockpit-sync`), STATE_PATH (optional).
 */
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { watch } from 'node:fs';
import { mkdir, readdir, readFile, rename, stat, utimes, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { createSyncEngine, createApi, isHidden } = require('../obsidian-plugin/main.js');

const CLIENT = 'desktop-sync/0.1.0';
const KEYCHAIN_SERVICE = 'dev.rubeen.cockpit-sync';
const INTERVAL_MS = 5 * 60_000;
const DEBOUNCE_MS = 3_000;
const WAIT_S = 25;

const toPosix = (p) => p.split(sep).join('/');

/** Vault auf der Platte, Schnittstelle wie `vaultFs` im Plugin. Versteckte Pfade bleiben außen vor. */
export function createNodeFs(root) {
  const rootAbs = resolve(root);
  // Pfade kommen vom Server: nur sichtbare, relative Pfade innerhalb des Vaults (isHidden schließt `.` und `..` aus).
  const abs = (path, base = rootAbs) => {
    const parts = String(path).split('/');
    if (isHidden(path) || parts.some((p) => p === '' || p.includes('\\'))) throw new Error(`Ungültiger Pfad: ${path}`);
    const target = resolve(base, ...parts);
    if (!target.startsWith(base + sep)) throw new Error(`Pfad außerhalb des Vaults: ${path}`);
    return target;
  };
  return {
    async list() {
      const out = [];
      for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
        if (!entry.isFile()) continue;
        const path = toPosix(relative(root, join(entry.parentPath, entry.name)));
        if (isHidden(path)) continue;
        const st = await stat(join(root, path)).catch(() => null);
        if (st) out.push({ path, size: st.size, mtime: Math.floor(st.mtimeMs) });
      }
      return out;
    },
    async stat(path) {
      const st = await stat(abs(path)).catch(() => null);
      return st?.isFile() ? { size: st.size, mtime: Math.floor(st.mtimeMs) } : null;
    },
    read: (path) => readFile(abs(path)),
    async write(path, data, mtime) {
      const target = abs(path);
      await mkdir(dirname(target), { recursive: true });
      // Erst versteckt daneben schreiben, dann umbenennen: Obsidian sieht nie eine halbe Datei.
      const tmp = join(dirname(target), `.cockpit-sync-${process.pid}-${Date.now()}`);
      await writeFile(tmp, Buffer.from(data));
      if (mtime) await utimes(tmp, new Date(), new Date(mtime));
      await rename(tmp, target);
    },
    async remove(path) {
      // Wie Obsidian „in den Papierkorb des Vaults“: wiederherstellbar.
      const target = abs(path, join(rootAbs, '.trash'));
      await mkdir(dirname(target), { recursive: true });
      await rename(abs(path), target);
    },
  };
}

/** HTTP wie `request` im Plugin, mit Zeitlimit (Long-Polling braucht mehr als WAIT_S). */
export function createRequest(url, token) {
  const base = url.replace(/\/+$/, '');
  return async (method, path, params = {}, body) => {
    const r = await fetch(`${base}${path}?${new URLSearchParams(params)}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'x-sync-client': CLIENT, ...(body ? { 'content-type': 'application/octet-stream' } : {}) },
      body,
      signal: AbortSignal.timeout(120_000),
    });
    return { status: r.status, headers: Object.fromEntries(r.headers), body: await r.arrayBuffer() };
  };
}

/** Der Dienst: ein Abgleich zur Zeit, was währenddessen ausgelöst wird, läuft danach einmal. */
export function createDaemon({ fs, api, state, save, log = console }) {
  const engine = createSyncEngine({ fs, api, state, save, log: (m) => log.info(m) });
  let running = null;
  let again = false;
  let stopped = false;
  const pause = (ms) => new Promise((r) => setTimeout(r, ms));

  async function syncNow() {
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      do {
        again = false;
        try {
          const s = await engine.sync();
          if (s.down || s.up || s.removed) log.info(`Abgleich: ${s.down} geholt, ${s.up} geschickt, ${s.removed} gelöscht`);
          for (const c of s.conflicts) log.warn(`Konflikt, Kopie: ${c}`);
          for (const p of s.problems) log.warn(`Problem: ${p}`);
        } catch (err) {
          log.error(`Abgleich fehlgeschlagen: ${err.message}`);
          again = false;
        }
      } while (again);
    })();
    try {
      await running;
    } finally {
      running = null;
    }
  }

  async function longPoll() {
    while (!stopped) {
      const since = state.cursor;
      if (since === null) {
        await syncNow();
        if (state.cursor === null) await pause(30_000);
        continue;
      }
      const t0 = Date.now();
      try {
        const page = await api.waitForChanges(since, WAIT_S);
        if (page.changes.length || page.cursor !== since) {
          await syncNow();
          if (state.cursor === since) await pause(10_000);
        } else if (Date.now() - t0 < 1000) await pause(60_000); // Server ohne Long-Polling
      } catch (err) {
        log.warn(`Warten auf Änderungen: ${err.message}`);
        await pause(10_000);
      }
    }
  }

  return { syncNow, longPoll, stop: () => void (stopped = true) };
}

/** Zustand (Cursor und bekannte Fassungen) als JSON-Datei. */
async function loadState(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return { cursor: null, files: {} };
  }
}

function tokenFromKeychain() {
  return execFileSync('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', 'token', '-w'], { encoding: 'utf8' }).trim();
}

async function main() {
  const url = process.env.COCKPIT_URL;
  const vault = process.env.VAULT_PATH;
  if (!url || !vault) throw new Error('COCKPIT_URL und VAULT_PATH setzen');
  const token = process.env.COCKPIT_SYNC_TOKEN || tokenFromKeychain();
  const statePath = process.env.STATE_PATH || join(homedir(), 'Library/Application Support/cockpit-sync/state.json');
  await mkdir(dirname(statePath), { recursive: true });

  const state = await loadState(statePath);
  const save = async () => {
    await writeFile(`${statePath}.tmp`, JSON.stringify(state));
    await rename(`${statePath}.tmp`, statePath);
  };
  const log = { info: (m) => console.log(m), warn: (m) => console.warn(m), error: (m) => console.error(m) };
  const daemon = createDaemon({ fs: createNodeFs(vault), api: createApi(createRequest(url, token)), state, save, log });

  log.info(`Cockpit Sync: ${vault} ↔ ${url}`);
  await daemon.syncNow();
  let timer = null;
  watch(vault, { recursive: true }, (_event, name) => {
    if (!name || isHidden(toPosix(name))) return;
    clearTimeout(timer);
    timer = setTimeout(() => daemon.syncNow(), DEBOUNCE_MS);
  });
  setInterval(() => daemon.syncNow(), INTERVAL_MS);
  await daemon.longPoll();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`Cockpit Sync: ${err.message}`);
    process.exit(1);
  });
}
