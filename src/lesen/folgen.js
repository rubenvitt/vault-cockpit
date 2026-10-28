import { readFileSync, writeFileSync, renameSync, mkdirSync, appendFileSync, rmSync, statSync, existsSync, truncateSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { htmlText } from './anchor.js';
import { sentences } from './listen.js';
import { createElevenLabs, DIALOGUE_CHARS } from './tts.js';
import { slugOf } from './vault-export.js';
import { breakTemplater, safeWikiMarkdown } from './wiki-markdown.js';
import { localDate } from '../cockpit/week.js';
import { EPISODE_LANGUAGES, DEFAULT_EPISODE_LANGUAGE, episodeLanguage } from './languages.js';
import { logStep, logTool } from './worklog.js';

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
 * Gehört ist auch die Folge selbst, sobald sie zu Ende gespielt ist (`listened`
 * mit Stelle kurz vor Schluss, vom Player) oder von Hand markiert (`setHeard`):
 * `heard_at` an der Folge, `position` (Sekunden) und `listened_at` für
 * „angefangen“. Ungehörte Folgen stehen vorn, gehörte treten zurück. Folgen
 * von vor dieser Unterscheidung gelten beim Laden als gehört.
 *
 * Podcast und Report schreibt Claude in der Sprache aus den Einstellungen
 * (`language`, Standard Deutsch; die Folge merkt sie sich beim Anlegen, die
 * Überschriften der Notiz bleiben deutsch). Dazu lassen sie sich einstellen: `style` (Ton, `STYLES`),
 * `topics` und `focus` (Schwerpunkt: Themen der Texte bzw. eigener Satz) gehen
 * in Claudes Auftrag. Mit `audio: false` entsteht erst nur das Transkript
 * (Status `transkript`, kostet bei ElevenLabs nichts); `speak` macht später
 * aus Claudes gesichertem Skript das Audio, ohne Claude noch einmal zu fragen.
 *
 * **Zu einem Thema** (Podcast oder Report, `createTopic`): statt Texten aus dem
 * Stapel ein Thema, auf Wunsch Ziele oder Anlass, und eine Länge von 5 bis 240
 * Minuten. Claude recherchiert erst als Agent im ganzen Vault (nur lesend, ohne
 * Vertrauliches, src/lesen/research-mcp.js) und, wenn gewünscht, im Internet,
 * und liefert ein Dossier mit Quellen und einen Kapitelplan
 * (`<id>.recherche.json`). Dann schreibt Claude Kapitel für Kapitel, ohne
 * Werkzeuge, nur aus dem Dossier; jedes fertige Kapitel liegt sofort im Skript.
 * So gehen auch Folgen von Stunden, und nach einem Fehler schreibt Claude nur,
 * was fehlt. Das Transkript bekommt Überblick, Kapitel, Dossier und Quellen
 * (Wikilinks auf die gelesenen Notizen, Webseiten als Links).
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
export const LENGTHS = [5, 10, 20, 30];
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
/** Themen-Folgen: Länge frei zwischen diesen Minuten, Vorschläge für die Auswahl. */
export const TOPIC_MINUTES = { min: 5, max: 240 };
export const TOPIC_LENGTHS = [15, 30, 60, 90, 120];
/** Arten, die es zu einem Thema gibt. */
export const TOPIC_KINDS = ['podcast', 'report'];
// Kapitel einer Themen-Folge: so viele Minuten höchstens je Kapitel, so viele Kapitel höchstens.
const CHAPTER_MINUTES = 20;
const MAX_CHAPTERS = 30;
// So viel vom Dossier geht in jedes Kapitel, so viel Ende des vorigen Kapitels für den Anschluss.
const DOSSIER_INPUT = 150_000;
const CARRY_CHARS = 1500;
// Recherche als Agent im Vault und im Netz braucht länger als das Schreiben.
const RESEARCH_TIMEOUT_MS = 45 * 60_000;
const WEB_TOOLS = ['WebSearch', 'WebFetch'];
// Gesprochenes Deutsch: rund 150 Wörter zu 6 Zeichen in der Minute.
export const CHARS_PER_MINUTE = 900;
export const MAX_DOCS = 40;
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
const STATES = { wartet: 'wartet', recherchiert: 'Claude recherchiert', schreibt: 'Claude schreibt', spricht: 'wird gesprochen', transkript: 'Transkript fertig', fertig: 'fertig', fehler: 'Fehler' };
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

/**
 * Wie viele Zeichen jeder Text an Claude geben darf: höchstens `DOC_INPUT`,
 * zusammen höchstens `TOTAL_INPUT`, gerecht geteilt. Kurze Texte bleiben ganz,
 * was sie übrig lassen, bekommen die langen; so kommt jeder Text zu Wort.
 */
export function inputShares(lengths, total = TOTAL_INPUT, each = DOC_INPUT) {
  const shares = lengths.map(() => 0);
  let left = total;
  const order = lengths.map((n, i) => [n, i]).sort((a, b) => a[0] - b[0]);
  order.forEach(([n, i], k) => {
    shares[i] = Math.min(n, each, Math.floor(left / (order.length - k)));
    left -= shares[i];
  });
  return shares;
}

/** Texte für Claude, je Text mit Nummer, Titel und Quelle. */
function sourceInput(docs) {
  const bodies = docs.map(plain);
  const shares = inputShares(bodies.map((b) => b.length));
  return docs
    .map((d, i) => `<text nr="${i + 1}" titel="${String(d.title || d.url).replace(/"/g, "'")}" quelle="${d.url}">\n${bodies[i].slice(0, shares[i])}\n</text>`)
    .join('\n\n');
}

/**
 * Sind die Texte zusammen länger als die Folge, soll Claude verdichten statt
 * Texte wegzulassen oder die Länge zu sprengen.
 */
function condense(docs, minutes) {
  const spoken = docs.reduce((n, d) => n + plain(d).length, 0) / CHARS_PER_MINUTE;
  if (spoken <= minutes * 1.2) return [];
  return [`Die Texte sind zusammen deutlich länger als die Folge. Verdichte: Halte die Länge ein, lass keinen Text ganz weg, nimm aus jedem das Wichtigste und Neue, kürze Wiederholungen und Beispiele und fass Texte zum selben Thema zusammen.`];
}

/**
 * Wünsche zu Ton und Schwerpunkt als Zeilen für Claudes Auftrag; ohne Wünsche
 * keine. Der Schwerpunkt ist ein Wunsch, kein Ersatz: Was die Texte dazu nicht
 * hergeben, soll Claude sagen statt erfinden.
 */
function wishes({ style, topics = [], focus = '', language = null } = {}) {
  const lines = [...languageLine(language)];
  const tone = STYLES[style]?.prompt;
  if (tone) lines.push(tone);
  const parts = [...(topics.length ? [`Themen: ${topics.join(', ')}`] : []), ...(focus ? [`Wunsch: ${focus}`] : [])];
  if (parts.length) lines.push(`Schwerpunkt (${parts.join('; ')}). Leg das Gewicht darauf, was die Texte dazu sagen; den Rest nur knapp, soweit er dafür wichtig ist. Geben die Texte dazu wenig her, sag das.`);
  return lines;
}

const system = (language) =>
  `Du schreibst auf ${EPISODE_LANGUAGES[episodeLanguage(language)]} für einen Menschen, der seinen Lesestapel unterwegs hört. Du arbeitest nur mit den Texten, die du bekommst, erfindest nichts dazu und sagst, wenn die Texte etwas offenlassen. Du lieferst ausschließlich das verlangte JSON.`;

/** Andere Sprache als Deutsch: alles Gesprochene und Gelesene darin, auch wenn die Texte anders sind. */
function languageLine(language) {
  const code = episodeLanguage(language);
  if (code === DEFAULT_EPISODE_LANGUAGE) return [];
  return [`Sprache: Schreib Titel, Gespräch bzw. Bericht und Sprechfassung auf ${EPISODE_LANGUAGES[code]}, auch wo die Texte in einer anderen Sprache sind. Vorgegebene Abschnittsüberschriften bleiben, wie sie sind.`];
}

function podcastJob(docs, minutes, options) {
  const chars = minutes * CHARS_PER_MINUTE;
  return {
    system: system(options?.language),
    prompt: [
      `Schreib ein Podcast-Gespräch über die Texte auf stdin, etwa ${minutes} Minuten lang, also rund ${chars} Zeichen gesprochener Text insgesamt.`,
      'Zwei Stimmen: A moderiert, führt durch, fragt nach und fasst zusammen. B ordnet ein, erklärt Zusammenhänge und widerspricht, wo die Texte das hergeben.',
      'Nenn jeden Text beim Titel, wenn er drankommt. Arbeite Querverbindungen zwischen den Texten heraus. Zum Schluss zwei oder drei Gedanken zum Mitnehmen.',
      'Gesprochene Sprache: kurze Sätze, keine Aufzählungen, kein Markdown, keine Links. Wechselt euch oft ab, kein Zug länger als etwa 600 Zeichen.',
      'Erlaubt sind sparsam Regieanweisungen in eckigen Klammern auf Englisch, z. B. [laughs], [thoughtful], [curious]; sonst nichts in Klammern.',
      ...condense(docs, minutes),
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
    system: system(options?.language),
    prompt: [
      'Schreib einen Report über die Texte auf stdin, in zwei Fassungen.',
      '`note`: Markdown für eine Notiz im Obsidian-Vault mit den Abschnitten „## Überblick“, „## Kernaussagen“ (je Text eine Unterüberschrift mit dem Titel und die Quelle als Link), „## Querverbindungen“ und „## Offene Fragen“. Keine Überschrift erster Ordnung.',
      `\`spoken\`: dieselben Inhalte als Fließtext zum Vorlesen, etwa ${minutes} Minuten, also rund ${chars} Zeichen. Gesprochene Sprache, kurze Sätze, kein Markdown, keine Links, Titel der Texte ausgesprochen.`,
      ...condense(docs, minutes),
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

const topicSystem = (language) =>
  [
    `Du arbeitest auf ${EPISODE_LANGUAGES[episodeLanguage(language)]} für den Menschen, dem dieser Obsidian-Vault gehört, und sprichst ihn mit du an. Er hört das Ergebnis unterwegs, etwa im Auto.`,
    'Du erfindest nichts. Was nicht aus seinem Vault stammt, sondern aus dem Internet, kennzeichnest du als extern. Lücken und Widersprüche sprichst du offen an.',
    'Du lieferst ausschließlich das verlangte JSON.',
  ].join(' ');

/** Ziele, Anlass, Schwerpunkte als Zeile für Claude, sonst nichts. */
const goalLine = (goal) => (goal ? `Ziele, Anlass oder Schwerpunkte, die er dazu genannt hat: ${goal}` : 'Ziele oder Anlass hat er nicht genannt; finde selbst heraus, was ihn an dem Thema gerade beschäftigt.');

/** Wie viele Kapitel ungefähr: eins bis zwölf Minuten, sonst eins je etwa zwölf Minuten. */
export function chapterHint(minutes) {
  if (minutes <= 12) return 'ein Kapitel';
  const n = Math.min(MAX_CHAPTERS, Math.max(2, Math.round(minutes / 12)));
  return `etwa ${n} Kapitel, keins länger als ${CHAPTER_MINUTES} Minuten`;
}

function researchJob(ep) {
  const reads = Math.min(60, Math.max(8, Math.round(ep.minutes / 2)));
  return {
    system: topicSystem(ep.language),
    prompt: [
      `Recherchiere für einen ${KINDS[ep.kind]} von etwa ${ep.minutes} Minuten zum Thema: ${ep.topic}`,
      goalLine(ep.goal),
      'Arbeite zuerst seinen ganzen Vault durch, mit den Werkzeugen mcp__vault__vault_search, vault_read, vault_links, vault_similar und vault_list: Projekte, Lebensbereiche, Ressourcen, Wiki, Tagesnotizen, Reviews und Archiv.',
      `Such mit mehreren Formulierungen und Synonymen, lies die einschlägigen Notizen ganz, folge ihren Links und ähnlichen Notizen. Je länger die Folge, desto gründlicher: lies rund ${reads} Notizen, wenn der Vault so viel hergibt.`,
      ep.web
        ? 'Ergänze danach mit WebSearch und WebFetch, was der Vault nicht hat: aktuelle Fakten, Forschung, Gegenpositionen, Beispiele. Suchanfragen ans Internet enthalten nie persönliche Details aus dem Vault (Namen, Gesundheit, Finanzen, Arbeitgeber, Beziehungen), nur das allgemeine Thema.'
        : 'Nur der Vault, kein Internet.',
      'Liefere:',
      '- `title`: Titel der Folge, höchstens 100 Zeichen.',
      '- `summary`: zwei bis vier Sätze Überblick für die Notiz.',
      '- `dossier`: Markdown ohne Überschrift erster Ordnung: die Befunde nach Unterthemen, jede Aussage mit Quellenkürzel wie [V3] (Vault) oder [W2] (Web), kurze wörtliche Zitate, wo sie tragen, Widersprüche, Entwicklungen über die Zeit und offene Fragen. Ausführlich genug, dass sich daraus die ganze Folge schreiben lässt, ohne noch einmal nachzusehen.',
      `- \`chapters\`: der Kapitelplan, ${chapterHint(ep.minutes)}, die Minuten zusammen etwa ${ep.minutes}; je Kapitel \`title\`, \`minutes\` und \`points\` (was drankommt, mit Quellenkürzeln). Das erste Kapitel eröffnet, das letzte schließt mit zwei oder drei Gedanken zum Mitnehmen.`,
      '- `sources`: alle Quellen mit `id` (V1, V2 … für Notizen, W1, W2 … fürs Web), `title`, bei Notizen `path` genau wie im Vault, bei Webseiten `url`.',
      ...languageLine(ep.language),
    ].join('\n'),
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['title', 'summary', 'dossier', 'chapters', 'sources'],
      properties: {
        title: { type: 'string' },
        summary: { type: 'string' },
        dossier: { type: 'string' },
        chapters: {
          type: 'array',
          minItems: 1,
          items: { type: 'object', additionalProperties: false, required: ['title', 'minutes', 'points'], properties: { title: { type: 'string' }, minutes: { type: 'number' }, points: { type: 'string' } } },
        },
        sources: {
          type: 'array',
          items: { type: 'object', additionalProperties: false, required: ['id', 'title'], properties: { id: { type: 'string' }, title: { type: 'string' }, path: { type: 'string' }, url: { type: 'string' } } },
        },
      },
    },
  };
}

/**
 * Claudes Recherche in feste Form: Kapitel mit Minuten, die zusammen die
 * gewünschte Länge ergeben (je mindestens 2), höchstens `MAX_CHAPTERS`;
 * Vault-Quellen nur, wenn Claude die Notiz auch gelesen hat (`read`), sonst
 * alle gelesenen; Webquellen nur mit http(s)-Adresse und nur, wenn im Internet
 * recherchiert werden durfte (`web`).
 */
export function normalizeResearch(raw, { minutes, topic, read = [], web: online = true }) {
  const text = (v) => String(v ?? '').trim();
  let chapters = (Array.isArray(raw?.chapters) ? raw.chapters : [])
    .map((c) => ({ title: cleanTitle(c?.title, ''), minutes: Math.max(1, Number(c?.minutes) || 0), points: text(c?.points) }))
    .filter((c) => c.title)
    .slice(0, MAX_CHAPTERS);
  if (!chapters.length) chapters = [{ title: cleanTitle(topic, 'Thema'), minutes, points: '' }];
  const sum = chapters.reduce((n, c) => n + c.minutes, 0);
  chapters = chapters.map((c) => ({ ...c, minutes: Math.max(2, Math.round((c.minutes / sum) * minutes)) }));
  const known = new Set(read);
  const strip = (p) => text(p).replace(/^\/+/, '');
  const withMd = (p) => (/\.md$/i.test(p) ? p : `${p}.md`);
  const all = Array.isArray(raw?.sources) ? raw.sources : [];
  const vault = [];
  const web = [];
  for (const s of all) {
    const id = text(s?.id).slice(0, 10);
    const title = text(s?.title).slice(0, 200);
    const path = strip(s?.path);
    const hit = path && (known.has(path) ? path : known.has(withMd(path)) ? withMd(path) : null);
    if (hit && !vault.some((v) => v.path === hit)) vault.push({ id, title: title || hit, path: hit });
    else if (!path && online && /^https?:\/\/\S+$/i.test(text(s?.url)) && !web.some((w) => w.url === text(s.url))) web.push({ id, title: title || text(s.url), url: text(s.url) });
  }
  if (!vault.length) for (const p of read) vault.push({ id: '', title: p.replace(/^.*\//, '').replace(/\.md$/i, ''), path: p });
  return {
    title: cleanTitle(raw?.title, cleanTitle(topic, 'Thema')),
    summary: text(raw?.summary),
    dossier: text(raw?.dossier),
    chapters,
    sources: { vault, web },
  };
}

/** Dossier und Quellen für jedes Kapitel über stdin. */
function dossierInput(research) {
  const src = [
    ...research.sources.vault.map((s) => `${s.id ? `[${s.id}] ` : ''}${s.title} (Notiz im Vault)`),
    ...research.sources.web.map((s) => `${s.id ? `[${s.id}] ` : ''}${s.title} (extern, ${s.url})`),
  ].join('\n');
  return `<dossier>\n${research.dossier.slice(0, DOSSIER_INPUT)}\n</dossier>\n\n<quellen>\n${src}\n</quellen>`;
}

/** Ein Kapitel schreiben, ohne Werkzeuge, aus dem Dossier; `before`: Ende des vorigen Kapitels. */
function chapterJob(ep, research, i, before) {
  const ch = research.chapters[i];
  const n = research.chapters.length;
  const chars = ch.minutes * CHARS_PER_MINUTE;
  const plan = research.chapters.map((c, k) => `${k + 1}. ${c.title} (${c.minutes} Min.)${k === i ? '  ← jetzt' : ''}`).join('\n');
  const place =
    n === 1
      ? 'Es ist die ganze Folge: Eröffne kurz, führe durch das Thema und schließ mit zwei oder drei Gedanken zum Mitnehmen.'
      : i === 0
        ? 'Es ist das erste Kapitel: Eröffne die Folge, sag kurz, worum es geht und was kommt. Keine Verabschiedung.'
        : i === n - 1
          ? 'Es ist das letzte Kapitel: Knüpf an das vorige an, führ zusammen und schließ mit zwei oder drei Gedanken zum Mitnehmen. Keine neue Begrüßung.'
          : 'Es ist ein Kapitel mittendrin: Knüpf an das vorige an, keine Begrüßung, keine Verabschiedung.';
  const common = [
    `Folge „${research.title}“ zum Thema: ${ep.topic}`,
    goalLine(ep.goal),
    `Kapitelplan:\n${plan}`,
    `Schreib jetzt Kapitel ${i + 1} von ${n}: „${ch.title}“, etwa ${ch.minutes} Minuten, also rund ${chars} Zeichen gesprochener Text.`,
    ch.points && `Was drankommt: ${ch.points}`,
    place,
    before && `So endete das vorige Kapitel:\n${before}`,
    'Grundlage ist allein das Dossier auf stdin. Sag beim Sprechen, woher etwas kommt (aus deinen Notizen, aus dem Wiki, aus einer Quelle im Netz), ohne Quellenkürzel vorzulesen.',
    'Gesprochene Sprache: kurze Sätze, keine Aufzählungen, kein Markdown, keine Links.',
    ...languageLine(ep.language),
  ].filter(Boolean);
  if (ep.kind === 'podcast') {
    return {
      system: topicSystem(ep.language),
      prompt: [
        ...common,
        'Ein Gespräch zweier Stimmen: A moderiert, führt durch, fragt nach und fasst zusammen. B ordnet ein, erklärt Zusammenhänge und widerspricht, wo das Material es hergibt. Wechselt euch oft ab, kein Zug länger als etwa 600 Zeichen.',
        'Erlaubt sind sparsam Regieanweisungen in eckigen Klammern auf Englisch, z. B. [laughs], [thoughtful], [curious]; sonst nichts in Klammern.',
      ].join('\n\n'),
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['turns'],
        properties: { turns: { type: 'array', minItems: 2, items: { type: 'object', additionalProperties: false, required: ['speaker', 'text'], properties: { speaker: { type: 'string', enum: ['A', 'B'] }, text: { type: 'string' } } } } },
      },
    };
  }
  return {
    system: topicSystem(ep.language),
    prompt: [...common, 'Eine Stimme erzählt, ruhig und klar, wie ein guter Radiobeitrag. Ohne den Kapiteltitel am Anfang, den sagt das Cockpit an.'].join('\n\n'),
    schema: { type: 'object', additionalProperties: false, required: ['spoken'], properties: { spoken: { type: 'string' } } },
  };
}

/** Ende eines Kapitels als Anschluss für das nächste. */
function chapterTail(chapter) {
  const text = chapter.turns ? chapter.turns.map((t) => `${t.speaker}: ${t.text}`).join('\n') : (chapter.spoken ?? '');
  return text.length > CARRY_CHARS ? `…${text.slice(-CARRY_CHARS)}` : text;
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
 *   als Wert oder Funktion (dann gilt eine geänderte Einstellung sofort);
 *   `language`: Sprache von Podcast und Report (`EPISODE_LANGUAGES`, sonst
 *   Deutsch), ebenso als Wert oder Funktion.
 * - `provider(cfg)`: ElevenLabs-Client (Tests ersetzen ihn).
 * - `research`: Vault-Zugang für Claudes Recherche (src/lesen/research-mcp.js,
 *   `{ open() }`); ohne gibt es keine Folgen zu einem Thema.
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
  language = null,
  provider = (cfg) => createElevenLabs(cfg),
  research = null,
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
  // Folgen von vor „gehört je Folge“: Ihre Texte waren schon gehört, also die Folge auch.
  let migrated = false;
  for (const ep of episodes) {
    if (ep.status === 'fertig' && !('heard_at' in ep)) {
      ep.heard_at = ep.finished_at ?? ep.updated_at ?? null;
      migrated = true;
    }
  }
  const queue = [];
  let running = null;

  function save() {
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${file}.tmp`, `${JSON.stringify(episodes, null, 2)}\n`, { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
  }

  if (migrated) {
    try {
      save();
    } catch (err) {
      logger.warn?.(`Folgen: Stand „gehört“ nicht gesichert: ${err.message}`);
    }
  }

  const find = (id) => episodes.find((e) => e.id === id) ?? null;
  const audioPath = (id) => join(dir, `${id}.mp3`);
  const scriptPath = (id) => join(dir, `${id}.skript.json`);
  const researchPath = (id) => join(dir, `${id}.recherche.json`);

  /** Claudes Antwort, sobald sie da ist: Ein zweiter Versuch fragt Claude nicht noch einmal. */
  function loadJson(path) {
    try {
      return JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      return null;
    }
  }
  function saveJson(path, value) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${path}.tmp`, JSON.stringify(value), { mode: 0o600 });
    renameSync(`${path}.tmp`, path);
  }
  const loadScript = (id) => loadJson(scriptPath(id));
  const saveScript = (id, script) => saveJson(scriptPath(id), script);
  /**
   * Lässt sich ohne Claude fortsetzen: Vorlesen immer, sonst mit gesichertem
   * Skript; bei einem Thema erst, wenn alle Kapitel geschrieben sind.
   */
  const resumable = (ep) => {
    if (ep.kind === 'vorlesen') return true;
    if (ep.source === 'thema') return loadScript(ep.id)?.complete === true;
    return existsSync(scriptPath(ep.id));
  };

  function update(ep, fields) {
    Object.assign(ep, fields, { updated_at: now().toISOString() });
    save();
  }

  /** Worklog der Folge (src/lesen/worklog.js); gespeichert mit dem nächsten `update`. */
  function step(ep, text) {
    ep.log ??= [];
    logStep(ep.log, text, now());
  }

  function availability() {
    const voice = Boolean(tts());
    const claude = Boolean(writer?.available());
    const missingVoice = voice ? null : 'Folgen brauchen ElevenLabs (Einstellungen → Vorlesen)';
    const missingClaude = claude ? null : 'Podcast und Report brauchen Claude: CLAUDE_CODE_OAUTH_TOKEN im Deployment (Token aus `claude setup-token`)';
    return { vorlesen: missingVoice, podcast: missingVoice ?? missingClaude, report: missingVoice ?? missingClaude };
  }
  /** Was einer Folge zu einem Thema fehlt, sonst null; erst nur das Transkript (`audio` false) braucht keine Stimme. */
  const topicMissing = (audio = true) => missingFor('report', audio) ?? (research ? null : 'Folgen zu einem Thema brauchen den Vault-Zugang für die Recherche');

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

  /** Sprache für neue Folgen aus den Einstellungen. */
  const currentLanguage = () => episodeLanguage(typeof language === 'function' ? language() : language);

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
  /** Sprache (außer Deutsch), Ton und Schwerpunkt in einem Satz fürs Transkript, ohne Wünsche leer. */
  const wished = (ep) =>
    [
      ep.language && ep.language !== DEFAULT_EPISODE_LANGUAGE ? (EPISODE_LANGUAGES[ep.language] ?? ep.language) : null,
      ep.style && ep.style !== DEFAULT_STYLE ? `Ton: ${STYLES[ep.style]?.label ?? ep.style}` : null,
      ep.topics?.length || ep.focus ? `Schwerpunkt: ${[...(ep.topics ?? []), ...(ep.focus ? [ep.focus] : [])].join(', ')}` : null,
    ]
      .filter(Boolean)
      .join(' · ');

  async function writeNote(ep, docs, title, body) {
    if (ep.note || !createNote) return;
    const date = today();
    const sources = docs.map((d) => ({ title: d.title || d.url, path: sourceNote?.(d.id) ?? null, url: d.url }));
    const line = `${KINDS[ep.kind]} aus dem Lesestapel, ${date}, ${docs.length} ${docs.length === 1 ? 'Text' : 'Texte'} (Cockpit)`;
    await saveNote(ep, { title, date, line, body, sources });
  }

  /**
   * Transkript einer Themen-Folge: Thema, Ziele und Internet im Frontmatter,
   * Überblick, Kapitel, das Dossier der Recherche und alle Quellen.
   */
  async function writeTopicNote(ep, research, chapters) {
    if (ep.note || !createNote) return;
    const date = today();
    const { vault, web } = research.sources;
    const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;
    const line = `${KINDS[ep.kind]} zum Thema, ${date}, ${count(chapters.length, 'Kapitel', 'Kapitel')}, Recherche in ${count(vault.length, 'Notiz', 'Notizen')}${ep.web ? ` und ${count(web.length, 'Webquelle', 'Webquellen')}` : ''} (Cockpit)`;
    const body = [
      ep.goal && `> [!note] Ziele und Anlass\n${ep.goal.split(/\r?\n/).map((l) => `> ${l}`).join('\n')}`,
      research.summary && `## Überblick\n\n${research.summary}`,
      ...chapters,
      research.dossier && `## Recherche\n\n${research.dossier}`,
    ].filter(Boolean).join('\n\n');
    const sources = [...vault.map((v) => ({ title: v.id ? `${v.id} ${v.title}` : v.title, path: v.path })), ...web.map((w) => ({ title: w.id ? `${w.id} ${w.title}` : w.title, url: w.url, external: true }))];
    const front = [`thema: ${JSON.stringify(breakTemplater(ep.topic))}`, ...(ep.goal ? [`ziel: ${JSON.stringify(breakTemplater(ep.goal))}`] : []), `internet: ${ep.web ? 'true' : 'false'}`, ...(web.length ? ['web:', ...web.map((w) => `  - ${JSON.stringify(w.url)}`)] : [])];
    await saveNote(ep, { title: research.title, date, line, body, sources, front, origin: 'thema' });
  }

  /**
   * Legt das Transkript an: `sources` als `{ title, path?, url?, external? }`,
   * Notizen als Wikilink (auch im Frontmatter unter `quellen`), sonst als Link.
   */
  async function saveNote(ep, { title, date, line, body, sources, front = [], origin = 'lesestapel' }) {
    const str = (v) => JSON.stringify(String(v));
    const label = (t) => String(t).replace(/[[\]|\r\n]+/g, ' ').trim();
    const linked = sources.map((s) => ({ ...s, path: s.path?.replace(/\.md$/i, '') ?? null }));
    const links = linked.filter((s) => s.path).map((s) => `  - ${str(`[[${s.path}]]`)}`);
    const content = [
      '---',
      'type: folge',
      `art: ${ep.kind}`,
      `quelle: ${origin}`,
      `titel: ${str(breakTemplater(title))}`,
      `folge_id: ${str(ep.id)}`,
      `erzeugt: ${date}`,
      `minuten: ${ep.minutes}`,
      ...front,
      ...(ep.language && ep.language !== DEFAULT_EPISODE_LANGUAGE ? [`sprache: ${ep.language}`] : []),
      ...(ep.style && ep.style !== DEFAULT_STYLE ? [`stil: ${ep.style}`] : []),
      ...(ep.topics?.length ? ['themen:', ...ep.topics.map((t) => `  - ${str(breakTemplater(t))}`)] : []),
      ...(ep.focus ? [`schwerpunkt: ${str(breakTemplater(ep.focus))}`] : []),
      ...(links.length ? ['quellen:', ...links] : ['quellen: []']),
      'ingest: offen',
      '---',
      '',
      `# ${safeWikiMarkdown(title)}`,
      '',
      `_${line}_`,
      '',
      ...(wished(ep) ? [`> ${safeWikiMarkdown(wished(ep))}`, ''] : []),
      safeWikiMarkdown(body),
      '',
      '## Quellen',
      '',
      ...linked.map((s) => (s.path ? `- [[${s.path}|${label(s.title)}]]` : `- [${label(s.title)}](<${String(s.url).replace(/[<>]/g, encodeURIComponent)}>)${s.external ? ' (extern)' : ''}`)),
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

  /**
   * Recherche und Kapitel einer Themen-Folge: Was schon da ist (Dossier,
   * geschriebene Kapitel), bleibt; Claude macht nur, was fehlt.
   */
  async function topicScript(ep) {
    let found = loadJson(researchPath(ep.id));
    if (!found) {
      if (!research) throw new EpisodeError(topicMissing());
      update(ep, { status: 'recherchiert', researching_at: now().toISOString() });
      step(ep, `Claude recherchiert zu „${ep.topic}“ im Vault${ep.web ? ' und im Internet' : ''}`);
      const session = await research.open();
      let raw;
      let read;
      try {
        const input = `Heute ist ${today()}. Die Werkzeuge mcp__vault__* lesen seinen Vault${ep.web ? ', WebSearch und WebFetch das Internet' : ''}.`;
        raw = await writer.write({ ...researchJob(ep), input, tools: ep.web ? WEB_TOOLS : [], mcp: session.mcp, timeoutMs: RESEARCH_TIMEOUT_MS, onTool: (name, args) => logTool(ep.log, name, args, now()) });
        read = session.read();
      } finally {
        await session.close();
      }
      found = normalizeResearch(raw, { minutes: ep.minutes, topic: ep.topic, read, web: ep.web });
      if (!found.dossier) throw new EpisodeError('Claude hat kein Dossier geliefert');
      saveJson(researchPath(ep.id), found);
      step(ep, `Recherche fertig: ${found.chapters.length} Kapitel geplant, aus ${found.sources.vault.length} Notizen${found.sources.web.length ? ` und ${found.sources.web.length} Webquellen` : ''}`);
    }
    const total = found.chapters.length;
    update(ep, { title: found.title, researched: true, chapters_total: total, notes_read: found.sources.vault.length, web_sources: found.sources.web.length });
    const script = loadScript(ep.id) ?? { chapters: [] };
    for (let i = script.chapters.length; i < total; i += 1) {
      update(ep, { status: 'schreibt', chapter: i + 1, writing_at: ep.status === 'schreibt' ? ep.writing_at : now().toISOString() });
      step(ep, `Claude schreibt Kapitel ${i + 1} von ${total}: „${found.chapters[i].title}“`);
      const before = i > 0 ? chapterTail(script.chapters[i - 1]) : null;
      const out = await writer.write({ ...chapterJob(ep, found, i, before), input: dossierInput(found) });
      const chapter = ep.kind === 'podcast' ? { turns: (out.turns ?? []).filter((t) => String(t.text ?? '').trim()).map((t) => ({ speaker: t.speaker === 'B' ? 'B' : 'A', text: String(t.text).trim() })) } : { spoken: String(out.spoken ?? '').trim() };
      if (ep.kind === 'podcast' ? chapter.turns.length < 2 : !chapter.spoken) throw new EpisodeError(`Claude hat Kapitel ${i + 1} leer gelassen`);
      script.chapters.push(chapter);
      saveScript(ep.id, script);
    }
    if (!script.complete) saveScript(ep.id, Object.assign(script, { complete: true }));
    return { found, script };
  }

  async function produce(ep) {
    // Erst nur das Transkript braucht keine Stimme; sonst fehlt sie schon vor Claude.
    const speaks = ep.audio !== false;
    const cfg = tts();
    if (!cfg && speaks) throw new EpisodeError(availability().vorlesen);
    let el = null;
    const voice = () => (el ??= provider(cfg));
    const topic = ep.source === 'thema';
    const docs = topic ? [] : ep.docs.map((id) => store.get(id)).filter(Boolean);
    if (!topic && !docs.length) throw new EpisodeError('Die Texte gibt es nicht mehr');
    const asTurns = (list) => {
      const { host, guest } = voices();
      return (list ?? []).filter((t) => String(t.text ?? '').trim()).map((t) => ({ text: String(t.text).trim(), voice: t.speaker === 'B' ? guest : host, speaker: t.speaker }));
    };
    const talk = (turns) => turns.map((t) => `**${t.speaker === 'B' ? 'Gast' : 'Moderation'}:** ${t.text}`).join('\n\n');
    const dialogueJobs = (turns) => dialogueBatches(turns).map((inputs) => async () => ({ audio: await voice().dialogue({ inputs }), paid: inputs.reduce((n, i) => n + i.text.length, 0) }));
    const narrationJobs = (parts) => parts.map((t, i) => async () => ({ audio: await voice().synthesize({ text: t, previous: parts[i - 1] ?? null, next: parts[i + 1] ?? null }), paid: t.length }));

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
    } else if (topic) {
      const { found, script } = await topicScript(ep);
      const n = script.chapters.length;
      const name = (i) => `${n > 1 ? `Kapitel ${i + 1}: ` : ''}${found.chapters[i].title}`;
      // Transkript vor dem Sprechen, wie bei den Folgen aus dem Stapel.
      if (ep.kind === 'podcast') {
        const turns = asTurns(script.chapters.flatMap((c) => c.turns));
        if (turns.length < 2) throw new EpisodeError('Claude hat kein Gespräch geliefert');
        await writeTopicNote(ep, found, script.chapters.map((c, i) => `## ${name(i)}\n\n${talk(asTurns(c.turns))}`));
        jobs = dialogueJobs(turns);
        update(ep, { title: found.title, chars: turns.reduce((sum, t) => sum + t.text.length, 0) });
      } else {
        await writeTopicNote(ep, found, script.chapters.map((c, i) => `## ${name(i)}\n\n${c.spoken}`));
        // Bei mehreren Kapiteln sagt die Stimme jedes an, zur Orientierung beim Hören.
        const parts = script.chapters.flatMap((c, i) => chunkText(n > 1 ? `${name(i)}. ${c.spoken}` : c.spoken, NARRATION_CHARS));
        if (!parts.length) throw new EpisodeError('Claude hat keine Sprechfassung geliefert');
        jobs = narrationJobs(parts);
        update(ep, { title: found.title, chars: parts.join('').length });
      }
    } else {
      let script = loadScript(ep.id);
      if (!script) {
        update(ep, { status: 'schreibt', writing_at: now().toISOString() });
        step(ep, `Claude schreibt ${ep.kind === 'podcast' ? 'das Gespräch' : 'den Report'} aus ${docs.length} ${docs.length === 1 ? 'Text' : 'Texten'}`);
        const options = { style: ep.style, topics: ep.topics, focus: ep.focus, language: ep.language };
        script = await writer.write({ ...(ep.kind === 'podcast' ? podcastJob(docs, ep.minutes, options) : reportJob(docs, ep.minutes, options)), input: sourceInput(docs) });
        saveScript(ep.id, script);
      }
      if (ep.kind === 'podcast') {
        const turns = asTurns(script.turns);
        if (turns.length < 2) throw new EpisodeError('Claude hat kein Gespräch geliefert');
        const title = cleanTitle(script.title, ep.title);
        // Transkript vor dem Sprechen: Was Claude geschrieben hat, ist dann sicher.
        await writeNote(ep, docs, title, `## Gespräch\n\n${talk(turns)}`);
        jobs = dialogueJobs(turns);
        update(ep, { title, chars: turns.reduce((s, t) => s + t.text.length, 0) });
      } else {
        const title = cleanTitle(script.title, ep.title);
        const spoken = String(script.spoken ?? '').trim();
        await writeNote(ep, docs, title, [String(script.note ?? '').trim(), spoken && `## Sprechfassung\n\n${spoken}`].filter(Boolean).join('\n\n'));
        const parts = chunkText(spoken, NARRATION_CHARS);
        if (!parts.length) throw new EpisodeError('Claude hat keine Sprechfassung geliefert');
        jobs = narrationJobs(parts);
        update(ep, { title, chars: parts.join('').length });
      }
    }
    if (ep.kind !== 'vorlesen') step(ep, ep.note ? `Transkript im Vault: ${ep.note.split('/').pop().replace(/\.md$/i, '')}` : 'Skript fertig (Transkript nicht im Vault)');
    if (ep.kind !== 'vorlesen' && !speaks) {
      // Skript (bei einem Thema auch die Recherche) bleibt für `speak`; gehört ist noch nichts.
      step(ep, 'Fertig: nur Transkript, Audio auf Knopfdruck');
      update(ep, { status: 'transkript', transcript_at: now().toISOString() });
      logger.info?.(`Folge „${ep.title}“ (${KINDS[ep.kind]}): Transkript fertig, Audio auf Knopfdruck`);
      return;
    }

    const part = `${audioPath(ep.id)}.part`;
    mkdirSync(dir, { recursive: true });
    // Fortsetzen: Was schon gesprochen in `.part` liegt, bleibt; ein halb geschriebenes Stück fällt weg.
    const from = ep.done > 0 && ep.total === jobs.length && Number.isInteger(ep.part_bytes) && existsSync(part) && statSync(part).size >= ep.part_bytes ? ep.done : 0;
    if (from) truncateSync(part, ep.part_bytes);
    else writeFileSync(part, Buffer.alloc(0), { mode: 0o600 });
    const at = now().toISOString();
    step(ep, `${ep.kind === 'vorlesen' ? 'ElevenLabs liest vor' : 'ElevenLabs spricht'}: ${jobs.length} ${jobs.length === 1 ? 'Abschnitt' : 'Abschnitte'}${from ? `, weiter ab ${from + 1}` : ''}`);
    update(ep, { status: 'spricht', done: from, total: jobs.length, part_bytes: from ? ep.part_bytes : 0, paid: from ? (ep.paid ?? 0) : 0, speaking_at: at, speaking_from: from });
    // Satzweise mehrere zugleich (Vorlesen); Gespräch und Report nacheinander, die Stücke sind groß.
    await inOrder(jobs.slice(from), ep.kind === 'vorlesen' ? PARALLEL : 1, ({ audio, paid }, i) => {
      const k = from + i;
      const chunk = audioFrames(audio);
      appendFileSync(part, chunk);
      update(ep, { done: k + 1, part_bytes: ep.part_bytes + chunk.length, paid: ep.paid + paid });
    });
    renameSync(part, audioPath(ep.id));
    for (const f of [scriptPath(ep.id), researchPath(ep.id)]) rmSync(f, { force: true });
    step(ep, 'Fertig');
    update(ep, { ...(ep.kind === 'vorlesen' ? { chars: ep.paid } : {}), status: 'fertig', frames: true, bytes: statSync(audioPath(ep.id)).size, finished_at: now().toISOString() });
    logger.info?.(`Folge „${ep.title}“ (${KINDS[ep.kind]}) fertig, ${ep.chars} Zeichen`);
    // Die Folge bleibt fertig, auch wenn der Vermerk scheitert. Eine Themen-Folge hat keine Texte.
    try {
      if (ep.docs?.length) await heard?.(ep.docs);
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
      step(ep, `Abgebrochen: ${err.message}`);
      update(ep, { status: 'fehler', error: err.message });
    } finally {
      running = null;
    }
    return next();
  }

  // Beim Start: Unterbrochenes fortsetzen, wenn das ohne Claude geht, sonst als Fehler; Wartendes wieder einreihen.
  for (const ep of episodes) {
    if (ep.status === 'recherchiert' || ep.status === 'schreibt' || ep.status === 'spricht') {
      if (resumable(ep)) Object.assign(ep, { status: 'wartet' });
      else if (ep.source === 'thema' && ep.researched) Object.assign(ep, { status: 'fehler', error: 'Durch einen Neustart unterbrochen. Die Recherche und fertige Kapitel bleiben.' });
      else if (ep.source === 'thema') Object.assign(ep, { status: 'fehler', error: 'Durch einen Neustart unterbrochen, bevor die Recherche fertig war.' });
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

  /**
   * Folge gehört (`true`) oder doch nicht (`false`). Gehört: `heard_at` jetzt,
   * Stelle vergessen; die Texte bekommen (noch einmal) den Vermerk „gehört“.
   * Ungehört nimmt nur den Vermerk an der Folge zurück, die Texte bleiben gehört.
   */
  function setHeard(id, value = true) {
    const ep = find(id);
    if (!ep) throw new EpisodeError('Diese Folge gibt es nicht', 404);
    if (ep.status !== 'fertig') throw new EpisodeError('Nur eine fertige Folge lässt sich als gehört markieren', 409);
    if (!value) {
      update(ep, { heard_at: null });
      return { ...ep };
    }
    const first = !ep.heard_at;
    update(ep, { heard_at: now().toISOString(), position: null });
    if (first) {
      Promise.resolve()
        .then(() => heard?.(ep.docs))
        .catch((err) => logger.warn?.(`Folge „${ep.title}“: Vermerk „gehört“ fehlgeschlagen: ${err.message}`));
    }
    return { ...ep };
  }

  return {
    KINDS,
    STATES,
    availability,
    missingFor,
    language: currentLanguage,
    list: () => [...episodes].reverse(),
    get: find,
    /** Nach einem Fehler: setzt fort, ohne Claude noch einmal zu fragen, wenn das Skript schon da ist. */
    resumable: (id) => {
      const ep = find(id);
      return Boolean(ep && resumable(ep));
    },
    audioPath: (id) => (find(id)?.status === 'fertig' && existsSync(audioPath(id)) ? audioPath(id) : null),
    /**
     * Claudes Text als Markdown aus dem gesicherten Skript, für den Fall, dass
     * das Transkript nicht im Vault liegt; ohne Skript (Vorlesen) null.
     */
    scriptText(id) {
      const ep = find(id);
      const script = ep && ep.kind !== 'vorlesen' ? loadScript(id) : null;
      if (!script) return null;
      const talk = (turns) => (turns ?? []).filter((t) => String(t.text ?? '').trim()).map((t) => `**${t.speaker === 'B' ? 'Gast' : 'Moderation'}:** ${String(t.text).trim()}`).join('\n\n');
      let title = cleanTitle(script.title, ep.title);
      let body;
      if (ep.source === 'thema') {
        const found = loadJson(researchPath(id));
        const chapters = script.chapters ?? [];
        title = found?.title ?? ep.title;
        const name = (i) => {
          const t = found?.chapters?.[i]?.title;
          return chapters.length > 1 ? `Kapitel ${i + 1}${t ? `: ${t}` : ''}` : t || 'Kapitel 1';
        };
        body = chapters.map((c, i) => `## ${name(i)}\n\n${ep.kind === 'podcast' ? talk(c.turns) : String(c.spoken ?? '').trim()}`).join('\n\n');
      } else if (ep.kind === 'podcast') {
        body = `## Gespräch\n\n${talk(script.turns)}`;
      } else {
        const spoken = String(script.spoken ?? '').trim();
        body = [String(script.note ?? '').trim(), spoken && `## Sprechfassung\n\n${spoken}`].filter(Boolean).join('\n\n');
      }
      return `# ${title}\n\n${body.trim()}\n`;
    },
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
        heard_at: null,
        chars: estimate({ kind, docs, minutes: m, audio: speaks }),
        ...(writes ? { audio: speaks, style: tone, topics: cleanTopics(topics), focus: cleanFocus(focus), language: currentLanguage() } : {}),
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

    /** Was Folgen zu einem Thema fehlt, sonst null. */
    topicMissing,

    /**
     * Folge zu einem Thema: `kind` Podcast oder Report, `topic`, optional
     * `goal` (Ziele, Anlass, Schwerpunkte), `minutes` zwischen
     * `TOPIC_MINUTES.min` und `.max`, `web` (Internetrecherche, Standard an),
     * `audio` (false = erst nur das Transkript, wie bei `create`). Sprache aus
     * den Einstellungen. Liefert sie sofort, `done` wie bei `create`.
     */
    createTopic({ kind, topic, goal = '', minutes = 30, web = true, audio = true }) {
      if (!TOPIC_KINDS.includes(kind)) throw new EpisodeError(`Zu einem Thema gibt es ${TOPIC_KINDS.map((k) => KINDS[k]).join(' oder ')}`);
      const missing = topicMissing(audio !== false);
      if (missing) throw new EpisodeError(missing, 409);
      const t = String(topic ?? '').replace(/\s+/g, ' ').trim();
      if (t.length < 3) throw new EpisodeError('Bitte ein Thema nennen');
      if (t.length > 300) throw new EpisodeError('Das Thema darf höchstens 300 Zeichen lang sein, Ziele und Details gehören ins Feld darunter');
      const g = String(goal ?? '').replace(/\r\n?/g, '\n').trim();
      if (g.length > 3000) throw new EpisodeError('Ziele und Anlass: höchstens 3000 Zeichen');
      const m = Number(minutes);
      if (!Number.isInteger(m) || m < TOPIC_MINUTES.min || m > TOPIC_MINUTES.max) throw new EpisodeError(`Länge: ${TOPIC_MINUTES.min} bis ${TOPIC_MINUTES.max} Minuten`);
      const at = now().toISOString();
      const ep = {
        id: randomUUID(),
        kind,
        source: 'thema',
        topic: t,
        goal: g || null,
        web: web !== false,
        audio: audio !== false,
        language: currentLanguage(),
        minutes: m,
        title: `${KINDS[kind]}: ${t}`,
        docs: [],
        status: 'wartet',
        heard_at: null,
        chars: audio !== false ? m * CHARS_PER_MINUTE : 0,
        created_at: at,
        updated_at: at,
      };
      episodes.push(ep);
      save();
      queue.push(ep.id);
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
      const missing = ep.source === 'thema' && !resumable(ep) ? topicMissing(ep.audio !== false) : missingFor(ep.kind, ep.audio !== false);
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

    /**
     * Stand des Players: `position` in Sekunden, `duration` (falls bekannt).
     * Kurz vor Schluss (letzte 15 Sekunden oder 95 %) gilt die Folge als gehört.
     * Liefert die Folge; `heard` sagt, ob sie damit gehört ist.
     */
    listened(id, { position, duration = null }) {
      const ep = find(id);
      if (!ep) throw new EpisodeError('Diese Folge gibt es nicht', 404);
      if (ep.status !== 'fertig') throw new EpisodeError('Nur eine fertige Folge lässt sich hören', 409);
      const pos = Number(position);
      if (!Number.isFinite(pos) || pos < 0) throw new EpisodeError('Ungültige Stelle');
      const length = Number(duration) > 0 ? Number(duration) : (ep.bytes ? ep.bytes / BYTES_PER_SECOND : 0);
      const end = length > 0 && (pos >= length - 15 || pos >= length * 0.95);
      if (end) return { ...setHeard(id, true), heard: true };
      update(ep, { position: Math.floor(pos), listened_at: now().toISOString() });
      return { ...ep, heard: Boolean(ep.heard_at) };
    },

    setHeard,

    remove(id) {
      const ep = find(id);
      if (!ep) throw new EpisodeError('Diese Folge gibt es nicht', 404);
      if (running === id) throw new EpisodeError('Die Folge entsteht gerade; danach löschen');
      episodes = episodes.filter((e) => e.id !== id);
      for (const f of [audioPath(id), `${audioPath(id)}.part`, scriptPath(id), researchPath(id)]) rmSync(f, { force: true });
      save();
      return ep;
    },
  };
}
