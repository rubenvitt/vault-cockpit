import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, readdirSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCapture } from '../src/vault/capture.js';
import { createCaptureRouter, cleanTitle } from '../src/capture/router.js';
import { createStateStore } from '../src/capture/state.js';
import { createZunderClient } from '../src/capture/zunder.js';
import { createCaptureHttp } from '../src/capture/http.js';
import { createTokenStore } from '../src/cockpit/tokens.js';
import { createApp } from '../src/http/app.js';

const quiet = { info() {}, warn() {}, error() {} };
let root, capture, state, zunderCalls, router;

/** Zunder-Attrappe: merkt sich Aufrufe, vergibt fortlaufende IDs. */
function fakeZunder({ fail = false } = {}) {
  zunderCalls = [];
  return {
    async createTask(args) {
      zunderCalls.push(args);
      if (fail) throw new Error('Zunder antwortet mit HTTP 503');
      const id = `t${zunderCalls.length}`;
      return { id, ref: null, url: `https://zunder.test/#/aufgabe/${id}` };
    },
  };
}

const inbox = () => readdirSync(join(root, 'inbox'));
const readInbox = (name) => readFileSync(join(root, 'inbox', name), 'utf8');

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'vault-capture-'));
  capture = createCapture({ vaultPath: root, folder: 'inbox', now: () => new Date(2026, 9, 13, 14, 30) });
  state = createStateStore(join(root, '.state', 'capture.json'));
  router = createCaptureRouter({ capture, zunder: fakeZunder(), state, logger: quiet });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

test('capture.write trägt Quelle und Capture-ID ins Frontmatter', () => {
  const r = capture.write({ title: 'Idee', text: 'Inhalt', source: 'sprachmemo', captureId: 'abc-1' });
  const text = readFileSync(r.absolute, 'utf8');
  assert.match(text, /\nsource: sprachmemo\n/);
  assert.match(text, /\ncapture_id: abc-1\n/);
});

test('capture.write legt dieselbe Capture-ID nur einmal an', () => {
  const a = capture.write({ title: 'Idee', text: 'eins', captureId: 'x' });
  const b = capture.write({ title: 'Anders', text: 'zwei', captureId: 'x' });
  assert.equal(b.duplicate, true);
  assert.equal(b.path, a.path);
  assert.equal(inbox().length, 1);
});

test('capture.write lehnt ungültige Quellen und IDs ab', () => {
  assert.throws(() => capture.write({ title: 'a', text: 'b', source: 'Böse\nQuelle' }), /Quelle/);
  assert.throws(() => capture.write({ title: 'a', text: 'b', captureId: 'a\nb' }), /Capture-ID/);
});

test('capture.write übernimmt den Zeitpunkt der Erfassung', () => {
  const r = capture.write({ title: 'Alt', text: 'x', created: new Date(2026, 0, 2, 8, 5) });
  assert.match(r.path, /^inbox\/2026-01-02 0805 - Alt\.md$/);
});

test('Titel: ohne Pfadtrenner und gekürzt', () => {
  assert.equal(cleanTitle('# Einkauf / Liste'), '# Einkauf - Liste');
  assert.equal(cleanTitle('a..b'), 'a.b');
  assert.ok(cleanTitle('x'.repeat(200)).length <= 80);
});

test('Text ohne ! wird eine Notiz im Capture-Ordner', async () => {
  const r = await router.route({ text: 'Gedanke zum Wochenende\nmehr Text', source: 'ios-kurzbefehl' });
  assert.equal(r.kind, 'note');
  assert.equal(r.path, 'inbox/2026-10-13 1430 - iOS-Kurzbefehl.md');
  assert.match(readInbox(inbox()[0]), /source: ios-kurzbefehl/);
  assert.equal(zunderCalls.length, 0);
});

test('Notiz ohne Titel: Text steht im Inhalt, nicht in Dateiname oder Titel', async () => {
  const r = await router.route({ text: 'Ein langer Gedanke, der kein Titel ist\nmit zweiter Zeile', source: 'cockpit' });
  assert.equal(r.path, 'inbox/2026-10-13 1430 - Web-Cockpit.md');
  const note = readInbox(inbox()[0]);
  assert.match(note, /^title: Web-Cockpit, 13\.10\.2026 14:30$/m);
  assert.doesNotMatch(note.split('\n---\n')[0], /langer Gedanke/);
  assert.match(note, /---\nEin langer Gedanke, der kein Titel ist\nmit zweiter Zeile\n$/);
});

