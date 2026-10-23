import { mkdirSync, readdirSync, statSync, unlinkSync, utimesSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

/**
 * Stimme vom Server für „Unterwegs hören“: ElevenLabs statt der Sprachausgabe
 * des Geräts. Aus, bis unter Einstellungen → Vorlesen (oder per
 * `ELEVENLABS_API_KEY`) ein Key steht; dann holen Web-Player und iOS-App die
 * Sätze als MP3 über `/lesen/hoeren/audio` bzw. `/api/app/audio`
 * (src/lesen/listen.js). Der Key verlässt den Server nie.
 *
 * Jeder Satz kostet Zeichen-Kontingent. Deshalb liegt jede Antwort auf der
 * Platte (`TTS_CACHE_DIR`, Schlüssel aus Modell, Stimme, Format und Text samt
 * Nachbarsätzen), und gleichzeitige Anfragen für denselben Satz (Vorladen und
 * Abspielen) gehen nur einmal raus. Wird der Cache größer als `maxBytes`,
 * fliegen die am längsten nicht gehörten Dateien.
 *
 * Ein anderer Anbieter wäre ein weiterer Client mit derselben Form
 * `{ id, synthesize({ text, previous, next }) → Buffer }`.
 */

export const ELEVENLABS_MODEL = 'eleven_multilingual_v2';
// „George“, eine der Standardstimmen; mit dem mehrsprachigen Modell spricht sie auch Deutsch.
export const ELEVENLABS_VOICE = 'JBFqnCBsd6RMkjVDRZzb';
const API = 'https://api.elevenlabs.io';
const FORMAT = 'mp3_44100_128';
// Kontext für den Tonfall: so viel vom Satz davor und danach geht mit, ohne dass es extra kostet.
const CONTEXT = 300;

export class SpeechError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

function elevenLabsMessage(status, body) {
  const detail = body?.detail;
  const code = typeof detail === 'object' ? detail?.status : null;
  if (code === 'quota_exceeded') return 'ElevenLabs: Kontingent aufgebraucht';
  if (code === 'voice_not_found') return 'ElevenLabs kennt diese Stimme nicht (Einstellungen → Vorlesen)';
  if (status === 401) return 'ElevenLabs lehnt den API-Key ab (Einstellungen → Vorlesen)';
  if (status === 429) return 'ElevenLabs: zu viele Anfragen, gleich noch einmal';
  const text = typeof detail === 'string' ? detail : detail?.message;
  return `ElevenLabs antwortet mit HTTP ${status}${text ? `: ${String(text).slice(0, 200)}` : ''}`;
}

/** Client für `POST /v1/text-to-speech/{voice}`; `fetch` nur für Tests. */
export function createElevenLabs({ key, voice = ELEVENLABS_VOICE, model = ELEVENLABS_MODEL, fetch = globalThis.fetch, timeoutMs = 60_000 }) {
  async function synthesize({ text, previous = null, next = null }) {
    const body = { text, model_id: model };
    // Ohne `language_code`: Im Stapel liegen auch englische Texte, das Modell erkennt die Sprache selbst.
    if (previous) body.previous_text = previous.slice(-CONTEXT);
    if (next) body.next_text = next.slice(0, CONTEXT);
    let res;
    try {
      res = await fetch(`${API}/v1/text-to-speech/${encodeURIComponent(voice)}?output_format=${FORMAT}`, {
        method: 'POST',
        headers: { 'xi-api-key': key, 'content-type': 'application/json', accept: 'audio/mpeg' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new SpeechError(`ElevenLabs nicht erreichbar (${err.cause?.code ?? err.message})`);
    }
    if (!res.ok) throw new SpeechError(elevenLabsMessage(res.status, await res.json().catch(() => null)));
    try {
      return Buffer.from(await res.arrayBuffer());
    } catch (err) {
      throw new SpeechError(`ElevenLabs: Antwort abgebrochen (${err.cause?.code ?? err.message})`);
    }
  }

  return { name: 'ElevenLabs', id: ['elevenlabs', model, voice, FORMAT].join('\n'), synthesize };
}

/**
 * MP3-Dateien je Satz auf der Platte. Ohne `dir` nur im Speicher (Tests).
 * `get` frischt die Änderungszeit auf, damit oft Gehörtes bleibt.
 */
export function createSpeechCache({ dir = null, maxBytes = 500 * 1024 * 1024, logger = console }) {
  const memory = new Map();
  let total = null;

  function scan() {
    try {
      return readdirSync(dir)
        .filter((f) => f.endsWith('.mp3'))
        .map((f) => {
          const path = join(dir, f);
          const s = statSync(path);
          return { path, size: s.size, mtime: s.mtimeMs };
        });
    } catch {
      return [];
    }
  }

  function prune() {
    const files = scan().sort((a, b) => a.mtime - b.mtime);
    total = files.reduce((sum, f) => sum + f.size, 0);
    // Bis auf 90 %, damit nicht jede neue Datei wieder aufräumt.
    for (const f of files) {
      if (total <= maxBytes * 0.9) break;
      try {
        unlinkSync(f.path);
        total -= f.size;
      } catch (err) {
        logger.warn?.(`Vorlesen: ${f.path} nicht gelöscht: ${err.message}`);
      }
    }
  }

  return {
    get(key) {
      if (!dir) return memory.get(key) ?? null;
      const path = join(dir, `${key}.mp3`);
      try {
        const data = readFileSync(path);
        const now = new Date();
        utimesSync(path, now, now);
        return data;
      } catch {
        return null;
      }
    },
    put(key, data) {
      if (!dir) return void memory.set(key, data);
      try {
        mkdirSync(dir, { recursive: true });
        // Erst ganz schreiben, dann umbenennen: Ein Abbruch hinterlässt keine halbe Datei, die als Treffer gälte.
        const path = join(dir, `${key}.mp3`);
        writeFileSync(`${path}.${process.pid}.tmp`, data, { mode: 0o600 });
        renameSync(`${path}.${process.pid}.tmp`, path);
      } catch (err) {
        return logger.warn?.(`Vorlesen: Cache nicht beschreibbar: ${err.message}`);
      }
      // Einmal zählen, danach nur dazurechnen; die neue Datei liegt beim ersten Zählen schon da.
      total = total === null ? scan().reduce((sum, f) => sum + f.size, 0) : total + data.length;
      if (total > maxBytes) prune();
    },
  };
}

/**
 * Stimme nach den Einstellungen: `settings()` liefert `{ key, voice, model }`
 * oder `null` (Gerätestimme). Ein neuer Key, eine neue Stimme oder ein neues
 * Modell wirken ohne Neustart. `provider` ersetzt den ElevenLabs-Client (Tests).
 */
export function createSpeech({ settings, cache = createSpeechCache({}), provider = (cfg) => createElevenLabs(cfg), logger = console }) {
  let current = null;
  let currentKey = null;
  const running = new Map();

  function client() {
    const cfg = settings();
    const key = cfg ? `${cfg.key}\n${cfg.voice}\n${cfg.model}` : null;
    if (key !== currentKey) {
      currentKey = key;
      current = cfg ? provider(cfg) : null;
    }
    return current;
  }

  return {
    /** Name des Anbieters, `null` ohne Stimme vom Server. */
    voice: () => client()?.name ?? null,

    /** MP3 zu `text`; `previous`/`next` sind die Nachbarsätze für einen durchgehenden Tonfall. */
    async audio({ text, previous = null, next = null }) {
      const c = client();
      if (!c) throw new SpeechError('Keine Stimme auf dem Server eingerichtet (Einstellungen → Vorlesen)', 404);
      const key = createHash('sha256').update(JSON.stringify([c.id, text, previous, next])).digest('hex');
      const cached = cache.get(key);
      if (cached) return cached;
      if (!running.has(key)) {
        const job = c
          .synthesize({ text, previous, next })
          .then((data) => {
            cache.put(key, data);
            return data;
          })
          .catch((err) => {
            logger.warn?.(`Vorlesen: ${err.message}`);
            throw err;
          })
          .finally(() => running.delete(key));
        running.set(key, job);
      }
      return running.get(key);
    },
  };
}
