import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEpisodes, normalizeResearch, chapterHint } from '../src/lesen/folgen.js';
import { progressOf, topicSummary, episodeJson } from '../src/lesen/folgen-page.js';
import { createClaudeWriter } from '../src/lesen/claude.js';
import { createResearchVault } from '../src/lesen/research-mcp.js';
import { createReadingStore } from '../src/lesen/store.js';
import { readingRoutes } from '../src/lesen/http.js';
import { buildIndex, openIndex } from '../src/vault/index.js';
import { compilePolicy } from '../src/vault/policy.js';

const quiet = { info() {}, warn() {}, error() {} };
const TTS = { key: 'sk', voice: 'Erz', model: 'eleven_multilingual_v2' };

function withDir(run) {
  const dir = mkdtempSync(join(tmpdir(), 'cockpit-thema-'));
  return Promise.resolve(run(dir)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

const RESEARCH = {
  title: 'Rückruf mit Bruno',
  summary: 'Drei Notizen, zwei Webquellen.',
  dossier: '### Stand\n\nBruno kommt drei von fünf Mal [V2]. Studien raten zu Belohnung [W1].',
  chapters: [
    { title: 'Ausgangslage', minutes: 10, points: 'Ziel und Methode [V1]' },
    { title: 'Forschung', minutes: 10, points: 'Belohnung [W1]' },
  ],
  sources: [
    { id: 'V1', title: 'Hund Training', path: '10-projekte/Hund Training.md' },
    { id: 'V2', title: 'Tag', path: 'daily/2026-10-20' },
    { id: 'V3', title: 'Erfunden', path: 'gibt/es-nicht.md' },
    { id: 'W1', title: 'Studie', url: 'https://example.org/studie' },
    { id: 'W2', title: 'Kaputt', url: 'javascript:alert(1)' },
  ],
};

/**
 * Falscher Claude: Recherche als Agent (bekommt Werkzeuge und den MCP-Server),
 * dann ein Kapitel je Aufruf. `failChapter(i)` lässt Kapitel `i` scheitern.
 */
function setup(dir, { research = RESEARCH, failChapter = () => false, withResearch = true, options = {} } = {}) {
  const calls = { research: [], chapters: [], notes: [], heard: [], opened: 0, closed: 0, speech: [], dialogue: [] };
  const writer = {
    available: () => true,
    write: async (job) => {
      if (job.schema.required.includes('dossier')) {
        calls.research.push(job);
        return research;
      }
      const i = calls.chapters.length;
      calls.chapters.push(job);
      if (failChapter(i)) throw new Error('Usage limit reached');
      const n = /Kapitel (\d+) von/.exec(job.prompt)[1];
      if (job.schema.required.includes('turns')) return { turns: [{ speaker: 'A', text: `Kapitel ${n}, Frage.` }, { speaker: 'B', text: `Kapitel ${n}, Antwort.` }] };
      return { spoken: `Text von Kapitel ${n}.` };
    },
  };
  const researchVault = {
    open: async () => {
      calls.opened += 1;
      return { mcp: { name: 'vault', config: { type: 'http', url: 'http://127.0.0.1:1/mcp' } }, read: () => ['10-projekte/Hund Training.md', 'daily/2026-10-20.md', 'wiki/rueckruf.md'], close: async () => (calls.closed += 1) };
    },
  };
  const provider = () => ({
    synthesize: async (input) => {
      calls.speech.push(input.text);
      return Buffer.from(`[${input.text}]`);
    },
    dialogue: async ({ inputs }) => {
      calls.dialogue.push(inputs);
      return Buffer.from(inputs.map((i) => `${i.voice}:${i.text}`).join('|'));
    },
  });
  const episodes = createEpisodes({
    dir,
    store: createReadingStore({ path: ':memory:' }),
    tts: () => TTS,
    voices: () => ({ host: 'Host', guest: 'Gast' }),
    writer,
    research: withResearch ? researchVault : null,
    createNote: async ({ folder, name, content }) => {
      calls.notes.push({ folder, name, content });
      return { path: `${folder}/${name}` };
    },
    heard: async (ids) => calls.heard.push(ids),
    provider,
    logger: quiet,
    now: () => new Date('2026-10-25T10:00:00Z'),
    tz: 'Europe/Berlin',
    ...options,
  });
  return { episodes, calls };
}

test('Thema: Recherche mit Vault und Internet, dann Kapitel für Kapitel, Transkript mit Dossier und Quellen', () =>
  withDir(async (dir) => {
    const { episodes, calls } = setup(dir);
    const ep = episodes.createTopic({ kind: 'report', topic: '  Rückruf   mit Bruno ', goal: 'Freilauf bis Dezember.\nIm Wald.', minutes: 20 });
    assert.equal(ep.title, 'Report: Rückruf mit Bruno');
    assert.equal(ep.chars, 20 * 900);
    await ep.done;
    const done = episodes.get(ep.id);
    assert.equal(done.status, 'fertig', done.error);
    assert.equal(done.title, 'Rückruf mit Bruno');

    // Recherche: einmal, als Agent mit Web-Werkzeugen und dem Vault-Server, der danach zu ist.
    assert.equal(calls.research.length, 1);
    const r = calls.research[0];
    assert.deepEqual(r.tools, ['WebSearch', 'WebFetch']);
    assert.equal(r.mcp.name, 'vault');
    assert.ok(r.timeoutMs > 15 * 60_000, 'Recherche darf länger dauern');
    assert.match(r.prompt, /etwa 20 Minuten zum Thema: Rückruf mit Bruno/);
    assert.match(r.prompt, /Freilauf bis Dezember/);
    assert.match(r.prompt, /nie persönliche Details/);
    assert.match(r.input, /Heute ist 2026-10-25/);
    assert.deepEqual([calls.opened, calls.closed], [1, 1]);

    // Kapitel: ohne Werkzeuge, aus dem Dossier, mit dem Ende des vorigen.
    assert.equal(calls.chapters.length, 2);
    for (const c of calls.chapters) {
      assert.equal(c.tools, undefined);
      assert.match(c.input, /<dossier>[\s\S]*drei von fünf[\s\S]*<\/dossier>/);
      assert.match(c.input, /\[W1\] Studie \(extern, https:\/\/example\.org\/studie\)/);
    }
    assert.match(calls.chapters[0].prompt, /Kapitel 1 von 2: „Ausgangslage“, etwa 10 Minuten, also rund 9000 Zeichen/);
    assert.match(calls.chapters[0].prompt, /erste Kapitel/);
    assert.doesNotMatch(calls.chapters[0].prompt, /So endete das vorige Kapitel/);
    assert.match(calls.chapters[1].prompt, /So endete das vorige Kapitel:\nText von Kapitel 1\./);
    assert.match(calls.chapters[1].prompt, /letzte Kapitel/);

    // Die Stimme sagt die Kapitel an.
    assert.deepEqual(calls.speech, ['Kapitel 1: Ausgangslage. Text von Kapitel 1.', 'Kapitel 2: Forschung. Text von Kapitel 2.']);
    assert.deepEqual(calls.heard, [], 'kein Vermerk „gehört“ ohne Texte');

    const [note] = calls.notes;
    assert.equal(note.folder, '30-ressourcen/audio-reports');
    assert.equal(note.name, '2026-10-25-report-rueckruf-mit-bruno.md');
    const c = note.content;
    assert.match(c, /^---\ntype: folge\nart: report\nquelle: thema\ntitel: "Rückruf mit Bruno"\n/);
    assert.match(c, /\nthema: "Rückruf mit Bruno"\nziel: "Freilauf bis Dezember.\\nIm Wald."\ninternet: true\nweb:\n {2}- "https:\/\/example\.org\/studie"\nquellen:\n {2}- "\[\[10-projekte\/Hund Training\]\]"\n {2}- "\[\[daily\/2026-10-20\]\]"\ningest: offen\n---/);
    assert.match(c, /_Report zum Thema, 2026-10-25, 2 Kapitel, Recherche in 2 Notizen und 1 Webquelle \(Cockpit\)_/);
    assert.match(c, /> \[!note\] Ziele und Anlass\n> Freilauf bis Dezember\.\n> Im Wald\./);
    assert.match(c, /## Überblick\n\nDrei Notizen/);
    assert.match(c, /## Kapitel 1: Ausgangslage\n\nText von Kapitel 1\.\n\n## Kapitel 2: Forschung\n\nText von Kapitel 2\./);
    assert.match(c, /## Recherche\n\n### Stand/);
    assert.match(c, /## Quellen\n\n- \[\[10-projekte\/Hund Training\|V1 Hund Training\]\]\n- \[\[daily\/2026-10-20\|V2 Tag\]\]\n- \[W1 Studie\]\(<https:\/\/example\.org\/studie>\) \(extern\)\n$/);
    assert.doesNotMatch(c, /Erfunden|javascript:/, 'nur gelesene Notizen und http(s)');

    assert.equal(readdirSync(dir).filter((f) => /skript|recherche|\.part$/.test(f)).length, 0, 'Zwischenstände weg');
    const json = episodeJson(done);
    assert.deepEqual([json.source, json.topic, json.goal, json.web, json.docs], ['thema', 'Rückruf mit Bruno', 'Freilauf bis Dezember.\nIm Wald.', true, []]);
  }));

test('Thema: Podcast, ohne Internet, ein Kapitel ohne Ansage', () =>
  withDir(async (dir) => {
    const one = { ...RESEARCH, chapters: [{ title: 'Alles', minutes: 8, points: '' }] };
    const { episodes, calls } = setup(dir, { research: one });
    const ep = episodes.createTopic({ kind: 'podcast', topic: 'Rückruf', minutes: 10, web: false });
    await ep.done;
    assert.equal(episodes.get(ep.id).status, 'fertig');
    assert.deepEqual(calls.research[0].tools, []);
    assert.match(calls.research[0].prompt, /Nur der Vault, kein Internet/);
    assert.match(calls.research[0].prompt, /Ziele oder Anlass hat er nicht genannt/);
    assert.match(calls.chapters[0].prompt, /Es ist die ganze Folge/);
    assert.match(calls.chapters[0].prompt, /Ein Gespräch zweier Stimmen/);
    assert.deepEqual(calls.dialogue.flat().map((i) => i.voice), ['Host', 'Gast']);
    const c = calls.notes[0].content;
    assert.match(c, /internet: false\n/);
    assert.doesNotMatch(c, /\nweb:|\nziel:|Ziele und Anlass/);
    assert.match(c, /## Alles\n\n\*\*Moderation:\*\* Kapitel 1, Frage\.\n\n\*\*Gast:\*\* Kapitel 1, Antwort\./);
  }));

test('Thema: nach einem Fehler schreibt Claude nur die fehlenden Kapitel, ohne neue Recherche', () =>
  withDir(async (dir) => {
    let fail = true;
    const { episodes, calls } = setup(dir, { failChapter: (i) => i === 1 && fail });
    const ep = episodes.createTopic({ kind: 'report', topic: 'Rückruf', minutes: 20 });
    await ep.done;
    const failed = episodes.get(ep.id);
    assert.equal(failed.status, 'fehler');
    assert.match(failed.error, /Usage limit/);
    assert.equal(failed.researched, true);
    assert.equal(episodes.resumable(ep.id), false, 'Kapitel fehlen noch');
    const json = episodeJson(failed, { resumable: false });
    assert.equal(json.retry.label, 'Fortsetzen');
    assert.match(json.retry.hint, /nur die fehlenden Kapitel/);
    assert.ok(existsSync(join(dir, `${ep.id}.recherche.json`)));

    fail = false;
    await episodes.retry(ep.id).done;
    assert.equal(episodes.get(ep.id).status, 'fertig');
    assert.equal(calls.research.length, 1, 'keine zweite Recherche');
    assert.deepEqual(calls.chapters.map((c) => /Kapitel (\d) von/.exec(c.prompt)[1]), ['1', '2', '2'], 'Kapitel 1 nicht noch einmal');
    assert.match(calls.chapters[2].prompt, /So endete das vorige Kapitel:\nText von Kapitel 1\./);
  }));

test('Thema: Neustart mitten in der Recherche oder in den Kapiteln', () =>
  withDir(async (dir) => {
    const at = '2026-10-25T09:00:00Z';
    const base = { kind: 'report', source: 'thema', topic: 'T', minutes: 20, docs: [], created_at: at, updated_at: at };
    writeFileSync(join(dir, 'folgen.json'), JSON.stringify([
      { ...base, id: 'r', status: 'recherchiert' },
      { ...base, id: 's', status: 'schreibt', researched: true },
      { ...base, id: 'k', status: 'schreibt', researched: true },
    ]));
    writeFileSync(join(dir, 's.skript.json'), JSON.stringify({ chapters: [{ spoken: 'Eins.' }] }));
    writeFileSync(join(dir, 'k.skript.json'), JSON.stringify({ chapters: [{ spoken: 'Eins.' }, { spoken: 'Zwei.' }], complete: true }));
    writeFileSync(join(dir, 'k.recherche.json'), JSON.stringify(normalizeResearch(RESEARCH, { minutes: 20, topic: 'T', read: ['10-projekte/Hund Training.md'] })));
    const { episodes, calls } = setup(dir);
    assert.match(episodes.get('r').error, /bevor die Recherche fertig war/);
    assert.match(episodes.get('s').error, /Recherche und fertige Kapitel bleiben/);
    assert.equal(episodes.get('k').status, 'wartet', 'alle Kapitel da: läuft ohne Claude weiter');
    await new Promise((res) => setTimeout(res, 1300));
    assert.equal(episodes.get('k').status, 'fertig');
    assert.equal(calls.research.length + calls.chapters.length, 0);
  }));

test('Thema: Eingaben prüfen, ohne Vault-Zugang nicht anlegbar', () =>
  withDir(async (dir) => {
    const { episodes } = setup(dir);
    assert.throws(() => episodes.createTopic({ kind: 'vorlesen', topic: 'Rückruf' }), /Podcast oder Report/);
    assert.throws(() => episodes.createTopic({ kind: 'report', topic: ' x ' }), /Thema nennen/);
    assert.throws(() => episodes.createTopic({ kind: 'report', topic: 'x'.repeat(301) }), /höchstens 300/);
    assert.throws(() => episodes.createTopic({ kind: 'report', topic: 'Rückruf', minutes: 4 }), /5 bis 240/);
    assert.throws(() => episodes.createTopic({ kind: 'report', topic: 'Rückruf', minutes: 241 }), /5 bis 240/);
    assert.throws(() => episodes.createTopic({ kind: 'report', topic: 'Rückruf', minutes: 30.5 }), /5 bis 240/);
    assert.equal(episodes.list().length, 0);

    const off = setup(dir, { withResearch: false }).episodes;
    assert.match(off.topicMissing(), /Vault-Zugang/);
    assert.throws(() => off.createTopic({ kind: 'report', topic: 'Rückruf' }), (e) => e.status === 409);
  }));

test('Thema: Recherche in feste Form – Minuten, Kapitelzahl, Quellen', () => {
  const r = normalizeResearch(
    { title: 'A/B', chapters: [{ title: 'Eins', minutes: 50 }, { title: '', minutes: 5 }, { title: 'Zwei', minutes: 50 }], sources: [{ id: 'V1', title: 'X', path: '/wiki/x' }], dossier: ' D ' },
    { minutes: 240, topic: 'T', read: ['wiki/x.md', 'wiki/y.md'] },
  );
  assert.equal(r.title, 'A B');
  assert.deepEqual(r.chapters.map((c) => [c.title, c.minutes]), [['Eins', 120], ['Zwei', 120]]);
  assert.deepEqual(r.sources.vault, [{ id: 'V1', title: 'X', path: 'wiki/x.md' }], 'Pfad ohne .md und mit / vorn passt');
  assert.equal(r.dossier, 'D');
  const empty = normalizeResearch({}, { minutes: 15, topic: 'Thema', read: ['a/b.md'] });
  assert.deepEqual(empty.chapters, [{ title: 'Thema', minutes: 15, points: '' }]);
  assert.deepEqual(empty.sources.vault, [{ id: '', title: 'b', path: 'a/b.md' }], 'ohne Angaben: alle gelesenen Notizen');
  const many = normalizeResearch({ chapters: Array.from({ length: 40 }, (_, i) => ({ title: `K${i}`, minutes: 1 })) }, { minutes: 240, topic: 'T' });
  assert.equal(many.chapters.length, 30);
  assert.match(chapterHint(10), /ein Kapitel/);
  assert.match(chapterHint(120), /etwa 10 Kapitel/);
  assert.match(chapterHint(240), /etwa 20 Kapitel, keins länger als 20 Minuten/);
});

test('Thema: Fortschritt mit Recherche und Kapiteln, Zusammenfassung am Knopf', () => {
  const at = Date.parse('2026-10-25T10:10:00Z');
  const base = { kind: 'report', source: 'thema', web: true, created_at: '2026-10-25T10:00:00Z' };
  const r = progressOf({ ...base, status: 'recherchiert', researching_at: '2026-10-25T10:03:00Z' }, at);
  assert.deepEqual(r.steps, ['Eingereiht', 'Claude recherchiert', 'Claude schreibt', 'Stimmen sprechen', 'Fertig']);
  assert.equal(r.step, 1);
  assert.equal(r.percent, null);
  assert.match(r.label, /recherchiert im Vault und im Internet, seit 7 Min\./);
  const w = progressOf({ ...base, status: 'schreibt', chapter: 3, chapters_total: 8, notes_read: 14, web_sources: 1 }, at);
  assert.equal(w.step, 2);
  assert.equal(w.percent, 25);
  assert.equal(w.label, 'Claude schreibt Kapitel 3 von 8, aus 14 Notizen und 1 Webquelle');
  assert.equal(progressOf({ ...base, status: 'spricht', done: 1, total: 4 }, at).step, 3);
  assert.deepEqual(topicSummary({ kind: 'podcast', minutes: 90, web: false }), { main: 'Podcast zum Thema · 90 Min. (1:30 Std.) · Vault', cost: 'rund 81.000 Zeichen bei ElevenLabs, dazu dein Claude-Abo' });
  assert.match(topicSummary({ kind: 'report', minutes: 300 }).main, /5 bis 240/);
});

test('Thema: Seite und Formular, auch ohne Haken beim Internet', () =>
  withDir(async (dir) => {
    const { episodes, calls } = setup(dir);
    const store = createReadingStore({ path: ':memory:' });
    const routes = readingRoutes({ store, episodes, logger: quiet });
    const ctx = (path) => ({ url: new URL(`https://vault.test${path}`), user: 'ruben', tz: 'Europe/Berlin', write: { csrf: 'c', back: path }, flash: null });
    const html = (await routes.pages['/lesen/folgen/thema'](ctx('/lesen/folgen/thema'))).html;
    assert.match(html, /<form method="post" action="\/aktion\/lesen\/folge\/thema"/);
    assert.match(html, /name="thema" required/);
    assert.match(html, /<textarea name="ziel"/);
    assert.match(html, /name="internet" value="1" checked/);
    assert.match(html, /name="art" value="report" checked/);
    assert.match(html, /name="minuten" min="5" max="240"/);
    assert.match(html, /value="120"[^>]*><span>2 Std\.<\/span>/);
    assert.match((await routes.pages['/lesen/folgen'](ctx('/lesen/folgen'))).html, /href="\/lesen\/folgen\/thema" class="btn">Zu einem Thema/);
    const api = JSON.parse((await routes.pages['/api/lesen/folgen/thema'](ctx('/api/lesen/folgen/thema'))).body);
    assert.deepEqual([api.enabled, api.min, api.max, api.missing], [true, 5, 240, null]);

    const r = await routes.actions['/aktion/lesen/folge/thema'](new URLSearchParams({ art: 'podcast', thema: 'Rückruf', ziel: '', minuten: '45' }), { sub: 'ruben' });
    assert.equal(r.redirect, '/lesen/folgen');
    assert.match(r.message, /Podcast zu „Rückruf“ entsteht im Hintergrund/);
    await new Promise((res) => setTimeout(res, 30));
    assert.deepEqual(calls.research[0].tools, [], 'ohne Haken kein Internet');
    await assert.rejects(routes.actions['/aktion/lesen/folge/thema'](new URLSearchParams({ art: 'report', thema: 'Rückruf', minuten: '' }), {}), /5 bis 240/);
  }));

/** Kindprozess-Attrappe für `claude -p`; merkt sich die MCP-Konfiguration, solange es sie gibt. */
function fakeClaude(answer) {
  const seen = {};
  const run = (command, args, opts) => {
    const at = args.indexOf('--mcp-config');
    Object.assign(seen, { command, args, opts, mcp: at >= 0 ? JSON.parse(readFileSync(args[at + 1], 'utf8')) : null });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.stdin.on('data', () => {});
    child.stdin.on('finish', () => {
      child.stdout.end(JSON.stringify(answer));
      child.stderr.end();
      setImmediate(() => child.emit('close', 0));
    });
    child.kill = () => {};
    return child;
  };
  return { run, seen };
}

test('Claude-Writer: mit Werkzeugen nur die genannten und der Vault-Server, Token nicht in der Kommandozeile', async () => {
  const { run, seen } = fakeClaude({ is_error: false, structured_output: { ok: true } });
  const writer = createClaudeWriter({ token: 'oat', run, logger: quiet });
  const mcp = { name: 'vault', config: { type: 'http', url: 'http://127.0.0.1:9/mcp', headers: { Authorization: 'Bearer geheim' } } };
  assert.deepEqual(await writer.write({ system: 'S', prompt: 'P', input: '', schema: { type: 'object' }, tools: ['WebSearch', 'WebFetch'], mcp }), { ok: true });
  const a = seen.args;
  assert.equal(a[a.indexOf('--tools') + 1], 'WebSearch,WebFetch');
  assert.equal(a[a.indexOf('--allowedTools') + 1], 'WebSearch,WebFetch,mcp__vault');
  assert.match(seen.opts.env.CLAUDE_CONFIG_DIR, /\.claude-config$/, 'frischer Konfigurationsordner statt der Einstellungen des Nutzers');
  assert.equal(a[a.indexOf('--setting-sources') + 1], '');
  for (const flag of ['--disable-slash-commands', '--strict-mcp-config']) assert.ok(a.includes(flag), flag);
  assert.ok(!a.includes('--safe-mode'), '--safe-mode schaltet auch --mcp-config ab');
  assert.equal(a[a.indexOf('--permission-mode') + 1], 'dontAsk');
  assert.deepEqual(seen.mcp, { mcpServers: { vault: mcp.config } });
  assert.ok(!a.join(' ').includes('geheim'));
  assert.ok(!existsSync(a[a.indexOf('--mcp-config') + 1]), 'Konfiguration danach weg');
});

test('Recherche-Vault: nur lesen, nie Vertrauliches, nur mit Token, merkt sich Gelesenes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vault-recherche-'));
  try {
    mkdirSync(join(root, 'projekte'), { recursive: true });
    mkdirSync(join(root, 'privat'), { recursive: true });
    writeFileSync(join(root, 'projekte/Hund.md'), '# Hund\n\nRückruf mit Pfeife. [[Geheim]] und [[Methode]]');
    writeFileSync(join(root, 'projekte/Methode.md'), '# Methode\n\nRückruf belohnen.');
    writeFileSync(join(root, 'privat/Geheim.md'), '# Geheim\n\nRückruf Diagnose. [[Hund]]');
    let index;
    buildIndex({ vaultPath: root, dbPath: ':memory:', policy: compilePolicy({ sensitive: { privat: 'privat' } }), persist: (db, vp) => (index = openIndex(db, { vaultPath: vp })), logger: quiet });
    const session = await createResearchVault({ index, logger: quiet }).open();
    const { url, headers } = session.mcp.config;
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    let id = 0;
    const rpc = async (method, params, auth = headers.Authorization) => {
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(auth ? { authorization: auth } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) });
      if (res.status !== 200) return { status: res.status };
      const text = await res.text();
      const line = text.split('\n').find((l) => l.startsWith('data: '));
      return JSON.parse(line ? line.slice(6) : text).result;
    };
    const call = async (name, args) => {
      const r = await rpc('tools/call', { name, arguments: args });
      return r.isError ? { error: r.content[0].text } : r.structuredContent;
    };
    try {
      assert.equal((await rpc('tools/list', {}, null)).status, 401);
      assert.equal((await rpc('tools/list', {}, 'Bearer falsch')).status, 401);
      const names = (await rpc('tools/list', {})).tools.map((t) => t.name).sort();
      assert.deepEqual(names, ['vault_links', 'vault_list', 'vault_read', 'vault_search', 'vault_similar']);
      for (const t of (await rpc('tools/list', {})).tools) assert.ok(!/sensitive/.test(JSON.stringify(t.inputSchema)), `${t.name} ohne Schalter für Vertrauliches`);

      const hits = await call('vault_search', { query: 'Rückruf', mode: 'text' });
      assert.deepEqual(hits.results.map((h) => h.path).sort(), ['projekte/Hund.md', 'projekte/Methode.md']);
      assert.match((await call('vault_read', { path: 'privat/Geheim.md' })).error, /vertraulich/);
      assert.match((await call('vault_read', { path: 'projekte/Hund.md' })).content, /Pfeife/);
      const links = await call('vault_links', { path: 'projekte/Hund.md' });
      assert.deepEqual(links.outgoing.map((l) => l.path), ['projekte/Methode.md']);
      assert.deepEqual(links.backlinks, []);
      assert.match((await call('vault_links', { path: 'privat/Geheim.md' })).error, /vertraulich/);
      assert.deepEqual((await call('vault_list', { folder: '' })).entries.map((e) => e.path).sort(), ['projekte/Hund.md', 'projekte/Methode.md']);
      assert.deepEqual(session.read(), ['projekte/Hund.md']);
    } finally {
      await session.close();
    }
    await assert.rejects(fetch(url, { method: 'POST' }), 'danach zu');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Thema: erst nur Transkript, Audio später ohne neue Recherche; Sprache aus den Einstellungen', () =>
  withDir(async (dir) => {
    const { episodes, calls } = setup(dir, { options: { language: () => 'en' } });
    const ep = episodes.createTopic({ kind: 'report', topic: 'Rückruf', minutes: 20, audio: false });
    assert.equal(ep.chars, 0);
    await ep.done;
    const t = episodes.get(ep.id);
    assert.equal(t.status, 'transkript');
    assert.equal(t.language, 'en');
    assert.equal(calls.notes.length, 1);
    assert.match(calls.notes[0].content, /\nsprache: en\n/);
    assert.deepEqual(calls.speech, [], 'noch nichts gesprochen');
    assert.match(calls.research[0].system, /auf Englisch/);
    assert.match(calls.research[0].prompt, /Sprache: Schreib .* auf Englisch/);
    assert.match(calls.chapters[0].prompt, /auf Englisch/);
    assert.deepEqual(progressOf({ ...t, status: 'schreibt' }).steps, ['Eingereiht', 'Claude recherchiert', 'Claude schreibt', 'Transkript fertig']);

    await episodes.speak(ep.id).done;
    assert.equal(episodes.get(ep.id).status, 'fertig');
    assert.equal(calls.research.length, 1, 'keine zweite Recherche');
    assert.equal(calls.chapters.length, 2, 'Claude schreibt nicht noch einmal');
    assert.equal(calls.notes.length, 1, 'Transkript nur einmal');
    assert.equal(calls.speech.length, 2);
  }));
