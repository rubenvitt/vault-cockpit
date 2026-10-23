import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createElevenLabs, createSpeech, createSpeechCache, SpeechError, ELEVENLABS_MODEL, ELEVENLABS_VOICE } from '../src/lesen/tts.js';
import { createSettingsStore, validateSettings, SettingsError } from '../src/cockpit/settings.js';
import { createReadingStore } from '../src/lesen/store.js';
import { readingRoutes } from '../src/lesen/http.js';
import { listenAudio, sentences } from '../src/lesen/listen.js';
import { htmlText } from '../src/lesen/anchor.js';

const quiet = { info() {}, warn() {}, error() {} };
const MP3 = Buffer.from('ID3-satz');

test('ElevenLabs: Anfrage mit Key, Modell, Stimme und Nachbarsätzen, MP3 zurück', async () => {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(MP3, { headers: { 'content-type': 'audio/mpeg' } });
  };
  const tts = createElevenLabs({ key: 'sk_test', fetch });
  const out = await tts.synthesize({ text: 'Zweiter Satz.', previous: 'Erster Satz.', next: 'x'.repeat(400) });
  assert.deepEqual(out, MP3);
  assert.equal(calls[0].url, `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE}?output_format=mp3_44100_128`);
  assert.equal(calls[0].init.headers['xi-api-key'], 'sk_test');
  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(Object.keys(body).sort(), ['model_id', 'next_text', 'previous_text', 'text']);
  assert.equal(body.model_id, ELEVENLABS_MODEL);
  assert.equal(body.previous_text, 'Erster Satz.');
  assert.equal(body.next_text.length, 300, 'Kontext gekürzt');
  assert.equal(tts.name, 'ElevenLabs');
});

test('ElevenLabs: Fehler als verständliche Meldung', async () => {
  const answer = (status, body) => async () => Response.json(body, { status });
  const cases = [
    [answer(401, { detail: { status: 'quota_exceeded', message: '…' } }), /Kontingent aufgebraucht/],
    [answer(401, { detail: { status: 'invalid_api_key' } }), /lehnt den API-Key ab/],
    [answer(404, { detail: { status: 'voice_not_found' } }), /kennt diese Stimme nicht/],
    [answer(429, { detail: { status: 'too_many_concurrent_requests' } }), /zu viele Anfragen/],
    [answer(500, { detail: 'kaputt' }), /HTTP 500: kaputt/],
    [async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }); }, /nicht erreichbar \(ENOTFOUND\)/],
  ];
  for (const [fetch, msg] of cases) {
    await assert.rejects(createElevenLabs({ key: 'k', fetch }).synthesize({ text: 'Hallo.' }), (e) => e instanceof SpeechError && e.status === 502 && msg.test(e.message));
  }
});

test('Stimme: aus ohne Einstellung, Cache und gleichzeitige Anfragen nur einmal, neuer Key ohne Neustart', async () => {
  let cfg = null;
  const made = [];
  let calls = 0;
  const provider = (c) => {
    made.push(c.key);
    return {
      name: 'ElevenLabs',
      id: `el\n${c.key}`,
      synthesize: async ({ text }) => {
        calls += 1;
        await new Promise((r) => setTimeout(r, 5));
        return Buffer.from(`${c.key}:${text}`);
      },
    };
  };
  const speech = createSpeech({ settings: () => cfg, provider, logger: quiet });
  assert.equal(speech.voice(), null);
  await assert.rejects(speech.audio({ text: 'Hallo.' }), (e) => e instanceof SpeechError && e.status === 404);

  cfg = { key: 'k1', voice: 'v', model: 'm' };
  assert.equal(speech.voice(), 'ElevenLabs');
  const [a, b] = await Promise.all([speech.audio({ text: 'Hallo.' }), speech.audio({ text: 'Hallo.' })]);
  assert.equal(String(a), 'k1:Hallo.');
  assert.deepEqual(a, b);
  assert.equal(calls, 1, 'Vorladen und Abspielen gehen nur einmal raus');
  await speech.audio({ text: 'Hallo.' });
  assert.equal(calls, 1, 'aus dem Cache');
  await speech.audio({ text: 'Hallo.', next: 'Danach.' });
  assert.equal(calls, 2, 'anderer Kontext, anderer Ton');

  cfg = { key: 'k2', voice: 'v', model: 'm' };
  assert.equal(String(await speech.audio({ text: 'Hallo.' })), 'k2:Hallo.');
  assert.deepEqual(made, ['k1', 'k2']);
});

