import { closeSync, constants, existsSync, fstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { localDate, zonedParts } from '../cockpit/week.js';
import { writePrivate } from '../cockpit/settings.js';
import { headingsOf } from '../vault/edit.js';
import { htmlToMarkdown } from './extract.js';
import { isLinkStub, fetchLinkPost } from './feeds.js';
import { blockId, fullTextOf, slugOf } from './vault-export.js';
import { breakTemplater, safeWikiMarkdown } from './wiki-markdown.js';
import { parseNote } from '../vault/markdown.js';
import { logStep, logTool } from './worklog.js';

/**
 * Ingest ins Mycel-Wiki: Claude entwirft, der Nutzer hakt ab, erst dann
 * schreibt das Cockpit.
 *
 * **Entwerfen** (Knopf oder Nachtlauf): Volltext als Markdown, die
 * Markierungen mit Notizen (stärkstes Signal) und bis zu 25 Kandidaten aus
 * `wiki/` (hybride Suche nach Titel, Auszug und Markierungen) gehen an Claude
 * (src/lesen/claude.js). Dazu gezielt je eine Suche nach Synthesen und nach
 * Source-Pages: Von bis zu acht je Typ sieht Claude einen Textauszug, damit es
 * den Text gegen andere Quellen und bestehende Synthesen prüfen kann (neue
 * Synthese nur mit mindestens einer anderen Quelle oder Synthese unter den
 * `beteiligte`, sonst fällt sie weg; bestehende Synthesen lassen sich um einen
 * Abschnitt ergänzen). Die Antwort wird danach deterministisch geprüft:
 * Pfade nur auf Kandidaten (beschreibbare Wiki-Seiten; Source-Pages weder zum
 * Verknüpfen noch zum Bestätigen), Slugs in kebab-case ohne Umlaute, ein
 * „neuer“ Slug, den es im Wiki schon gibt, wird zum Verknüpfen (vorgewählt nur
 * bei Kandidaten), einer, den es sonst im Vault gibt, fällt weg, Wikilinks nur
 * auf Kandidaten oder vorgeschlagene Seiten, nichts in vertraulichen,
 * ausgeschlossenen oder Readwise-Ordnern. Claudes Markdown wird entschärft
 * (src/lesen/wiki-markdown.js): keine fremden Bilder, kein HTML, kein
 * Templater, keine ausführbaren Code-Blöcke. Der Entwurf (`draft`, version 1)
 * liegt in der Tabelle `ingests` von `lesestapel.db`; der Text bleibt im Stapel.
 *
 * **Übernehmen** schreibt in festen Schritten, jeder für sich wiederholbar,
 * der Fortschritt steht in `applied`: Rohquelle über den Exporter (Volltext,
 * gelesen), Source-Page, gewählte neue Seiten, Ergänzungen bestehender
 * Synthesen (Abschnitt „### Aus [[source]] (Datum)“ unter „Ergänzungen“),
 * Verknüpfungen und Bestätigungen
 * an bestehenden Seiten, Eintrag in `wiki/log.md`, Frontmatter der Rohquelle,
 * Dokument archivieren. Bricht ein Schritt ab, setzt der nächste Versuch dort fort.
 * Steht in der Rohquelle schon `ingest: <Datum>` (der Skill `wiki-ingest` war
 * schneller) oder `übersprungen`, entsteht kein Entwurf und Übernehmen lehnt ab.
 *
 * Supersession und Widersprüche löst das Cockpit nicht auf; sie stehen nur als
 * Hinweis im Entwurf („per /wiki-lint“). Nach dem Übernehmen ruft der Dienst
 * `onApplied(docId)`: Dort reiht main.js das Einpflanzen ein
 * (src/lesen/einpflanzen.js), das die Quelle in die Seiten einarbeitet und
 * Widersprüche als Spannung festhält.
 *
 * Worklog (src/lesen/worklog.js): Was beim Entwerfen passiert, steht live
 * unter `worklog(docId)` und danach im Entwurf (`draft.log`).
 *
 * Es entsteht immer nur ein Entwurf zugleich (Claude-Abo schonen). Nach einem
 * Neustart gehen angefangene Entwürfe wieder in die Warteschlange.
 * shortcut: Die Warteschlange lebt im Speicher und wird beim Start aus der
 * Tabelle (`wartet`, `entwirft`) neu gebaut; Reihenfolge nach `requested_at`.
 */

export class IngestError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

/** Ordner je Seitentyp im Mycel. */
export const WIKI_FOLDERS = { source: 'wiki/sources', entity: 'wiki/entities', concept: 'wiki/concepts', synthesis: 'wiki/synthesis', question: 'wiki/questions' };
export const RELATION_TYPES = ['uses', 'depends-on', 'part-of', 'instance-of', 'extends', 'supports', 'contradicts', 'caused', 'fixed', 'supersedes', 'authored-by', 'owned-by', 'alternative-to', 'related-to', 'refines', 'refined-by'];
const CONFIDENCE = ['high', 'medium', 'low', 'speculative'];
const ENTITY_TYPES = ['person', 'tool', 'org', 'product', 'project'];
const SYNTHESIS_ART = ['querverbindung', 'vergleich', 'widerspruch'];
const NEW_KINDS = ['entity', 'concept', 'synthesis', 'question'];
const LOG = 'wiki/log.md';
const NOT_PAGES = new Set([LOG, 'wiki/index.md']);
// So viel Volltext geht an Claude; so viele Kandidaten aus dem Wiki.
const DOC_INPUT = 60_000;
const MAX_CANDIDATES = 25;
const MAX_QUERIES_FROM_HIGHLIGHTS = 8;
// Gezielt gesuchte Synthesen und Source-Pages: so viele je Typ mit Textauszug, so lang je Auszug, so viel insgesamt.
const MAX_FOCUS = { synthesis: 8, source: 8 };
const EXCERPT = 700;
const EXCERPT_TOTAL = 12_000;
const LIMITS = { verknuepfen: 12, neu: 8, synthese: 2, ergaenzen: 2, bestaetigung: 8, relation: 10, hinweise: 10 };

const oneLine = (v, max = 200) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
/** Höchstens `max` Zeichen, an einer Wortgrenze gekürzt. */
function clip(v, max) {
  const s = oneLine(v, 10_000);
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1).replace(/\s+\S*$/, '')}…`;
}
/**
 * Textauszug einer Seite für Claude: Body ohne Frontmatter, H1 und Kommentare,
 * höchstens `max` Zeichen, gekürzt an einer Absatz- oder Satzgrenze (sonst an
 * einem Wort). Absätze bleiben als „¶“ erkennbar.
 */
export function excerptOf(content, max = EXCERPT) {
  const body = parseNote(String(content ?? '')).body.replace(/%%[\s\S]*?%%/g, '').replace(/^#\s+.*$/m, '');
  const paras = body.split(/\n\s*\n/).map((p) => p.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const text = paras.join(' ¶ ');
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  const para = head.lastIndexOf(' ¶ ');
  if (para >= max * 0.5) return head.slice(0, para);
  let sentence = -1;
  for (const m of head.matchAll(/[.!?…]["“”»)]?(?=\s)/g)) sentence = m.index + m[0].length;
  if (sentence >= max * 0.4) return head.slice(0, sentence);
  return `${head.slice(0, max - 1).replace(/\s+\S*$/, '')}…`;
}
/** Überschriften (außerhalb von Code) als fette Zeile: Ein Abschnitt darf die Gliederung der Seite nicht brechen. */
function demoteHeadings(md) {
  let fence = null;
  return String(md ?? '')
    .split('\n')
    .map((l) => {
      const f = /^\s{0,3}(`{3,}|~{3,})/.exec(l);
      if (fence) {
        if (f && f[1][0] === fence[0] && f[1].length >= fence.length) fence = null;
        return l;
      }
      if (f) {
        fence = f[1];
        return l;
      }
      const h = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(l);
      return h && h[1] ? `**${h[1]}**` : l;
    })
    .join('\n')
    .trim();
}
const stemOf = (path) => String(path).split('/').pop().replace(/\.md$/i, '');
const escRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Source-Page? In deren `sources` stehen Rohquellen, keine anderen Source-Pages. */
const isSourcePath = (path) => String(path ?? '').startsWith(`${WIKI_FOLDERS.source}/`);
/** Slug in kebab-case ohne Umlaute; leer oder unbrauchbar → aus `fallback`. */
function cleanSlug(raw, fallback) {
  const s = slugOf(String(raw ?? '').replace(/\.md$/i, '').split('/').pop());
  if (s !== 'text' || /^text$/i.test(String(raw ?? '').trim())) return s.slice(0, 80);
  return slugOf(fallback).slice(0, 80);
}
/** Tags englisch, lowercase, ohne Raute, höchstens zehn. */
const cleanTags = (tags) =>
  [...new Set((Array.isArray(tags) ? tags : String(tags ?? '').split(/[,\s]+/)).map((t) => slugOf(String(t).replace(/^#/, ''))).filter((t) => t && t !== 'text'))].slice(0, 10);
/** Ziel eines Wikilinks ohne Klammern, Alias und Abschnitt. */
const linkTarget = (raw) => String(raw ?? '').replace(/^\[\[|\]\]$/g, '').split('|')[0].split('#')[0].trim();
const RESERVED = /^(true|false|yes|no|on|off|null|y|n|~)$/i;
/** YAML-Wert: Datum und schlichte kebab-Wörter bloß, alles andere in Anführungszeichen; ohne Templater-Tag. */
const scalar = (v) => {
  const s = breakTemplater(v);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) || (/^[a-z][a-z0-9-]*$/.test(s) && !RESERVED.test(s)) ? s : JSON.stringify(s);
};

/** Frontmatter aus `[key, value]`; `null` fällt weg, Listen als Block. */
function frontmatter(entries) {
  const lines = ['---'];
  for (const [key, value] of entries) {
    if (value == null) continue;
    if (Array.isArray(value)) lines.push(...(value.length ? [`${key}:`, ...value.map((v) => `  - ${scalar(v)}`)] : [`${key}: []`]));
    else lines.push(`${key}: ${scalar(value)}`);
  }
  lines.push('---');
  return lines.join('\n');
}

/**
 * Wikilinks umschreiben: Ziele aus `map` (klein geschrieben → Slug) bleiben
 * mit diesem Slug, `resolve(target)` darf weitere zulassen (liefert den Slug
 * oder null); alles andere wird zu Text (Alias, sonst `label(target)`).
 */
function relink(text, map, { resolve = () => null, label = (t) => t } = {}) {
  return String(text ?? '').replace(/\[\[([^[\]\n]+)\]\]/g, (_, inner) => {
    const [targetPart, ...aliasParts] = inner.split('|');
    const alias = aliasParts.join('|').trim();
    const [base, ...anchor] = targetPart.split('#');
    const key = base.trim().replace(/\.md$/i, '').toLowerCase();
    const slug = map.get(key) ?? map.get(key.split('/').pop()) ?? resolve(base.trim());
    if (!slug) return alias || label(base.trim());
    return `[[${slug}${anchor.length ? `#${anchor.join('#')}` : ''}${alias ? `|${alias}` : ''}]]`;
  });
}

const SYSTEM = [
  'Du bereitest Texte für das persönliche Wissenswiki „Mycel“ in einem Obsidian-Vault vor. Ein Mensch prüft deinen Entwurf und hakt ab, was übernommen wird; du schreibst nichts selbst.',
  'Mycel-Konventionen: Seiten liegen unter wiki/sources (eine Quelle, eine Seite), wiki/entities (Personen, Tools, Organisationen, Produkte, Projekte), wiki/concepts (Konzepte, Methoden, Muster), wiki/synthesis (Querverbindungen, Vergleiche, Widersprüche zwischen mehreren Quellen), wiki/questions (offene Fragen).',
  'Inhalte und Titel immer auf Deutsch, unabhängig von der Sprache der Quelle. Tags englisch, lowercase, kebab-case. Slugs kebab-case ohne Umlaute und Sonderzeichen; Source-Pages mit Autor- oder Quellenpräfix, z. B. glaser-the-elastic-loop. Summary ist ein Einzeiler mit höchstens 80 Zeichen.',
  'Wikilinks als [[slug]] oder [[slug|Anzeige]], nur auf Slugs der Kandidaten aus dem Wiki (Dateiname ohne .md) oder auf Seiten, die du selbst neu vorschlägst.',
  'Compound über Completeness: lieber wenige gut verknüpfte Seiten als viele isolierte. Sei konservativ mit neuen Seiten: eine neue Entity oder ein neues Konzept nur, wenn es im Text eine tragende Rolle spielt und es im Wiki noch keine passende Seite gibt. Fragen nur, wenn der Text sie wirklich trägt.',
  'Synthesen sind die wertvollste Schicht des Wikis: Sie halten fest, was erst aus mehreren Quellen zusammen sichtbar wird. Prüfe den Text deshalb ausdrücklich gegen die Synthesen und Quellen unter den Kandidaten. Eine Synthese braucht mindestens eine andere Quelle oder Synthese, mit der der Text eine Querverbindung bildet, sich vergleichen lässt oder in Widerspruch steht; bloße Themennähe reicht nicht. Lieber eine starke Synthese als zwei schwache, und keine, wenn nichts trägt.',
  'Seiten werden aktualisiert statt dupliziert: Trägt der Text zu einer bestehenden Synthese etwas bei, ergänze sie, statt eine neue mit ähnlichem Thema anzulegen.',
  'Widersprüche nie glätten: benenne sie, schlage eine Auflösung vor, ändere aber nichts. Erfinde nichts, was nicht im Text oder in den Kandidaten steht; Lücken offen benennen.',
  'Die Markierungen und Notizen des Lesers zeigen, was ihm wichtig war: Sie sind das stärkste Signal für Kernaussagen und Verknüpfungen.',
  'Du lieferst ausschließlich das verlangte JSON.',
].join('\n');

const PROMPT = [
  'Auf stdin stehen ein Text aus dem Lesestapel (<text>), die Markierungen des Lesers (<markierungen>), Kandidaten aus dem Wiki (<wiki-kandidaten>, je Pfad, Typ, Titel und Summary) und Synthesen und Quellen aus dem Wiki mit einem Auszug ihres Texts (<synthesen-und-quellen>, ebenfalls Kandidaten). Entwirf den Ingest:',
  '- `digest.kernaussagen`: 3–5 Sätze, was der Text sagt.',
  '- `digest.neu`: 0–4 Punkte, was gegenüber dem Wiki neu ist.',
  '- `digest.bestaetigt`: Kandidaten, deren Aussage der Text bestätigt (`path` exakt wie angegeben, `claim` = die bestätigte Aussage).',
  '- `digest.widerspricht`: Kandidaten, denen der Text widerspricht, mit `vorschlag` zur Auflösung.',
  '- `digest.dockt_an`: Kandidaten, an die der Text anschließt und die auf die neue Source-Page verweisen sollen (`warum` in einem Satz). Nur echte Bezüge, keine bloße Themennähe.',
  '- `source`: die Source-Page. `body` ist Markdown ohne Überschrift erster Ordnung und ohne Frontmatter: eine Destillation, keine Kopie (was ist neu, was ist relevant, was widerspricht Bestehendem), mit Wikilinks auf Kandidaten und auf deine neuen Seiten. `confidence` nach Qualität der Quelle (high nur bei sauber belegten Quellen).',
  '- `neu`: neue Seiten (kind entity, concept, synthesis oder question) mit Slug, Titel, Summary, kurzem Body (Markdown, Deutsch, ohne Überschrift erster Ordnung) und `warum`. Entity mit `entity_type`, Synthese mit `art` und `beteiligte` (Pfade der Kandidaten). Fragen als Frage formuliert. Leer lassen, wenn nichts davon trägt.',
  '- Synthese-Schritt: Gehe die Synthesen und Quellen unter <synthesen-und-quellen> einzeln durch. Bildet der Text mit einer anderen Quelle eine Querverbindung, lässt er sich mit ihr vergleichen oder widerspricht er ihr? Daraus 0–2 neue Synthesen in `neu` (kind synthesis): `art` querverbindung, vergleich oder widerspruch (bei einem erkannten Widerspruch bevorzugt eine Synthese mit art widerspruch), `beteiligte` mit mindestens einem Pfad einer anderen Quelle oder Synthese aus den Kandidaten (sonst wird sie verworfen), der Body benennt, was erst aus beiden zusammen sichtbar wird.',
  '- `ergaenzungen`: 0–2 bestehende Synthesen (`path` exakt wie angegeben, nur Kandidaten vom Typ synthesis), zu denen der Text inhaltlich etwas beiträgt. `body` ist der neue Abschnitt: Markdown, Deutsch, ohne Überschriften, 2–6 Sätze, was diese Quelle zur Synthese beiträgt, bestätigt, verschiebt oder widerlegt, mit Wikilinks wie oben; `warum` ein Satz. Passt der Text zu einer bestehenden Synthese, ergänze sie, statt eine ähnliche neue vorzuschlagen. Leer lassen, wenn nichts trägt.',
  '- `relationen`: typisierte Beziehungen von der Source-Page zu Kandidaten (`to` = Pfad), nur wenn der Text die Beziehung trägt.',
  '- `hinweise`: was der Leser vor dem Übernehmen wissen sollte (z. B. Text sehr kurz oder hinter einer Paywall, Widerspruch zu [[slug]] – Auflösung per /wiki-lint).',
].join('\n');

const pathRef = { type: 'string', description: 'Pfad eines Kandidaten, exakt wie angegeben' };
const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['digest', 'source', 'neu', 'ergaenzungen', 'relationen', 'hinweise'],
  properties: {
    digest: {
      type: 'object',
      additionalProperties: false,
      required: ['kernaussagen', 'neu', 'bestaetigt', 'widerspricht', 'dockt_an'],
      properties: {
        kernaussagen: { type: 'array', items: { type: 'string' } },
        neu: { type: 'array', items: { type: 'string' } },
        bestaetigt: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['path', 'claim'], properties: { path: pathRef, claim: { type: 'string' } } } },
        widerspricht: {
          type: 'array',
          items: { type: 'object', additionalProperties: false, required: ['path', 'claim', 'vorschlag'], properties: { path: pathRef, claim: { type: 'string' }, vorschlag: { type: 'string' } } },
        },
        dockt_an: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['path', 'warum'], properties: { path: pathRef, warum: { type: 'string' } } } },
      },
    },
    source: {
      type: 'object',
      additionalProperties: false,
      required: ['slug', 'title', 'summary', 'confidence', 'tags', 'body'],
      properties: {
        slug: { type: 'string' },
        title: { type: 'string' },
        summary: { type: 'string', description: 'höchstens 80 Zeichen' },
        confidence: { type: 'string', enum: CONFIDENCE },
        tags: { type: 'array', items: { type: 'string' } },
        body: { type: 'string' },
      },
    },
    neu: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'slug', 'title', 'summary', 'body', 'warum'],
        properties: {
          kind: { type: 'string', enum: NEW_KINDS },
          slug: { type: 'string' },
          title: { type: 'string' },
          summary: { type: 'string', description: 'höchstens 80 Zeichen' },
          entity_type: { type: 'string', enum: ENTITY_TYPES },
          art: { type: 'string', enum: SYNTHESIS_ART },
          beteiligte: { type: 'array', items: pathRef, description: 'bei Synthesen: mindestens eine andere Quelle oder Synthese aus den Kandidaten' },
          tags: { type: 'array', items: { type: 'string' } },
          body: { type: 'string' },
          warum: { type: 'string' },
        },
      },
    },
    ergaenzungen: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, required: ['path', 'body', 'warum'], properties: { path: { ...pathRef, description: 'Pfad einer Synthese unter den Kandidaten, exakt wie angegeben' }, body: { type: 'string' }, warum: { type: 'string' } } },
    },
    relationen: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['type', 'to'], properties: { type: { type: 'string', enum: RELATION_TYPES }, to: pathRef } } },
    hinweise: { type: 'array', items: { type: 'string' } },
  },
};

