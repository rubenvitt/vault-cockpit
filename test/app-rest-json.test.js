import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/http/app.js';
import { createWebHttp } from '../src/web/http.js';
import { createSettingsStore } from '../src/cockpit/settings.js';
import { createTokenStore } from '../src/cockpit/tokens.js';
import { buildIndex, openIndex } from '../src/vault/index.js';
import { compilePolicy } from '../src/vault/policy.js';
import { createEditor } from '../src/vault/edit.js';
import { createNoteDesk } from '../src/cockpit/notes.js';
import { createReadingStore } from '../src/lesen/store.js';
import { readingRoutes } from '../src/lesen/http.js';

const quiet = { info() {}, warn() {}, error() {} };
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

const IDEE = `---
projekt: "[[Hund]]"
tags: [idee]
---
# Idee

Mit [[Hund]], [[Gibts nicht]] und ==markiert==.

- [ ] Preise vergleichen
- [x] Termin machen

![[foto.png|120]]

> [!tip] Merken
> - [ ] nur Anzeige
`;

const SYNTHESE = `---
type: synthesis
summary: Willenskraft ist kein Muskel, sagt [[Hund]]
art: Brücke
status: entwurf
confidence: mittel
updated: 2026-10-20
---
# Selbstkontrolle

## Erschöpfung ist umstritten
Text [TODO: Quelle zu Ego-Depletion prüfen]

## Gewohnheiten schlagen Willenskraft

## Offene Punkte
- [ ] Gegenposition suchen
- [x] Erledigtes
`;

/** Gestörte und laufende Dienste wie aus src/health/collect.js. */
const SERVICES = [
  { id: 'sync', name: 'Sync', state: 'ok', summary: 'läuft', lastOkAt: '2026-10-25T08:00:00.000Z', lastErrorAt: null, lastError: null, facts: [{ label: 'Letzter Lauf', at: '2026-10-25T08:00:00.000Z' }, { label: 'Dateien', value: '1234' }] },
  {
    id: 'calendars',
    name: 'Kalender',
    state: 'error',
    summary: '1 von 2 nicht erreichbar',
    lastOkAt: '2026-10-25T07:00:00.000Z',
    lastErrorAt: '2026-10-25T07:30:00.000Z',
    lastError: 'Arbeit: 401 Unauthorized',
    facts: [],
    items: [
      { id: 'c1', name: 'Privat', state: 'ok', summary: '12 Termine', lastOkAt: '2026-10-25T07:00:00.000Z', lastErrorAt: null, lastError: null },
      { id: 'c2', name: 'Arbeit', state: 'error', summary: null, lastOkAt: null, lastErrorAt: '2026-10-25T07:30:00.000Z', lastError: '401 Unauthorized' },
    ],
  },
  { id: 'mail', name: 'Mail-Abruf', state: 'off', summary: 'nicht eingerichtet', lastOkAt: null, lastErrorAt: null, lastError: null, facts: [] },
];

/**
 * Vault auf der Platte mit Index und Notiz-Schreibtisch, dazu Attrappen für
 * Suche, Graph, Zustand, Belege und Zunder; Cockpit mit Geräte-Token der App.
 * `get`/`act` wie die App (Bearer, Formular, `Accept: application/json`).
 */
