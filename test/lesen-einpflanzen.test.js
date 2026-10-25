import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, statSync, existsSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildIndex, openIndex } from '../src/vault/index.js';
import { compilePolicy } from '../src/vault/policy.js';
import { createEditor } from '../src/vault/edit.js';
import { createSettingsStore } from '../src/cockpit/settings.js';
import { createReadingStore } from '../src/lesen/store.js';
import { createReadingExport } from '../src/lesen/vault-export.js';
import { createIngest } from '../src/lesen/ingest.js';
import { createPlanter, guardEditor, inputFor, PlantError } from '../src/lesen/einpflanzen.js';
import { createVaultMcpHandler } from '../src/mcp/server.js';
import { hybridSearch } from '../src/semantic/search.js';
import { parseNote } from '../src/vault/markdown.js';
import { ingestRoutes, appliedMessage } from '../src/lesen/ingest-page.js';
import { createClaudeWriter } from '../src/lesen/claude.js';

const quiet = { info() {}, warn() {}, error() {} };
const NOW = new Date('2026-10-25T10:00:00Z');
const HTML = `<p>${'Backpressure hält den elastischen Loop nützlich, sagt Robert Glaser. '.repeat(40)}</p>`;
let root, idx, editor, settings, store, policy, exporter, doc, ingest, planter, agentRun, agentCalls;

const read = (p) => readFileSync(join(root, p), 'utf8');
const fm = (p) => parseNote(read(p)).frontmatter;
const put = (p, text) => {
  mkdirSync(join(root, p, '..'), { recursive: true });
  writeFileSync(join(root, p), text);
};

const DRAFT = {
  digest: {
    kernaussagen: ['Backpressure macht lange Loops möglich.'],
    neu: ['Der Loop als Gang.'],
    bestaetigt: [],
    widerspricht: [{ path: 'wiki/concepts/backpressure.md', claim: 'nur technisch', vorschlag: 'beide Schichten' }],
    dockt_an: [{ path: 'wiki/concepts/backpressure.md', warum: 'Kernbegriff' }],
  },
  source: { slug: 'glaser-loop', title: 'Der elastische Loop', summary: 'Loops und Backpressure', confidence: 'medium', tags: ['agents'], body: 'Glaser verbindet [[backpressure]] mit Loops.' },
  neu: [],
  ergaenzungen: [],
  relationen: [],
  hinweise: [],
};

