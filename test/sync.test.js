import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, unlinkSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIndexManager } from '../src/vault/manager.js';
import { createObsidianHeadlessAdapter } from '../src/sync/headless.js';
import { createSyncAdapter } from '../src/sync/index.js';
import { createVaultWatcher } from '../src/sync/watch.js';
import { createStatusTracker, writeStatusFile } from '../sync/status.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Wartet auf das nächste Paket des Watchers. */
function nextBatch(batches, timeoutMs = 3000) {
  const start = batches.length;
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const poll = setInterval(() => {
      if (batches.length > start) {
        clearInterval(poll);
        resolve(batches[batches.length - 1]);
      } else if (Date.now() > deadline) {
        clearInterval(poll);
        reject(new Error('kein Paket vom Watcher'));
      }
    }, 20);
  });
}

/** Wartet, bis eine Weile lang kein neues Paket mehr kommt. */
async function settle(batches, quietMs) {
  let seen;
  do {
    seen = batches.length;
    await sleep(quietMs);
  } while (batches.length !== seen);
}

/**
 * Startet den Watcher und kehrt erst zurück, wenn er nachweislich Ereignisse
 * liefert und sich beruhigt hat. Unter macOS (FSEvents) kommen die ersten
 * Ereignisse erst nach einer Weile, und Ordner, die kurz vor dem Start
 * angelegt wurden, können noch verspätet gemeldet werden. Eine Probe-Notiz
 * zeigt, dass der Watcher läuft; danach ist batches leer.
 */
async function startLiveWatcher(dir, batches, debounceMs) {
  const w = createVaultWatcher({ vaultPath: dir, onBatch: (b) => batches.push(b), debounceMs });
  const deadline = Date.now() + 5000;
  for (let i = 0; !batches.some((b) => b.paths?.includes('probe.md')); i++) {
    if (Date.now() > deadline) {
      w.stop();
      throw new Error('Watcher liefert keine Ereignisse');
    }
    writeFileSync(join(dir, 'probe.md'), String(i));
    await sleep(debounceMs * 2);
  }
  await settle(batches, debounceMs * 3);
  batches.length = 0;
  return w;
}

let root, dbPath, mgr;

before(() => {
  root = mkdtempSync(join(tmpdir(), 'vault-sync-'));
  dbPath = join(mkdtempSync(join(tmpdir(), 'vault-sync-db-')), 'index.db');
  mkdirSync(join(root, 'projects'), { recursive: true });
  writeFileSync(join(root, 'projects/Erste.md'), '# Erste\n\nVerweist auf [[Zweite]].');
  mgr = createIndexManager({ vaultPath: root, dbPath, logger: { info() {}, warn() {}, error() {} } });
});

after(() => {
  mgr?.stop();
  rmSync(root, { recursive: true, force: true });
});

test('applyChanges nimmt eine neue Notiz auf und löst Links anderer Notizen auf sie auf', () => {
  assert.deepEqual(mgr.outgoingLinks('projects/Erste.md'), []);
  writeFileSync(join(root, 'projects/Zweite.md'), '# Zweite\n\nNebelhorn.');
  mgr.applyChanges(['projects/Zweite.md']);
  assert.equal(mgr.search('Nebelhorn').total, 1);
  assert.deepEqual(mgr.backlinks('projects/Zweite.md').map((b) => b.path), ['projects/Erste.md']);
  assert.ok(mgr.lastChangedAt() > 0);
});

test('applyChanges entfernt eine gelöschte Notiz samt Linkziel', () => {
  unlinkSync(join(root, 'projects/Zweite.md'));
  mgr.applyChanges(['projects/Zweite.md']);
  assert.equal(mgr.search('Nebelhorn').total, 0);
  assert.deepEqual(mgr.outgoingLinks('projects/Erste.md'), []);
});

test('applyChanges übernimmt geänderten Inhalt', () => {
  writeFileSync(join(root, 'projects/Erste.md'), '# Erste\n\nJetzt mit Leuchtturm.');
  mgr.applyChanges(['projects/Erste.md', 'projects/Erste.md']);
  assert.equal(mgr.search('Leuchtturm').total, 1);
});