async function withVaultApp(run, { week = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'app-rest-'));
  const put = (p, data) => {
    mkdirSync(join(root, p, '..'), { recursive: true });
    writeFileSync(join(root, p), data);
  };
  put('00-inbox/Idee.md', IDEE);
  put('00-inbox/foto.png', PNG);
  put('wiki/Hund.md', '---\ntags: [idee, hund]\n---\n# Hund\n\nÜber den Hund und Preise.\n');
  put('wiki/Training.md', '---\ntags: [hund]\n---\n# Training\n\nHund Preise vergleichen und Termin.\n');
  put('wiki/synthesis/Selbstkontrolle.md', SYNTHESE);
  put('wiki/synthesis/Gewohnheit.md', '---\ntype: synthesis\nsummary: Kleine Schritte\nart: Vertiefung\nstatus: stabil\nupdated: 2026-10-01\n---\n# Gewohnheit\n');
  put('40-archiv/Alt.md', '# Alt\n');
  put('privat/Geheim.md', '# Geheim\n');

  const policy = compilePolicy({ exclude: ['^privat/'] });
  let index;
  buildIndex({ vaultPath: root, dbPath: ':memory:', policy, persist: (db, vp) => (index = openIndex(db, { vaultPath: vp, policy })) });
  const settings = createSettingsStore({ defaults: { tz: 'Europe/Berlin', inboxFolder: '00-inbox', vaultName: 'Vault', zunderUrl: 'https://zunder.test', zunderToken: 'zt_test' }, logger: quiet });
  const notes = createNoteDesk({ index, editor: createEditor({ vaultPath: root, index }), policy, settings, vaultPath: root });
  const tokens = createTokenStore({ logger: quiet });
  const calls = [];
  const actions = {
    async synthesisTasks({ path, points }) {
      calls.push(['synthesisTasks', path, points]);
      return { created: points.length - 1, existing: 1 };
    },
  };
  const evidence = {
    suggest: async () => [{ id: 'hl-1', text: 'Gewohnheiten tragen weiter als Vorsätze.', title: 'Vom Wollen', href: '/lesen/doc?id=doc-7#h-hl-1', score: 0.812 }],
    matching: async (paths) => new Set(paths.filter((p) => p.endsWith('Selbstkontrolle.md'))),
    attach: ({ path, highlightId }) => ({ state: 'neu', path, highlightId, label: 'Vom Wollen' }),
    detach: ({ path }) => ({ state: 'neu', path }),
  };
  const search = async (q, { type = null, paths = null } = {}) => {
    const all = type === 'synthesis' ? ['wiki/synthesis/Selbstkontrolle.md', 'wiki/synthesis/Gewohnheit.md'] : Array.from({ length: 12 }, (_, i) => `wiki/Treffer ${i + 1}.md`);
    const hits = all.filter((p) => !paths || paths.includes(p));
    return { results: hits.map((p, i) => ({ path: p, title: p.split('/').pop().replace(/\.md$/, ''), snippet: i % 2 ? null : `… ${q} …`, streams: i % 3 ? ['text'] : ['text', 'semantic'] })), total: hits.length, degraded: type ? null : 'Bedeutungssuche gerade nicht verfügbar, nur Volltext' };
  };
  const graph = {
    async around(path) {
      if (path !== '2026-10-25.md' && path !== 'wiki/Hund.md') return null;
      const c = `note:${path}`;
      return {
        center: c,
        nodes: [
          { id: c, kind: 'note', path, level: 0, label: path === 'wiki/Hund.md' ? 'Hund' : '2026-10-25', type: null, sensitivity: null },
          { id: 'note:wiki/Training.md', kind: 'note', path: 'wiki/Training.md', level: 1, label: 'Training', type: null, sensitivity: null },
          { id: 'note:00-inbox/Idee.md', kind: 'note', path: '00-inbox/Idee.md', level: 1, label: 'Idee', type: null, sensitivity: null },
          { id: 'note:wiki/synthesis/Gewohnheit.md', kind: 'note', path: 'wiki/synthesis/Gewohnheit.md', level: 1, label: 'Gewohnheit', type: 'synthesis', sensitivity: null },
          { id: 'task:t1', kind: 'task', taskId: 't1', label: 'Leine kaufen', url: 'https://zunder.test/#/aufgabe/t1', status: 'in_progress', ref: 'HUN-3', level: 1 },
          { id: 'task:t2', kind: 'task', taskId: 't2', label: 'Tierarzt', url: 'https://zunder.test/#/aufgabe/t2', status: 'open', ref: null, level: 2 },
          { id: 'event:1', kind: 'event', label: 'Hundeschule', start: '2026-10-25T09:00:00.000Z', end: '2026-10-25T10:00:00.000Z', allDay: false, calendar: 'Privat', level: 1 },
          { id: 'event:2', kind: 'event', label: 'Urlaub', start: '2026-10-24T22:00:00.000Z', end: '2026-10-25T22:00:00.000Z', allDay: true, calendar: null, level: 1 },
        ],
        edges: [
          { from: c, to: 'note:wiki/Training.md', kind: 'link' },
          { from: 'note:00-inbox/Idee.md', to: c, kind: 'link' },
          { from: c, to: 'note:wiki/synthesis/Gewohnheit.md', kind: 'semantic', score: 0.734 },
          { from: c, to: 'task:t1', kind: 'task' },
          { from: 'note:wiki/Training.md', to: 'task:t2', kind: 'task' },
          { from: c, to: 'event:1', kind: 'event' },
          { from: c, to: 'event:2', kind: 'event' },
        ],
        problems: ['Zunder: 1 Aufgabe(n) nicht abrufbar, Status aus der Notiz'],
      };
    },
  };
  const health = { check: async () => SERVICES, failing: () => SERVICES.filter((s) => s.state === 'error').map(({ id, name }) => ({ id, name })) };
  const webHttp = createWebHttp({
    cockpit: { week: async () => week },
    settings,
    actions,
    notes,
    tokens,
    graph,
    search,
    evidence,
    health,
    // Den Geräte-Zugang gibt es nur mit Lesebereich (src/web/app-access.js).
    reading: readingRoutes({ store: createReadingStore({ path: ':memory:' }), logger: quiet, capture: async () => ({ path: '00-inbox/x.md', duplicate: false }), review: { embedder: () => null } }),
    oidc: {},
    sessionSecret: 'x'.repeat(40),
    publicUrl: 'https://vault.test',
    allowedSubjects: ['ruben'],
    logger: quiet,
    now: () => Date.parse('2026-10-25T08:30:00.000Z'),
  });
  const app = createApp({
    config: { publicUrl: 'https://vault.test', resource: 'https://vault.test/mcp', issuer: 'https://id.test', supportedScopes: [], allowedHosts: ['vault.test'], trustProxy: true },
    verifyToken: async () => {
      throw new Error('nicht benutzt');
    },
    mcpHandler: async () => {},
    webHttp,
    logger: quiet,
  });
  app.listen(0, '127.0.0.1');
  await new Promise((res) => app.once('listening', res));
  const base = `http://127.0.0.1:${app.address().port}`;
  const bearer = tokens.create('Rubens iPhone', 'app').token;
  const raw = (path, { token = bearer } = {}) => fetch(base + path, { redirect: 'manual', headers: { 'x-forwarded-host': 'vault.test', ...(token ? { authorization: `Bearer ${token}` } : {}) } });
  const get = async (path, opts) => {
    const res = await raw(path, opts);
    assert.match(res.headers.get('content-type'), /^application\/json/, path);
    assert.equal(res.headers.get('cache-control'), 'no-store', path);
    return { status: res.status, body: await res.json() };
  };
  const act = async (path, fields, { token = bearer } = {}) => {
    const res = await fetch(base + path, {
      method: 'POST',
      headers: { 'x-forwarded-host': 'vault.test', accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: new URLSearchParams(fields),
    });
    return { status: res.status, body: await res.json(), headers: res.headers };
  };
  try {
    await run({ get, act, raw, root, tokens, calls, read: (p) => readFileSync(join(root, p), 'utf8') });
  } finally {
    app.close();
    index.close();
    rmSync(root, { recursive: true, force: true });
  }
}