/** MCP über HTTP, wie die CLI es täte. */
async function mcpCall(mcp, name, args) {
  const res = await fetch(mcp.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${mcp.token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  const text = await res.text();
  const line = text.split('\n').find((l) => l.startsWith('data: '));
  return { status: res.status, body: JSON.parse(line ? line.slice(6) : text).result };
}

const claude = {
  available: () => true,
  async write() {
    return structuredClone(DRAFT);
  },
  async agent(job) {
    agentCalls.push(job);
    return agentRun(job);
  },
};

function reindex() {
  idx?.close();
  buildIndex({ vaultPath: root, dbPath: ':memory:', policy, logger: quiet, persist: (db, vp) => (idx = openIndex(db, { vaultPath: vp, policy })) });
  editor = createEditor({ vaultPath: root, index: idx });
  exporter = createReadingExport({ vaultPath: root, index: idx, editor, policy, store, settings, now: () => NOW, delayMs: 60_000, logger: quiet });
}

function services() {
  ingest = createIngest({
    store,
    writer: claude,
    search: (query, o) => hybridSearch({ index: idx, semantic: null, query, ...o }),
    index: idx,
    exporter,
    editor,
    policy,
    settings,
    vaultPath: root,
    onApplied: (id) => planter.request(id, { auto: true }),
    logger: quiet,
    now: () => NOW,
    resumeDelayMs: 0,
  });
  planter = createPlanter({
    store,
    claude,
    mcp: ({ editor: guarded, verifyToken }) => createVaultMcpHandler({ index: idx, capture: null, editor: guarded, policy, verifyToken, allowSensitive: false }),
    editor,
    index: idx,
    settings,
    log: (entry) => ingest.log(entry),
    logger: quiet,
    now: () => NOW,
    resumeDelayMs: 0,
  });
}

async function applied() {
  ingest.request([doc.id]);
  await ingest.idle();
  return ingest.apply(doc.id, { items: ['v1'] });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'einpflanzen-vault-'));
  put('wiki/concepts/backpressure.md', "---\ntype: concept\ntitle: Backpressure\nsummary: Widerstand für Agent-Output\nupdated: '2026-06-23'\nrelations:\n  - \"uses [[loops]]\"\nstatus: active\n---\n\n# Backpressure\n\nBackpressure ist Widerstand für Agenten im Loop.\n\n## Quellen\n\n- [[alt]]\n");
  put('wiki/concepts/loops.md', '---\ntype: concept\ntitle: Loops\n---\n\n# Loops\n\nLoops.\n');
  put('wiki/privat/geheim.md', '---\ntype: concept\ntitle: Geheim\n---\n\n# Geheim\n\nBackpressure geheim.\n');
  put('wiki/log.md', '# Log\n');
  put('inbox/Start.md', '# Start\n');
  policy = compilePolicy({ exclude: ['^wiki/log\\.md$'], sensitive: { 'wiki/privat': 'privat' } });
  settings = createSettingsStore({ defaults: { tz: 'Europe/Berlin' }, logger: quiet });
  store = createReadingStore({ path: ':memory:', now: () => NOW.getTime() });
  ({ doc } = store.addDocument({ url: 'https://glaser.test/loop', title: 'The Elastic Loop', site: 'Glaser', status: 'stapel', content_html: HTML }));
  agentCalls = [];
  agentRun = async () => ({ zusammenfassung: 'Nichts zu tun.', eingepflanzt: [], offen: [] });
  idx = null;
  reindex();
  services();
});
afterEach(() => {
  exporter.stop();
  idx.close();
  store.close();
  rmSync(root, { recursive: true, force: true });
});

