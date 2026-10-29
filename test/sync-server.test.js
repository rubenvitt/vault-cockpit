import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, statSync, unlinkSync, symlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSyncJournal, checkSyncPath, SyncPathError } from '../src/sync/server/journal.js';
import { createSyncHttp } from '../src/sync/server/http.js';
import { createSyncAdapter, createSyncSwitch } from '../src/sync/index.js';
import { createSettingsStore, SettingsError } from '../src/cockpit/settings.js';
import { createTokenStore } from '../src/cockpit/tokens.js';

const quiet = { info() {}, warn() {}, error() {} };
const sha = (s) => createHash('sha256').update(s).digest('hex');

let vault, data, journal, tokens, server, base, written;
let mac, phone, searchToken;

before(async () => {
  vault = mkdtempSync(join(tmpdir(), 'sync-vault-'));
  data = mkdtempSync(join(tmpdir(), 'sync-data-'));
  mkdirSync(join(vault, 'projekte'), { recursive: true });
  mkdirSync(join(vault, '.obsidian'), { recursive: true });
  writeFileSync(join(vault, 'projekte/Alt.md'), '# Alt\n');
  writeFileSync(join(vault, '.obsidian/app.json'), '{}');
  journal = createSyncJournal({ vaultPath: vault, dbPath: join(data, 'sync.db'), blobDir: join(data, 'blobs'), logger: quiet });
  journal.scan();
  tokens = createTokenStore({});
  mac = tokens.create('r-mac', 'sync').token;
  phone = tokens.create('iPhone', 'sync').token;
  searchToken = tokens.create('Suche', 'search').token;
  written = [];
  const syncHttp = createSyncHttp({ tokens, journal, onWrite: (p) => written.push(p), logger: quiet });
  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (!syncHttp.matches(url.pathname)) return res.writeHead(404).end();
    syncHttp.handle(req, res, url);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server?.close();
  journal?.close();
  rmSync(vault, { recursive: true, force: true });
  rmSync(data, { recursive: true, force: true });
});