test('Notiz-JSON: Kopf, Frontmatter, Text als Baum, Verwandte, Vorschläge und Ziele; nur angemeldet', async () => {
  await withVaultApp(async ({ get, tokens }) => {
    assert.equal((await get('/api/notiz?pfad=00-inbox%2FIdee.md', { token: null })).status, 401);
    assert.equal((await get('/api/notiz?pfad=00-inbox%2FIdee.md', { token: tokens.create('Suche', 'search').token })).status, 401);
    assert.equal((await get('/api/notiz?pfad=privat%2FGeheim.md')).status, 404);
    assert.equal((await get('/api/notiz?pfad=gibts%2Fnicht.md')).body.error, 'not_found');

    const { status, body } = await get('/api/notiz?pfad=00-inbox%2FIdee.md');
    assert.equal(status, 200);
    assert.equal(body.title, 'Idee');
    assert.equal(body.folder, '00-inbox');
    assert.deepEqual(body.tags, ['idee']);
    assert.equal(body.inInbox, true);
    assert.equal(body.obsidian, 'obsidian://open?vault=Vault&file=00-inbox%2FIdee');
    assert.equal(body.synthesis, null);
    assert.deepEqual(body.can, { write: true, graph: true });
    // Frontmatter ohne Tags, Wikilinks aufgelöst.
    assert.deepEqual(body.frontmatter.map((f) => [f.key, f.text]), [['projekt', 'Hund']]);
    assert.equal(body.frontmatter[0].content[0].path, 'wiki/Hund.md');

    assert.deepEqual(body.blocks.map((b) => b.type), ['heading', 'paragraph', 'list', 'image', 'callout']);
    const [, hund, , gone] = body.blocks[1].content;
    assert.deepEqual([hund.type, hund.status, hund.path], ['wikilink', 'note', 'wiki/Hund.md']);
    assert.deepEqual([gone.status, gone.text], ['missing', 'Gibts nicht']);
    assert.deepEqual(body.blocks[2].items.map((i) => i.task), [
      { done: false, n: 0, line: '- [ ] Preise vergleichen' },
      { done: true, n: 1, line: '- [x] Termin machen' },
    ]);
    assert.deepEqual(body.blocks[3], { type: 'image', path: '00-inbox/foto.png', src: '/notiz/bild?pfad=00-inbox%2Ffoto.png', alt: 'foto.png', width: 120, height: null });
    assert.equal(body.blocks[4].children[0].items[0].task.n, null);

    assert.deepEqual(body.related.backlinks, []);
    assert.ok(body.related.similar.some((h) => h.path === 'wiki/Training.md'));
    assert.equal(body.related.source, 'text');
    // Inbox-Notiz: Vorschläge und Ziele zum Ablegen, das Archiv extra.
    assert.ok(body.suggestions.of >= 1);
    assert.ok(body.suggestions.folders.some((f) => f.folder === 'wiki'));
    assert.ok(body.targets.includes('wiki') && !body.targets.includes('00-inbox') && !body.targets.includes('privat'));
    assert.equal(body.archive, '40-archiv');
    assert.equal(body.evidence, null);
  });
});