test('Notizen ohne Titel in derselben Minute bekommen eigene Dateien', async () => {
  await router.route({ text: 'eins', source: 'sprachmemo' });
  const b = await router.route({ text: 'zwei', source: 'sprachmemo' });
  assert.equal(b.path, 'inbox/2026-10-13 1430 - Sprachmemo (2).md');
});

test('ein ausdrücklicher Titel bleibt Dateiname und Titel', async () => {
  const r = await router.route({ text: 'Inhalt', title: 'Einkauf / Liste', source: 'api' });
  assert.equal(r.path, 'inbox/2026-10-13 1430 - Einkauf - Liste.md');
  assert.match(readInbox(inbox()[0]), /^title: Einkauf - Liste$/m);
});

test('Text mit ! wird eine Aufgabe in der Zunder-Inbox', async () => {
  const r = await router.route({ text: '! Reifen wechseln\nTermin bei der Werkstatt', source: 'sprachmemo' });
  assert.equal(r.kind, 'task');
  assert.equal(r.url, 'https://zunder.test/#/aufgabe/t1');
  assert.equal(zunderCalls[0].title, 'Reifen wechseln');
  assert.match(zunderCalls[0].description, /^Termin bei der Werkstatt\n\n_Erfasst über Sprachmemo/);
  assert.deepEqual(readdirSync(root).filter((n) => n === 'inbox'), [], 'keine Notiz angelegt');
});

test('dieselbe Capture-ID erzeugt keine zweite Zunder-Aufgabe', async () => {
  await router.route({ text: '!Einmal', source: 'mail', captureId: 'm1' });
  const again = await router.route({ text: '!Einmal', source: 'mail', captureId: 'm1' });
  assert.equal(again.duplicate, true);
  assert.equal(zunderCalls.length, 1);
});

test('dieselbe Capture-ID legt keine zweite Notiz an, auch nach dem Ablegen (VCP-56)', async () => {
  const first = await router.route({ text: 'Gedanke', source: 'cockpit', captureId: 'c1' });
  // Abgelegt: die Notiz liegt nicht mehr im Capture-Ordner.
  renameSync(join(root, first.path), join(root, 'abgelegt.md'));
  const again = await router.route({ text: 'Gedanke', source: 'cockpit', captureId: 'c1' });
  assert.equal(again.duplicate, true);
  assert.equal(again.path, first.path);
  assert.deepEqual(inbox(), []);
  // Auch nach einem Neustart, der Merkzettel liegt in einer Datei.
  const restarted = createCaptureRouter({ capture, zunder: fakeZunder(), state: createStateStore(join(root, '.state', 'capture.json')), logger: quiet });
  assert.equal((await restarted.route({ text: 'Gedanke', source: 'cockpit', captureId: 'c1' })).duplicate, true);
  assert.deepEqual(inbox(), []);
});

test('! ohne eingerichtetes Zunder ist ein Fehler, keine stille Notiz', async () => {
  const r = createCaptureRouter({ capture, zunder: null, state, logger: quiet });
  await assert.rejects(r.route({ text: '!Aufgabe', source: 'api' }), (err) => err.status === 503);
});

test('Zunder-Zugang wird je Aufgabe neu gefragt (Einstellungen ohne Neustart)', async () => {
  let current = null;
  const r = createCaptureRouter({ capture, zunder: () => current, state, logger: quiet });
  await assert.rejects(r.route({ text: '!Erst ohne Zugang', source: 'api' }), (err) => err.status === 503);

  current = fakeZunder();
  const first = await r.route({ text: '!Mit altem Token', source: 'api' });
  assert.equal(first.kind, 'task');
  const old = zunderCalls;

  current = fakeZunder();
  await r.route({ text: '!Mit neuem Token', source: 'api' });
  assert.equal(old.length, 1, 'der alte Client bekommt nichts mehr');
  assert.equal(zunderCalls[0].title, 'Mit neuem Token');
});

test('! ohne Text wird abgelehnt', async () => {
  await assert.rejects(router.route({ text: '!   ', source: 'api' }), /fehlt/);
});

test('Funke-Notizen werten ! nicht aus', async () => {
  const r = await router.route({ text: '!wichtig', title: 'Notiz', source: 'funke', allowTask: false });
  assert.equal(r.kind, 'note');
});

test('Zustand überlebt einen Neustart', () => {
  state.set('k', { id: 'x' });
  assert.deepEqual(createStateStore(join(root, '.state', 'capture.json')).get('k'), { id: 'x' });
});