/** Kleiner Client wie ein Gerät ihn hätte. */
function client(token) {
  const call = (method, path, params = {}, body) =>
    fetch(`${base}${path}?${new URLSearchParams(params)}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'x-sync-client': 'test/1' },
      body,
    });
  return {
    call,
    async state() {
      return (await call('GET', '/sync/v1/state')).json();
    },
    async changes(since) {
      return (await call('GET', '/sync/v1/changes', { since })).json();
    },
    async get(path, hash) {
      const res = await call('GET', '/sync/v1/file', hash ? { path, hash } : { path });
      return { status: res.status, hash: res.headers.get('x-sync-hash'), text: res.status === 200 ? await res.text() : null };
    },
    async put(path, text, baseHash, extra = {}) {
      const res = await call('POST', '/sync/v1/file', { path, base: baseHash ?? '', ...extra }, text);
      return { status: res.status, body: await res.json() };
    },
    async del(path, baseHash) {
      const res = await call('POST', '/sync/v1/delete', { path, base: baseHash ?? '' });
      return { status: res.status, body: await res.json() };
    },
  };
}

test('checkSyncPath lehnt Ausbrüche, versteckte und kaputte Pfade ab', () => {
  for (const bad of ['', '/abs.md', '../x.md', 'a/../../x.md', 'a//b.md', '.obsidian/app.json', 'a/.trash/x.md', 'a\\b.md', 'a\u0000.md', './a.md']) {
    assert.throws(() => checkSyncPath(bad), SyncPathError, bad);
  }
  assert.equal(checkSyncPath('projekte/Neu Notiz (1).md'), 'projekte/Neu Notiz (1).md');
});

test('Scan erfasst sichtbare Dateien, keine versteckten', () => {
  const snap = journal.snapshot();
  assert.deepEqual(snap.files.map((f) => f.path), ['projekte/Alt.md']);
  assert.equal(snap.files[0].hash, sha('# Alt\n'));
  assert.ok(snap.cursor >= 1);
});

test('ohne passenden Token kein Zugriff', async () => {
  assert.equal((await fetch(`${base}/sync/v1/state`)).status, 401);
  assert.equal((await client(searchToken).call('GET', '/sync/v1/state')).status, 401);
  assert.equal((await client('vct_falsch').call('GET', '/sync/v1/state')).status, 401);
});

test('zwei Geräte gleichen sich ab, ein veralteter Stand überschreibt nichts', async () => {
  const a = client(mac);
  const b = client(phone);
  const start = (await b.state()).cursor;

  const created = await a.put('projekte/Neu.md', 'eins\n', null);
  assert.equal(created.status, 200);
  assert.equal(created.body.entry.hash, sha('eins\n'));
  assert.equal(readFileSync(join(vault, 'projekte/Neu.md'), 'utf8'), 'eins\n');
  assert.deepEqual(written, ['projekte/Neu.md']);

  // B sieht die neue Datei und holt sie.
  const feed = await b.changes(start);
  assert.deepEqual(feed.changes.map((c) => c.path), ['projekte/Neu.md']);
  const got = await b.get('projekte/Neu.md');
  assert.equal(got.text, 'eins\n');
  const h1 = got.hash;

  // A ändert, B ändert dieselbe Zeile auf alter Basis: Datei bleibt die von A,
  // die Fassung von B liegt als Konfliktkopie daneben.
  assert.equal((await a.put('projekte/Neu.md', 'zwei\n', h1)).status, 200);
  written.length = 0;
  const conflict = await b.put('projekte/Neu.md', 'drei\n', h1);
  assert.equal(conflict.status, 200);
  assert.equal(conflict.body.resolution, 'copy');
  assert.equal(conflict.body.entry.hash, sha('zwei\n'));
  assert.match(conflict.body.copy.path, /^projekte\/Neu \(Konflikt iPhone \d{4}-\d{2}-\d{2}\)\.md$/);
  assert.equal(readFileSync(join(vault, 'projekte/Neu.md'), 'utf8'), 'zwei\n');
  assert.equal(readFileSync(join(vault, conflict.body.copy.path), 'utf8'), 'drei\n');
  assert.deepEqual(written, [conflict.body.copy.path], 'nur die Kopie ist neu');

  // Die alte Basis bleibt als Blob abrufbar (für den Merge auf dem Gerät).
  assert.equal((await b.get('projekte/Neu.md', h1)).text, 'eins\n');

  // Mit neuer Basis geht es durch; derselbe Upload noch einmal ist kein Fehler.
  const resolved = await b.put('projekte/Neu.md', 'zwei\ndrei\n', sha('zwei\n'));
  assert.equal(resolved.status, 200);
  const again = await b.put('projekte/Neu.md', 'zwei\ndrei\n', sha('zwei\n'));
  assert.equal(again.status, 200);
  assert.equal(again.body.entry.seq, resolved.body.entry.seq);

  // Neu anlegen, wo schon etwas liegt, gibt ebenfalls eine Konfliktkopie (mit Zähler).
  const twice = await a.put('projekte/Neu.md', 'anders\n', null);
  assert.equal(twice.body.resolution, 'copy');
  assert.match(twice.body.copy.path, /^projekte\/Neu \(Konflikt r-mac \d{4}-\d{2}-\d{2}\)\.md$/);
  assert.equal(readFileSync(join(vault, 'projekte/Neu.md'), 'utf8'), 'zwei\ndrei\n');
});

test('Löschen braucht die aktuelle Basis und landet als Grabstein im Feed', async () => {
  const a = client(mac);
  const b = client(phone);
  await a.put('tmp/weg/Kurz.md', 'kurz\n', null);
  const since = journal.cursor();

  // Löschen gegen Ändern: Ändern gewinnt, die Datei bleibt.
  const kept = await b.del('tmp/weg/Kurz.md', sha('alt\n'));
  assert.equal(kept.status, 200);
  assert.equal(kept.body.resolution, 'kept');
  assert.equal(kept.body.entry.hash, sha('kurz\n'));
  assert.ok(existsSync(join(vault, 'tmp/weg/Kurz.md')));

  const gone = await b.del('tmp/weg/Kurz.md', sha('kurz\n'));
  assert.equal(gone.status, 200);
  assert.equal(gone.body.entry.hash, null);
  assert.ok(!existsSync(join(vault, 'tmp')), 'leere Ordner werden aufgeräumt');
  assert.equal((await b.del('tmp/weg/Kurz.md', sha('kurz\n'))).status, 200, 'schon weg ist kein Fehler');

  const feed = await a.changes(since);
  assert.deepEqual(feed.changes.map((c) => [c.path, c.hash]), [['tmp/weg/Kurz.md', null]]);
  assert.equal((await a.get('tmp/weg/Kurz.md')).status, 404);
});

test('was das Cockpit selbst schreibt, sehen Geräte, und es wird nicht überschrieben', async () => {
  const a = client(mac);
  const before = (await a.get('projekte/Alt.md')).hash;
  // Wie vault_edit: direkt auf der Platte, am Journal vorbei.
  writeFileSync(join(vault, 'projekte/Alt.md'), '# Alt\n\nvom Cockpit\n');
  const stale = await a.put('projekte/Alt.md', '# Alt\n\nvom Gerät\n', before);
  assert.equal(stale.body.resolution, 'copy');
  assert.equal(stale.body.entry.hash, sha('# Alt\n\nvom Cockpit\n'));
  assert.equal(readFileSync(join(vault, 'projekte/Alt.md'), 'utf8'), '# Alt\n\nvom Cockpit\n');
  unlinkSync(join(vault, stale.body.copy.path));
  journal.scan();

  const since = journal.cursor();
  writeFileSync(join(vault, 'projekte/Extern.md'), 'extern\n');
  unlinkSync(join(vault, 'projekte/Alt.md'));
  journal.scan();
  const feed = await a.changes(since);
  assert.deepEqual(feed.changes.map((c) => [c.path, c.hash]).sort(), [['projekte/Alt.md', null], ['projekte/Extern.md', sha('extern\n')]]);
});

test('Pfade außerhalb, versteckte Pfade und Groß-/Kleinschreibung werden abgewiesen', async () => {
  const a = client(mac);
  assert.equal((await a.put('../ausbruch.md', 'x', null)).status, 400);
  assert.equal((await a.put('.obsidian/workspace.json', '{}', null)).status, 400);
  assert.equal((await a.get('../../etc/passwd')).status, 400);
  assert.ok(!existsSync(join(vault, '..', 'ausbruch.md')));

  const clash = await a.put('projekte/neu.md', 'klein\n', null);
  assert.equal(clash.status, 409);
  assert.equal(clash.body.error, 'case');
  assert.equal(clash.body.current.path, 'projekte/Neu.md');
});

test('Anhänge gehen als Bytes durch und behalten die mtime des Geräts', async () => {
  const a = client(mac);
  const bytes = Buffer.from([0, 1, 2, 255, 254, 10, 13]);
  const mtime = Date.parse('2026-01-02T03:04:05Z');
  const res = await a.call('POST', '/sync/v1/file', { path: 'anhang/bild.png', base: '', mtime }, bytes);
  assert.equal(res.status, 200);
  assert.deepEqual(readFileSync(join(vault, 'anhang/bild.png')), bytes);
  assert.equal(Math.floor(statSync(join(vault, 'anhang/bild.png')).mtimeMs), mtime);
  const got = await a.call('GET', '/sync/v1/file', { path: 'anhang/bild.png' });
  assert.deepEqual(Buffer.from(await got.arrayBuffer()), bytes);
  assert.equal(got.headers.get('x-sync-mtime'), String(mtime));
});

test('changes blättert mit more und cursor', async () => {
  const a = client(mac);
  const page = await (await a.call('GET', '/sync/v1/changes', { since: 0, limit: 2 })).json();
  assert.equal(page.changes.length, 2);
  assert.equal(page.more, true);
  const rest = await a.changes(page.cursor);
  assert.ok(rest.changes.every((c) => c.seq > page.cursor));
  assert.equal(rest.more, false);
  assert.equal(rest.cursor, journal.cursor());
  assert.equal((await a.call('GET', '/sync/v1/changes', { since: -1 })).status, 400);
});

test('Geräte erscheinen mit Name, Client und Zeitpunkten', () => {
  const devices = journal.devices();
  assert.deepEqual(devices.map((d) => d.name).sort(), ['iPhone', 'r-mac']);
  const m = devices.find((d) => d.name === 'r-mac');
  assert.equal(m.client, 'test/1');
  assert.ok(m.pullAt && m.pushAt && m.seenAt);
});

test('ein widerrufener Token kommt sofort nicht mehr durch', async () => {
  const t = tokens.create('Altgerät', 'sync');
  const c = client(t.token);
  assert.equal((await c.call('GET', '/sync/v1/state')).status, 200);
  tokens.revoke(t.id);
  assert.equal((await c.call('GET', '/sync/v1/state')).status, 401);
});

test('Journal überlebt einen Neustart samt Zähler', () => {
  const cursor = journal.cursor();
  const j2 = createSyncJournal({ vaultPath: vault, dbPath: join(data, 'sync.db'), blobDir: join(data, 'blobs'), logger: quiet });
  assert.equal(j2.cursor(), cursor);
  assert.deepEqual(j2.scan(), []);
  j2.close();
});

test('Adapter „cockpit“ liefert Journal und Zustand mit Geräten', () => {
  const d = mkdtempSync(join(tmpdir(), 'sync-adapter-'));
  const adapter = createSyncAdapter({ kind: 'cockpit', vaultPath: vault, dataDir: d, logger: quiet, watch: () => ({ close() {}, on() {} }) });
  assert.equal(adapter.name, 'cockpit');
  const seen = [];
  adapter.start({ onChanges: (b) => seen.push(b) });
  adapter.journal.scan();
  adapter.journal.seen({ id: 'x', name: 'Laptop' }, { pulled: true });
  const s = adapter.status();
  assert.equal(s.adapter, 'cockpit');
  assert.equal(s.state, 'synced');
  assert.equal(s.devices[0].name, 'Laptop');
  assert.ok(s.lastSyncAt);
  adapter.notifyWrite('a/b.md');
  adapter.notifyWrite('a/b.png');
  assert.deepEqual(seen, [{ paths: ['a/b.md'] }]);
  adapter.stop();
  rmSync(d, { recursive: true, force: true });
});

test('Journal: Datei über der Grenze wird übersprungen, nicht abgebrochen', () => {
  const v = mkdtempSync(join(tmpdir(), 'sync-big-'));
  const d = mkdtempSync(join(tmpdir(), 'sync-big-data-'));
  writeFileSync(join(v, 'gross.bin'), Buffer.alloc(2048));
  writeFileSync(join(v, 'klein.md'), 'x');
  const j = createSyncJournal({ vaultPath: v, dbPath: join(d, 'sync.db'), blobDir: join(d, 'blobs'), maxFileBytes: 1024, logger: quiet });
  assert.deepEqual(j.scan(), ['klein.md']);
  assert.deepEqual(j.put('gross2.bin', Buffer.alloc(2048), {}), { ok: false, reason: 'too_large' });
  j.close();
  rmSync(v, { recursive: true, force: true });
  rmSync(d, { recursive: true, force: true });
});

test('Sync umschaltbar: Wechsel stoppt den alten Adapter und startet den neuen mit denselben Empfängern', () => {
  const d = mkdtempSync(join(tmpdir(), 'sync-switch-'));
  const watch = () => ({ close() {}, on() {} });
  const sw = createSyncSwitch({ kind: 'none', vaultPath: vault, dataDir: d, logger: quiet, watch });
  const seen = [];
  sw.start({ onChanges: (b) => seen.push(b) });
  assert.equal(sw.name, 'none');
  assert.equal(sw.journal, null);
  assert.equal(sw.switchTo('none'), false);

  assert.equal(sw.switchTo('cockpit'), true);
  assert.equal(sw.name, 'cockpit');
  assert.ok(sw.journal);
  sw.notifyWrite('x.md');
  assert.deepEqual(seen, [{ paths: ['x.md'] }], 'der neue Adapter meldet an dieselben Empfänger');

  assert.throws(() => sw.switchTo('gibtsnicht'), /Unbekannter Sync-Adapter/);
  assert.equal(sw.name, 'cockpit', 'ein fehlgeschlagener Wechsel lässt den alten laufen');
  sw.switchTo('none');
  assert.equal(sw.journal, null);
  sw.stop();
  rmSync(d, { recursive: true, force: true });
});

test('ohne eingeschalteten eigenen Sync antwortet /sync/v1 mit 503, ohne Token weiter mit 401', async () => {
  const off = createSyncHttp({ tokens, journal: () => null, logger: quiet });
  const srv = http.createServer((req, res) => off.handle(req, res, new URL(req.url, 'http://localhost')));
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const at = `http://127.0.0.1:${srv.address().port}/sync/v1/state`;
  assert.equal((await fetch(at)).status, 401);
  const res = await fetch(at, { headers: { authorization: `Bearer ${mac}` } });
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error, 'sync_off');
  srv.close();
});