test('Watcher bündelt Notizänderungen und ignoriert versteckte Pfade und Anhänge', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vault-watch-'));
  mkdirSync(join(dir, 'notes'));
  mkdirSync(join(dir, '.obsidian'));
  const batches = [];
  const w = await startLiveWatcher(dir, batches, 100);
  try {
    // Ereignisse kommen in Schreibreihenfolge. Lösen die versteckten Dateien
    // oder der Anhang etwas aus, landet das im selben oder in einem früheren
    // Paket als die Notizen.
    writeFileSync(join(dir, '.obsidian/workspace.json'), '{}');
    writeFileSync(join(dir, '.obsidian/versteckt.md'), 'v');
    writeFileSync(join(dir, 'notes/bild.png'), 'x');
    writeFileSync(join(dir, 'notes/a.md'), 'a');
    writeFileSync(join(dir, 'notes/b.md'), 'b');
    const batch = await nextBatch(batches);
    assert.equal(batch.full, undefined, 'versteckte Dateien und Anhänge lösen keinen Komplettaufbau aus');
    assert.deepEqual(batch.paths.sort(), ['notes/a.md', 'notes/b.md']);
  } finally {
    w.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Watcher verlangt einen Komplettaufbau, wenn ein Ordner umbenannt wird', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vault-watch-'));
  mkdirSync(join(dir, 'alt'));
  writeFileSync(join(dir, 'alt/n.md'), 'n');
  const batches = [];
  const w = await startLiveWatcher(dir, batches, 100);
  try {
    renameSync(join(dir, 'alt'), join(dir, 'neu'));
    const batch = await nextBatch(batches);
    assert.equal(batch.full, true);
  } finally {
    w.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Watcher plant für versteckte Pfade und Anhänge kein Paket ein', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'vault-watch-'));
  mkdirSync(join(dir, 'notes'));
  writeFileSync(join(dir, 'notes/bild.png'), 'x');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const handlers = [];
  const fakeWatch = (_p, _o, cb) => {
    handlers.push(cb);
    return { close() {}, on() {} };
  };
  const batches = [];
  const w = createVaultWatcher({ vaultPath: dir, onBatch: (b) => batches.push(b), debounceMs: 100, watch: fakeWatch });
  try {
    handlers[0]('change', '.obsidian/workspace.json');
    handlers[0]('rename', '.trash/alt.md');
    handlers[0]('change', 'notes/bild.png');
    t.mock.timers.tick(10_000);
    assert.deepEqual(batches, []);

    handlers[0]('change', 'notes/a.md');
    t.mock.timers.tick(100);
    assert.deepEqual(batches, [{ paths: ['notes/a.md'] }]);
  } finally {
    w.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Watcher meldet sehr viele Änderungen als Komplettaufbau', async () => {
  const handlers = [];
  const fakeWatch = (_p, _o, cb) => {
    handlers.push(cb);
    return { close() {}, on() {} };
  };
  const batches = [];
  const w = createVaultWatcher({ vaultPath: '/nirgends', onBatch: (b) => batches.push(b), debounceMs: 20, maxBatch: 3, watch: fakeWatch });
  for (const n of ['a', 'b', 'c', 'd']) handlers[0]('change', `${n}.md`);
  const batch = await nextBatch(batches);
  assert.equal(batch.full, true);
  w.stop();
});

test('Statustracker leitet den Zustand aus der Client-Ausgabe ab', () => {
  let t = Date.parse('2026-10-13T10:00:00Z');
  const tracker = createStatusTracker({ clientVersion: '0.0.14', now: () => new Date(t) });
  assert.equal(tracker.snapshot().state, 'starting');

  tracker.onLine('Connecting...');
  assert.equal(tracker.snapshot().state, 'connecting');

  t += 1000;
  tracker.onLine('Uploading file error-log.md');
  assert.equal(tracker.snapshot().state, 'syncing', 'Dateiname mit "error" ist kein Fehler');
  assert.equal(tracker.snapshot().lastError, null);

  t += 1000;
  tracker.onLine('Fully synced');
  assert.equal(tracker.snapshot().state, 'synced');
  assert.equal(tracker.snapshot().lastSyncAt, '2026-10-13T10:00:02.000Z');

  tracker.onLine('Sync error: Verbindung verloren', { stderr: true });
  assert.equal(tracker.snapshot().state, 'error');
  assert.match(tracker.snapshot().lastError.message, /Verbindung verloren/);

  tracker.onLine('Disconnected from server');
  assert.equal(tracker.snapshot().state, 'disconnected');

  tracker.onExit(1, null);
  assert.equal(tracker.snapshot().state, 'stopped');
  assert.match(tracker.snapshot().lastError.message, /Code 1/);
});

test('Adapter liest den Status des Sidecars und erkennt einen verstummten Sidecar', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vault-status-'));
  const file = join(dir, 'sync.json');
  let t = Date.parse('2026-10-13T10:00:00Z');
  const adapter = createObsidianHeadlessAdapter({ vaultPath: dir, statusFile: file, now: () => t });
  try {
    assert.equal(adapter.status().state, 'unknown');

    const tracker = createStatusTracker({ clientVersion: '0.0.14', now: () => new Date(t) });
    tracker.onLine('Fully synced');
    writeStatusFile(file, tracker.snapshot());
    const s = adapter.status();
    assert.equal(s.state, 'synced');
    assert.equal(s.clientVersion, '0.0.14');
    assert.equal(s.lastSyncAt, '2026-10-13T10:00:00.000Z');

    t += 10 * 60_000;
    assert.equal(adapter.status().state, 'stale');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Adapter ohne Statusdatei meldet unbekannt, der Adapter "none" ist abgeschaltet', () => {
  assert.equal(createObsidianHeadlessAdapter({ vaultPath: '/x' }).status().state, 'unknown');
  const none = createSyncAdapter({ kind: 'none' });
  assert.equal(none.status().state, 'disabled');
  assert.throws(() => createSyncAdapter({ kind: 'dropbox' }), /Unbekannter Sync-Adapter/);
});