test('Notiz-JSON einer Synthese: Zusammenfassung, Thesen, offene Punkte, Belege aus dem Lesestapel', async () => {
  await withVaultApp(async ({ get }) => {
    const { body } = await get('/api/notiz?pfad=wiki%2Fsynthesis%2FSelbstkontrolle.md');
    assert.equal(body.type, 'synthesis');
    assert.equal(body.inInbox, false);
    assert.equal(body.suggestions, null);
    const s = body.synthesis;
    assert.deepEqual(s.summary.map((n) => n.type), ['text', 'wikilink']);
    assert.deepEqual([s.art, s.status, s.confidence], ['Brücke', 'entwurf', 'mittel']);
    assert.deepEqual(s.theses, [
      { id: 'h-erschöpfung-ist-umstritten', text: 'Erschöpfung ist umstritten' },
      { id: 'h-gewohnheiten-schlagen-willenskraft', text: 'Gewohnheiten schlagen Willenskraft' },
      { id: 'h-offene-punkte', text: 'Offene Punkte' },
    ]);
    assert.deepEqual(s.openPoints, ['Quelle zu Ego-Depletion prüfen', 'Gegenposition suchen']);
    assert.equal(s.toZunder, true);
    assert.deepEqual(body.evidence, [{ id: 'hl-1', text: 'Gewohnheiten tragen weiter als Vorsätze.', title: 'Vom Wollen', score: 0.812, docId: 'doc-7', href: '/lesen/doc?id=doc-7#h-hl-1' }]);
  });
});