test('Einstellungen: Sync-Wahl wird geprüft, Standard kommt aus der Umgebung', () => {
  const store = createSettingsStore({ defaults: { syncAdapter: 'none' } });
  assert.equal(store.get().sync.adapter, 'none');
  store.save({ ...store.stored(), sync: { adapter: 'cockpit' } });
  assert.equal(store.get().sync.adapter, 'cockpit');
  assert.throws(() => store.save({ ...store.stored(), sync: { adapter: 'dropbox' } }), (err) => err instanceof SettingsError && err.field === 'sync.adapter');
  assert.equal(createSettingsStore({}).get().sync.adapter, 'obsidian-headless');
});

test('ein Symlink im Vault führt nicht hinaus, weder lesend noch schreibend', async () => {
  const outside = mkdtempSync(join(tmpdir(), 'sync-aussen-'));
  writeFileSync(join(outside, 'geheim.md'), 'geheim\n');
  symlinkSync(outside, join(vault, 'link'));
  const a = client(mac);
  assert.equal((await a.get('link/geheim.md')).status, 400);
  assert.equal((await a.put('link/neu.md', 'x', null)).status, 400);
  assert.equal((await a.put('link/tief/neu.md', 'x', null)).status, 400);
  assert.ok(!existsSync(join(outside, 'neu.md')));
  assert.ok(!existsSync(join(outside, 'tief')));
  unlinkSync(join(vault, 'link'));
  rmSync(outside, { recursive: true, force: true });
});

