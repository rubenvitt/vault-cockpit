import { readFileSync, writeFileSync, renameSync, mkdirSync, appendFileSync, rmSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { htmlText } from './anchor.js';
import { sentences } from './listen.js';
import { createElevenLabs, DIALOGUE_CHARS } from './tts.js';

/**
 * Folgen aus dem Lesestapel: eine MP3, im Hintergrund erzeugt, auf Knopfdruck.
 *
 * - **Vorlesen**: die ganzen Texte nacheinander, eine Erzählerstimme (die
 *   Stimme unter Einstellungen → Vorlesen). Ohne Claude.
 * - **Podcast**: Claude schreibt ein Gespräch zweier Stimmen über die Texte,
 *   ElevenLabs spricht es mit Text-to-Dialogue (`eleven_v3`).
 * - **Report**: Claude schreibt einen Bericht; er kommt als Notiz in die
 *   Vault-Inbox, eine Stimme liest die Sprechfassung.
 *
 * Claude läuft über die CLI mit dem Abo (src/lesen/claude.js). Die Folgen
 * liegen unter `dir` (`folgen.json` und je Folge `<id>.mp3`), es läuft immer
 * nur eine. Was beim Neustart mitten drin war, steht danach als Fehler da:
 * neu anstoßen kostet noch einmal, also entscheidet das der Nutzer.
 */

export const KINDS = { vorlesen: 'Vorlesen', podcast: 'Podcast', report: 'Report' };
/** Länge von Podcast und Report in Minuten. */
export const LENGTHS = [5, 10, 20];
// Gesprochenes Deutsch: rund 150 Wörter zu 6 Zeichen in der Minute.
export const CHARS_PER_MINUTE = 900;
export const MAX_DOCS = 20;
// Je Anfrage beim Vorlesen; ElevenLabs nimmt mehr, kürzere Stücke scheitern seltener.
const NARRATION_CHARS = 3000;
// So viel Text je Dokument und insgesamt geht an Claude.
const DOC_INPUT = 60_000;
const TOTAL_INPUT = 300_000;
const STATES = { wartet: 'wartet', schreibt: 'Claude schreibt', spricht: 'wird gesprochen', fertig: 'fertig', fehler: 'Fehler' };

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

const plain = (doc) => htmlText(doc.content_html ?? '').trim();

/** Stücke zum Vorlesen eines Textes: Titel und Quelle, kurze Pause, dann der Text. */
function narration(doc, model) {
  const html = doc.content_html ?? '';
  const text = htmlText(html);
  // Pausen-Tags kennt `eleven_v3` nicht, dort würden sie vorgelesen.
  const pause = /^eleven_v3/.test(model) ? '' : ' <break time="1.5s" />';
  const head = `${doc.title || doc.site || 'Ohne Titel'}.${doc.site ? ` Von ${doc.site}.` : ''}${pause}`;
  const body = chunkText(sentences(html).map((s) => text.slice(s.start, s.end)).join(' '), NARRATION_CHARS);
  return [head, ...body];
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
 * - `voices()`: `{ host, guest }` für den Podcast.
 * - `writer`: Claude (src/lesen/claude.js), `{ available(), write() }`.
 * - `capture({ title, text, captureId })`: legt die Report-Notiz in der Vault-Inbox an, liefert `{ path }`.
 * - `provider(cfg)`: ElevenLabs-Client (Tests ersetzen ihn).
 */
export function createEpisodes({ dir, store, tts, voices, writer, capture, provider = (cfg) => createElevenLabs(cfg), logger = console, now = () => new Date() }) {
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

  /** Zeichen, die ElevenLabs berechnet (geschätzt bei Podcast und Report). */
  function estimate({ kind, docs, minutes }) {
    if (kind === 'vorlesen') return docs.reduce((sum, d) => sum + narration(d, tts()?.model ?? '').join(' ').length, 0);
    return minutes * CHARS_PER_MINUTE;
  }

  async function produce(ep) {
    const cfg = tts();
    if (!cfg) throw new EpisodeError(availability().vorlesen);
    const el = provider(cfg);
    const docs = ep.docs.map((id) => store.get(id)).filter(Boolean);
    if (!docs.length) throw new EpisodeError('Die Texte gibt es nicht mehr');

    // Was gesprochen wird: Stücke für eine Stimme oder Gesprächsabschnitte.
    let jobs;
    if (ep.kind === 'vorlesen') {
      const parts = docs.flatMap((d) => narration(d, cfg.model));
      jobs = parts.map((text, i) => () => el.synthesize({ text, previous: parts[i - 1] ?? null, next: parts[i + 1] ?? null }));
      ep.chars = parts.join('').length;
    } else {
      update(ep, { status: 'schreibt' });
      const input = sourceInput(docs);
      if (ep.kind === 'podcast') {
        const script = await writer.write({ ...podcastJob(docs, ep.minutes), input });
        const { host, guest } = voices();
        const turns = (script.turns ?? []).filter((t) => String(t.text ?? '').trim()).map((t) => ({ text: String(t.text).trim(), voice: t.speaker === 'B' ? guest : host }));
        if (turns.length < 2) throw new EpisodeError('Claude hat kein Gespräch geliefert');
        const batches = dialogueBatches(turns);
        jobs = batches.map((inputs) => () => el.dialogue({ inputs }));
        update(ep, { title: cleanTitle(script.title, ep.title), chars: turns.reduce((s, t) => s + t.text.length, 0) });
      } else {
        const script = await writer.write({ ...reportJob(docs, ep.minutes), input });
        const title = cleanTitle(script.title, ep.title);
        const sources = docs.map((d) => `- [${String(d.title || d.url).replace(/[[\]]/g, '')}](${d.url})`).join('\n');
        const date = now().toISOString().slice(0, 10);
        const text = `_Report aus dem Lesestapel, ${date}, ${docs.length} ${docs.length === 1 ? 'Text' : 'Texte'} (Cockpit)_\n\n${String(script.note ?? '').trim()}\n\n## Quellen\n\n${sources}\n`;
        const note = await capture({ title, text, captureId: `folge-${ep.id}` });
        const parts = chunkText(String(script.spoken ?? ''), NARRATION_CHARS);
        if (!parts.length) throw new EpisodeError('Claude hat keine Sprechfassung geliefert');
        jobs = parts.map((t, i) => () => el.synthesize({ text: t, previous: parts[i - 1] ?? null, next: parts[i + 1] ?? null }));
        update(ep, { title, note: note?.path ?? null, chars: parts.join('').length });
      }
    }

    update(ep, { status: 'spricht', done: 0, total: jobs.length });
    const part = `${audioPath(ep.id)}.part`;
    mkdirSync(dir, { recursive: true });
    writeFileSync(part, Buffer.alloc(0), { mode: 0o600 });
    for (const [i, job] of jobs.entries()) {
      const audio = await job();
      appendFileSync(part, i === 0 ? audio : stripId3(audio));
      update(ep, { done: i + 1 });
    }
    renameSync(part, audioPath(ep.id));
    update(ep, { status: 'fertig', bytes: statSync(audioPath(ep.id)).size, finished_at: now().toISOString() });
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
      rmSync(`${audioPath(ep.id)}.part`, { force: true });
      logger.warn?.(`Folge „${ep.title}“: ${err.message}`);
      update(ep, { status: 'fehler', error: err.message });
    } finally {
      running = null;
    }
    return next();
  }

  // Beim Start: Unterbrochenes als Fehler, Wartendes wieder einreihen.
  for (const ep of episodes) {
    if (ep.status === 'schreibt' || ep.status === 'spricht') Object.assign(ep, { status: 'fehler', error: 'Durch einen Neustart unterbrochen. Neu anstoßen kostet noch einmal.' });
    if (ep.status === 'wartet') queue.push(ep.id);
  }
  if (episodes.length) save();
  // Nach dem Start, nicht mittendrin im Aufbau des Servers.
  if (queue.length) setTimeout(next, 1000).unref?.();

  return {
    KINDS,
    STATES,
    availability,
    list: () => [...episodes].reverse(),
    get: find,
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

    remove(id) {
      const ep = find(id);
      if (!ep) throw new EpisodeError('Diese Folge gibt es nicht', 404);
      if (running === id) throw new EpisodeError('Die Folge entsteht gerade; danach löschen');
      episodes = episodes.filter((e) => e.id !== id);
      rmSync(audioPath(id), { force: true });
      save();
      return ep;
    },
  };
}
