import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEmbedCache } from '../src/lesen/embed-cache.js';

const quiet = { info() {}, warn() {}, error() {} };

test('Embedding-Speicher: jeder Text einmal, in Paketen, gleichzeitige Aufrufe teilen sich den Auftrag', async () => {
  const calls = [];
  const e = { model: 'm', embed: async (texts) => (calls.push(texts), texts.map((t) => Float32Array.from([t.length]))) };
  const cache = createEmbedCache({ embedder: () => e, batch: 2, logger: quiet });
  const [a, b] = await Promise.all([cache.vectors(['x', 'yy', 'zzz']), cache.vectors(['yy', 'zzz'])]);
  assert.deepEqual(calls, [['x', 'yy'], ['zzz']]);
  assert.deepEqual(a.map((v) => v[0]), [1, 2, 3]);
  assert.deepEqual(b.map((v) => v[0]), [2, 3]);
  await cache.vectors(['x']);
  assert.equal(calls.length, 2, 'schon eingebettet');
  assert.deepEqual(cache.status(), { state: 'bereit', error: null });
});

test('Embedding-Speicher: ohne Embedder null, nach einem Fehler Pause, langsame Texte fehlen vorerst', async () => {
  assert.equal(await createEmbedCache({ logger: quiet }).vectors(['x']), null);
  assert.equal(createEmbedCache({ logger: quiet }).status().state, 'aus');

  let calls = 0;
  const broken = createEmbedCache({ embedder: () => ({ model: 'm', embed: async () => (calls++, Promise.reject(new Error('nicht erreichbar'))) }), logger: quiet });
  assert.deepEqual(await broken.vectors(['x']), [undefined]);
  assert.deepEqual(broken.status(), { state: 'pause', error: 'nicht erreichbar' });
  assert.equal(await broken.vectors(['x']), null);
  assert.equal(calls, 1);

  let release;
  const slow = createEmbedCache({ embedder: () => ({ model: 'm', embed: (texts) => new Promise((r) => (release = () => r(texts.map(() => Float32Array.from([1]))))) }), waitMs: 10, logger: quiet });
  assert.deepEqual(await slow.vectors(['x']), [undefined]);
  release();
  await new Promise((r) => setImmediate(r));
  assert.equal((await slow.vectors(['x']))[0][0], 1);
});