const attr = (v) => oneLine(v, 300).replace(/"/g, "'");

/** Eingabe für Claude: Text, Markierungen, Kandidaten; Synthesen und Quellen mit Auszug in einem eigenen Block. */
function inputFor(doc, text, highlights, candidates) {
  const marks = highlights.length
    ? highlights.map((h, i) => `${i + 1}. „${oneLine(h.quote, 1000)}“${h.note?.trim() ? ` — Notiz: ${oneLine(h.note, 1000)}` : ''}`).join('\n')
    : 'keine';
  const line = (c) => `- ${c.path} · ${c.type ?? '?'} · ${oneLine(c.title)}${c.summary ? ` — ${oneLine(c.summary)}` : ''}`;
  const plain = candidates.filter((c) => c.excerpt == null);
  const focus = candidates.filter((c) => c.excerpt != null);
  const cands = plain.length ? plain.map(line).join('\n') : 'keine';
  const focused = focus.length ? focus.map((c) => `${line(c)}${c.excerpt ? `\n  Auszug: ${c.excerpt}` : ''}`).join('\n') : 'keine';
  return [
    `<text titel="${attr(doc.title || doc.url)}" quelle="${attr(doc.site)}" url="${attr(doc.url)}"${doc.author ? ` autor="${attr(doc.author)}"` : ''}>`,
    text,
    '</text>',
    '',
    '<markierungen>',
    marks,
    '</markierungen>',
    '',
    '<wiki-kandidaten>',
    cands,
    '</wiki-kandidaten>',
    '',
    '<synthesen-und-quellen>',
    focused,
    '</synthesen-und-quellen>',
  ].join('\n');
}

/** Kurzform eines Entwurfs für Listen: Kernaussagen, Source-Felder, Hinweise. */
function brief(draft) {
  if (!draft) return null;
  return {
    version: draft.version,
    digest: { kernaussagen: draft.digest?.kernaussagen ?? [], neu: draft.digest?.neu ?? [] },
    source: { slug: draft.source?.slug, title: draft.source?.title, summary: draft.source?.summary, confidence: draft.source?.confidence, tags: draft.source?.tags ?? [] },
    hinweise: draft.hinweise ?? [],
    // Ohne Body und Begründung: genug für Zählung und Gruppen auf den Karten der Übersicht.
    items: (draft.items ?? []).map(({ id, kind, action, title, entity_type, art, default: def }) => ({ id, kind, action, title, entity_type, art, default: def })),
  };
}

/** Zählung der Items eines Entwurfs je Art, für Listen. */
function itemCounts(draft) {
  const items = draft?.items ?? [];
  const n = (f) => items.filter(f).length;
  return {
    total: items.length,
    default: n((i) => i.default),
    neu: n((i) => i.action === 'neu'),
    verknuepfen: n((i) => i.action === 'verknuepfen'),
    ergaenzen: n((i) => i.action === 'ergaenzen'),
    bestaetigung: n((i) => i.kind === 'bestaetigung'),
    relation: n((i) => i.kind === 'relation'),
  };
}

/**
 * - `store`: Lesestapel (src/lesen/store.js) mit der Tabelle `ingests`.
 * - `writer`: Claude (src/lesen/claude.js), `{ available(), write() }`.
 * - `search(query, { folder, type, limit })` → `{ results: [{ path, title, type }] }` (hybride Suche; `type` filtert nach Seitentyp).
 * - `index`, `editor`, `policy`, `vaultPath` wie für die übrigen Schreibwege.
 * - `exporter`: Lesestapel → Vault (src/lesen/vault-export.js), legt die Rohquelle an.
 * - `settings.get()`: `tz` und `ingest` (`nightly`, `hour`, `model`, `limit`).
 * - `resumeDelayMs`: Pause vor dem Fortsetzen nach dem Start.
 * - `fetchPage`: Abruf für Link-Posts (`fetchLinkPost` in src/lesen/feeds.js), Standard `safeFetch`; setzen Tests.
 */
export function createIngest({ store, writer, search, index, exporter, editor, policy, settings, vaultPath, onApplied = null, logger = console, now = () => new Date(), resumeDelayMs = 1000, fetchPage }) {
  const queue = [];
  // Worklog laufender und fehlgeschlagener Entwürfe (nur im Speicher).
  const logs = new Map();
  const applying = new Set();
  let pump = null;
  const iso = () => now().toISOString();
  const today = () => localDate(now(), settings.get().tz);

  function available() {
    if (!writer?.available()) return { ok: false, reason: 'Ingest braucht Claude: CLAUDE_CODE_OAUTH_TOKEN im Deployment (Token aus `claude setup-token`)' };
    return { ok: true };
  }

  // --- Wiki-Seiten ------------------------------------------------------------

  /** Darf das Cockpit in diesen Ordner schreiben? Wie beim Exporter: nicht vertraulich, nicht ausgeschlossen, kein Readwise. */
  const folderAllowed = (folder) => {
    const probe = `${folder}/_.md`;
    return !policy.isExcluded(probe) && !policy.sensitivityOf(probe) && policy.classify(probe) === 'core';
  };
  /** Vorhandene, beschreibbare Wiki-Seite? */
  function writable(path) {
    if (!/^wiki\/.+\.md$/.test(path) || NOT_PAGES.has(path) || path.split('/').some((p) => p.startsWith('.'))) return false;
    if (policy.isExcluded(path) || policy.sensitivityOf(path) || policy.classify(path) !== 'core') return false;
    const note = index.getNote(path);
    return Boolean(note && note.content !== null && note.class === 'core' && !note.sensitivity);
  }
  /** Pfad, `wiki/…` ohne `.md`, `[[slug]]` oder Slug → Pfad einer beschreibbaren Wiki-Seite oder null. */
  function resolvePage(ref) {
    const raw = String(ref ?? '').trim();
    if (!raw) return null;
    const target = linkTarget(raw);
    for (const p of [target, `${target}.md`]) if (p.startsWith('wiki/') && writable(p)) return p;
    const hit = index.resolveLink?.(target.replace(/\.md$/i, ''));
    return hit && writable(hit) ? hit : null;
  }
  function describePage(path) {
    const note = index.getNote(path);
    const fm = note?.frontmatter ?? {};
    const entityType = ENTITY_TYPES.includes(fm['entity-type']) ? fm['entity-type'] : null;
    return { path, title: oneLine(note?.title ?? fm.title ?? stemOf(path)), type: note?.type ?? fm.type ?? null, entity_type: entityType, summary: oneLine(fm.summary ?? '', 200), status: fm.status ?? note?.status ?? null };
  }
  /** Seitentyp → Art eines Items (unbekannt: concept). */
  const kindOf = (type) => (['source', 'entity', 'concept', 'synthesis', 'question'].includes(type) ? type : 'concept');

  /** Kandidaten aus `wiki/`: mehrere Anfragen, abwechselnd zusammengeführt, ohne Doppelte. */
  async function findCandidates(doc, text, highlights) {
    const ask = async (q, opts) => {
      try {
        return (await search(q, { folder: 'wiki', limit: 15, ...opts }))?.results ?? [];
      } catch (err) {
        logger.warn?.(`Ingest: Suche „${q.slice(0, 40)}“${opts.type ? ` (${opts.type})` : ''} fehlgeschlagen: ${err.message}`);
        return [];
      }
    };
    const queries = [doc.title, doc.excerpt || text.slice(0, 400), ...highlights.slice(0, MAX_QUERIES_FROM_HIGHLIGHTS).map((h) => `${h.quote} ${h.note ?? ''}`)]
      .map((q) => oneLine(q, 300))
      .filter(Boolean);
    const lists = [];
    for (const q of queries) lists.push(await ask(q, {}));
    const out = new Map();
    for (let i = 0; out.size < MAX_CANDIDATES && lists.some((l) => i < l.length); i += 1) {
      for (const l of lists) {
        const path = l[i]?.path;
        if (!path || out.has(path) || !writable(path)) continue;
        out.set(path, describePage(path));
        if (out.size >= MAX_CANDIDATES) break;
      }
    }

    // Synthesen und Source-Pages gezielt (je eine Anfrage mit Typfilter), mit Auszug: Ob sie unter den
    // gemischten Treffern sind, wäre sonst Zufall, und ohne ihren Text sieht Claude keine Querverbindung.
    const focus = oneLine([doc.title, doc.excerpt || text.slice(0, 400), ...highlights.slice(0, 3).map((h) => h.quote)].filter(Boolean).join(' '), 600);
    let budget = EXCERPT_TOTAL;
    for (const type of ['synthesis', 'source']) {
      const hits = focus ? await ask(focus, { type }) : [];
      const isType = (c) => (type === 'source' ? c.type === 'source' || isSourcePath(c.path) : c.type === 'synthesis');
      let n = 0;
      // Erst die gezielten Treffer, dann was die gemischte Suche schon fand.
      for (const path of [...hits.map((h) => h?.path), ...out.keys()]) {
        if (n >= MAX_FOCUS[type]) break;
        if (!path || out.get(path)?.excerpt != null || !writable(path)) continue;
        const c = out.get(path) ?? describePage(path);
        if (!isType(c)) continue;
        const excerpt = budget > 0 ? excerptOf(index.getNote(path)?.content, Math.min(EXCERPT, budget)) : '';
        budget -= excerpt.length;
        out.set(path, { ...c, excerpt });
        n += 1;
      }
    }
    return [...out.values()];
  }

  /**
   * Claudes Antwort → Entwurf nach Vertrag: nur bekannte Pfade, saubere Slugs,
   * IDs je Art (v, n, s, q, e, b, r), `default` (Neues abgewählt), Wikilinks geprüft.
   * Neue Synthesen nur mit einer anderen Quelle oder Synthese unter den Kandidaten
   * in `beteiligte`, höchstens zwei; Ergänzungen nur an Synthesen unter den
   * Kandidaten, höchstens zwei.
   */
  function shape(out, { doc, candidates, text }) {
    const known = new Map(candidates.map((c) => [c.path, c]));
    // Nur Kandidaten: Claude darf keine anderen Seiten (vorgewählt) anfassen.
    const page = (ref) => known.get(resolvePage(ref)) ?? null;
    const isSource = (p) => p.type === 'source' || isSourcePath(p.path);
    const isSynthesis = (p) => p.type === 'synthesis';
    const hinweise = [];
    const counters = {};
    const nextId = (prefix) => `${prefix}${(counters[prefix] = (counters[prefix] ?? 0) + 1)}`;

    const title = oneLine(out?.source?.title || doc.title || doc.url, 200);
    const source = {
      slug: cleanSlug(out?.source?.slug, title),
      title,
      summary: clip(out?.source?.summary ?? '', 80),
      confidence: CONFIDENCE.includes(out?.source?.confidence) ? out.source.confidence : 'medium',
      tags: cleanTags(out?.source?.tags ?? []),
      body: String(out?.source?.body ?? '').trim(),
    };

    // Wikilink-Ziele: Kandidaten (Slug, Pfad oder Titel) und, unten ergänzt, neue Seiten.
    const links = new Map();
    for (const c of candidates) {
      links.set(c.title.toLowerCase(), stemOf(c.path));
      links.set(stemOf(c.path).toLowerCase(), stemOf(c.path));
      links.set(c.path.replace(/\.md$/, '').toLowerCase(), stemOf(c.path));
    }
    links.set(String(out?.source?.slug ?? '').trim().toLowerCase(), source.slug);
    links.set(source.slug, source.slug);

    const items = [];
    const linked = new Set();
    // Source-Pages nie: Bezüge zwischen Quellen nur als Wikilink im Body oder als Relation.
    const verknuepfen = (p, warum, def = true) => {
      if (isSource(p) || linked.has(p.path) || items.filter((i) => i.action === 'verknuepfen').length >= LIMITS.verknuepfen) return;
      linked.add(p.path);
      // `entity_type` aus dem Frontmatter, damit die Oberfläche „Person“ oder „Werkzeug“ statt „Entity“ zeigt.
      items.push({ id: nextId('v'), kind: kindOf(p.type), action: 'verknuepfen', path: p.path, title: p.title, ...(p.entity_type ? { entity_type: p.entity_type } : {}), warum: oneLine(warum, 500), default: def });
    };

    const dockt = [];
    for (const d of out?.digest?.dockt_an ?? []) {
      const p = page(d.path);
      if (!p) continue;
      dockt.push({ path: p.path, title: p.title, warum: oneLine(d.warum, 500) });
      verknuepfen(p, d.warum);
    }

    const newSlugs = new Set();
    for (const n of out?.neu ?? []) {
      if (!NEW_KINDS.includes(n?.kind)) continue;
      // Eine Synthese ohne andere Quelle oder Synthese ist bloße Themennähe: weg, bevor sie irgendwo verknüpft.
      const beteiligte = n.kind === 'synthesis' ? [...new Set((n.beteiligte ?? []).map((b) => page(b)).filter(Boolean).map((p) => p.path))] : [];
      if (n.kind === 'synthesis' && !beteiligte.some((p) => isSource(known.get(p)) || isSynthesis(known.get(p)))) {
        logger.info?.(`Ingest: Synthese „${oneLine(n.title, 80)}“ verworfen, keine andere Quelle oder Synthese beteiligt`);
        continue;
      }
      if (n.kind === 'synthesis' && items.filter((i) => i.kind === 'synthesis' && i.action === 'neu').length >= LIMITS.synthese) continue;
      const slug = cleanSlug(n.slug, n.title);
      const folder = WIKI_FOLDERS[n.kind];
      if (!folderAllowed(folder)) {
        hinweise.push(`„${oneLine(n.title, 80)}“ nicht vorgeschlagen: ${folder} ist vertraulich oder ausgeschlossen`);
        continue;
      }
      // Gibt es die Seite schon (im Zielordner oder als Slug irgendwo im Wiki), wird verknüpft statt
      // angelegt; vorgewählt nur, wenn sie ein Kandidat ist.
      const hit = resolvePage(`${folder}/${slug}.md`) ?? resolvePage(slug);
      const existing = hit ? (known.get(hit) ?? describePage(hit)) : null;
      if (existing) {
        links.set(oneLine(n.title).toLowerCase(), stemOf(existing.path));
        links.set(String(n.slug ?? '').trim().toLowerCase(), stemOf(existing.path));
        links.set(slug, stemOf(existing.path));
        verknuepfen(existing, n.warum, known.has(existing.path));
        continue;
      }
      // Derselbe Dateiname sonst im Vault (vertraulich, außerhalb des Wikis, mehrdeutig): [[slug]] zeigte nicht eindeutig auf die neue Seite.
      if (index.basenameCount?.(slug) || existsSync(join(vaultPath, folder, `${slug}.md`))) {
        hinweise.push(`„${oneLine(n.title, 80)}“ nicht vorgeschlagen: den Namen „${slug}“ gibt es im Vault schon`);
        continue;
      }
      if (newSlugs.has(slug) || slug === source.slug || newSlugs.size >= LIMITS.neu) continue;
      newSlugs.add(slug);
      links.set(oneLine(n.title).toLowerCase(), slug);
      links.set(String(n.slug ?? '').trim().toLowerCase(), slug);
      links.set(slug, slug);
      const prefix = { entity: 'n', concept: 'n', synthesis: 's', question: 'q' }[n.kind];
      const item = { id: nextId(prefix), kind: n.kind, action: 'neu', slug, title: oneLine(n.title, 200) || slug, summary: clip(n.summary ?? '', 80) };
      if (n.kind === 'entity' && ENTITY_TYPES.includes(n.entity_type)) item.entity_type = n.entity_type;
      if (n.kind === 'synthesis') {
        item.art = SYNTHESIS_ART.includes(n.art) ? n.art : 'querverbindung';
        item.beteiligte = beteiligte;
      }
      const tags = cleanTags(n.tags ?? []);
      if (tags.length) item.tags = tags;
      Object.assign(item, { body: String(n.body ?? '').trim(), warum: oneLine(n.warum, 500), default: false });
      items.push(item);
    }

    // Bestehende Synthesen ergänzen: nur Kandidaten vom Typ synthesis, jede einmal.
    for (const e of out?.ergaenzungen ?? []) {
      const p = page(e?.path);
      if (!p || !isSynthesis(p) || items.some((i) => i.action === 'ergaenzen' && i.path === p.path)) continue;
      if (items.filter((i) => i.action === 'ergaenzen').length >= LIMITS.ergaenzen) break;
      const body = String(e.body ?? '').trim();
      if (!body) continue;
      items.push({ id: nextId('e'), kind: 'synthesis', action: 'ergaenzen', path: p.path, title: p.title, body, warum: oneLine(e.warum, 500), default: false });
    }

    const bestaetigt = [];
    for (const b of out?.digest?.bestaetigt ?? []) {
      const p = page(b.path);
      if (!p || bestaetigt.some((x) => x.path === p.path)) continue;
      bestaetigt.push({ path: p.path, title: p.title, claim: oneLine(b.claim, 500) });
      if (!isSource(p) && items.filter((i) => i.kind === 'bestaetigung').length < LIMITS.bestaetigung) items.push({ id: nextId('b'), kind: 'bestaetigung', path: p.path, title: p.title, claim: oneLine(b.claim, 500), default: true });
    }

    const widerspricht = [];
    for (const w of out?.digest?.widerspricht ?? []) {
      const p = page(w.path);
      if (!p) continue;
      widerspricht.push({ path: p.path, title: p.title, claim: oneLine(w.claim, 500), vorschlag: oneLine(w.vorschlag, 500) });
      hinweise.push(`Widerspruch zu [[${stemOf(p.path)}]] – Auflösung per /wiki-lint`);
    }

    for (const r of out?.relationen ?? []) {
      if (!RELATION_TYPES.includes(r?.type)) continue;
      const p = page(r.to);
      if (!p || items.some((i) => i.kind === 'relation' && i.type === r.type && i.to === p.path)) continue;
      if (items.filter((i) => i.kind === 'relation').length >= LIMITS.relation) break;
      items.push({ id: nextId('r'), kind: 'relation', type: r.type, to: p.path, title: p.title, default: true });
    }

    // Wikilinks in den Bodies: Kandidaten, neue Seiten, sonst vorhandene Wiki-Seiten; der Rest wird Text.
    const resolve = (t) => {
      const p = resolvePage(t);
      return p ? stemOf(p) : null;
    };
    // Entschärft schon im Entwurf (Vorschau), beim Schreiben noch einmal.
    source.body = safeWikiMarkdown(relink(source.body.replace(/^#\s+.*\n+/, ''), links, { resolve }));
    for (const i of items) if (i.action === 'neu') i.body = safeWikiMarkdown(relink(i.body.replace(/^#\s+.*\n+/, ''), links, { resolve }));
    // Ergänzungen stehen unter einer eigenen Überschrift dritter Ordnung: eigene Überschriften darin werden fetter Text.
    for (const i of items) if (i.action === 'ergaenzen') i.body = safeWikiMarkdown(relink(demoteHeadings(i.body), links, { resolve }));

    if (text.length < 1500) hinweise.unshift('Text sehr kurz – vielleicht nur ein Anriss oder hinter einer Paywall');
    for (const h of out?.hinweise ?? []) hinweise.push(relink(oneLine(h, 300), links, { resolve }));

    return {
      version: 1,
      digest: {
        kernaussagen: (out?.digest?.kernaussagen ?? []).map((k) => oneLine(k, 600)).filter(Boolean).slice(0, 6),
        neu: (out?.digest?.neu ?? []).map((k) => oneLine(k, 600)).filter(Boolean).slice(0, 6),
        bestaetigt,
        widerspricht,
        dockt_an: dockt,
      },
      source,
      items,
      hinweise: [...new Set(hinweise)].slice(0, LIMITS.hinweise),
    };
  }

  // --- Entwerfen ----------------------------------------------------------------

  /** `ingest` der Rohquelle, wenn sie schon im Wiki ist (ein Datum) oder der Skill sie übersprungen hat; sonst null. */
  function ingestedAs(docId) {
    const path = exporter.notePath?.(docId);
    const v = path ? index.getNote(path)?.frontmatter?.ingest : null;
    const s = v instanceof Date ? v.toISOString().slice(0, 10) : oneLine(v, 40);
    return /^\d{4}-\d{2}-\d{2}/.test(s) || /^übersprungen$/i.test(s) ? s : null;
  }
  const alreadyText = (v) => (/^\d/.test(v) ? `Schon im Wiki (ingest: ${v.slice(0, 10)})` : 'Vom Ingest-Skill übersprungen (ingest: übersprungen)');

  async function draftOne(docId) {
    const row = store.getIngest(docId);
    if (!row || row.status !== 'wartet') return;
    let doc = store.get(docId);
    if (!doc) return;
    // Der Skill war schneller: kein zweiter Ingest, Claude bleibt unbefragt.
    const done = ingestedAs(docId);
    if (done) {
      store.saveIngest(docId, { status: 'verworfen', draft: null, error: `${alreadyText(done)} – kein Entwurf` });
      logger.info?.(`Ingest „${doc.title || doc.url}“: ${alreadyText(done)}, kein Entwurf`);
      return;
    }
    const model = settings.get().ingest?.model ?? null;
    const log = [];
    logs.set(docId, log);
    try {
      store.saveIngest(docId, { status: 'entwirft', error: null, model });
      // Link-Post (etwa Hacker News): Claude bekommt den Artikel, nicht den Anriss aus dem Feed.
      if (isLinkStub(doc)) {
        logStep(log, 'Holt den Artikel hinter dem Link-Post', now());
        doc = await fetchLinkPost(store, doc, { fetchPage }).catch((err) => {
          throw new IngestError(`Nur ein Link-Post, der Artikel ließ sich nicht holen: ${err.message}`);
        });
      }
      if (!htmlToMarkdown(doc.content_html)) throw new IngestError('Dieser Text hat keinen Lesetext');
      const text = fullTextOf(doc).slice(0, DOC_INPUT);
      const highlights = store.listHighlights({ docId });
      logStep(log, `Bereitet den Text vor${highlights.length ? `, mit ${highlights.length} ${highlights.length === 1 ? 'Markierung' : 'Markierungen'}` : ''}`, now());
      const candidates = await findCandidates(doc, text, highlights);
      logStep(log, `Sucht passende Seiten im Wiki: ${candidates.length} ${candidates.length === 1 ? 'Kandidat' : 'Kandidaten'}`, now());
      logStep(log, `Claude entwirft Source-Page und Vorschläge${model ? ` (${model})` : ''}`, now());
      const out = await writer.write({ system: SYSTEM, prompt: PROMPT, input: inputFor(doc, text, highlights, candidates), schema: SCHEMA, onTool: (name, args) => logTool(log, name, args, now()) });
      const draft = shape(out, { doc, candidates, text });
      logStep(log, `Entwurf geprüft: ${draft.items.length} ${draft.items.length === 1 ? 'Vorschlag' : 'Vorschläge'}`, now());
      draft.log = log;
      // Inzwischen verworfen oder gelöscht: nichts überschreiben.
      if (store.getIngest(docId)?.status !== 'entwirft') return;
      logs.delete(docId);
      store.saveIngest(docId, { status: 'bereit', draft, drafted_at: iso(), error: null });
      logger.info?.(`Ingest „${doc.title || doc.url}“: Entwurf bereit, ${draft.items.length} Vorschläge`);
    } catch (err) {
      logger.warn?.(`Ingest „${doc.title || doc.url}“: ${err.message}`);
      logStep(log, `Abgebrochen: ${err.message}`, now());
      try {
        if (store.get(docId)) store.saveIngest(docId, { status: 'fehler', error: err.message });
      } catch {
        /* Dokument inzwischen weg */
      }
    }
  }

  /** Arbeitet die Warteschlange ab, ein Entwurf zugleich; liefert das Ende des Laufs. */
  function kick() {
    if (pump) return pump;
    pump = (async () => {
      while (queue.length) await draftOne(queue.shift());
    })().finally(() => {
      pump = null;
      // Während des Abschlusses eingereiht: gleich weiter.
      if (queue.length) kick();
    });
    return pump;
  }

  function request(docIds, { origin = 'knopf', force = false } = {}) {
    const ok = available();
    if (!ok.ok) throw new IngestError(ok.reason, 409);
    const ids = [...new Set([docIds].flat().map((id) => String(id ?? '')).filter(Boolean))];
    if (ids.length === 1 && !store.get(ids[0])) throw new IngestError('Dieses Dokument gibt es nicht', 404);
    const queued = [];
    for (const id of ids) {
      if (!store.get(id)) continue;
      const cur = store.getIngest(id);
      if (cur && ['wartet', 'entwirft'].includes(cur.status)) continue;
      // Übernommenes nie neu entwerfen; angefangenes Übernehmen erst fortsetzen, ein neuer Entwurf verlöre den Fortschritt.
      const blocked = cur?.status === 'uebernommen' ? 'Schon ins Wiki übernommen' : cur?.applied?.steps?.length ? 'Übernehmen angefangen – erst fortsetzen' : null;
      if (blocked) {
        if (force && ids.length === 1) throw new IngestError(blocked, 409);
        continue;
      }
      if (!force && cur?.status === 'bereit') continue;
      if (applying.has(id)) continue;
      store.saveIngest(id, { status: 'wartet', origin: origin === 'nacht' ? 'nacht' : 'knopf', draft: null, error: null, applied: null, requested_at: iso(), drafted_at: null, applied_at: null });
      queue.push(id);
      queued.push(id);
    }
    return { queued, done: queued.length ? kick() : Promise.resolve() };
  }

  /** Stapel-Dokumente ohne offenen oder fertigen Entwurf (fehlgeschlagene noch einmal, verworfene nicht), älteste zuerst. */
  function requestStack({ origin = 'knopf', limit = Infinity } = {}) {
    const docs = store.list({ status: 'stapel', limit: 5000 }).reverse();
    const statuses = store.ingestStatuses(docs.map((d) => d.id));
    const ids = docs.filter((d) => !statuses.has(d.id) || statuses.get(d.id) === 'fehler').map((d) => d.id).slice(0, limit);
    if (!ids.length) return 0;
    return request(ids, { origin }).queued.length;
  }

  // --- Übernehmen -----------------------------------------------------------------

  /** Seite anlegen; gibt es den Pfad schon, bleibt sie und es kommt ein Fehler. */
  function createPage(path, content) {
    const folder = path.split('/').slice(0, -1).join('/');
    if (!folderAllowed(folder)) throw new IngestError(`${folder} ist vertraulich oder ausgeschlossen; dort schreibt das Cockpit nicht`, 409);
    editor.create({ folder, name: path.split('/').pop(), content });
  }

  /** Bestehende `sources` als Liste; `[[x]]` unquotiert liest der Parser als `[x]`, das wird wieder ein Wikilink. */
  const sourcesOf = (fm) =>
    [fm?.sources ?? []].flat().filter((s) => s != null && String(s).trim()).map((s) => {
      const v = String(s).trim();
      return /^\[+[^[\]]+\]+$/.test(v) && !v.includes('/') ? `[[${linkTarget(v.replace(/^\[+|\]+$/g, ''))}]]` : v;
    });

  /**
   * Bestehende Seite mit der Source-Page verbinden: `sources` ergänzen, `updated`
   * bzw. `confirmed` auf heute, verblasst → aktiv, Zeile unter „## Quellen“.
   */
  function linkPage(path, slug, { confirm = false, update = false }) {
    if (!writable(path)) throw new IngestError(`„${path}“ ist nicht (mehr) beschreibbar`, 409);
    const note = index.getNote(path);
    const fm = note.frontmatter ?? {};
    const sources = sourcesOf(fm);
    const set = {};
    if (!sources.some((s) => linkTarget(s) === slug)) set.sources = [...sources, `[[${slug}]]`];
    if (update) set.updated = today();
    if (confirm) set.confirmed = today();
    if (fm.status === 'faded') set.status = (fm.type ?? note.type) === 'question' ? 'open' : 'active';
    if (Object.keys(set).length) editor.setFrontmatter({ path, set });
    const content = readFileSync(join(vaultPath, path), 'utf8');
    const line = `- [[${slug}]]`;
    if (new RegExp(`^- \\[\\[${escRe(slug)}(\\|[^\\]]*)?\\]\\]`, 'm').test(content)) return;
    // „Quellen“ so gesucht wie der Editor (jede Ebene, außerhalb von Code); mehrdeutig → ans Ende.
    const headings = headingsOf(content);
    const quellen = headings.filter((h) => h.text === 'Quellen').length;
    if (quellen === 1) editor.append({ path, heading: 'Quellen', text: line });
    else if (quellen > 1 && headings.at(-1).text === 'Quellen') editor.append({ path, text: line });
    else editor.append({ path, text: `\n## Quellen\n\n${line}` });
  }

  /**
   * Bestehende Synthese ergänzen: Abschnitt `### Aus [[slug]] (Datum)` unter
   * „Ergänzungen“ (so gesucht wie „Quellen“; fehlt sie oder ist sie mehrdeutig, neu
   * am Ende), danach wie beim Verknüpfen `sources`, `updated`, `confirmed`, verblasst
   * → aktiv und die Zeile unter „Quellen“. Steht der Abschnitt schon da (zweiter
   * Versuch nach einem Abbruch), wird er nicht noch einmal angehängt.
   */
  function extendSynthesis(path, slug, body) {
    if (!writable(path)) throw new IngestError(`„${path}“ ist nicht (mehr) beschreibbar`, 409);
    if ((index.getNote(path)?.type ?? index.getNote(path)?.frontmatter?.type) !== 'synthesis') throw new IngestError(`„${path}“ ist keine Synthese (mehr)`, 409);
    const content = readFileSync(join(vaultPath, path), 'utf8');
    const done = headingsOf(content).some((h) => new RegExp(`^Aus \\[\\[${escRe(slug)}(\\|[^\\]]*)?\\]\\]`).test(h.text));
    if (!done) {
      const section = `### Aus [[${slug}]] (${today()})\n\n${safeWikiMarkdown(String(body ?? '').trim())}`;
      if (headingsOf(content).filter((h) => h.text === 'Ergänzungen').length === 1) editor.append({ path, heading: 'Ergänzungen', text: `\n${section}` });
      else editor.append({ path, text: `\n## Ergänzungen\n\n${section}` });
    }
    linkPage(path, slug, { update: true, confirm: true });
  }

  /**
   * Eintrag in `wiki/log.md`. Steht das Log nicht im Index (Policy schließt es oft aus), direkt anhängen.
   * Mit `slug` nur, wenn es zu dieser Source-Page noch keinen Ingest-Eintrag gibt (zweiter Versuch nach einem Abbruch).
   */
  function appendLog(entry, slug = null) {
    if (policy.sensitivityOf(LOG) || policy.classify(LOG) !== 'core') throw new IngestError(`${LOG} liegt in einem vertraulichen oder importierten Ordner`, 409);
    const abs = join(vaultPath, LOG);
    const done = (content) => slug != null && new RegExp(`ingest \\(cockpit\\) \\|[^\\n]*\\n- Source-Page: \\[\\[${escRe(slug)}\\]\\]`).test(content);
    const note = index.getNote(LOG);
    if (note && note.content !== null && note.class === 'core' && !note.sensitivity) {
      if (!done(note.content)) editor.append({ path: LOG, text: `\n${entry}` });
      return;
    }
    // Wie im Editor: nichts über einen Symlink aus dem Vault hinaus.
    const vaultReal = realpathSync(vaultPath);
    mkdirSync(dirname(abs), { recursive: true });
    if (!realpathSync(dirname(abs)).startsWith(vaultReal + sep)) throw new IngestError(`${LOG} zeigt aus dem Vault heraus`, 409);
    // Öffnen, ohne einem Symlink zu folgen, dann über denselben Deskriptor lesen und
    // anhängen: kein Zeitfenster zwischen Prüfen und Schreiben.
    let fd;
    try {
      fd = openSync(abs, constants.O_RDWR | constants.O_APPEND | constants.O_NOFOLLOW);
    } catch (err) {
      if (err.code === 'ELOOP') throw new IngestError(`${LOG} ist ein Symlink; dorthin schreibt das Cockpit nicht`, 409);
      if (err.code !== 'ENOENT') throw err;
      // `wx` legt nur neu an, auch nicht über einen inzwischen untergeschobenen Symlink.
      writeFileSync(abs, `# Log\n\n${entry}\n`, { encoding: 'utf8', flag: 'wx' });
      return;
    }
    try {
      if (!fstatSync(fd).isFile()) throw new IngestError(`${LOG} ist keine gewöhnliche Datei`, 409);
      const content = readFileSync(fd, 'utf8');
      if (done(content)) return;
      writeSync(fd, `${content.endsWith('\n') ? '' : '\n'}\n${entry}\n`);
    } finally {
      closeSync(fd);
    }
  }

  /** Source-Page: Frontmatter nach Mycel, H1, Destillation, Markiertes, Verknüpftes, Quelle. */
  function sourceContent({ doc, source, rawPath, relations, chosenStems, highlights }) {
    const rawStem = stemOf(rawPath);
    const url = /^https?:\/\//i.test(doc.url ?? '') ? doc.url : null;
    const d = today();
    const body = safeWikiMarkdown(source.body.trim());
    const missing = chosenStems.filter((s) => !new RegExp(`\\[\\[${escRe(s)}(?:[|#\\]])`).test(body));
    // Zitat aus dem Artikel, Notiz vom Leser: `<…>` und fremde Bilder entschärft wie Claudes Text.
    const marks = highlights.map((h) => {
      const quote = safeWikiMarkdown(clip(String(h.quote).replace(/\[\[|\]\]/g, ''), 300));
      const note = h.note?.trim() ? `\n  Notiz: ${safeWikiMarkdown(clip(h.note.replace(/\[\[|\]\]/g, ''), 500))}` : '';
      return `- „${quote}“ → [[${rawStem}#^${blockId(h.id)}]]${note}`;
    });
    return [
      frontmatter([
        ['type', 'source'],
        ['title', source.title],
        ['summary', source.summary],
        ['created', d],
        ['updated', d],
        ['sources', [rawPath]],
        ['url', url],
        ['tags', source.tags],
        ['status', 'active'],
        ['confidence', source.confidence],
        ['relations', relations.length ? relations : null],
      ]),
      '',
      `# ${safeWikiMarkdown(source.title)}`,
      '',
      ...(body ? [body, ''] : []),
      ...(marks.length ? ['## Markiert', '', ...marks, ''] : []),
      ...(missing.length ? ['## Verknüpft', '', ...missing.map((s) => `- [[${s}]]`), ''] : []),
      '## Quelle',
      '',
      `- Rohquelle: [[${rawStem}]]`,
      ...(url ? [`- Original: <${url.replace(/[<>]/g, encodeURIComponent)}>`] : []),
      '',
    ].join('\n');
  }

  /** Neue Seite (Entity, Konzept, Synthese, Frage) mit Rückverweis auf die Source-Page. */
  function itemContent(item, { slug, confidence }) {
    const d = today();
    const beteiligte = (item.beteiligte ?? []).map(stemOf);
    return [
      frontmatter([
        ['type', item.kind],
        ['entity-type', item.kind === 'entity' ? (item.entity_type ?? null) : null],
        ['art', item.kind === 'synthesis' ? item.art : null],
        ['title', item.title],
        ['summary', item.summary],
        ['created', d],
        ['updated', d],
        ['sources', [`[[${slug}]]`]],
        ['tags', item.tags ?? []],
        ['status', item.kind === 'question' ? 'open' : 'active'],
        ['confidence', confidence],
      ]),
      '',
      `# ${safeWikiMarkdown(item.title)}`,
      '',
      ...(item.body ? [safeWikiMarkdown(item.body.trim()), ''] : []),
      ...(beteiligte.length ? ['## Beteiligte', '', ...beteiligte.map((s) => `- [[${s}]]`), ''] : []),
      '## Quellen',
      '',
      `- [[${slug}]]`,
      '',
    ].join('\n');
  }

  /**
   * Übernehmen. `items`: IDs aus dem Entwurf (unbekannte → 400); `source`: Änderungen
   * an Titel, Summary, Slug, Tags. Jeder Schritt steht danach in `applied`; ein
   * zweiter Aufruf nach einem Abbruch setzt fort, nach dem Erfolg liefert er das Ergebnis
   * `{ source, raw, written, linked, confirmed, extended }` (nur Bestätigtes steht unter `confirmed`,
   * nicht unter `linked`; ergänzte Synthesen unter `extended`).
   */
  async function apply(docId, { items: chosenIds = [], source: edits = {} } = {}) {
    const id = String(docId ?? '');
    const row = store.getIngest(id);
    const doc = store.get(id);
    if (!row || !doc) throw new IngestError('Zu diesem Dokument gibt es keinen Entwurf', 404);
    if (row.status === 'uebernommen' && row.applied?.result) return { ...row.applied.result, plant: row.applied.plant?.status ?? null };
    if (row.status !== 'bereit' || !row.draft) throw new IngestError('Dieser Entwurf ist nicht bereit zum Übernehmen', 409);
    if (applying.has(id)) throw new IngestError('Wird gerade übernommen', 409);
    if (!folderAllowed(WIKI_FOLDERS.source)) throw new IngestError(`${WIKI_FOLDERS.source} ist vertraulich oder ausgeschlossen; dort schreibt das Cockpit nicht`, 409);

    const draft = row.draft;
    const byId = new Map(draft.items.map((i) => [i.id, i]));
    const ids = [...new Set([chosenIds].flat().filter((x) => x != null && x !== '').map(String))];
    const unknown = ids.filter((x) => !byId.has(x));
    if (unknown.length) throw new IngestError(`Unbekannte Vorschläge: ${unknown.join(', ')}`, 400);
    const chosen = ids.map((x) => byId.get(x));

    // Der Skill war schneller (oder hat übersprungen): nicht doppelt. Das eigene Datum aus Schritt (f) zählt nicht.
    const done = row.applied?.steps?.includes('raw_frontmatter') ? null : ingestedAs(id);
    if (done) throw new IngestError(`${alreadyText(done)}; Übernehmen würde den Text doppelt ins Wiki bringen`, 409);

    const applied = row.applied ?? { steps: [], items: {}, written: [], linked: [], extended: [] };
    // Ältere Stände kennen keine Ergänzungen.
    applied.extended ??= [];
    const save = () => store.saveIngest(id, { applied });
    const step = async (name, run) => {
      if (applied.steps.includes(name)) return;
      await run();
      applied.steps.push(name);
      save();
    };

    applying.add(id);
    try {
      // Nutzer-Änderungen an der Source-Page; der Slug bleibt nach dem ersten Schreiben fest.
      const source = { ...draft.source };
      if (oneLine(edits.title)) source.title = oneLine(edits.title, 200);
      if (oneLine(edits.summary)) source.summary = clip(edits.summary, 80);
      if (oneLine(edits.slug)) source.slug = cleanSlug(edits.slug, source.title);
      if (edits.tags != null && oneLine([edits.tags].flat().join(' '))) source.tags = cleanTags(edits.tags);

      // (a) Rohquelle mit Volltext, gelesen.
      await step('raw', () => {
        // Ohne `ingest: offen`: Sonst holte der Skill den Text nach einem Abbruch hier ein zweites Mal.
        const r = exporter.save(id, { read: true, fullText: true, markIngest: false });
        if (r.state === 'übersprungen' || r.state === 'weg') throw new IngestError(r.reason ?? 'Die Rohquelle ließ sich nicht anlegen', 409);
        applied.raw = r.path ?? exporter.notePath(id);
        if (!applied.raw) throw new IngestError('Die Rohquelle ließ sich nicht anlegen', 409);
      });
      const rawPath = applied.raw;

      // Slug der Source-Page: bei Kollision mit fremder Seite Kurz-ID anhängen. Belegt ist er auch,
      // wenn es den Dateinamen sonst im Vault gibt (jede Klasse, auch vertraulich): [[slug]] wäre mehrdeutig.
      // Eine schon geschriebene eigene Seite (Abbruch vor dem Merken) erkennt man an der Rohquelle.
      const own = (p) => existsSync(join(vaultPath, p)) && sourcesOf(index.getNote(p)?.frontmatter).includes(rawPath);
      const taken = (s) => {
        const p = `${WIKI_FOLDERS.source}/${s}.md`;
        const mine = own(p);
        if (!mine && existsSync(join(vaultPath, p))) return true;
        return (index.basenameCount?.(s) ?? 0) > (mine && index.getNote(p) ? 1 : 0);
      };
      // Gemerkt, aber noch nicht geschrieben, und inzwischen belegt: neu wählen.
      if (!applied.source || (!applied.steps.includes('source') && taken(applied.slug))) {
        let slug = source.slug;
        if (taken(slug)) slug = `${slug}-${blockId(id).slice(3, 9)}`;
        if (taken(slug)) throw new IngestError(`wiki/sources/${slug}.md gibt es schon`, 409);
        applied.slug = slug;
        applied.source = `${WIKI_FOLDERS.source}/${slug}.md`;
        applied.title = source.title;
        save();
      }
      const slug = applied.slug;
      // Die Bodies verlinken den Slug aus dem Entwurf; hat er sich geändert (Nutzer, Kollision), auf den tatsächlichen.
      const self = draft.source?.slug && draft.source.slug !== slug ? new RegExp(`\\[\\[${escRe(draft.source.slug)}(?=[|#\\]])`, 'gi') : null;
      const relinkSelf = (text) => (self ? String(text ?? '').replace(self, `[[${slug}`) : text);

      // Neue Seiten: Pfad inzwischen belegt → verknüpfen (eine eigene vom Abbruch bleibt); derselbe Name sonst im
      // Vault → die beschreibbare Wiki-Seite verknüpfen (keine Source-Page), sonst weglassen ([[slug]] wäre mehrdeutig).
      const newPath = (i) => `${WIKI_FOLDERS[i.kind]}/${i.slug}.md`;
      const chosenNew = chosen.filter((i) => i.action === 'neu');
      const plan = new Map();
      for (const item of chosenNew) {
        if (item.id in applied.items) continue;
        const path = newPath(item);
        if (existsSync(join(vaultPath, path))) plan.set(item.id, { path, own: sourcesOf(index.getNote(path)?.frontmatter).some((s) => linkTarget(s) === slug) });
        else if (index.basenameCount?.(item.slug)) {
          const other = resolvePage(item.slug);
          plan.set(item.id, other && !isSourcePath(other) ? { path: other } : { skip: true });
        } else plan.set(item.id, { path, create: true });
      }
      const skipped = (i) => plan.get(i.id)?.skip || (i.id in applied.items && applied.items[i.id] === null);
      const notChosen = draft.items.filter((i) => i.action === 'neu' && (!ids.includes(i.id) || skipped(i)));
      // Links auf abgewählte oder weggelassene neue Seiten werden Text.
      const drop = new Map(notChosen.map((i) => [i.slug, i.title]));
      const unlink = (text) =>
        String(text ?? '').replace(/\[\[([^[\]\n|#]+)(?:#[^[\]\n|]*)?(?:\|([^[\]\n]*))?\]\]/g, (m, target, alias) => (drop.has(target.trim()) ? alias || drop.get(target.trim()) : m));
      source.body = unlink(relinkSelf(source.body));

      const relations = chosen.filter((i) => i.kind === 'relation' && writable(i.to)).map((i) => `${i.type} [[${stemOf(i.to)}]]`);
      const chosenStems = [...new Set([...chosenNew.filter((i) => !skipped(i)).map((i) => i.slug), ...chosen.filter((i) => i.action === 'verknuepfen').map((i) => stemOf(i.path))])];

      // (b) Source-Page. Steht sie schon, ist es die eigene (fremde schließt die Wahl des Slugs oben aus).
      await step('source', () => {
        if (existsSync(join(vaultPath, applied.source))) {
          if (!applied.written.includes(applied.source)) applied.written.push(applied.source);
          return;
        }
        const highlights = store.listHighlights({ docId: id });
        createPage(applied.source, sourceContent({ doc, source, rawPath, relations, chosenStems, highlights }));
        applied.written.push(applied.source);
      });

      // (c) Gewählte neue Seiten.
      for (const item of chosenNew) {
        if (item.id in applied.items) continue;
        const p = plan.get(item.id);
        if (p.skip) applied.items[item.id] = null;
        else {
          if (p.create) {
            createPage(p.path, itemContent({ ...item, body: unlink(relinkSelf(item.body)) }, { slug, confidence: source.confidence }));
            applied.written.push(p.path);
          } else if (p.own) {
            if (!applied.written.includes(p.path)) applied.written.push(p.path);
          } else {
            linkPage(p.path, slug, { update: true });
            if (!applied.linked.includes(p.path)) applied.linked.push(p.path);
          }
          applied.items[item.id] = p.path;
        }
        save();
      }

      // (c2) Bestehende Synthesen ergänzen; der Abschnitt verlinkt abgewählte neue Seiten nicht.
      for (const item of chosen.filter((i) => i.action === 'ergaenzen')) {
        if (item.id in applied.items) continue;
        extendSynthesis(item.path, slug, unlink(relinkSelf(item.body)));
        if (!applied.extended.includes(item.path)) applied.extended.push(item.path);
        applied.items[item.id] = item.path;
        save();
      }

      // (d) Verknüpfen und Bestätigen.
      const touch = new Map();
      for (const i of chosen) {
        if (i.action === 'verknuepfen') touch.set(i.path, { ...(touch.get(i.path) ?? {}), update: true, ids: [...(touch.get(i.path)?.ids ?? []), i.id] });
        if (i.kind === 'bestaetigung') touch.set(i.path, { ...(touch.get(i.path) ?? {}), confirm: true, ids: [...(touch.get(i.path)?.ids ?? []), i.id] });
      }
      for (const [path, t] of touch) {
        if (t.ids.every((x) => applied.items[x])) continue;
        linkPage(path, slug, t);
        // Nur bestätigt ist nicht verknüpft: steht im Ergebnis und im Log unter `confirmed` bzw. „Bestätigt“.
        if (t.update && !applied.linked.includes(path)) applied.linked.push(path);
        for (const x of t.ids) applied.items[x] = path;
        save();
      }
      const confirmed = [...new Set(chosen.filter((i) => i.kind === 'bestaetigung').map((i) => i.path))];
      // Ältere Stände führten nur Bestätigtes auch unter `linked`.
      const linked = applied.linked.filter((p) => !confirmed.includes(p) || chosen.some((i) => i.action === 'verknuepfen' && i.path === p));

      // (e) Log.
      await step('log', () => {
        const list = (paths) => (paths.length ? paths.map((p) => `[[${stemOf(p)}]]`).join(', ') : '—');
        const entry = [
          `## [${today()}] ingest (cockpit) | ${safeWikiMarkdown(oneLine(applied.title ?? source.title, 200))}`,
          `- Source-Page: [[${slug}]]`,
          `- Rohquelle: ${rawPath}`,
          `- Neu: ${list(applied.written.filter((p) => p !== applied.source))}`,
          `- Verknüpft: ${list(linked)}`,
          `- Bestätigt: ${list(confirmed)}`,
          ...(applied.extended.length ? [`- Synthese ergänzt: ${list(applied.extended)}`] : []),
        ].join('\n');
        appendLog(entry, slug);
      });

      // (f) Frontmatter der Rohquelle.
      await step('raw_frontmatter', () => {
        const path = exporter.notePath(id) ?? rawPath;
        editor.setFrontmatter({ path, set: { ingest: today(), wiki_source: `[[${slug}]]`, lesestatus: 'gelesen' } });
      });

      // (g) Gelesen und archiviert.
      await step('archiv', () => {
        store.setStatus(id, 'archiv');
      });

      const result = { source: applied.source, raw: rawPath, written: [...applied.written], linked, confirmed, extended: [...applied.extended] };
      applied.result = result;
      store.saveIngest(id, { status: 'uebernommen', applied, applied_at: iso(), error: null });
      logger.info?.(`Ingest „${source.title}“ übernommen: ${result.written.length} geschrieben, ${linked.length} verknüpft, ${confirmed.length} bestätigt, ${result.extended.length} Synthesen ergänzt`);
      // Danach pflanzt ein Agent die Quelle ein (src/lesen/einpflanzen.js); scheitert das Einreihen, bleibt das Übernommene.
      let plant = null;
      try {
        plant = onApplied?.(id) ?? null;
      } catch (err) {
        logger.warn?.(`Ingest „${source.title}“: Einpflanzen nicht eingereiht: ${err.message}`);
      }
      return { ...result, plant };
    } catch (err) {
      store.saveIngest(id, { applied, error: err.message });
      if (err instanceof IngestError) throw err;
      throw new IngestError(`Übernehmen unterbrochen: ${String(err.message).replace(/[.\s]+$/, '')}. Der Fortschritt ist gesichert, ein neuer Versuch setzt dort fort.`, 409);
    } finally {
      applying.delete(id);
    }
  }

  // --- Lesen ----------------------------------------------------------------------

  const docInfo = (d) => (d ? { id: d.id, title: d.title, url: d.url, site: d.site, reading_minutes: d.reading_minutes, status: d.status } : null);
  const view = (row, doc, { full }) => ({
    doc_id: row.doc_id,
    status: row.status,
    origin: row.origin,
    draft: full ? row.draft : brief(row.draft),
    item_counts: itemCounts(row.draft),
    error: row.error,
    applied: row.applied,
    model: row.model,
    requested_at: row.requested_at,
    drafted_at: row.drafted_at,
    applied_at: row.applied_at,
    updated_at: row.updated_at,
    doc,
  });

  /** Nachtlauf: wenn eingeschaltet und Claude da ist, höchstens `limit` Stapel-Dokumente. */
  function nightly() {
    const cfg = settings.get().ingest ?? {};
    if (!cfg.nightly || !available().ok) return 0;
    const n = requestStack({ origin: 'nacht', limit: cfg.limit ?? 20 });
    if (n) logger.info?.(`Ingest nachts: ${n} Entwürfe eingereiht`);
    return n;
  }

  /** Worklog eines Entwurfs: live beim Entwerfen, danach aus dem Entwurf; sonst null. */
  const worklog = (docId) => logs.get(docId) ?? store.getIngest(docId)?.draft?.log ?? null;

  const get = (docId) => {
    const row = store.getIngest(docId);
    return row ? view(row, docInfo(store.get(row.doc_id)), { full: true }) : null;
  };

  /** Entwurf verwerfen; `done`: Dokument „weg“ mit Lesedatum (gelesen, ohne Wiki). */
  function discard(docId, { done = false } = {}) {
    const id = String(docId ?? '');
    if (!store.get(id)) throw new IngestError('Dieses Dokument gibt es nicht', 404);
    const cur = store.getIngest(id);
    if (cur?.status === 'entwirft') throw new IngestError('Der Entwurf entsteht gerade; danach verwerfen', 409);
    if (cur?.status === 'uebernommen') throw new IngestError('Schon ins Wiki übernommen', 409);
    if (applying.has(id)) throw new IngestError('Wird gerade übernommen', 409);
    // Teilweise Geschriebenes (Rohquelle, Source-Page …) bliebe sonst verwaist.
    if (cur?.applied?.steps?.length) throw new IngestError('Übernehmen angefangen – erst fortsetzen', 409);
    const at = queue.indexOf(id);
    if (at >= 0) queue.splice(at, 1);
    store.saveIngest(id, { status: 'verworfen', draft: null, error: null });
    if (done) store.setStatus(id, 'weg', { read: true });
    return get(id);
  }

  // Beim Start: Unterbrochenes wieder einreihen, älteste zuerst; Claude erst nach dem Aufbau des Servers.
  for (const row of store.listIngests({ status: ['wartet', 'entwirft'] }).reverse()) {
    if (row.status === 'entwirft') store.saveIngest(row.doc_id, { status: 'wartet' });
    queue.push(row.doc_id);
  }
  if (queue.length && available().ok) setTimeout(kick, resumeDelayMs).unref?.();

  return {
    available,
    request,
    requestStack,
    get,
    worklog,
    list({ status = null } = {}) {
      return store.listIngests({ status }).map((r) =>
        view(r, { id: r.doc_id, title: r.doc_title, url: r.doc_url, site: r.doc_site, reading_minutes: r.doc_reading_minutes, status: r.doc_status }, { full: false }),
      );
    },
    counts() {
      const c = store.ingestCounts();
      return { wartet: c.wartet, entwirft: c.entwirft, bereit: c.bereit, fehler: c.fehler };
    },
    statusFor: (docIds) => store.ingestStatuses(docIds),
    apply,
    discard,
    nightly,
    /** Eintrag ans Ende von `wiki/log.md` (für das Einpflanzen). */
    log: (entry) => appendLog(entry),
    /** Wartet, bis die Warteschlange leer ist (Tests, Herunterfahren). */
    async idle() {
      if (!pump && queue.length) kick();
      while (pump) await pump;
    },
    SCHEMA,
  };
}

/**
 * Taktgeber für den Nachtlauf: `tick()` (von main.js alle 10 Minuten) ruft
 * `ingest.nightly()`, wenn es in der Zeitzone der Einstellungen gerade die
 * eingestellte Stunde ist und heute noch nicht gelaufen ist. Der Tag steht in
 * `file` (unter /data), damit ein Neustart in der Stunde nicht doppelt läuft,
 * und im Speicher, falls die Datei nicht schreibbar ist. Fällt die Stunde wegen
 * der Zeitumstellung aus, läuft er in der Stunde danach.
 */
export function createNightlyClock({ ingest, settings, file = null, now = () => new Date(), logger = console }) {
  let memory = null;
  // Der spätere Tag aus Datei und Speicher: Scheitert das Schreiben, hält der Speicher den Lauf fest.
  const last = () => {
    let stored = null;
    try {
      if (file) stored = readFileSync(file, 'utf8').trim() || null;
    } catch {
      /* noch keiner oder nicht lesbar */
    }
    return [stored, memory].filter(Boolean).sort().at(-1) ?? null;
  };
  const remember = (day) => {
    memory = day;
    if (!file) return;
    try {
      writePrivate(file, `${day}\n`);
    } catch (err) {
      logger.warn?.(`Ingest nachts: ${file} nicht schreibbar: ${err.message}`);
    }
  };
  return {
    /** Liefert die Zahl der eingereihten Entwürfe, oder null, wenn nicht dran. */
    tick() {
      const s = settings.get();
      const cfg = s.ingest ?? {};
      if (!cfg.nightly) return null;
      const t = now();
      const { hour } = zonedParts(t, s.tz);
      // Gibt es die Stunde heute nicht (Sommerzeit: auf 1:59 folgt 3:00), läuft er in der Stunde danach.
      const skipped = hour === cfg.hour + 1 && zonedParts(new Date(t.getTime() - 3_600_000), s.tz).hour !== cfg.hour;
      if (hour !== cfg.hour && !skipped) return null;
      const day = localDate(t, s.tz);
      if (last() === day) return null;
      // Erst merken, dann laufen: Ein Fehler wiederholt sich nicht alle zehn Minuten.
      remember(day);
      try {
        return ingest.nightly();
      } catch (err) {
        logger.warn?.(`Ingest nachts: ${err.message}`);
        return null;
      }
    },
  };
}
