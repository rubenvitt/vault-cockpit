import { readFileSync, writeFileSync, renameSync, mkdirSync, appendFileSync, rmSync, statSync, existsSync, truncateSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { htmlText } from './anchor.js';
import { sentences } from './listen.js';
import { createElevenLabs, DIALOGUE_CHARS } from './tts.js';

/**
 * Folgen aus dem Lesestapel: eine MP3, im Hintergrund erzeugt, auf Knopfdruck.
 *
 * - **Vorlesen**: die ganzen Texte nacheinander, eine Erzählerstimme (die
 *   Stimme unter Einstellungen → Vorlesen). Ohne Claude. Satz für Satz über
 *   `speech` (src/lesen/tts.js), mit denselben Nachbarsätzen wie beim Streamen:
 *   Was schon gehört oder offline geladen wurde, liegt im Cache und kostet
 *   nichts mehr, und umgekehrt.
 * - **Podcast**: Claude schreibt ein Gespräch zweier Stimmen über die Texte,
 *   ElevenLabs spricht es mit Text-to-Dialogue (`eleven_v3`).
 * - **Report**: Claude schreibt einen Bericht; er kommt als Notiz in die
 *   Vault-Inbox, eine Stimme liest die Sprechfassung.
 *
 * Claude läuft über die CLI mit dem Abo (src/lesen/claude.js). Die Folgen
 * liegen unter `dir` (`folgen.json`, je Folge `<id>.mp3`), es läuft immer nur
 * eine. Nichts Bezahltes geht verloren: Claudes Skript liegt als
 * `<id>.skript.json`, sobald es da ist, und die schon gesprochenen Abschnitte
 * bleiben in `<id>.mp3.part`. Nach einem Fehler setzt `retry` dort fort; nach
 * einem Neustart geht das von selbst, wenn das Skript schon da ist (Vorlesen
 * holt Gesprochenes ohnehin aus dem Satz-Cache). Fehlt das Skript, müsste
 * Claude noch einmal schreiben; das entscheidet der Nutzer.
 */

export const KINDS = { vorlesen: 'Vorlesen', podcast: 'Podcast', report: 'Report' };
/** Länge von Podcast und Report in Minuten. */
export const LENGTHS = [5, 10, 20];
// Gesprochenes Deutsch: rund 150 Wörter zu 6 Zeichen in der Minute.
export const CHARS_PER_MINUTE = 900;
export const MAX_DOCS = 20;
// Je Anfrage bei der Sprechfassung des Reports; ElevenLabs nimmt mehr, kürzere Stücke scheitern seltener.
const NARRATION_CHARS = 3000;
// So viele Sätze gleichzeitig beim Vorlesen; mehr erlaubt ElevenLabs je nach Tarif nicht.
const PARALLEL = 3;
// So viel Text je Dokument und insgesamt geht an Claude.
const DOC_INPUT = 60_000;
const TOTAL_INPUT = 300_000;
const STATES = { wartet: 'wartet', schreibt: 'Claude schreibt', spricht: 'wird gesprochen', fertig: 'fertig', fehler: 'Fehler' };
/** `mp3_44100_128` (src/lesen/tts.js) hat eine feste Bitrate: 16 000 Bytes je Sekunde. */
export const BYTES_PER_SECOND = 16_000;

export class EpisodeError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

/** Sätze zu Stücken von höchstens `max` Zeichen; ein längerer Satz bleibt ein eigenes Stück. */
export function chunkText(text, max) {
  const parts = String(text).match(/[^.!?…]+(?:[.!?…]+["'”“»«’)\]]*|$)\s*/gu) ?? [];
  const out = [];
  let cur = '';
  for (const p of parts) {
    if (cur && cur.length + p.length > max) {
      out.push(cur.trim());
      cur = '';
    }
    cur += p;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** Gesprächszüge `[{ text, voice }]` zu Anfragen mit höchstens `max` Zeichen; lange Züge werden geteilt. */
export function dialogueBatches(turns, max = DIALOGUE_CHARS) {
  const inputs = turns.flatMap((t) => chunkText(t.text, max).map((text) => ({ text, voice: t.voice })));
  const batches = [];
  let cur = [];
  let size = 0;
  for (const i of inputs) {
    if (cur.length && size + i.text.length > max) {
      batches.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(i);
    size += i.text.length;
  }
  if (cur.length) batches.push(cur);
  return batches;
}

/** ID3v2-Kopf vorn weg, damit aneinandergehängte MP3-Stücke keinen Tag mitten im Strom haben. */
export function stripId3(buf) {
  if (buf.length < 10 || buf.toString('latin1', 0, 3) !== 'ID3') return buf;
  const size = (buf[6] << 21) | (buf[7] << 14) | (buf[8] << 7) | buf[9];
  return buf.subarray(10 + size);
}

const BITRATES = { 1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320], 2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160] };
const RATES = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

/** Kopf eines MPEG-Layer-III-Frames bei `at`: `{ length, tag }` (`tag`: Info/Xing/VBRI-Frame), sonst null. */
function frameAt(buf, at) {
  if (at + 4 > buf.length || buf[at] !== 0xff || (buf[at + 1] & 0xe0) !== 0xe0) return null;
  const version = (buf[at + 1] >> 3) & 3;
  if (version === 1 || ((buf[at + 1] >> 1) & 3) !== 1) return null;
  const kbps = BITRATES[version === 3 ? 1 : 2][(buf[at + 2] >> 4) & 15];
  const rate = RATES[version][(buf[at + 2] >> 2) & 3];
  if (!kbps || !rate) return null;
  const length = Math.floor(((version === 3 ? 144 : 72) * kbps * 1000) / rate) + ((buf[at + 2] >> 1) & 1);
  const mono = (buf[at + 3] >> 6) === 3;
  const side = version === 3 ? (mono ? 17 : 32) : mono ? 9 : 17;
  const id = buf.toString('latin1', at + 4 + side, at + 8 + side);
  return { length, tag: id === 'Info' || id === 'Xing' || buf.toString('latin1', at + 36, at + 40) === 'VBRI' };
}

/**
 * Nur die Audio-Frames: ohne ID3-Tags und ohne Info/Xing-Frame. Den Info-Frame
 * schreibt der Encoder an den Anfang jedes Stücks, mit der Länge nur dieses
 * Stücks. Hängen mehrere Stücke hintereinander, liest AVFoundation (iOS,
 * Safari) die Länge daraus und hält die Folge für so lang wie das erste Stück.
 * Ohne ihn rechnen Player mit der festen Bitrate. Was kein MP3 ist, bleibt, wie es ist.
 */
export function audioFrames(buf) {
  let at = 0;
  const out = [];
  let any = false;
  while (at < buf.length) {
    if (buf.toString('latin1', at, at + 3) === 'ID3' && at + 10 <= buf.length) {
      at += 10 + ((buf[at + 6] << 21) | (buf[at + 7] << 14) | (buf[at + 8] << 7) | buf[at + 9]);
      continue;
    }
    const frame = frameAt(buf, at);
    if (!frame) {
      // Kein Frame: Rest unverändert, damit nichts verloren geht (auch Nicht-MP3 in Tests).
      if (!any) return stripId3(buf);
      out.push(buf.subarray(at));
      break;
    }
    any = true;
    if (!frame.tag) out.push(buf.subarray(at, at + frame.length));
    at += frame.length;
  }
  return out.length === 1 ? out[0] : Buffer.concat(out);
}

const plain = (doc) => htmlText(doc.content_html ?? '').trim();

/**
 * Anfragen zum Vorlesen eines Textes: Titel und Quelle mit kurzer Pause, dann
 * jeder Satz mit Nachbarsätzen genau wie `listenAudio` (src/lesen/listen.js),
 * damit der Cache für beide gilt.
 */
function narration(doc, model) {
  const html = doc.content_html ?? '';
  const text = htmlText(html);
  // Pausen-Tags kennt `eleven_v3` nicht, dort würden sie vorgelesen.
  const pause = /^eleven_v3/.test(model) ? '' : ' <break time="1.5s" />';
  const head = { text: `${doc.title || doc.site || 'Ohne Titel'}.${doc.site ? ` Von ${doc.site}.` : ''}${pause}`, previous: null, next: null };
  const list = sentences(html);
  const say = (s) => (s ? text.slice(s.start, s.end) : null);
  return [head, ...list.map((s, i) => ({ text: say(s).trim(), previous: i > 0 ? say(list[i - 1]) : null, next: say(list[i + 1]) }))];
}

/**
 * Führt `jobs` mit höchstens `n` gleichzeitig aus und reicht die Ergebnisse in
 * Reihenfolge an `each`. `each` ist synchron: Ohne `await` dazwischen kann kein
 * zweiter Worker dasselbe Stück schreiben.
 */
async function inOrder(jobs, n, each) {
  const results = new Array(jobs.length);
  let started = 0;
  let written = 0;
  let failed = null;
  async function worker() {
    while (started < jobs.length && !failed) {
      const i = started++;
      try {
        results[i] = { value: await jobs[i]() };
      } catch (err) {
        failed ??= err;
        return;
      }
      while (written < jobs.length && results[written]) {
        each(results[written].value, written);
        results[written] = true;
        written += 1;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, jobs.length) }, worker));
  if (failed) throw failed;
}

/** Texte für Claude, je Text mit Nummer, Titel und Quelle. */
function sourceInput(docs) {
  let left = TOTAL_INPUT;
  return docs
    .map((d, i) => {
      const body = plain(d).slice(0, Math.max(0, Math.min(DOC_INPUT, left)));
      left -= body.length;
      return `<text nr="${i + 1}" titel="${String(d.title || d.url).replace(/"/g, "'")}" quelle="${d.url}">\n${body}\n</text>`;
    })
    .join('\n\n');
}

const SYSTEM = 'Du schreibst auf Deutsch für einen Menschen, der seinen Lesestapel unterwegs hört. Du arbeitest nur mit den Texten, die du bekommst, erfindest nichts dazu und sagst, wenn die Texte etwas offenlassen. Du lieferst ausschließlich das verlangte JSON.';

function podcastJob(docs, minutes) {
  const chars = minutes * CHARS_PER_MINUTE;
  return {
    system: SYSTEM,
    prompt: [
      `Schreib ein Podcast-Gespräch über die Texte auf stdin, etwa ${minutes} Minuten lang, also rund ${chars} Zeichen gesprochener Text insgesamt.`,
      'Zwei Stimmen: A moderiert, führt durch, fragt nach und fasst zusammen. B ordnet ein, erklärt Zusammenhänge und widerspricht, wo die Texte das hergeben.',
      'Nenn jeden Text beim Titel, wenn er drankommt. Arbeite Querverbindungen zwischen den Texten heraus. Zum Schluss zwei oder drei Gedanken zum Mitnehmen.',
      'Gesprochene Sprache: kurze Sätze, keine Aufzählungen, kein Markdown, keine Links. Wechselt euch oft ab, kein Zug länger als etwa 600 Zeichen.',
      'Erlaubt sind sparsam Regieanweisungen in eckigen Klammern auf Englisch, z. B. [laughs], [thoughtful], [curious]; sonst nichts in Klammern.',
    ].join('\n'),
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['title', 'turns'],
      properties: {
        title: { type: 'string', description: 'Titel der Folge, höchstens 100 Zeichen' },
        turns: {
          type: 'array',
          minItems: 2,
          items: { type: 'object', additionalProperties: false, required: ['speaker', 'text'], properties: { speaker: { type: 'string', enum: ['A', 'B'] }, text: { type: 'string' } } },
        },
      },
    },
  };
}

function reportJob(docs, minutes) {
  const chars = minutes * CHARS_PER_MINUTE;
  return {
    system: SYSTEM,
    prompt: [
      'Schreib einen Report über die Texte auf stdin, in zwei Fassungen.',
      '`note`: Markdown für eine Notiz im Obsidian-Vault mit den Abschnitten „## Überblick“, „## Kernaussagen“ (je Text eine Unterüberschrift mit dem Titel und die Quelle als Link), „## Querverbindungen“ und „## Offene Fragen“. Keine Überschrift erster Ordnung.',
      `\`spoken\`: dieselben Inhalte als Fließtext zum Vorlesen, etwa ${minutes} Minuten, also rund ${chars} Zeichen. Gesprochene Sprache, kurze Sätze, kein Markdown, keine Links, Titel der Texte ausgesprochen.`,
    ].join('\n'),
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['title', 'note', 'spoken'],
      properties: {
        title: { type: 'string', description: 'Titel des Reports, höchstens 100 Zeichen, ohne / und \\' },
        note: { type: 'string' },
        spoken: { type: 'string' },
      },
    },
  };
}

const cleanTitle = (t, fallback) => String(t ?? '').replace(/[\\/\r\n]+/g, ' ').replace(/\.\.+/g, '.').replace(/^[!>#\s]+/, '').trim().slice(0, 100) || fallback;

/**
 * - `store`: Lesestapel (src/lesen/store.js).
 * - `tts()`: Stimme aus den Einstellungen (`{ key, voice, model }` oder null).
 * - `speech`: Stimme mit Satz-Cache (src/lesen/tts.js `createSpeech`) fürs Vorlesen.
 * - `voices()`: `{ host, guest }` für den Podcast.
 * - `writer`: Claude (src/lesen/claude.js), `{ available(), write() }`.
 * - `capture({ title, text, captureId })`: legt die Report-Notiz in der Vault-Inbox an, liefert `{ path }`.
 * - `provider(cfg)`: ElevenLabs-Client (Tests ersetzen ihn).
 */
export function createEpisodes({ dir, store, tts, speech = null, voices, writer, capture, provider = (cfg) => createElevenLabs(cfg), logger = console, now = () => new Date() }) {
  const file = join(dir, 'folgen.json');
  let episodes = [];
  try {
    episodes = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    /* noch keine */
  }
  const queue = [];
  let running = null;

  function save() {
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${file}.tmp`, `${JSON.stringify(episodes, null, 2)}\n`, { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
  }

  const find = (id) => episodes.find((e) => e.id === id) ?? null;
  const audioPath = (id) => join(dir, `${id}.mp3`);
  const scriptPath = (id) => join(dir, `${id}.skript.json`);

  /** Claudes Antwort, sobald sie da ist: Ein zweiter Versuch fragt Claude nicht noch einmal. */
  function loadScript(id) {
    try {
      return JSON.parse(readFileSync(scriptPath(id), 'utf8'));
    } catch {
      return null;
    }
  }
  function saveScript(id, script) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${scriptPath(id)}.tmp`, JSON.stringify(script), { mode: 0o600 });
    renameSync(`${scriptPath(id)}.tmp`, scriptPath(id));
  }
  /** Lässt sich ohne Claude fortsetzen: Vorlesen immer, sonst mit gesichertem Skript. */
  const resumable = (ep) => ep.kind === 'vorlesen' || existsSync(scriptPath(ep.id));

  function update(ep, fields) {
    Object.assign(ep, fields, { updated_at: now().toISOString() });
    save();
  }

  function availability() {
    const voice = Boolean(tts());
    const claude = Boolean(writer?.available());
    const missingVoice = voice ? null : 'Folgen brauchen ElevenLabs (Einstellungen → Vorlesen)';
    const missingClaude = claude ? null : 'Podcast und Report brauchen Claude: CLAUDE_CODE_OAUTH_TOKEN im Deployment (Token aus `claude setup-token`)';
    return { vorlesen: missingVoice, podcast: missingVoice ?? missingClaude, report: missingVoice ?? missingClaude };
  }

  function docsOf(ids) {
    const unique = [...new Set(ids)].slice(0, MAX_DOCS);
    const docs = unique.map((id) => store.get(id)).filter((d) => d && plain(d));
    if (!docs.length) throw new EpisodeError('Keiner der gewählten Texte hat Text zum Vorlesen');
    return docs;
  }

  /** Zeichen, die ElevenLabs berechnet: beim Vorlesen nur, was nicht schon im Cache liegt; bei Podcast und Report geschätzt. */
  function estimate({ kind, docs, minutes }) {
    if (kind === 'vorlesen') return docs.flatMap((d) => narration(d, tts()?.model ?? '')).reduce((sum, p) => sum + (speech?.cached(p) ? 0 : p.text.length), 0);
    return minutes * CHARS_PER_MINUTE;
  }

  async function produce(ep) {
    const cfg = tts();
    if (!cfg) throw new EpisodeError(availability().vorlesen);
    const el = provider(cfg);
    const docs = ep.docs.map((id) => store.get(id)).filter(Boolean);
    if (!docs.length) throw new EpisodeError('Die Texte gibt es nicht mehr');

    // Was gesprochen wird, je Stück `() => { audio, paid }`: Sätze für eine Stimme oder Gesprächsabschnitte.
    let jobs;
    if (ep.kind === 'vorlesen') {
      if (!speech) throw new EpisodeError('Vorlesen braucht die Stimme vom Server');
      const parts = docs.flatMap((d) => narration(d, cfg.model)).filter((p) => p.text);
      // Bezahlt wird nur, was nicht schon im Cache lag.
      jobs = parts.map((p) => async () => {
        const paid = speech.cached(p) ? 0 : p.text.length;
        return { audio: await speech.audio(p), paid };
      });
    } else {
      let script = loadScript(ep.id);
      if (!script) {
        update(ep, { status: 'schreibt', writing_at: now().toISOString() });
        script = await writer.write({ ...(ep.kind === 'podcast' ? podcastJob(docs, ep.minutes) : reportJob(docs, ep.minutes)), input: sourceInput(docs) });
        saveScript(ep.id, script);
      }
      if (ep.kind === 'podcast') {
        const { host, guest } = voices();
        const turns = (script.turns ?? []).filter((t) => String(t.text ?? '').trim()).map((t) => ({ text: String(t.text).trim(), voice: t.speaker === 'B' ? guest : host }));
        if (turns.length < 2) throw new EpisodeError('Claude hat kein Gespräch geliefert');
        jobs = dialogueBatches(turns).map((inputs) => async () => ({ audio: await el.dialogue({ inputs }), paid: inputs.reduce((n, i) => n + i.text.length, 0) }));
        update(ep, { title: cleanTitle(script.title, ep.title), chars: turns.reduce((s, t) => s + t.text.length, 0) });
      } else {
        const title = cleanTitle(script.title, ep.title);
        // Die Notiz nur einmal; `captureId` macht auch einen zweiten Versuch harmlos.
        if (!ep.note) {
          const sources = docs.map((d) => `- [${String(d.title || d.url).replace(/[[\]]/g, '')}](${d.url})`).join('\n');
          const date = now().toISOString().slice(0, 10);
          const text = `_Report aus dem Lesestapel, ${date}, ${docs.length} ${docs.length === 1 ? 'Text' : 'Texte'} (Cockpit)_\n\n${String(script.note ?? '').trim()}\n\n## Quellen\n\n${sources}\n`;
          const note = await capture({ title, text, captureId: `folge-${ep.id}` });
          update(ep, { note: note?.path ?? null });
        }
        const parts = chunkText(String(script.spoken ?? ''), NARRATION_CHARS);
        if (!parts.length) throw new EpisodeError('Claude hat keine Sprechfassung geliefert');
        jobs = parts.map((t, i) => async () => ({ audio: await el.synthesize({ text: t, previous: parts[i - 1] ?? null, next: parts[i + 1] ?? null }), paid: t.length }));
        update(ep, { title, chars: parts.join('').length });
      }
    }

    const part = `${audioPath(ep.id)}.part`;
    mkdirSync(dir, { recursive: true });
    // Fortsetzen: Was schon gesprochen in `.part` liegt, bleibt; ein halb geschriebenes Stück fällt weg.
    const from = ep.done > 0 && ep.total === jobs.length && Number.isInteger(ep.part_bytes) && existsSync(part) && statSync(part).size >= ep.part_bytes ? ep.done : 0;
    if (from) truncateSync(part, ep.part_bytes);
    else writeFileSync(part, Buffer.alloc(0), { mode: 0o600 });
    const at = now().toISOString();
    update(ep, { status: 'spricht', done: from, total: jobs.length, part_bytes: from ? ep.part_bytes : 0, paid: from ? (ep.paid ?? 0) : 0, speaking_at: at, speaking_from: from });
    // Satzweise mehrere zugleich (Vorlesen); Gespräch und Report nacheinander, die Stücke sind groß.
    await inOrder(jobs.slice(from), ep.kind === 'vorlesen' ? PARALLEL : 1, ({ audio, paid }, i) => {
      const k = from + i;
      const chunk = audioFrames(audio);
      appendFileSync(part, chunk);
      update(ep, { done: k + 1, part_bytes: ep.part_bytes + chunk.length, paid: ep.paid + paid });
    });
    renameSync(part, audioPath(ep.id));
    rmSync(scriptPath(ep.id), { force: true });
    update(ep, { ...(ep.kind === 'vorlesen' ? { chars: ep.paid } : {}), status: 'fertig', frames: true, bytes: statSync(audioPath(ep.id)).size, finished_at: now().toISOString() });
    logger.info?.(`Folge „${ep.title}“ (${KINDS[ep.kind]}) fertig, ${ep.chars} Zeichen`);
  }

  async function next() {
    if (running || !queue.length) return;
    const ep = find(queue.shift());
    if (!ep || ep.status !== 'wartet') return next();
    running = ep.id;
    try {
      await produce(ep);
    } catch (err) {
      // `.part` und Skript bleiben für `retry`.
      logger.warn?.(`Folge „${ep.title}“: ${err.message}`);
      update(ep, { status: 'fehler', error: err.message });
    } finally {
      running = null;
    }
    return next();
  }

  // Beim Start: Unterbrochenes fortsetzen, wenn das ohne Claude geht, sonst als Fehler; Wartendes wieder einreihen.
  for (const ep of episodes) {
    if (ep.status === 'schreibt' || ep.status === 'spricht') {
      if (resumable(ep)) Object.assign(ep, { status: 'wartet' });
      else Object.assign(ep, { status: 'fehler', error: 'Durch einen Neustart unterbrochen, bevor Claudes Skript da war.' });
    }
    if (ep.status === 'wartet') queue.push(ep.id);
  }
  if (episodes.length) save();
  // Nach dem Start, nicht mittendrin im Aufbau des Servers.
  if (queue.length) setTimeout(next, 1000).unref?.();
  // Ältere Folgen hatten Info-Frames mitten im Strom (falsche Länge auf iOS): einmal bereinigen.
  if (episodes.some((ep) => ep.status === 'fertig' && !ep.frames)) setTimeout(repair, 1500).unref?.();

  function repair() {
    for (const ep of episodes) {
      if (ep.status !== 'fertig' || ep.frames || running === ep.id) continue;
      try {
        const path = audioPath(ep.id);
        if (existsSync(path)) {
          const clean = audioFrames(readFileSync(path));
          writeFileSync(`${path}.tmp`, clean, { mode: 0o600 });
          renameSync(`${path}.tmp`, path);
          ep.bytes = clean.length;
        }
        ep.frames = true;
      } catch (err) {
        logger.warn?.(`Folge „${ep.title}“ nicht bereinigt: ${err.message}`);
      }
    }
    save();
  }

  return {
    KINDS,
    STATES,
    availability,
    list: () => [...episodes].reverse(),
    get: find,
    /** Nach einem Fehler: setzt fort, ohne Claude noch einmal zu fragen, wenn das Skript schon da ist. */
    resumable: (id) => {
      const ep = find(id);
      return Boolean(ep && resumable(ep));
    },
    audioPath: (id) => (find(id)?.status === 'fertig' && existsSync(audioPath(id)) ? audioPath(id) : null),
    /** Zeichen und Texte vor dem Anstoßen, für die Auswahlseite. */
    preview({ kind, docIds, minutes = 10 }) {
      const docs = docsOf(docIds);
      return { docs, chars: estimate({ kind, docs, minutes }) };
    },

    /** Legt eine Folge an und reiht sie ein; liefert sie sofort. `done` wartet auf das Ende (Tests). */
    create({ kind, docIds, minutes = 10 }) {
      if (!KINDS[kind]) throw new EpisodeError(`Unbekannte Art „${kind}“`);
      const missing = availability()[kind];
      if (missing) throw new EpisodeError(missing, 409);
      const m = kind === 'vorlesen' ? null : Number(minutes);
      if (m !== null && !LENGTHS.includes(m)) throw new EpisodeError(`Länge: ${LENGTHS.join(', ')} Minuten`);
      const docs = docsOf(docIds);
      const first = docs[0].title || docs[0].url;
      const at = now().toISOString();
      const ep = {
        id: randomUUID(),
        kind,
        minutes: m,
        title: docs.length === 1 ? `${KINDS[kind]}: ${first}` : `${KINDS[kind]}: ${first} und ${docs.length - 1} weitere`,
        docs: docs.map((d) => d.id),
        status: 'wartet',
        chars: estimate({ kind, docs, minutes: m }),
        created_at: at,
        updated_at: at,
      };
      episodes.push(ep);
      save();
      queue.push(ep.id);
      // Stand beim Anlegen; `next` läuft sofort los und ändert `ep`.
      const created = { ...ep };
      return Object.assign(created, { done: next() });
    },

    /**
     * Fehlgeschlagene Folge noch einmal einreihen. Gesprochenes und Claudes
     * Skript bleiben, bezahlt wird nur, was fehlt. `done` wie bei `create`.
     */
    retry(id) {
      const ep = find(id);
      if (!ep) throw new EpisodeError('Diese Folge gibt es nicht', 404);
      if (ep.status !== 'fehler') throw new EpisodeError('Nur eine fehlgeschlagene Folge lässt sich fortsetzen', 409);
      const missing = availability()[ep.kind];
      if (missing) throw new EpisodeError(missing, 409);
      update(ep, { status: 'wartet', error: null });
      queue.push(ep.id);
      return Object.assign({ ...ep }, { done: next() });
    },

    remove(id) {
      const ep = find(id);
      if (!ep) throw new EpisodeError('Diese Folge gibt es nicht', 404);
      if (running === id) throw new EpisodeError('Die Folge entsteht gerade; danach löschen');
      episodes = episodes.filter((e) => e.id !== id);
      for (const f of [audioPath(id), `${audioPath(id)}.part`, scriptPath(id)]) rmSync(f, { force: true });
      save();
      return ep;
    },
  };
}