test('Merkzettel aus einer Sicherung gilt sofort, der alte Stand im Speicher überschreibt ihn nicht (VCP-59)', () => {
  const file = join(root, '.state', 'capture.json');
  state.set('alt', 1);
  const backup = createStateStore(null);
  backup.set('gesichert', { id: 'x' });
  state.replaceWith(backup.snapshot());
  // Ein Durchgang der Brücke nach dem Wiederherstellen schreibt auf dem neuen Stand weiter.
  state.set('neu', 2);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { gesichert: { id: 'x' }, neu: 2 });
  assert.equal(state.get('alt'), null);
  assert.throws(() => state.replaceWith(Buffer.from('[]')), /kein JSON-Objekt/);
});

test('Zunder-Client ruft create_task über MCP auf', async () => {
  let seen;
  const client = createZunderClient({
    url: 'https://zunder.test/',
    token: 'zt_geheim',
    fetch: async (url, init) => {
      seen = { url, init, body: JSON.parse(init.body) };
      return Response.json({ jsonrpc: '2.0', id: 1, result: { structuredContent: { task: { id: 'abc', ref: null } } } });
    },
  });
  const task = await client.createTask({ title: 'Test', description: 'D', vaultLinks: ['a.md'] });
  assert.equal(seen.url, 'https://zunder.test/mcp');
  assert.equal(seen.init.headers.authorization, 'Bearer zt_geheim');
  assert.equal(seen.body.method, 'tools/call');
  assert.deepEqual(seen.body.params, {
    name: 'create_task',
    arguments: { title: 'Test', description: 'D', vault_links: ['a.md'] },
  });
  assert.deepEqual(task, { id: 'abc', ref: null, url: 'https://zunder.test/#/aufgabe/abc' });
});

test('Zunder-Client meldet Ablehnungen mit der Begründung', async () => {
  const client = createZunderClient({
    url: 'https://zunder.test',
    token: 't',
    fetch: async () =>
      Response.json({ jsonrpc: '2.0', id: 1, result: { isError: true, structuredContent: { error: { code: 'invalid_value', message: 'Titel zu lang' } } } }),
  });
  await assert.rejects(client.createTask({ title: 'x' }), /Titel zu lang/);
  const down = createZunderClient({ url: 'https://zunder.test', token: 't', fetch: async () => new Response('', { status: 502 }) });
  await assert.rejects(down.createTask({ title: 'x' }), /HTTP 502/);
});

// --- HTTP ---

async function withServer(run, { zunder = fakeZunder(), zunderEnabled = true, token = 'capture-geheim', tokens = null } = {}) {
  const r = createCaptureRouter({ capture, zunder, state, logger: quiet });
  const app = createApp({
    config: { publicUrl: 'https://vault.test', resource: 'https://vault.test/mcp', issuer: 'https://id.test', supportedScopes: [], allowedHosts: ['vault.test'], trustProxy: true },
    verifyToken: async () => {
      throw new Error('nicht benutzt');
    },
    mcpHandler: async () => {},
    captureHttp: createCaptureHttp({ token, tokens, router: r, zunderEnabled }),
    logger: quiet,
  });
  app.listen(0, '127.0.0.1');
  await new Promise((res) => app.once('listening', res));
  const base = `http://127.0.0.1:${app.address().port}`;
  const call = (path, { method = 'POST', body, type = 'application/json', auth = 'Bearer capture-geheim' } = {}) =>
    fetch(base + path, {
      method,
      headers: { 'x-forwarded-host': 'vault.test', 'content-type': type, ...(auth ? { authorization: auth } : {}) },
      body,
    });
  try {
    await run(call);
  } finally {
    app.close();
  }
}

test('/capture verlangt den Capture-Token', async () => {
  await withServer(async (call) => {
    assert.equal((await call('/capture', { body: 'x', type: 'text/plain', auth: null })).status, 401);
    const denied = await call('/capture', { body: 'x', type: 'text/plain', auth: 'Bearer falsch' });
    assert.equal(denied.status, 401);
    const deniedBody = await denied.json();
    assert.equal(deniedBody.status, 401, 'Status auch im Body für den Kurzbefehl');
    assert.match(deniedBody.message, /Token abgelehnt/);
    assert.equal((await call('/capture', { method: 'GET' })).status, 200);
  });
});

