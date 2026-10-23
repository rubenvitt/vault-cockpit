import { setTimeout as delay } from 'node:timers/promises';

/** So lange wartet ein Aufruf höchstens auf Embeddings, danach mit dem, was da ist. */
const WAIT_MS = 1500;
/** Nach einem Fehler des Embedders so lange keine neuen Versuche. */
const PAUSE_MS = 5 * 60_000;
/** Texte je Aufruf an Ollama; kleine Pakete, damit eine frische Auswahl nicht hinter Hunderten wartet. */
const BATCH = 32;

/**
 * Embeddings kurzer Texte aus dem Lesestapel (Markierungen, eine Auswahl) nur
 * im Speicher, Schlüssel ist Modell + Text. Gemeinsam für das Wiedersehen
 * (VCP-74) und die Querverbindungen (VCP-73), damit jede Markierung nur einmal
 * eingebettet wird.
 *
 * - `embedder()` liefert den konfigurierten Embedder (`{ model, embed }`) oder `null`.
 * - Texte, die gerade schon eingebettet werden, gehen nicht noch einmal an Ollama.
 * - Nach einem Fehler ruht der Speicher `pauseMs` lang (Ollama aus, Modell lädt),
 *   `vectors` liefert dann `null`; `status()` sagt warum.
 */
export function createEmbedCache({ embedder = () => null, waitMs = WAIT_MS, pauseMs = PAUSE_MS, max = 2000, batch = BATCH, logger = console, label = 'Lesen' } = {}) {
  /** Modell + Text → Vektor. */
  const cache = new Map();
  /** Modell + Text → Auftrag, der ihn gerade einbettet. */
  const inflight = new Map();
  let pausedUntil = 0;
  let lastError = null;

  function current() {
    const e = embedder?.();
    return e && Date.now() >= pausedUntil ? e : null;
  }

  return {
    /**
     * Vektoren zu `texts` in derselben Reihenfolge, `undefined` für Texte, die
     * nach `waitMs` noch fehlen (sie landen im Hintergrund trotzdem im Speicher);
     * `null` ohne Embedder oder in der Pause nach einem Fehler.
     */
    async vectors(texts, { waitMs: wait = waitMs } = {}) {
      const e = current();
      if (!e) return null;
      const key = (t) => `${e.model}\n${t}`;
      // shortcut: alles leeren statt verdrängen, wenn der Speicher voll ist; reicht bei einigen tausend Markierungen.
      if (cache.size + texts.filter((t) => !cache.has(key(t))).length > max) cache.clear();
      const missing = [...new Set(texts)].filter((t) => !cache.has(key(t)) && !inflight.has(key(t)));
      // Pakete nacheinander; ein späterer Aufruf (frische Auswahl) kommt dazwischen dran.
      let prev = Promise.resolve();
      for (let i = 0; i < missing.length; i += batch) {
        const part = missing.slice(i, i + batch);
        const job = prev
          .then(async () => {
            if (Date.now() < pausedUntil) return;
            const vecs = await e.embed(part);
            part.forEach((t, k) => cache.set(key(t), vecs[k]));
          })
          .catch((err) => {
            pausedUntil = Date.now() + pauseMs;
            lastError = err.message;
            logger.warn?.(`${label}: keine Embeddings (${err.message})`);
          })
          .finally(() => part.forEach((t) => inflight.delete(key(t))));
        part.forEach((t) => inflight.set(key(t), job));
        prev = job;
      }
      const waiting = [...new Set(texts.map((t) => inflight.get(key(t))).filter(Boolean))];
      if (waiting.length && wait > 0) await Promise.race([Promise.all(waiting), delay(wait, null, { ref: false })]);
      return texts.map((t) => cache.get(key(t)));
    },

    /** `{ state: 'aus' | 'pause' | 'bereit', error }`, `error` ist der letzte Fehler des Embedders. */
    status() {
      if (!embedder?.()) return { state: 'aus', error: null };
      return { state: Date.now() < pausedUntil ? 'pause' : 'bereit', error: lastError };
    },
  };
}