test('Stimme: Cache auf der Platte, räumt die am längsten nicht gehörten Dateien weg', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cockpit-tts-'));
  try {
    const cache = createSpeechCache({ dir: join(dir, 'tts'), maxBytes: 100, logger: quiet });
    assert.equal(cache.get('a'), null);
    cache.put('a', Buffer.alloc(40));
    cache.put('b', Buffer.alloc(40));
    // `a` älter machen, dann hören: `get` frischt auf, `b` ist danach das älteste.
    const old = new Date(Date.now() - 60_000);
    utimesSync(join(dir, 'tts', 'a.mp3'), old, old);
    utimesSync(join(dir, 'tts', 'b.mp3'), new Date(Date.now() - 30_000), new Date(Date.now() - 30_000));
    assert.equal(cache.get('a').length, 40);
    cache.put('c', Buffer.alloc(40));
    assert.deepEqual(readdirSync(join(dir, 'tts')).sort(), ['a.mp3', 'c.mp3']);
    assert.equal(cache.get('b'), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Einstellungen: Vorlesen mit ElevenLabs, Key aus der Umgebung, Gerät als Standard', () => {
  const bare = createSettingsStore({ logger: quiet });
  assert.equal(bare.get().tts, null, 'ohne Key liest das Gerät');

  const env = createSettingsStore({ defaults: { elevenlabsKey: 'sk_env' }, logger: quiet });
  assert.deepEqual(env.get().tts, { provider: 'elevenlabs', key: 'sk_env', voice: ELEVENLABS_VOICE, model: ELEVENLABS_MODEL, source: 'umgebung' });
  env.save({ tts: { provider: 'geraet' }, calendars: [] });
  assert.equal(env.get().tts, null, 'Gerät gewählt, trotz Key');
  env.save({ tts: { provider: 'elevenlabs', key: 'sk_eigen', voice: 'AbC123', model: 'eleven_flash_v2_5' }, calendars: [] });
  assert.deepEqual(env.get().tts, { provider: 'elevenlabs', key: 'sk_eigen', voice: 'AbC123', model: 'eleven_flash_v2_5', source: 'einstellungen' });

  const forced = createSettingsStore({ defaults: { ttsProvider: 'geraet', elevenlabsKey: 'sk_env' }, logger: quiet });
  assert.equal(forced.get().tts, null, 'TTS_PROVIDER=geraet schaltet ab');
  const noKey = createSettingsStore({ logger: quiet });
  noKey.save({ tts: { provider: 'elevenlabs' }, calendars: [] });
  assert.equal(noKey.get().tts, null, 'ElevenLabs ohne Key: Gerät');

  for (const [input, msg] of [
    [{ tts: { provider: 'polly' } }, /Anbieter/],
    [{ tts: { voice: 'George Stimme' } }, /Voice-ID/],
    [{ tts: { model: 'eleven multilingual' } }, /Model-ID/],
  ]) {
    assert.throws(() => validateSettings(input), (e) => e instanceof SettingsError && msg.test(e.message));
  }
  assert.deepEqual(validateSettings({ calendars: [] }).tts, { provider: null, key: null, voice: null, model: null }, 'ältere Datei bleibt gültig');
});

function setup({ voice = true } = {}) {
  const store = createReadingStore({ path: ':memory:' });
  const html = '<p>Erster Satz hier. Zweiter Satz dort. Dritter Satz.</p>';
  const { doc } = store.addDocument({ url: 'https://blatt.test/a', title: 'Vom Lesen', status: 'stapel', reading_minutes: 5, content_html: html });
  const asked = [];
  const speech = voice
    ? {
        voice: () => 'ElevenLabs',
        audio: async (input) => {
          asked.push(input);
          return MP3;
        },
      }
    : null;
  const routes = readingRoutes({ store, speech, logger: quiet });
  const page = (path) => routes.pages[new URL(`https://vault.test${path}`).pathname]({ url: new URL(`https://vault.test${path}`), user: 'ruben', tz: 'Europe/Berlin', write: { csrf: 'c', back: path }, flash: null });
  const at = (prefix) => sentences(html).find(({ start }) => htmlText(html).startsWith(prefix, start));
  return { store, doc, page, at, asked, speech };
}

test('Hören: Satz als MP3 mit Nachbarsätzen, nur Text aus dem Stapel', async () => {
  const { store, doc, page, at, asked, speech } = setup();
  const s = at('Zweiter');
  const r = await page(`/lesen/hoeren/audio?id=${doc.id}&von=${s.start}&bis=${s.end}`);
  assert.equal(r.headers['content-type'], 'audio/mpeg');
  assert.deepEqual(r.body, MP3);
  assert.deepEqual(asked.at(-1), { text: 'Zweiter Satz dort.', previous: 'Erster Satz hier.', next: 'Dritter Satz.' });

  // Kein Satzanfang: kein Kontext, aber vorgelesen wird trotzdem nur, was im Text steht.
  await listenAudio(store, speech, { id: doc.id, von: '2', bis: '10' });
  assert.deepEqual(asked.at(-1), { text: 'ster Sat', previous: null, next: null });

  for (const [query, status] of [
    [`id=gibtsnicht&von=0&bis=5`, 404],
    [`id=${doc.id}&von=5&bis=5`, 400],
    [`id=${doc.id}&von=0&bis=9999`, 400],
    [`id=${doc.id}&von=-1&bis=5`, 400],
    [`id=${doc.id}&von=0`, 400],
  ]) {
    const bad = await page(`/lesen/hoeren/audio?${query}`);
    assert.equal(bad.status, status, query);
    assert.match(bad.headers['content-type'], /^application\/json/);
  }

  const { html } = await page('/lesen/hoeren?zeit=15');
  assert.match(html, /<div class="hoeren-player" data-voice="ElevenLabs" hidden>/);
});

test('Hören: ohne Stimme vom Server 404 und kein data-voice', async () => {
  const { doc, page } = setup({ voice: false });
  const r = await page(`/lesen/hoeren/audio?id=${doc.id}&von=0&bis=5`);
  assert.equal(r.status, 404);
  assert.match(JSON.parse(r.body).message, /Einstellungen → Vorlesen/);
  assert.match((await page('/lesen/hoeren?zeit=15')).html, /<div class="hoeren-player" hidden>/);
});
