import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEpisodes, chunkText, dialogueBatches, stripId3, EpisodeError } from '../src/lesen/folgen.js';
import { parseRange } from '../src/lesen/folgen-page.js';
import { createClaudeWriter, WriterError } from '../src/lesen/claude.js';
import { createReadingStore } from '../src/lesen/store.js';
import { readingRoutes } from '../src/lesen/http.js';
import { createSpeech } from '../src/lesen/tts.js';
import { listenAudio } from '../src/lesen/listen.js';

const quiet = { info() {}, warn() {}, error() {} };
const TTS = { key: 'sk', voice: 'Erz', model: 'eleven_multilingual_v2' };

function withDir(run) {
  const dir = mkdtempSync(join(tmpdir(), 'cockpit-folgen-'));
  return Promise.resolve(run(dir)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

test('Folgen: Text in Stücke an Satzgrenzen, Gespräch in Abschnitte, ID3 weg, Range', () => {
  assert.deepEqual(chunkText('Eins. Zwei! Drei? Vier.', 12), ['Eins. Zwei!', 'Drei? Vier.']);
  assert.deepEqual(chunkText('Ein sehr langer Satz ohne Ende', 5), ['Ein sehr langer Satz ohne Ende'], 'zu langer Satz bleibt ganz');
  const batches = dialogueBatches([{ text: 'a'.repeat(10) + '.', voice: 'A' }, { text: 'Bb. Cc.', voice: 'B' }, { text: 'Dd.', voice: 'A' }], 15);
  assert.deepEqual(batches, [[{ text: 'a'.repeat(10) + '.', voice: 'A' }], [{ text: 'Bb. Cc.', voice: 'B' }, { text: 'Dd.', voice: 'A' }]]);

  const tagged = Buffer.concat([Buffer.from('ID3'), Buffer.from([4, 0, 0, 0, 0, 0, 2]), Buffer.from('xx'), Buffer.from('MP3')]);
  assert.equal(String(stripId3(tagged)), 'MP3');
  assert.equal(String(stripId3(Buffer.from('MP3'))), 'MP3');

  assert.equal(parseRange(null, 100), null);
  assert.deepEqual(parseRange('bytes=0-1', 100), [0, 1]);
  assert.deepEqual(parseRange('bytes=90-', 100), [90, 99]);
  assert.deepEqual(parseRange('bytes=-10', 100), [90, 99]);
  assert.deepEqual(parseRange('bytes=0-999', 100), [0, 99]);
  assert.equal(parseRange('bytes=200-300', 100), false);
});

/** Stapel mit zwei Texten, falsches ElevenLabs, falscher Claude, falsche Inbox. */
function setup(dir, { tts = TTS, writer = null } = {}) {
  const store = createReadingStore({ path: ':memory:' });
  const a = store.addDocument({ url: 'https://blatt.test/a', title: 'Vom Lesen', site: 'blatt.test', status: 'stapel', reading_minutes: 3, content_html: '<p>Erster Satz hier. Zweiter Satz dort.</p>' }).doc;
  const b = store.addDocument({ url: 'https://blatt.test/b', title: 'Vom Hören', status: 'stapel', reading_minutes: 2, content_html: '<p>Hören geht auch.</p>' }).doc;
  const calls = { speech: [], dialogue: [], writes: [], notes: [] };
  const provider = (cfg) => ({
    name: 'ElevenLabs',
    id: `el\n${cfg.voice}`,
    synthesize: async (input) => {
      calls.speech.push({ ...input, cfg });
      return Buffer.from(`[${input.text}]`);
    },
    dialogue: async ({ inputs }) => {
      calls.dialogue.push(inputs);
      return Buffer.from(inputs.map((i) => `${i.voice}:${i.text}`).join('|'));
    },
  });
  const fakeWriter = writer ?? {
    available: () => true,
    write: async (job) => {
      calls.writes.push(job);
      if (job.schema.required.includes('turns')) return { title: 'Lesen und Hören', turns: [{ speaker: 'A', text: 'Willkommen.' }, { speaker: 'B', text: 'Danke.' }, { speaker: 'A', text: '  ' }] };
      return { title: 'Report/Woche', note: '## Überblick\n\nZwei Texte.', spoken: 'Zwei Texte. Beide kurz.' };
    },
  };
  let current = tts;
  const speech = createSpeech({ settings: () => current, provider, logger: quiet });
  const episodes = createEpisodes({
    dir,
    store,
    tts: () => current,
    speech,
    voices: () => ({ host: 'Host', guest: 'Gast' }),
    writer: fakeWriter,
    capture: async (input) => {
      calls.notes.push(input);
      return { kind: 'note', path: 'inbox/Report Woche.md' };
    },
    provider,
    logger: quiet,
    now: () => new Date('2026-10-23T10:00:00Z'),
  });
  return { store, a, b, episodes, calls, speech, setTts: (v) => (current = v) };
}

test('Folgen: Vorlesen spricht die ganzen Texte mit der Erzählerstimme, eine MP3', () =>
  withDir(async (dir) => {
    const { a, b, episodes, calls } = setup(dir);
    const ep = episodes.create({ kind: 'vorlesen', docIds: [a.id, b.id, a.id, 'gibtsnicht'] });
    assert.equal(ep.status, 'wartet');
    assert.equal(ep.title, 'Vorlesen: Vom Lesen und 1 weitere');
    await ep.done;
    const done = episodes.get(ep.id);
    assert.equal(done.status, 'fertig');
    assert.deepEqual(calls.speech.map((c) => c.text), ['Vom Lesen. Von blatt.test. <break time="1.5s" />', 'Erster Satz hier.', 'Zweiter Satz dort.', 'Vom Hören. <break time="1.5s" />', 'Hören geht auch.']);
    assert.deepEqual([calls.speech[1].previous, calls.speech[1].next], [null, 'Zweiter Satz dort.'], 'Nachbarn wie beim Streamen');
    assert.equal(String(readFileSync(episodes.audioPath(ep.id))), calls.speech.map((c) => `[${c.text}]`).join(''), 'Reihenfolge bleibt, auch parallel');
    assert.equal(done.total, 5);
    assert.equal(done.bytes, readFileSync(episodes.audioPath(ep.id)).length);
    assert.equal(episodes.list()[0].id, ep.id);
  }));

test('Folgen: Vorlesen bezahlt nur, was nicht schon gestreamt oder offline geladen wurde', () =>
  withDir(async (dir) => {
    const { store, a, episodes, calls, speech } = setup(dir);
    // Ersten Satz vorher gestreamt, wie /lesen/hoeren/audio bzw. /api/app/audio.
    await listenAudio(store, speech, { id: a.id, von: '0', bis: '17' });
    assert.equal(calls.speech.length, 1);
    const head = 'Vom Lesen. Von blatt.test. <break time="1.5s" />'.length;
    const preview = episodes.preview({ kind: 'vorlesen', docIds: [a.id] });
    assert.equal(preview.chars, head + 'Zweiter Satz dort.'.length, 'Schätzung ohne den gehörten Satz');
    const ep = episodes.create({ kind: 'vorlesen', docIds: [a.id] });
    await ep.done;
    assert.deepEqual(calls.speech.slice(1).map((c) => c.text), ['Vom Lesen. Von blatt.test. <break time="1.5s" />', 'Zweiter Satz dort.'], 'gehörter Satz kommt aus dem Cache');
    assert.equal(episodes.get(ep.id).chars, preview.chars, 'berechnete Zeichen');
    assert.equal(String(readFileSync(episodes.audioPath(ep.id))), '[Vom Lesen. Von blatt.test. <break time="1.5s" />][Erster Satz hier.][Zweiter Satz dort.]');

    // Noch einmal: alles im Cache, kostet nichts.
    const again = episodes.create({ kind: 'vorlesen', docIds: [a.id] });
    assert.equal(again.chars, 0);
    await again.done;
    assert.equal(calls.speech.length, 3);
  }));

test('Folgen: Podcast mit zwei Stimmen über Text-to-Dialogue, Texte gehen an Claude', () =>
  withDir(async (dir) => {
    const { a, b, episodes, calls } = setup(dir);
    const ep = episodes.create({ kind: 'podcast', docIds: [a.id, b.id], minutes: 5 });
    assert.equal(ep.chars, 4500, 'Schätzung: 900 Zeichen je Minute');
    await ep.done;
    const done = episodes.get(ep.id);
    assert.equal(done.status, 'fertig', done.error);
    assert.equal(done.title, 'Lesen und Hören');
    assert.match(calls.writes[0].prompt, /etwa 5 Minuten/);
    assert.match(calls.writes[0].input, /<text nr="1" titel="Vom Lesen" quelle="https:\/\/blatt\.test\/a">\nErster Satz hier\. Zweiter Satz dort\.\n<\/text>/);
    assert.deepEqual(calls.dialogue, [[{ text: 'Willkommen.', voice: 'Host' }, { text: 'Danke.', voice: 'Gast' }]]);
    assert.equal(String(readFileSync(episodes.audioPath(ep.id))), 'Host:Willkommen.|Gast:Danke.');
    assert.equal(calls.speech.length, 0);
  }));

test('Folgen: Report als Notiz in die Inbox, eine Stimme liest die Sprechfassung', () =>
  withDir(async (dir) => {
    const { a, episodes, calls } = setup(dir);
    const ep = episodes.create({ kind: 'report', docIds: [a.id], minutes: 10 });
    await ep.done;
    const done = episodes.get(ep.id);
    assert.equal(done.status, 'fertig', done.error);
    assert.equal(done.title, 'Report Woche', 'ohne Pfadtrenner');
    assert.equal(done.note, 'inbox/Report Woche.md');
    assert.equal(calls.notes[0].title, 'Report Woche');
    assert.equal(calls.notes[0].captureId, `folge-${ep.id}`);
    assert.match(calls.notes[0].text, /^_Report aus dem Lesestapel, 2026-10-23, 1 Text \(Cockpit\)_\n\n## Überblick\n\nZwei Texte\.\n\n## Quellen\n\n- \[Vom Lesen\]\(https:\/\/blatt\.test\/a\)\n$/);
    assert.deepEqual(calls.speech.map((c) => [c.text, c.cfg.voice]), [['Zwei Texte. Beide kurz.', 'Erz']]);
  }));

test('Folgen: ohne Stimme oder Claude nicht anlegbar, Fehler bleibt stehen, Löschen', () =>
  withDir(async (dir) => {
    const failing = { available: () => true, write: async () => { throw new WriterError('Claude: Limit erreicht'); } };
    const { a, episodes, setTts } = setup(dir, { writer: failing });
    const ep = episodes.create({ kind: 'podcast', docIds: [a.id] });
    await ep.done;
    assert.equal(episodes.get(ep.id).status, 'fehler');
    assert.equal(episodes.get(ep.id).error, 'Claude: Limit erreicht');
    assert.equal(episodes.audioPath(ep.id), null);
    episodes.remove(ep.id);
    assert.equal(episodes.get(ep.id), null);

    assert.throws(() => episodes.create({ kind: 'podcast', docIds: [a.id], minutes: 7 }), /Länge/);
    assert.throws(() => episodes.create({ kind: 'film', docIds: [a.id] }), /Unbekannte Art/);
    assert.throws(() => episodes.create({ kind: 'vorlesen', docIds: ['x'] }), /Keiner der gewählten Texte/);
    setTts(null);
    assert.throws(() => episodes.create({ kind: 'vorlesen', docIds: [a.id] }), (e) => e instanceof EpisodeError && e.status === 409 && /ElevenLabs/.test(e.message));

    const noClaude = setup(join(dir, 'b'), { writer: { available: () => false } });
    assert.match(noClaude.episodes.availability().report, /CLAUDE_CODE_OAUTH_TOKEN/);
    assert.equal(noClaude.episodes.availability().vorlesen, null);
  }));

test('Folgen: nach einem Neustart ist Unterbrochenes ein Fehler, Wartendes läuft weiter', () =>
  withDir(async (dir) => {
    const at = '2026-10-23T09:00:00Z';
    writeFileSync(
      join(dir, 'folgen.json'),
      JSON.stringify([
        { id: 'x1', kind: 'vorlesen', title: 'Halb', docs: [], status: 'spricht', chars: 10, created_at: at, updated_at: at },
        { id: 'x2', kind: 'vorlesen', title: 'Fertig', docs: [], status: 'fertig', chars: 10, created_at: at, updated_at: at },
      ]),
    );
    const { episodes } = setup(dir);
    assert.equal(episodes.get('x1').status, 'fehler');
    assert.match(episodes.get('x1').error, /Neustart/);
    assert.equal(episodes.get('x2').status, 'fertig');
  }));

test('Folgen: Seiten ohne JavaScript, Anlegen per Formular, Audio mit Range', () =>
  withDir(async (dir) => {
    const { store, a, b, episodes } = setup(dir);
    const routes = readingRoutes({ store, episodes, logger: quiet });
    const ctx = (path, range = null) => ({ url: new URL(`https://vault.test${path}`), range, user: 'ruben', tz: 'Europe/Berlin', write: { csrf: 'c', back: path }, flash: null });
    const page = (path, range) => routes.pages[new URL(`https://vault.test${path}`).pathname](ctx(path, range));

    const neu = (await page('/lesen/folgen/neu?zeit=15')).html;
    assert.match(neu, new RegExp(`name="doc" value="${a.id}" checked`));
    assert.match(neu, new RegExp(`name="doc" value="${b.id}" checked`));
    assert.match(neu, /name="art" value="vorlesen" checked/);
    assert.match(neu, /rund \d+ Zeichen bei ElevenLabs/);
    assert.match((await page('/lesen/stapel?zeit=15')).html, /href="\/lesen\/folgen\/neu\?zeit=15" class="btn quiet">Folge erzeugen/);

    const form = new URLSearchParams([['art', 'vorlesen'], ['doc', a.id], ['laenge', '10']]);
    const r = await routes.actions['/aktion/lesen/folge/neu'](form, { sub: 'ruben' });
    assert.equal(r.redirect, '/lesen/folgen');
    assert.match(r.message, /^Vorlesen entsteht im Hintergrund/);
    await assert.rejects(routes.actions['/aktion/lesen/folge/neu'](new URLSearchParams([['art', 'podcast'], ['doc', a.id], ['laenge', '3']]), {}), /Länge/);

    await new Promise((res) => setTimeout(res, 20));
    const [ep] = episodes.list();
    assert.equal(ep.status, 'fertig');
    const list = (await page('/lesen/folgen')).html;
    assert.match(list, new RegExp(`<audio controls preload="none" src="/lesen/folgen/audio\\?id=${ep.id}"></audio>`));

    const full = await page(`/lesen/folgen/audio?id=${ep.id}`);
    assert.equal(full.status, 200);
    assert.equal(full.headers['accept-ranges'], 'bytes');
    const part = await page(`/lesen/folgen/audio?id=${ep.id}`, 'bytes=0-1');
    assert.equal(part.status, 206);
    assert.equal(part.body.length, 2);
    assert.equal(part.headers['content-range'], `bytes 0-1/${full.body.length}`);
    assert.equal((await page(`/lesen/folgen/audio?id=${ep.id}`, 'bytes=9999-')).status, 416);
    assert.equal((await page('/lesen/folgen/audio?id=gibtsnicht')).status, 404);

    await routes.actions['/aktion/lesen/folge/loeschen'](new URLSearchParams({ id: ep.id }), {});
    assert.match((await page('/lesen/folgen')).html, /Noch keine Folgen/);
  }));

/** Kindprozess-Attrappe für `claude -p`. */
function fakeClaude(answer, { code = 0 } = {}) {
  const seen = {};
  const run = (command, args, opts) => {
    Object.assign(seen, { command, args, opts });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    let input = '';
    child.stdin.on('data', (d) => (input += d));
    child.stdin.on('finish', () => {
      seen.input = input;
      child.stdout.end(typeof answer === 'string' ? answer : JSON.stringify(answer));
      child.stderr.end();
      setImmediate(() => child.emit('close', code));
    });
    child.kill = () => {};
    return child;
  };
  return { run, seen };
}

test('Claude-Writer: ohne Werkzeuge, mit Abo-Token statt API-Key, Ergebnis aus structured_output', async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-ant-fremd';
  try {
    const { run, seen } = fakeClaude({ type: 'result', subtype: 'success', is_error: false, result: '', structured_output: { title: 'T' }, num_turns: 2 });
    const writer = createClaudeWriter({ token: 'oat-abo', model: () => 'sonnet', run, logger: quiet });
    assert.equal(writer.available(), true);
    const out = await writer.write({ system: 'S', prompt: 'P', input: 'Texte', schema: { type: 'object' } });
    assert.deepEqual(out, { title: 'T' });
    assert.equal(seen.command, 'claude');
    assert.equal(seen.input, 'Texte');
    const a = seen.args;
    assert.deepEqual(a.slice(0, 2), ['-p', 'P']);
    for (const [flag, value] of [['--output-format', 'json'], ['--json-schema', '{"type":"object"}'], ['--system-prompt', 'S'], ['--tools', ''], ['--permission-mode', 'dontAsk'], ['--model', 'sonnet']]) {
      assert.equal(a[a.indexOf(flag) + 1], value, flag);
    }
    for (const flag of ['--safe-mode', '--strict-mcp-config', '--no-session-persistence']) assert.ok(a.includes(flag), flag);
    assert.equal(seen.opts.env.CLAUDE_CODE_OAUTH_TOKEN, 'oat-abo');
    assert.equal(seen.opts.env.ANTHROPIC_API_KEY, undefined, 'API-Key geht nicht mit, sonst rechnet die CLI darüber ab');
  } finally {
    delete process.env.ANTHROPIC_API_KEY;
  }
});

test('Claude-Writer: Fehler als Meldung', async () => {
  await assert.rejects(createClaudeWriter({ token: null }).write({ system: '', prompt: '', input: '', schema: {} }), /CLAUDE_CODE_OAUTH_TOKEN fehlt/);
  const cases = [
    [fakeClaude({ is_error: true, subtype: 'error_during_execution', result: 'Usage limit reached' }, { code: 1 }), /Claude: Usage limit reached/],
    [fakeClaude({ is_error: false, result: 'Nein.' }), /kein Ergebnis im verlangten Format/],
    [fakeClaude('kaputt'), /ohne JSON/],
  ];
  for (const [{ run }, msg] of cases) {
    await assert.rejects(createClaudeWriter({ token: 't', run, logger: quiet }).write({ system: '', prompt: '', input: '', schema: {} }), (e) => e instanceof WriterError && msg.test(e.message));
  }
  const missing = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    setImmediate(() => child.emit('error', Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' })));
    return child;
  };
  await assert.rejects(createClaudeWriter({ token: 't', run: missing, logger: quiet }).write({ system: '', prompt: '', input: '', schema: {} }), /nicht installiert/);
});

test('Einstellungen: Folgen-Stimmen, Moderation folgt der Vorlese-Stimme, Claude-Modell sonnet', async () => {
  const { createSettingsStore, validateSettings } = await import('../src/cockpit/settings.js');
  const s = createSettingsStore({ logger: quiet });
  assert.deepEqual(s.get().episodes, { host: 'JBFqnCBsd6RMkjVDRZzb', guest: 'EXAVITQu4vr4xnSDxMaL', model: 'sonnet' });
  s.save({ tts: { voice: 'Erz1' }, calendars: [] });
  assert.equal(s.get().episodes.host, 'Erz1');
  s.save({ tts: { voice: 'Erz1' }, episodes: { host: 'Mod2', guest: 'Gast3', model: 'opus' }, calendars: [] });
  assert.deepEqual(s.get().episodes, { host: 'Mod2', guest: 'Gast3', model: 'opus' });
  assert.throws(() => validateSettings({ episodes: { guest: 'zwei Wörter' } }), /Gast/);
  assert.throws(() => validateSettings({ episodes: { model: 'claude opus' } }), /Claude-Modell/);
});
