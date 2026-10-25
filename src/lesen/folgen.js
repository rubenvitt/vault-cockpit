import { readFileSync, writeFileSync, renameSync, mkdirSync, appendFileSync, rmSync, statSync, existsSync, truncateSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { htmlText } from './anchor.js';
import { sentences } from './listen.js';
import { createElevenLabs, DIALOGUE_CHARS } from './tts.js';
import { slugOf } from './vault-export.js';
import { breakTemplater, safeWikiMarkdown } from './wiki-markdown.js';
import { localDate } from '../cockpit/week.js';

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
 * - **Report**: Claude schreibt einen Bericht, eine Stimme liest die
 *   Sprechfassung.
 *
 * Podcast und Report landen als Transkript im Vault (`noteFolder`, Standard
 * `30-ressourcen/audio-reports`, neben den übrigen Audio-Reports), sobald
 * Claudes Skript da ist, also vor dem Sprechen: `type: folge`, `art`,
 * `quellen` als Wikilinks auf die Lesestapel-Notizen und `ingest: offen`,
 * damit ein Claude-Skill sie später ins Wiki holt. Der Report mit Bericht und
 * Sprechfassung, der Podcast mit dem Gespräch; Claudes Text entschärft
 * (src/lesen/wiki-markdown.js). Lässt sich das Transkript nicht anlegen (Vault
 * nur lesbar, Ordner vertraulich), läuft die Folge ohne weiter. Vorlesen braucht keine Notiz,
 * das sind die Texte selbst. Ist eine Folge fertig (jede Art), bekommen ihre
 * Texte über `heard` den Vermerk „gehört“.
 *
 * Podcast und Report lassen sich einstellen: `style` (Ton, `STYLES`),
 * `topics` und `focus` (Schwerpunkt: Themen der Texte bzw. eigener Satz) gehen
 * in Claudes Auftrag. Mit `audio: false` entsteht erst nur das Transkript
 * (Status `transkript`, kostet bei ElevenLabs nichts); `speak` macht später
 * aus Claudes gesichertem Skript das Audio, ohne Claude noch einmal zu fragen.
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
/** Ton von Podcast und Report: Name, Erklärung für die Auswahl und die Zeile für Claude (keine beim Standard). */
export const STYLES = {
  ausgewogen: { label: 'Ausgewogen', description: 'Einordnen, erklären, Querverbindungen', prompt: null },
  locker: { label: 'Locker', description: 'Unterhaltsam, mit Beispielen aus dem Alltag', prompt: 'Ton: locker und unterhaltsam, mit Beispielen aus dem Alltag, ohne flapsig zu werden oder Inhalt zu verlieren.' },
  kritisch: { label: 'Kritisch', description: 'Argumente prüfen, Lücken und Widersprüche benennen', prompt: 'Ton: kritisch. Prüf die Argumente der Texte, benenn Schwächen, Lücken und Widersprüche und was dagegen spricht.' },
  tiefgang: { label: 'Tiefgang', description: 'Weniger Punkte, dafür gründlich erklärt', prompt: 'Ton: in die Tiefe. Lieber weniger Punkte gründlich: Begriffe, Hintergründe und Zusammenhänge genau erklärt.' },
};
export const DEFAULT_STYLE = 'ausgewogen';
/** Schwerpunkt: höchstens so viele Themen und so viele Zeichen eigener Text. */
export const MAX_TOPICS = 5;
export const MAX_FOCUS = 200;
const TOPIC_CHARS = 60;
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
/** Ordner der Transkripte im Vault, wo auch die übrigen Audio-Reports liegen. */
export const DEFAULT_NOTE_FOLDER = '30-ressourcen/audio-reports';
// Länge des Titels im Dateinamen.
const SLUG_CHARS = 60;
const STATES = { wartet: 'wartet', schreibt: 'Claude schreibt', spricht: 'wird gesprochen', transkript: 'Transkript fertig', fertig: 'fertig', fehler: 'Fehler' };
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

/**
 * Wünsche zu Ton und Schwerpunkt als Zeilen für Claudes Auftrag; ohne Wünsche
 * keine. Der Schwerpunkt ist ein Wunsch, kein Ersatz: Was die Texte dazu nicht
 * hergeben, soll Claude sagen statt erfinden.
 */
function wishes({ style, topics = [], focus = '' } = {}) {
  const lines = [];
  const tone = STYLES[style]?.prompt;
  if (tone) lines.push(tone);
  const parts = [...(topics.length ? [`Themen: ${topics.join(', ')}`] : []), ...(focus ? [`Wunsch: ${focus}`] : [])];
  if (parts.length) lines.push(`Schwerpunkt (${parts.join('; ')}). Leg das Gewicht darauf, was die Texte dazu sagen; den Rest nur knapp, soweit er dafür wichtig ist. Geben die Texte dazu wenig her, sag das.`);
  return lines;
}

const SYSTEM = 'Du schreibst auf Deutsch für einen Menschen, der seinen Lesestapel unterwegs hört. Du arbeitest nur mit den Texten, die du bekommst, erfindest nichts dazu und sagst, wenn die Texte etwas offenlassen. Du lieferst ausschließlich das verlangte JSON.';

function podcastJob(docs, minutes, options) {
  const chars = minutes * CHARS_PER_MINUTE;
  return {
    system: SYSTEM,
    prompt: [
      `Schreib ein Podcast-Gespräch über die Texte auf stdin, etwa ${minutes} Minuten lang, also rund ${chars} Zeichen gesprochener Text insgesamt.`,
      'Zwei Stimmen: A moderiert, führt durch, fragt nach und fasst zusammen. B ordnet ein, erklärt Zusammenhänge und widerspricht, wo die Texte das hergeben.',
      'Nenn jeden Text beim Titel, wenn er drankommt. Arbeite Querverbindungen zwischen den Texten heraus. Zum Schluss zwei oder drei Gedanken zum Mitnehmen.',
      'Gesprochene Sprache: kurze Sätze, keine Aufzählungen, kein Markdown, keine Links. Wechselt euch oft ab, kein Zug länger als etwa 600 Zeichen.',
      'Erlaubt sind sparsam Regieanweisungen in eckigen Klammern auf Englisch, z. B. [laughs], [thoughtful], [curious]; sonst nichts in Klammern.',
      ...wishes(options),
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

function reportJob(docs, minutes, options) {
  const chars = minutes * CHARS_PER_MINUTE;
  return {
    system: SYSTEM,
    prompt: [
      'Schreib einen Report über die Texte auf stdin, in zwei Fassungen.',
      '`note`: Markdown für eine Notiz im Obsidian-Vault mit den Abschnitten „## Überblick“, „## Kernaussagen“ (je Text eine Unterüberschrift mit dem Titel und die Quelle als Link), „## Querverbindungen“ und „## Offene Fragen“. Keine Überschrift erster Ordnung.',
      `\`spoken\`: dieselben Inhalte als Fließtext zum Vorlesen, etwa ${minutes} Minuten, also rund ${chars} Zeichen. Gesprochene Sprache, kurze Sätze, kein Markdown, keine Links, Titel der Texte ausgesprochen.`,
      ...wishes(options),
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

/** Themen des Schwerpunkts: getrimmt, ohne Doppelte und Zeilenumbrüche, höchstens `MAX_TOPICS`. */
export function cleanTopics(list) {
  const seen = new Set();
  const out = [];
  for (const raw of [].concat(list ?? [])) {
    const t = String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, TOPIC_CHARS);
    if (!t || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    out.push(t);
  }
  return out.slice(0, MAX_TOPICS);
}

/** Eigener Schwerpunkt in einer Zeile, höchstens `MAX_FOCUS` Zeichen. */
export const cleanFocus = (text) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_FOCUS);

const cleanTitle = (t, fallback) => String(t ?? '').replace(/[\\/\r\n]+/g, ' ').replace(/\.\.+/g, '.').replace(/^[!>#\s]+/, '').trim().slice(0, 100) || fallback;

/**
 * - `store`: Lesestapel (src/lesen/store.js).
 * - `tts()`: Stimme aus den Einstellungen (`{ key, voice, model }` oder null).
 * - `speech`: Stimme mit Satz-Cache (src/lesen/tts.js `createSpeech`) fürs Vorlesen.
 * - `voices()`: `{ host, guest }` für den Podcast.
 * - `writer`: Claude (src/lesen/claude.js), `{ available(), write() }`.
 * - `createNote({ folder, name, content })`: legt das Transkript im Vault an
 *   (Vault-Editor `create`, wirft, wenn es die Datei schon gibt), liefert `{ path }`.
 * - `sourceNote(docId)`: Vault-Pfad der Lesestapel-Notiz eines Textes oder null.
 * - `heard(docIds)`: Vermerk „gehört“, sobald eine Folge fertig ist.
 * - `noteFolder`: Ordner der Transkripte; `tz`: Zeitzone fürs Datum (sonst UTC),
 *   als Wert oder Funktion (dann gilt eine geänderte Einstellung sofort).
 * - `provider(cfg)`: ElevenLabs-Client (Tests ersetzen ihn).
 *
 * `createNote`, `sourceNote` und `heard` sind optional: Ohne sie gibt es keine
 * Notiz, keine Wikilinks bzw. keinen Vermerk.
 */
export function createEpisodes({
  dir,
  store,
  tts,
  speech = null,
  voices,
  writer,
  createNote = null,
  sourceNote = null,
  heard = null,
  noteFolder = DEFAULT_NOTE_FOLDER,
  tz = null,
  provider = (cfg) => createElevenLabs(cfg),
  logger = console,
  now = () => new Date(),
}) {
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

  /** Was fehlt, um `kind` anzulegen: Erst nur das Transkript braucht keine Stimme, nur Claude. */
  function missingFor(kind, audio = true) {
    if (audio || kind === 'vorlesen') return availability()[kind];
    return writer?.available() ? null : availability()[kind];
  }

  function docsOf(ids) {
    const unique = [...new Set(ids)].slice(0, MAX_DOCS);
    const docs = unique.map((id) => store.get(id)).filter((d) => d && plain(d));
    if (!docs.length) throw new EpisodeError('Keiner der gewählten Texte hat Text zum Vorlesen');
    return docs;
  }

  /** Zeichen, die ElevenLabs berechnet: beim Vorlesen nur, was nicht schon im Cache liegt; bei Podcast und Report geschätzt. */
  function estimate({ kind, docs, minutes, audio = true }) {
    if (kind !== 'vorlesen' && !audio) return 0;
    if (kind === 'vorlesen') return docs.flatMap((d) => narration(d, tts()?.model ?? '')).reduce((sum, p) => sum + (speech?.cached(p) ? 0 : p.text.length), 0);
    return minutes * CHARS_PER_MINUTE;
  }

  const today = () => {
    const zone = typeof tz === 'function' ? tz() : tz;
    return zone ? localDate(now(), zone) : now().toISOString().slice(0, 10);
  };

  /**
   * Transkript einer Folge im Vault: Frontmatter, Titel, Hinweiszeile, `body`
   * und die Quellen (Wikilink auf die Lesestapel-Notiz, sonst die URL). Nur
   * einmal je Folge (`ep.note`); gibt es den Dateinamen schon, mit Kurz-ID.
   * Claudes Text (Titel, `body`) ist entschärft (src/lesen/wiki-markdown.js), sonst
   * wie geliefert. Scheitert das Anlegen ganz, nur eine Warnung: `ep.note` bleibt
   * leer, die Folge läuft weiter.
   */
  /** Ton und Schwerpunkt in einem Satz fürs Transkript, ohne Wünsche leer. */
  const wished = (ep) =>
    [
      ep.style && ep.style !== DEFAULT_STYLE ? `Ton: ${STYLES[ep.style]?.label ?? ep.style}` : null,
      ep.topics?.length || ep.focus ? `Schwerpunkt: ${[...(ep.topics ?? []), ...(ep.focus ? [ep.focus] : [])].join(', ')}` : null,
    ]
      .filter(Boolean)
      .join(' · ');

  async function writeNote(ep, docs, title, body) {
    if (ep.note || !createNote) return;
    const str = (v) => JSON.stringify(String(v));
    const date = today();
    const label = (d) => String(d.title || d.url).replace(/[[\]|\r\n]+/g, ' ').trim();
    const sources = docs.map((d) => ({ d, path: sourceNote?.(d.id)?.replace(/\.md$/i, '') ?? null }));
    const links = sources.filter((s) => s.path).map((s) => `  - ${str(`[[${s.path}]]`)}`);
    const content = [
      '---',
      'type: folge',
      `art: ${ep.kind}`,
      `titel: ${str(breakTemplater(title))}`,
      `folge_id: ${str(ep.id)}`,
      `erzeugt: ${date}`,
      `minuten: ${ep.minutes}`,
      ...(ep.style && ep.style !== DEFAULT_STYLE ? [`stil: ${ep.style}`] : []),
      ...(ep.topics?.length ? ['themen:', ...ep.topics.map((t) => `  - ${str(breakTemplater(t))}`)] : []),
      ...(ep.focus ? [`schwerpunkt: ${str(breakTemplater(ep.focus))}`] : []),
      ...(links.length ? ['quellen:', ...links] : ['quellen: []']),
      'ingest: offen',
      '---',
      '',
      `# ${safeWikiMarkdown(title)}`,
      '',
      `_${KINDS[ep.kind]} aus dem Lesestapel, ${date}, ${docs.length} ${docs.length === 1 ? 'Text' : 'Texte'} (Cockpit)_`,
      '',
      ...(wished(ep) ? [`> ${safeWikiMarkdown(wished(ep))}`, ''] : []),
      safeWikiMarkdown(body),
      '',
      '## Quellen',
      '',
      ...sources.map(({ d, path }) => (path ? `- [[${path}|${label(d)}]]` : `- [${label(d)}](<${String(d.url).replace(/[<>]/g, encodeURIComponent)}>)`)),
      '',
    ].join('\n');
    const stem = `${date}-${ep.kind}-${slugOf(title).slice(0, SLUG_CHARS).replace(/-+$/, '') || ep.kind}`;
    const names = [`${stem}.md`, `${stem}-${ep.id.slice(0, 8)}.md`];
    for (const [i, name] of names.entries()) {
      try {
        const made = await createNote({ folder: noteFolder, name, content });
        update(ep, { note: made?.path ?? `${noteFolder}/${name}` });
        return;
      } catch (err) {
        // Meist gibt es den Namen schon; dann mit Kurz-ID. Scheitert auch die (Vault nur lesbar, Ordner
        // vertraulich oder ausgeschlossen), geht es ohne Transkript weiter: Das Skript ist gesichert, die Folge zählt.
        if (i === names.length - 1) {
          logger.warn?.(`Folge „${ep.title}“: Transkript nicht im Vault: ${err.message}`);
          update(ep, { note: null });
        }
      }
    }
  }

  async function produce(ep) {
    // Erst nur das Transkript braucht keine Stimme; sonst fehlt sie schon vor Claude.
    const speaks = ep.audio !== false;
    const cfg = tts();
    if (!cfg && speaks) throw new EpisodeError(availability().vorlesen);
    let el = null;
    const voice = () => (el ??= provider(cfg));
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
        const options = { style: ep.style, topics: ep.topics, focus: ep.focus };
        script = await writer.write({ ...(ep.kind === 'podcast' ? podcastJob(docs, ep.minutes, options) : reportJob(docs, ep.minutes, options)), input: sourceInput(docs) });
        saveScript(ep.id, script);
      }
      if (ep.kind === 'podcast') {
        const { host, guest } = voices();
        const turns = (script.turns ?? []).filter((t) => String(t.text ?? '').trim()).map((t) => ({ text: String(t.text).trim(), voice: t.speaker === 'B' ? guest : host, speaker: t.speaker }));
        if (turns.length < 2) throw new EpisodeError('Claude hat kein Gespräch geliefert');
        const title = cleanTitle(script.title, ep.title);
        // Transkript vor dem Sprechen: Was Claude geschrieben hat, ist dann sicher.
        const talk = turns.map((t) => `**${t.speaker === 'B' ? 'Gast' : 'Moderation'}:** ${t.text}`).join('\n\n');
        await writeNote(ep, docs, title, `## Gespräch\n\n${talk}`);
        jobs = dialogueBatches(turns).map((inputs) => async () => ({ audio: await voice().dialogue({ inputs }), paid: inputs.reduce((n, i) => n + i.text.length, 0) }));
        update(ep, { title, chars: turns.reduce((s, t) => s + t.text.length, 0) });
      } else {
        const title = cleanTitle(script.title, ep.title);
        const spoken = String(script.spoken ?? '').trim();
        await writeNote(ep, docs, title, [String(script.note ?? '').trim(), spoken && `## Sprechfassung\n\n${spoken}`].filter(Boolean).join('\n\n'));
        const parts = chunkText(spoken, NARRATION_CHARS);
        if (!parts.length) throw new EpisodeError('Claude hat keine Sprechfassung geliefert');
        jobs = parts.map((t, i) => async () => ({ audio: await voice().synthesize({ text: t, previous: parts[i - 1] ?? null, next: parts[i + 1] ?? null }), paid: t.length }));
        update(ep, { title, chars: parts.join('').length });
      }
      if (!speaks) {
        // Skript bleibt für `speak`; gehört ist noch nichts.
        update(ep, { status: 'transkript', transcript_at: now().toISOString() });
        logger.info?.(`Folge „${ep.title}“ (${KINDS[ep.kind]}): Transkript fertig, Audio auf Knopfdruck`);
        return;
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
    // Die Folge bleibt fertig, auch wenn der Vermerk scheitert.
    try {
      await heard?.(ep.docs);
    } catch (err) {
      logger.warn?.(`Folge „${ep.title}“: Vermerk „gehört“ fehlgeschlagen: ${err.message}`);
    }
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
    missingFor,
    list: () => [...episodes].reverse(),
    get: find,
    /** Nach einem Fehler: setzt fort, ohne Claude noch einmal zu fragen, wenn das Skript schon da ist. */
    resumable: (id) => {
      const ep = find(id);
      return Boolean(ep && resumable(ep));
    },
    audioPath: (id) => (find(id)?.status === 'fertig' && existsSync(audioPath(id)) ? audioPath(id) : null),
    /** Zeichen und Texte vor dem Anstoßen, für die Auswahlseite. */
    preview({ kind, docIds, minutes = 10, audio = true }) {
      const docs = docsOf(docIds);
      return { docs, chars: estimate({ kind, docs, minutes, audio }) };
    },

    /**
     * Legt eine Folge an und reiht sie ein; liefert sie sofort. `done` wartet
     * auf das Ende (Tests). Podcast und Report nehmen `style`, `topics`,
     * `focus` und `audio` (false = erst nur das Transkript); Vorlesen nicht.
     */
    create({ kind, docIds, minutes = 10, audio = true, style = DEFAULT_STYLE, topics = [], focus = '' }) {
      if (!KINDS[kind]) throw new EpisodeError(`Unbekannte Art „${kind}“`);
      const writes = kind !== 'vorlesen';
      const speaks = !writes || audio !== false;
      const missing = missingFor(kind, speaks);
      if (missing) throw new EpisodeError(missing, 409);
      const m = writes ? Number(minutes) : null;
      if (m !== null && !LENGTHS.includes(m)) throw new EpisodeError(`Länge: ${LENGTHS.join(', ')} Minuten`);
      const tone = writes ? style || DEFAULT_STYLE : null;
      if (tone && !STYLES[tone]) throw new EpisodeError(`Ton: ${Object.values(STYLES).map((s) => s.label).join(', ')}`);
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
        chars: estimate({ kind, docs, minutes: m, audio: speaks }),
        ...(writes ? { audio: speaks, style: tone, topics: cleanTopics(topics), focus: cleanFocus(focus) } : {}),
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
      const missing = missingFor(ep.kind, ep.audio !== false);
      if (missing) throw new EpisodeError(missing, 409);
      update(ep, { status: 'wartet', error: null });
      queue.push(ep.id);
      return Object.assign({ ...ep }, { done: next() });
    },

    /**
     * Audio zu einem fertigen Transkript: aus Claudes gesichertem Skript, Claude
     * schreibt nicht noch einmal. `done` wie bei `create`.
     */
    speak(id) {
      const ep = find(id);
      if (!ep) throw new EpisodeError('Diese Folge gibt es nicht', 404);
      if (ep.status !== 'transkript') throw new EpisodeError('Audio gibt es nur zu einem fertigen Transkript', 409);
      const missing = availability().vorlesen ?? (existsSync(scriptPath(ep.id)) ? null : availability()[ep.kind]);
      if (missing) throw new EpisodeError(missing, 409);
      update(ep, { status: 'wartet', audio: true, error: null });
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