test('eine Datei über der Grenze auf der Platte wird weder überschrieben noch gelöscht', () => {
  const v = mkdtempSync(join(tmpdir(), 'sync-gross-'));
  const d = mkdtempSync(join(tmpdir(), 'sync-gross-data-'));
  writeFileSync(join(v, 'video.bin'), Buffer.alloc(2048, 1));
  const j = createSyncJournal({ vaultPath: v, dbPath: join(d, 'sync.db'), blobDir: join(d, 'blobs'), maxFileBytes: 1024, logger: quiet });
  j.scan();
  assert.deepEqual(j.put('video.bin', Buffer.from('klein'), { base: null }), { ok: false, reason: 'too_large' });
  assert.equal(readFileSync(join(v, 'video.bin')).length, 2048);
  writeFileSync(join(v, 'wächst.bin'), 'a');
  j.scan();
  const old = sha('a');
  writeFileSync(join(v, 'wächst.bin'), Buffer.alloc(2048, 2));
  assert.deepEqual(j.remove('wächst.bin', { base: old }), { ok: false, reason: 'too_large' });
  assert.ok(existsSync(join(v, 'wächst.bin')));
  j.close();
  rmSync(v, { recursive: true, force: true });
  rmSync(d, { recursive: true, force: true });
});

test('ein Symlink auf einen versteckten Ordner im Vault liefert nichts aus', async () => {
  mkdirSync(join(vault, '.privat'), { recursive: true });
  writeFileSync(join(vault, '.privat/geheim.txt'), 'geheim\n');
  symlinkSync(join(vault, '.privat'), join(vault, 'alias'));
  const a = client(mac);
  const got = await a.get('alias/geheim.txt');
  assert.equal(got.status, 400);
  assert.equal(got.text, null);
  assert.equal((await a.put('alias/neu.txt', 'x', null)).status, 400);
  assert.ok(!existsSync(join(vault, '.privat/neu.txt')));
  unlinkSync(join(vault, 'alias'));
  rmSync(join(vault, '.privat'), { recursive: true, force: true });
});