test('/capture nimmt API-Tokens mit dem Recht Capture an, auch ohne CAPTURE_TOKEN', async () => {
  const tokens = createTokenStore({ logger: quiet });
  const cap = tokens.create('iPhone', 'capture');
  const search = tokens.create('Raycast', 'search');
  await withServer(
    async (call) => {
      assert.equal((await call('/capture', { method: 'GET', auth: `Bearer ${cap.token}` })).status, 200);
      assert.equal((await call('/funke/health', { method: 'GET', auth: `Bearer ${cap.token}` })).status, 200);
      assert.equal((await call('/capture', { method: 'GET', auth: `Bearer ${search.token}` })).status, 401, 'Such-Token darf nicht anlegen');
      assert.equal((await call('/capture', { method: 'GET' })).status, 401, 'ohne CAPTURE_TOKEN gilt der alte Token nicht');
      tokens.revoke(cap.id);
      assert.equal((await call('/capture', { method: 'GET', auth: `Bearer ${cap.token}` })).status, 401);
    },
    { token: null, tokens },
  );
  // Übergang: CAPTURE_TOKEN und angelegte Tokens gelten nebeneinander.
  const next = tokens.create('iPad', 'capture');
  await withServer(
    async (call) => {
      assert.equal((await call('/capture', { method: 'GET' })).status, 200);
      assert.equal((await call('/capture', { method: 'GET', auth: `Bearer ${next.token}` })).status, 200);
    },
    { tokens },
  );
});

test('/capture meldet den aktuellen Zunder-Stand', async () => {
  let on = false;
  await withServer(
    async (call) => {
      assert.equal((await (await call('/capture', { method: 'GET' })).json()).zunder, false);
      on = true;
      assert.equal((await (await call('/capture', { method: 'GET' })).json()).zunder, true);
    },
    { zunderEnabled: () => on },
  );
});

test('/capture nimmt Klartext vom Kurzbefehl an', async () => {
  await withServer(async (call) => {
    const res = await call('/capture?source=sprachmemo', { body: 'Diktierter Gedanke', type: 'text/plain' });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.kind, 'note');
    assert.equal(body.message, `Notiz angelegt: ${body.path}`);
    assert.match(readInbox(inbox()[0]), /source: sprachmemo/);
  });
});

test('/capture leitet ! als JSON an Zunder weiter', async () => {
  await withServer(async (call) => {
    const res = await call('/capture', { body: JSON.stringify({ text: '!Paket abholen', source: 'ios-kurzbefehl', id: 'k1' }) });
    assert.equal(res.status, 201);
    assert.equal((await res.json()).kind, 'task');
    const again = await call('/capture', { body: JSON.stringify({ text: '!Paket abholen', source: 'ios-kurzbefehl', id: 'k1' }) });
    assert.equal(again.status, 200);
    assert.equal(zunderCalls.length, 1);
  });
});

test('/capture meldet Fehler verständlich', async () => {
  await withServer(async (call) => {
    assert.equal((await call('/capture', { body: '{kaputt' })).status, 400);
    assert.equal((await call('/capture', { body: JSON.stringify({ text: 'x', source: 'mail' }) })).status, 400);
    assert.equal((await call('/capture', { body: '   ', type: 'text/plain' })).status, 400);
  });
  await withServer(
    async (call) => {
      const res = await call('/capture', { body: '!Aufgabe', type: 'text/plain' });
      assert.equal(res.status, 502);
      const body = await res.json();
      assert.match(body.error, /503/);
      assert.equal(body.status, 502);
      assert.match(body.message, /^Zunder lehnt ab: /);
    },
    { zunder: fakeZunder({ fail: true }) },
  );
});

test('/funke spricht das Protokoll des Funke-Relays, idempotent', async () => {
  await withServer(async (call) => {
    assert.equal((await call('/funke/health', { method: 'GET' })).status, 200);
    const note = JSON.stringify({ folder: '../../etc', filename: '2026-10-13 0912 Idee aus Funke', content: 'Text', createdAt: '2026-10-13T07:12:00Z' });
    const first = await call('/funke/notes', { body: note });
    assert.equal(first.status, 201);
    const { path } = await first.json();
    assert.match(path, /^inbox\/2026-10-13 \d{4} - Idee aus Funke\.md$/, 'Ordner aus der App wird ignoriert');
    assert.equal((await call('/funke/notes', { body: note })).status, 200);
    assert.equal(inbox().length, 1);
    assert.match(readInbox(inbox()[0]), /source: funke/);
  });
});