test('Einpflanzen: nach dem Übernehmen arbeitet der Agent über MCP ein; updated, Log und Stand folgen', async () => {
  const seen = {};
  agentRun = async (job) => {
    const { mcp } = job;
    // Lesen geht, vertraulich nicht, auch wenn verlangt.
    seen.read = (await mcpCall(mcp, 'vault_read', { path: 'wiki/concepts/backpressure.md' })).body.structuredContent.path;
    seen.secret = (await mcpCall(mcp, 'vault_read', { path: 'wiki/privat/geheim.md', allow_sensitive: true })).body.isError;
    // Einfügen mitten in der Seite.
    const ins = await mcpCall(mcp, 'vault_edit', { path: 'wiki/concepts/backpressure.md', old_text: 'Widerstand für Agenten im Loop.', new_text: 'Widerstand für Agenten im Loop. Glaser zeigt, dass er lange Loops trägt ([[glaser-loop]]).' });
    seen.insert = ins.body.isError ?? false;
    // Löschen und Umschreiben lehnt das Cockpit ab.
    seen.remove = (await mcpCall(mcp, 'vault_edit', { path: 'wiki/concepts/backpressure.md', old_text: 'Backpressure ist ', new_text: '' })).body.content[0].text;
    seen.outside = (await mcpCall(mcp, 'vault_append', { path: 'inbox/Start.md', text: 'x' })).body.content[0].text;
    seen.log = (await mcpCall(mcp, 'vault_append', { path: 'wiki/log.md', text: 'x' })).body.isError;
    seen.capture = (await mcpCall(mcp, 'vault_capture', { title: 'x', text: 'y' })).body.isError;
    // Spannung als Abschnitt, Relation nur ergänzend.
    await mcpCall(mcp, 'vault_edit', { path: 'wiki/concepts/backpressure.md', old_text: '## Quellen', new_text: '## Spannungen\n\n[[glaser-loop]] sieht Backpressure auch sozial; hier nur technisch.\n\n## Quellen' });
    seen.dropRel = (await mcpCall(mcp, 'vault_set_frontmatter', { path: 'wiki/sources/glaser-loop.md', set: { relations: ['contradicts [[backpressure]]'] } })).body.isError ?? false;
    seen.summary = (await mcpCall(mcp, 'vault_set_frontmatter', { path: 'wiki/concepts/backpressure.md', set: { summary: 'weg' } })).body.isError;
    seen.badToken = (await fetch(mcp.url, { method: 'POST', headers: { authorization: 'Bearer falsch', 'content-type': 'application/json' }, body: '{}' })).status;
    return { zusammenfassung: 'Backpressure bekommt Glasers Befund und eine Spannung.', eingepflanzt: [{ path: 'wiki/concepts/backpressure.md', was: 'Befund und Spannung' }, { path: 'wiki/concepts/loops.md', was: 'erfunden' }], offen: ['Spannung zu Backpressure auflösen'] };
  };

  const r = await applied();
  assert.equal(r.plant, 'wartet');
  assert.match(appliedMessage('Der elastische Loop', r), /Claude pflanzt es jetzt ein$/);
  await planter.idle();

  assert.equal(agentCalls.length, 1);
  const job = agentCalls[0];
  assert.deepEqual(job.tools, ['vault_search', 'vault_read', 'vault_links', 'vault_list', 'vault_similar', 'vault_graph', 'vault_edit', 'vault_append', 'vault_set_frontmatter']);
  assert.match(job.mcp.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
  assert.match(job.system, /# Wiki einpflanzen/);
  assert.doesNotMatch(job.system, /^name: wiki-einpflanzen/m, 'ohne Frontmatter des Skills');
  assert.match(job.input, /Source-Page: wiki\/sources\/glaser-loop\.md/);
  assert.match(job.input, /Widerspricht:\n- wiki\/concepts\/backpressure\.md — nur technisch — Vorschlag: beide Schichten/);
  assert.match(job.input, /verknüpft \(Link unter „## Quellen“\): wiki\/concepts\/backpressure\.md/);

  assert.equal(seen.read, 'wiki/concepts/backpressure.md');
  assert.equal(seen.secret, true);
  assert.equal(seen.insert, false);
  assert.match(seen.remove, /nur ergänzt/);
  assert.match(seen.outside, /Nur Seiten unter wiki\//);
  assert.equal(seen.log, true);
  assert.equal(seen.capture, true);
  assert.equal(seen.dropRel, false, 'Source-Page hat noch keine relations, also nichts verloren');
  assert.equal(seen.summary, true);
  assert.equal(seen.badToken, 401);

  const page = read('wiki/concepts/backpressure.md');
  assert.match(page, /Widerstand für Agenten im Loop\. Glaser zeigt, dass er lange Loops trägt \(\[\[glaser-loop\]\]\)\./);
  assert.match(page, /## Spannungen\n\n\[\[glaser-loop\]\] sieht Backpressure auch sozial/);
  assert.match(page, /Backpressure ist Widerstand/);
  assert.equal(String(fm('wiki/concepts/backpressure.md').updated).slice(0, 10), '2026-10-25');
  assert.equal(fm('wiki/concepts/backpressure.md').summary, 'Widerstand für Agent-Output');
  assert.deepEqual(fm('wiki/sources/glaser-loop.md').relations, ['contradicts [[backpressure]]']);
  assert.equal(read('inbox/Start.md'), '# Start\n');

  const plant = store.getIngest(doc.id).applied.plant;
  assert.equal(plant.status, 'fertig');
  assert.equal(plant.summary, 'Backpressure bekommt Glasers Befund und eine Spannung.');
  // Was geändert wurde, weiß das Cockpit selbst; Erfundenes aus dem Bericht fällt weg.
  assert.deepEqual(plant.changed, [
    { path: 'wiki/concepts/backpressure.md', was: 'Befund und Spannung' },
    { path: 'wiki/sources/glaser-loop.md', was: null },
  ]);
  assert.deepEqual(plant.open, ['Spannung zu Backpressure auflösen']);
  const log = read('wiki/log.md');
  assert.match(log, /## \[2026-10-25\] einpflanzen \(cockpit\) \| Der elastische Loop\n- Source-Page: \[\[glaser-loop\]\]\n- Eingepflanzt: \[\[backpressure\]\], \[\[glaser-loop\]\]\n- Offen: Spannung zu Backpressure auflösen/);
  // Ein zweites Übernehmen reiht nichts neu ein und meldet den Stand.
  assert.equal((await ingest.apply(doc.id, { items: ['v1'] })).plant, 'fertig');
  assert.equal(agentCalls.length, 1);
});

test('Einpflanzen: aus in den Einstellungen → nichts eingereiht; von Hand geht es trotzdem, Fehler bleiben sichtbar', async () => {
  settings.save({ ingest: { agent: false }, calendars: [] });
  const r = await applied();
  assert.equal(r.plant, null);
  await planter.idle();
  assert.equal(agentCalls.length, 0);
  assert.equal(store.getIngest(doc.id).applied.plant, undefined);

  agentRun = async () => {
    throw new Error('Usage limit reached');
  };
  assert.equal(planter.request(doc.id), 'wartet');
  await planter.idle();
  const plant = store.getIngest(doc.id).applied.plant;
  assert.equal(plant.status, 'fehler');
  assert.equal(plant.error, 'Usage limit reached');

  // Nur Übernommenes lässt sich einpflanzen.
  const { doc: other } = store.addDocument({ url: 'https://x.test/a', title: 'A', status: 'stapel', content_html: HTML });
  ingest.request([other.id]);
  await ingest.idle();
  assert.throws(() => planter.request(other.id), (e) => e instanceof PlantError && e.status === 409);
});

test('Einpflanzen: nach einem Neustart geht Wartendes und Angefangenes wieder in die Warteschlange', async () => {
  settings.save({ ingest: { agent: false }, calendars: [] });
  await applied();
  const row = store.getIngest(doc.id);
  store.saveIngest(doc.id, { applied: { ...row.applied, plant: { status: 'laeuft', requested_at: NOW.toISOString() } } });
  services();
  await new Promise((r) => setTimeout(r, 5));
  await planter.idle();
  assert.equal(agentCalls.length, 1);
  assert.equal(store.getIngest(doc.id).applied.plant.status, 'fertig');
});

test('guardEditor: nur wiki/, nur ergänzen, Frontmatter nur relations, höchstens n Seiten', () => {
  const g = guardEditor(editor, { index: idx, maxPages: 1 });
  assert.throws(() => g.replace({ path: 'wiki/concepts/backpressure.md', oldText: 'Loop.', newText: 'x', replaceAll: true }), /replace_all/);
  assert.throws(() => g.replace({ path: 'wiki/../inbox/Start.md', oldText: 'Start', newText: 'Start!' }), /Nur Seiten unter wiki/);
  assert.throws(() => g.replace({ path: 'wiki/concepts/backpressure.md', oldText: 'im Loop.', newText: 'in Loops.' }), /nur ergänzt/);
  assert.throws(() => g.setFrontmatter({ path: 'wiki/concepts/backpressure.md', set: { relations: ['extends [[loops]]'] } }), /es fehlten danach: uses \[\[loops\]\]/);
  assert.throws(() => g.setFrontmatter({ path: 'wiki/concepts/backpressure.md', set: { updated: '2030-01-01' } }), /nur `relations`/);
  assert.throws(() => g.move({ path: 'wiki/concepts/backpressure.md', folder: 'wiki' }), /gesperrt/);
  g.setFrontmatter({ path: 'wiki/concepts/backpressure.md', set: { relations: ['uses [[loops]]', 'extends [[loops]]'] } });
  assert.deepEqual([...g.touched], ['wiki/concepts/backpressure.md']);
  assert.throws(() => g.append({ path: 'wiki/concepts/loops.md', text: 'mehr' }), /Höchstens 1 Seiten/);
  g.append({ path: 'wiki/concepts/backpressure.md', text: 'mehr' });
});

test('Einpflanzen in der Oberfläche: Stand als JSON und im Live-Stand, Knopf reiht neu ein', async () => {
  let release;
  agentRun = () => new Promise((r) => (release = () => r({ zusammenfassung: 'Fertig.', eingepflanzt: [], offen: [] })));
  await applied();
  await new Promise((r) => setTimeout(r, 20));
  const routes = ingestRoutes({ store, ingest, planter, logger: quiet });
  const ctx = { url: new URL('http://x/lesen/ingest'), write: { csrf: 't', back: '/lesen/ingest' }, tz: 'Europe/Berlin', nav: {} };

  const data = JSON.parse((await routes.pages['/api/lesen/ingest'](ctx)).body);
  const planting = data.planting;
  assert.equal(data.actions.plant, '/aktion/lesen/ingest/einpflanzen');
  assert.equal(planting.length, 1);
  assert.equal(planting[0].plant.status, 'laeuft');

  const stand = await routes.pages['/lesen/ingest/stand']({ ...ctx, url: new URL(`http://x/lesen/ingest/stand?ids=${doc.id}`) });
  const items = JSON.parse(stand.body).items;
  assert.equal(items[0].status, 'uebernommen');
  assert.equal(items[0].plant, 'laeuft');

  release();
  await planter.idle();
  assert.equal(JSON.parse((await routes.pages['/api/lesen/ingest'](ctx)).body).planting[0].plant.summary, 'Fertig.');
  agentRun = async () => ({ zusammenfassung: 'Noch einmal.', eingepflanzt: [], offen: [] });
  const msg = await routes.actions['/aktion/lesen/ingest/einpflanzen'](new Map([['id', doc.id]]));
  assert.match(msg.message, /^Wird eingepflanzt: Der elastische Loop/);
  await planter.idle();
  assert.equal(store.getIngest(doc.id).applied.plant.summary, 'Noch einmal.');
  assert.equal(inputFor(store.getIngest(doc.id)).includes('Kernaussagen:\n- Backpressure macht lange Loops möglich.'), true);
});

test('Claude als Agent: nur der MCP-Server des Laufs, Token in einer Datei mit 0600, eigener Konfigurationsordner, kein Safe-Mode', async () => {
  const seen = {};
  const run = (command, args, opts) => {
    const config = args[args.indexOf('--mcp-config') + 1];
    Object.assign(seen, { args, opts, config: JSON.parse(readFileSync(config, 'utf8')), mode: statSync(config).mode & 0o777, configPath: config });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.stdin.on('finish', () => {
      child.stdout.end(JSON.stringify({ is_error: false, structured_output: { ok: true } }));
      child.stderr.end();
      setImmediate(() => child.emit('close', 0));
    });
    child.kill = () => {};
    return child;
  };
  const writer = createClaudeWriter({ token: 'oat-abo', model: () => 'sonnet', run, logger: quiet });
  const out = await writer.agent({ system: 'S', prompt: 'P', input: 'I', schema: { type: 'object' }, mcp: { name: 'vault', url: 'http://127.0.0.1:1234/mcp', token: 'geheim' }, tools: ['vault_read', 'vault_edit'] });
  assert.deepEqual(out, { ok: true });
  const a = seen.args;
  assert.ok(!a.includes('--safe-mode'), 'Safe-Mode schaltet auch --mcp-config ab');
  assert.ok(!a.join(' ').includes('geheim'), 'Token nicht in der Prozessliste');
  for (const flag of ['--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence']) assert.ok(a.includes(flag), flag);
  for (const [flag, value] of [['--tools', ''], ['--allowedTools', 'mcp__vault__vault_read,mcp__vault__vault_edit'], ['--permission-mode', 'dontAsk'], ['--model', 'sonnet']]) assert.equal(a[a.indexOf(flag) + 1], value, flag);
  assert.deepEqual(seen.config, { mcpServers: { vault: { type: 'http', url: 'http://127.0.0.1:1234/mcp', headers: { Authorization: 'Bearer geheim' } } } });
  assert.equal(seen.mode, 0o600);
  assert.ok(seen.opts.env.CLAUDE_CONFIG_DIR.startsWith(seen.opts.cwd));
  assert.equal(existsSync(seen.configPath), false, 'Arbeitsverzeichnis samt Token weg');
  await assert.rejects(writer.agent({ system: '', prompt: '', input: '', schema: {}, mcp: { name: 'a b', url: 'x', token: 't' }, tools: [] }), /Ungültiger Name/);
});