test('Notiz-Aktionen mit Geräte-Token: Checkbox, Tags, Anhängen, Verlinken, Ablegen, Synthese', async () => {
  await withVaultApp(async ({ get, act, read, calls }) => {
    const pfad = '00-inbox/Idee.md';
    const task = (await get('/api/notiz?pfad=00-inbox%2FIdee.md')).body.blocks[2].items[0].task;
    const box = await act('/aktion/notiz/checkbox', { pfad, n: String(task.n), line: task.line, erledigt: '1' });
    assert.equal(box.status, 200);
    assert.deepEqual({ ...box.body, undo: undefined }, { ok: true, message: 'Abgehakt', path: pfad, n: 0, line: '- [x] Preise vergleichen', done: true, undo: undefined });
    assert.deepEqual(box.body.undo, { action: '/aktion/notiz/checkbox', fields: { pfad, n: '0', line: '- [x] Preise vergleichen', erledigt: '0' } });
    assert.match(read(pfad), /- \[x\] Preise vergleichen/);
    assert.equal((await get('/api/notiz?pfad=00-inbox%2FIdee.md')).body.blocks[2].items[0].task.done, true);
    // Veraltete Zeile: Fehler statt falscher Checkbox.
    const stale = await act('/aktion/notiz/checkbox', { pfad, n: '0', line: '- [ ] Preise vergleichen', erledigt: '1' });
    assert.equal(stale.status, 400);
    assert.equal(stale.body.error, 'action_failed');

    const tags = await act('/aktion/notiz/tags', { pfad, tags: 'idee, hund' });
    assert.deepEqual([tags.body.message, tags.body.tags], ['Tags: #idee #hund', ['idee', 'hund']]);
    assert.equal((await act('/aktion/notiz/anhaengen', { pfad, text: 'Noch ein Gedanke.' })).body.message, 'Angehängt');
    assert.match(read(pfad), /Noch ein Gedanke\.\n?$/);
    const link = await act('/aktion/verlinken', { pfad, ziel: 'wiki/Training.md' });
    assert.deepEqual({ ...link.body }, { ok: true, message: 'Verlinkt: Training', path: pfad, target: 'wiki/Training.md', title: 'Training', changed: true });
    assert.equal((await act('/aktion/verlinken', { pfad, ziel: 'wiki/Training.md' })).body.changed, false);

    const filed = await act('/aktion/notiz/ablegen', { pfad, ordner: 'wiki', back: `/notiz?pfad=${encodeURIComponent(pfad)}` });
    assert.equal(filed.body.path, 'wiki/Idee.md');
    assert.equal(filed.body.from, pfad);
    assert.equal(filed.body.folder, 'wiki');
    assert.equal(filed.body.redirect, '/notiz?pfad=wiki%2FIdee.md');
    assert.equal(filed.headers.get('set-cookie'), null, 'keine Meldung per Cookie für die App');
    assert.deepEqual(filed.body.undo, { action: '/aktion/notiz/ablegen', fields: { pfad: 'wiki/Idee.md', ordner: '00-inbox', back: '/notiz?pfad=00-inbox%2FIdee.md' } });
    const back = await act(filed.body.undo.action, filed.body.undo.fields);
    assert.equal(back.body.path, pfad);
    assert.equal((await act('/aktion/notiz/ablegen', { pfad, ordner: 'privat' })).status, 403);

    const synth = 'wiki/synthesis/Selbstkontrolle.md';
    const tasks = await act('/aktion/synthese/aufgaben', { pfad: synth });
    assert.deepEqual([tasks.body.message, tasks.body.created, tasks.body.existing], ['Nach Zunder: 1 Aufgabe, 1 schon dort', 1, 1]);
    assert.deepEqual(calls, [['synthesisTasks', synth, ['Quelle zu Ego-Depletion prüfen', 'Gegenposition suchen']]]);
    assert.equal((await act('/aktion/synthese/aufgaben', { pfad })).status, 404);
    const beleg = await act('/aktion/synthese/beleg', { pfad: synth, markierung: 'hl-1' });
    assert.deepEqual(beleg.body.undo, { action: '/aktion/synthese/beleg/entfernen', fields: { pfad: synth, markierung: 'hl-1' } });
    assert.equal((await act(beleg.body.undo.action, beleg.body.undo.fields)).body.message, 'Beleg entfernt');
  });
});

