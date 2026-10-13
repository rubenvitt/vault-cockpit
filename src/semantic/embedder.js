/**
 * Embeddings über einen Ollama-Server (`POST /api/embed`).
 *
 * Das Modell läuft lokal in einem eigenen Container (Standard `bge-m3`,
 * mehrsprachig, 1024 Dimensionen). Das Cockpit bleibt frei von Modellgewichten
 * und nativen Abhängigkeiten; ein anderer Anbieter wäre nur ein weiterer Client
 * mit derselben Form `embed(texts) → Float32Array[]`.
 *
 * Fehlt das Modell auf dem Server, zieht der Client es einmal selbst
 * (`POST /api/pull`), damit der erste Start ohne Handarbeit auskommt.
 */
export function createOllamaEmbedder({ url, model = 'bge-m3', fetch = globalThis.fetch, timeoutMs = 120_000, pullTimeoutMs = 30 * 60_000, logger = console }) {
  const base = String(url).replace(/\/+$/, '');
  let pulled = false;

  async function post(path, body, timeout) {
    try {
      return await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeout),
      });
    } catch (err) {
      throw new Error(`Ollama unter ${base} nicht erreichbar (${err.cause?.code ?? err.message})`);
    }
  }

  async function pull() {
    logger.info?.(`Embeddings: Modell ${model} fehlt auf ${base}, wird geladen …`);
    const res = await post('/api/pull', { model, stream: false }, pullTimeoutMs);
    if (!res.ok) throw new Error(`Ollama lädt ${model} nicht (HTTP ${res.status})`);
    pulled = true;
    logger.info?.(`Embeddings: Modell ${model} geladen`);
  }

  async function embed(texts) {
    if (!texts.length) return [];
    let res = await post('/api/embed', { model, input: texts }, timeoutMs);
    if (res.status === 404 && !pulled) {
      await pull();
      res = await post('/api/embed', { model, input: texts }, timeoutMs);
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Ollama antwortet mit HTTP ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`);
    }
    const out = await res.json();
    const vectors = out?.embeddings;
    if (!Array.isArray(vectors) || vectors.length !== texts.length) {
      throw new Error('Ollama hat nicht für jeden Text ein Embedding geliefert');
    }
    return vectors.map((v) => normalize(Float32Array.from(v)));
  }

  return { model, embed };
}

/** Auf Länge 1 bringen, damit Kosinus-Ähnlichkeit ein Skalarprodukt ist. */
export function normalize(vec) {
  let sum = 0;
  for (let i = 0; i < vec.length; i += 1) sum += vec[i] * vec[i];
  const len = Math.sqrt(sum);
  if (len > 0) for (let i = 0; i < vec.length; i += 1) vec[i] /= len;
  return vec;
}

export function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i += 1) s += a[i] * b[i];
  return s;
}