test('veraltete Basis: getrennte Änderungen werden zusammengeführt, gelöschte Dateien kommen zurück', async () => {
  const a = client(mac);
  const b = client(phone);
  const base = '# Plan\n\nMontag\n\nDienstag\n';
  const h0 = (await a.put('merge/Plan.md', base, null)).body.entry.hash;
  assert.equal((await a.put('merge/Plan.md', '# Plan\n\nMontag: Hund\n\nDienstag\n', h0)).status, 200);
  written.length = 0;
  const merged = await b.put('merge/Plan.md', '# Plan\n\nMontag\n\nDienstag: Sport\n', h0);
  assert.equal(merged.status, 200);
  assert.equal(merged.body.resolution, 'merged');
  const result = '# Plan\n\nMontag: Hund\n\nDienstag: Sport\n';
  assert.equal(readFileSync(join(vault, 'merge/Plan.md'), 'utf8'), result);
  assert.equal(merged.body.entry.hash, sha(result), 'das Gerät sieht am Hash, dass es neu holen muss');
  assert.deepEqual(written, ['merge/Plan.md']);

  // Auf dem Server gelöscht, auf dem Gerät geändert: Ändern gewinnt.
  const h1 = merged.body.entry.hash;
  assert.equal((await a.del('merge/Plan.md', h1)).status, 200);
  const back = await b.put('merge/Plan.md', `${result}\nMittwoch\n`, h1);
  assert.equal(back.body.resolution, 'restored');
  assert.equal(readFileSync(join(vault, 'merge/Plan.md'), 'utf8'), `${result}\nMittwoch\n`);

  // Anhänge werden nie gemergt: Konfliktkopie.
  const p0 = (await a.call('POST', '/sync/v1/file', { path: 'merge/bild.png', base: '' }, Buffer.from([1, 2]))).status;
  assert.equal(p0, 200);
  await a.call('POST', '/sync/v1/file', { path: 'merge/bild.png', base: sha(Buffer.from([1, 2])) }, Buffer.from([1, 3]));
  const res = await b.call('POST', '/sync/v1/file', { path: 'merge/bild.png', base: sha(Buffer.from([1, 2])) }, Buffer.from([4, 2]));
  const body = await res.json();
  assert.equal(body.resolution, 'copy');
  assert.match(body.copy.path, /^merge\/bild \(Konflikt iPhone .*\)\.png$/);
  assert.deepEqual(readFileSync(join(vault, 'merge/bild.png')), Buffer.from([1, 3]));
  assert.deepEqual(readFileSync(join(vault, body.copy.path)), Buffer.from([4, 2]));
  rmSync(join(vault, 'merge'), { recursive: true, force: true });
  journal.scan();
});