test('Wissen, Suche, Graph und Zustand als JSON für die App; Störung in der Woche', async () => {
  const week = { tz: 'Europe/Berlin', week: { id: '2026-W43' } };
  await withVaultApp(
    async ({ get }) => {
      const wissen = (await get('/api/wissen')).body;
      assert.equal(wissen.total, 2);
      assert.equal(wissen.hits, null);
      assert.deepEqual(wissen.recent.map((n) => n.title), ['Selbstkontrolle', 'Gewohnheit']);
      assert.deepEqual(wissen.arts, ['Brücke', 'Vertiefung']);
      assert.equal(wissen.reading, true);
      const asked = (await get('/api/wissen?q=Willen&status=entwurf')).body;
      assert.deepEqual(asked.hits.map((n) => n.path), ['wiki/synthesis/Selbstkontrolle.md']);
      assert.equal((await get('/api/wissen?lesen=1')).body.recent.length, 1);

      const quick = (await get('/api/suche?q=Hund')).body;
      assert.equal(quick.results.length, 8);
      assert.equal(quick.total, 12);
      const all = (await get('/api/suche?q=Hund&alle=1')).body;
      assert.equal(all.results.length, 12);
      assert.equal(all.notes, true);
      assert.match(all.degraded, /nur Volltext/);

      const g = (await get('/api/graph?pfad=2026-10-25.md')).body;
      assert.equal(g.label, '2026-10-25');
      assert.equal(g.obsidian, 'obsidian://open?vault=Vault&file=2026-10-25');
      assert.deepEqual(g.lists.outgoing.map((n) => n.path), ['wiki/Training.md']);
      assert.deepEqual(g.lists.incoming.map((n) => n.path), ['00-inbox/Idee.md']);
      assert.deepEqual(g.lists.similar, [{ path: 'wiki/synthesis/Gewohnheit.md', label: 'Gewohnheit', type: 'synthesis', score: 0.734 }]);
      assert.deepEqual(g.lists.tasks, [
        { id: 't1', label: 'Leine kaufen', url: 'https://zunder.test/#/aufgabe/t1', status: 'in_progress', ref: 'HUN-3', from: null },
        { id: 't2', label: 'Tierarzt', url: 'https://zunder.test/#/aufgabe/t2', status: 'open', ref: null, from: 'Training' },
      ]);
      assert.deepEqual(g.lists.events.map((e) => [e.label, e.allDay]), [['Urlaub', true], ['Hundeschule', false]]);
      assert.deepEqual(g.can, { link: true, notes: true });
      assert.equal(g.problems.length, 1);
      assert.equal((await get('/api/graph?pfad=fehlt.md')).status, 404);

      const z = (await get('/api/zustand')).body;
      assert.equal(z.checkedAt, '2026-10-25T08:30:00.000Z');
      assert.deepEqual(z.failing, [{ id: 'calendars', name: 'Kalender' }]);
      assert.deepEqual(z.services.map((s) => s.state), ['ok', 'error', 'off']);

      const w = (await get('/api/woche')).body;
      assert.deepEqual(w.alert, [{ id: 'calendars', name: 'Kalender' }]);
      assert.equal(w.week.id, '2026-W43');
    },
    { week },
  );
});
