import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { localDate, zonedParts } from '../cockpit/week.js';
import { writePrivate } from '../cockpit/settings.js';
import { htmlToMarkdown } from './extract.js';
import { blockId, fullTextOf, slugOf } from './vault-export.js';

/**
 * Ingest ins Mycel-Wiki: Claude entwirft, der Nutzer hakt ab, erst dann
 * schreibt das Cockpit.
 *
 * **Entwerfen** (Knopf oder Nachtlauf): Volltext als Markdown, die
 * Markierungen mit Notizen (stärkstes Signal) und bis zu 25 Kandidaten aus
 * `wiki/` (hybride Suche nach Titel, Auszug und Markierungen) gehen an Claude
 * (src/lesen/claude.js). Die Antwort wird danach deterministisch geprüft:
 * Pfade nur auf vorhandene, beschreibbare Wiki-Seiten, Slugs in kebab-case ohne
 * Umlaute, ein „neuer“ Slug, den es schon gibt, wird zum Verknüpfen, Wikilinks
 * nur auf Kandidaten oder vorgeschlagene Seiten, nichts in vertraulichen,
 * ausgeschlossenen oder Readwise-Ordnern. Der Entwurf (`draft`, version 1)
 * liegt in der Tabelle `ingests` von `lesestapel.db`; der Text bleibt im Stapel.
 *
 * **Übernehmen** schreibt in festen Schritten, jeder für sich wiederholbar,
 * der Fortschritt steht in `applied`: Rohquelle über den Exporter (Volltext,
 * gelesen), Source-Page, gewählte neue Seiten, Verknüpfungen und Bestätigungen
 * an bestehenden Seiten, Eintrag in `wiki/log.md`, Frontmatter der Rohquelle,
 * Dokument archivieren. Bricht ein Schritt ab, setzt der nächste Versuch dort fort.
 *
 * Supersession und Widersprüche löst das Cockpit nicht auf; sie stehen nur als
 * Hinweis im Entwurf („per /wiki-lint“).
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
const LIMITS = { verknuepfen: 12, neu: 8, bestaetigung: 8, relation: 10, hinweise: 10 };

const oneLine = (v, max = 200) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
/** Höchstens `max` Zeichen, an einer Wortgrenze gekürzt. */
function clip(v, max) {
  const s = oneLine(v, 10_000);
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1).replace(/\s+\S*$/, '')}…`;
}
const stemOf = (path) => String(path).split('/').pop().replace(/\.md$/i, '');
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
/** YAML-Wert: Datum und schlichte kebab-Wörter bloß, alles andere in Anführungszeichen. */
const scalar = (v) => {
  const s = String(v);
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
  'Compound über Completeness: lieber wenige gut verknüpfte Seiten als viele isolierte. Sei konservativ mit neuen Seiten: eine neue Entity oder ein neues Konzept nur, wenn es im Text eine tragende Rolle spielt und es im Wiki noch keine passende Seite gibt. Synthesen und Fragen nur, wenn der Text sie wirklich trägt, sonst keine.',
  'Widersprüche nie glätten: benenne sie, schlage eine Auflösung vor, ändere aber nichts. Erfinde nichts, was nicht im Text oder in den Kandidaten steht; Lücken offen benennen.',
  'Die Markierungen und Notizen des Lesers zeigen, was ihm wichtig war: Sie sind das stärkste Signal für Kernaussagen und Verknüpfungen.',
  'Du lieferst ausschließlich das verlangte JSON.',
].join('\n');

const PROMPT = [
  'Auf stdin stehen ein Text aus dem Lesestapel (<text>), die Markierungen des Lesers (<markierungen>) und Kandidaten aus dem Wiki (<wiki-kandidaten>, je Pfad, Typ, Titel und Summary). Entwirf den Ingest:',
  '- `digest.kernaussagen`: 3–5 Sätze, was der Text sagt.',
  '- `digest.neu`: 0–4 Punkte, was gegenüber dem Wiki neu ist.',
  '- `digest.bestaetigt`: Kandidaten, deren Aussage der Text bestätigt (`path` exakt wie angegeben, `claim` = die bestätigte Aussage).',
  '- `digest.widerspricht`: Kandidaten, denen der Text widerspricht, mit `vorschlag` zur Auflösung.',
  '- `digest.dockt_an`: Kandidaten, an die der Text anschließt und die auf die neue Source-Page verweisen sollen (`warum` in einem Satz). Nur echte Bezüge, keine bloße Themennähe.',
  '- `source`: die Source-Page. `body` ist Markdown ohne Überschrift erster Ordnung und ohne Frontmatter: eine Destillation, keine Kopie (was ist neu, was ist relevant, was widerspricht Bestehendem), mit Wikilinks auf Kandidaten und auf deine neuen Seiten. `confidence` nach Qualität der Quelle (high nur bei sauber belegten Quellen).',
  '- `neu`: neue Seiten (kind entity, concept, synthesis oder question) mit Slug, Titel, Summary, kurzem Body (Markdown, Deutsch, ohne Überschrift erster Ordnung) und `warum`. Entity mit `entity_type`, Synthese mit `art` und `beteiligte` (Pfade der Kandidaten). Fragen als Frage formuliert. Leer lassen, wenn nichts davon trägt.',
  '- `relationen`: typisierte Beziehungen von der Source-Page zu Kandidaten (`to` = Pfad), nur wenn der Text die Beziehung trägt.',
  '- `hinweise`: was der Leser vor dem Übernehmen wissen sollte (z. B. Text sehr kurz oder hinter einer Paywall, Widerspruch zu [[slug]] – Auflösung per /wiki-lint).',
].join('\n');

const pathRef = { type: 'string', description: 'Pfad eines Kandidaten, exakt wie angegeben' };
const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['digest', 'source', 'neu', 'relationen', 'hinweise'],
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
          beteiligte: { type: 'array', items: pathRef },
          tags: { type: 'array', items: { type: 'string' } },
          body: { type: 'string' },
          warum: { type: 'string' },
        },
      },
    },
    relationen: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['type', 'to'], properties: { type: { type: 'string', enum: RELATION_TYPES }, to: pathRef } } },
    hinweise: { type: 'array', items: { type: 'string' } },
  },
};

const attr = (v) => oneLine(v, 300).replace(/"/g, "'");

/** Eingabe für Claude: Text, Markierungen, Kandidaten. */
function inputFor(doc, text, highlights, candidates) {
  const marks = highlights.length
    ? highlights.map((h, i) => `${i + 1}. „${oneLine(h.quote, 1000)}“${h.note?.trim() ? ` — Notiz: ${oneLine(h.note, 1000)}` : ''}`).join('\n')
    : 'keine';
  const cands = candidates.length ? candidates.map((c) => `- ${c.path} · ${c.type ?? '?'} · ${oneLine(c.title)}${c.summary ? ` — ${oneLine(c.summary)}` : ''}`).join('\n') : 'keine';
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
    bestaetigung: n((i) => i.kind === 'bestaetigung'),
    relation: n((i) => i.kind === 'relation'),
  };
}

/**
 * - `store`: Lesestapel (src/lesen/store.js) mit der Tabelle `ingests`.
 * - `writer`: Claude (src/lesen/claude.js), `{ available(), write() }`.
 * - `search(query, { folder, limit })` → `{ results: [{ path, title, type }] }` (hybride Suche).
 * - `index`, `editor`, `policy`, `vaultPath` wie für die übrigen Schreibwege.
 * - `exporter`: Lesestapel → Vault (src/lesen/vault-export.js), legt die Rohquelle an.
 * - `settings.get()`: `tz` und `ingest` (`nightly`, `hour`, `model`, `limit`).
 * - `resumeDelayMs`: Pause vor dem Fortsetzen nach dem Start.
 */
export function createIngest({ store, writer, search, index, exporter, editor, policy, settings, vaultPath, logger = console, now = () => new Date(), resumeDelayMs = 1000 }) {
  const queue = [];
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
    return { path, title: oneLine(note?.title ?? fm.title ?? stemOf(path)), type: note?.type ?? fm.type ?? null, summary: oneLine(fm.summary ?? '', 200), status: fm.status ?? note?.status ?? null };
  }
  /** Seitentyp → Art eines Items (unbekannt: concept). */
  const kindOf = (type) => (['source', 'entity', 'concept', 'synthesis', 'question'].includes(type) ? type : 'concept');

  /** Kandidaten aus `wiki/`: mehrere Anfragen, abwechselnd zusammengeführt, ohne Doppelte. */
  async function findCandidates(doc, text, highlights) {
    const queries = [doc.title, doc.excerpt || text.slice(0, 400), ...highlights.slice(0, MAX_QUERIES_FROM_HIGHLIGHTS).map((h) => `${h.quote} ${h.note ?? ''}`)]
      .map((q) => oneLine(q, 300))
      .filter(Boolean);
    const lists = [];
    for (const q of queries) {
      try {
        lists.push((await search(q, { folder: 'wiki', limit: 15 }))?.results ?? []);
      } catch (err) {
        logger.warn?.(`Ingest: Suche „${q.slice(0, 40)}“ fehlgeschlagen: ${err.message}`);
      }
    }
    const out = new Map();
    for (let i = 0; out.size < MAX_CANDIDATES && lists.some((l) => i < l.length); i += 1) {
      for (const l of lists) {
        const path = l[i]?.path;
        if (!path || out.has(path) || !writable(path)) continue;
        out.set(path, describePage(path));
        if (out.size >= MAX_CANDIDATES) break;
      }
    }
    return [...out.values()];
  }

  /**
   * Claudes Antwort → Entwurf nach Vertrag: nur bekannte Pfade, saubere Slugs,
   * IDs je Art (v, n, s, q, b, r), `default` (Neues abgewählt), Wikilinks geprüft.
   */
  function shape(out, { doc, candidates, text }) {
    const known = new Map(candidates.map((c) => [c.path, c]));
    const page = (ref) => {
      const p = resolvePage(ref);
      return p ? (known.get(p) ?? describePage(p)) : null;
    };
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
    const verknuepfen = (p, warum) => {
      if (linked.has(p.path) || items.filter((i) => i.action === 'verknuepfen').length >= LIMITS.verknuepfen) return;
      linked.add(p.path);
      items.push({ id: nextId('v'), kind: kindOf(p.type), action: 'verknuepfen', path: p.path, title: p.title, warum: oneLine(warum, 500), default: true });
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
      const slug = cleanSlug(n.slug, n.title);
      const folder = WIKI_FOLDERS[n.kind];
      if (!folderAllowed(folder)) {
        hinweise.push(`„${oneLine(n.title, 80)}“ nicht vorgeschlagen: ${folder} ist vertraulich oder ausgeschlossen`);
        continue;
      }
      // Gibt es die Seite schon (im Zielordner oder als Slug irgendwo im Wiki), wird verknüpft statt angelegt.
      const existing = page(`${folder}/${slug}.md`) ?? page(slug);
      if (existing) {
        links.set(oneLine(n.title).toLowerCase(), stemOf(existing.path));
        links.set(String(n.slug ?? '').trim().toLowerCase(), stemOf(existing.path));
        links.set(slug, stemOf(existing.path));
        verknuepfen(existing, n.warum);
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
        item.beteiligte = [...new Set((n.beteiligte ?? []).map((b) => page(b)?.path).filter(Boolean))];
      }
      const tags = cleanTags(n.tags ?? []);
      if (tags.length) item.tags = tags;
      Object.assign(item, { body: String(n.body ?? '').trim(), warum: oneLine(n.warum, 500), default: false });
      items.push(item);
    }

    const bestaetigt = [];
    for (const b of out?.digest?.bestaetigt ?? []) {
      const p = page(b.path);
      if (!p || bestaetigt.some((x) => x.path === p.path)) continue;
      bestaetigt.push({ path: p.path, title: p.title, claim: oneLine(b.claim, 500) });
      if (bestaetigt.length <= LIMITS.bestaetigung) items.push({ id: nextId('b'), kind: 'bestaetigung', path: p.path, title: p.title, claim: oneLine(b.claim, 500), default: true });
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
    source.body = relink(source.body.replace(/^#\s+.*\n+/, ''), links, { resolve });
    for (const i of items) if (i.action === 'neu') i.body = relink(i.body.replace(/^#\s+.*\n+/, ''), links, { resolve });

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

  async function draftOne(docId) {
    const row = store.getIngest(docId);
    if (!row || row.status !== 'wartet') return;
    const doc = store.get(docId);
    if (!doc) return;
    const model = settings.get().ingest?.model ?? null;
    try {
      store.saveIngest(docId, { status: 'entwirft', error: null, model });
      if (!htmlToMarkdown(doc.content_html)) throw new IngestError('Dieser Text hat keinen Lesetext');
      const text = fullTextOf(doc).slice(0, DOC_INPUT);
      const highlights = store.listHighlights({ docId });
      const candidates = await findCandidates(doc, text, highlights);
      const out = await writer.write({ system: SYSTEM, prompt: PROMPT, input: inputFor(doc, text, highlights, candidates), schema: SCHEMA });
      const draft = shape(out, { doc, candidates, text });
      // Inzwischen verworfen oder gelöscht: nichts überschreiben.
      if (store.getIngest(docId)?.status !== 'entwirft') return;
      store.saveIngest(docId, { status: 'bereit', draft, drafted_at: iso(), error: null });
      logger.info?.(`Ingest „${doc.title || doc.url}“: Entwurf bereit, ${draft.items.length} Vorschläge`);
    } catch (err) {
      logger.warn?.(`Ingest „${doc.title || doc.url}“: ${err.message}`);
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
      if (!force && cur && ['bereit', 'uebernommen'].includes(cur.status)) continue;
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
    if (new RegExp(`^- \\[\\[${slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\|[^\\]]*)?\\]\\]`, 'm').test(content)) return;
    if (/^##[ \t]+Quellen[ \t]*$/m.test(content)) editor.append({ path, heading: 'Quellen', text: line });
    else editor.append({ path, text: `\n## Quellen\n\n${line}` });
  }

  /** Eintrag in `wiki/log.md`. Steht das Log nicht im Index (Policy schließt es oft aus), direkt anhängen. */
  function appendLog(entry, slug) {
    if (policy.sensitivityOf(LOG) || policy.classify(LOG) !== 'core') throw new IngestError(`${LOG} liegt in einem vertraulichen oder importierten Ordner`, 409);
    const abs = join(vaultPath, LOG);
    const done = (content) => new RegExp(`ingest \\(cockpit\\) \\|[^\\n]*\\n- Source-Page: \\[\\[${slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]\\]`).test(content);
    const note = index.getNote(LOG);
    if (note && note.content !== null && note.class === 'core' && !note.sensitivity) {
      if (!done(note.content)) editor.append({ path: LOG, text: `\n${entry}` });
      return;
    }
    // Wie im Editor: nichts über einen Symlink aus dem Vault hinaus.
    const vaultReal = realpathSync(vaultPath);
    mkdirSync(dirname(abs), { recursive: true });
    if (!realpathSync(dirname(abs)).startsWith(vaultReal + sep)) throw new IngestError(`${LOG} zeigt aus dem Vault heraus`, 409);
    if (!existsSync(abs)) {
      writeFileSync(abs, `# Log\n\n${entry}\n`, { encoding: 'utf8', flag: 'wx' });
      return;
    }
    if (lstatSync(abs).isSymbolicLink()) throw new IngestError(`${LOG} ist ein Symlink; dorthin schreibt das Cockpit nicht`, 409);
    const content = readFileSync(abs, 'utf8');
    if (done(content)) return;
    appendFileSync(abs, `${content.endsWith('\n') ? '' : '\n'}\n${entry}\n`, 'utf8');
  }

  /** Source-Page: Frontmatter nach Mycel, H1, Destillation, Markiertes, Verknüpftes, Quelle. */
  function sourceContent({ doc, source, rawPath, relations, chosenStems, highlights }) {
    const rawStem = stemOf(rawPath);
    const url = /^https?:\/\//i.test(doc.url ?? '') ? doc.url : null;
    const d = today();
    const body = source.body.trim();
    const missing = chosenStems.filter((s) => !new RegExp(`\\[\\[${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:[|#\\]])`).test(body));
    const marks = highlights.map((h) => {
      const quote = clip(String(h.quote).replace(/\[\[|\]\]/g, ''), 300);
      const note = h.note?.trim() ? `\n  Notiz: ${clip(h.note.replace(/\[\[|\]\]/g, ''), 500)}` : '';
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
      `# ${source.title}`,
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
      `# ${item.title}`,
      '',
      ...(item.body ? [item.body.trim(), ''] : []),
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
   * zweiter Aufruf nach einem Abbruch setzt fort, nach dem Erfolg liefert er das Ergebnis.
   */
  async function apply(docId, { items: chosenIds = [], source: edits = {} } = {}) {
    const id = String(docId ?? '');
    const row = store.getIngest(id);
    const doc = store.get(id);
    if (!row || !doc) throw new IngestError('Zu diesem Dokument gibt es keinen Entwurf', 404);
    if (row.status === 'uebernommen' && row.applied?.result) return row.applied.result;
    if (row.status !== 'bereit' || !row.draft) throw new IngestError('Dieser Entwurf ist nicht bereit zum Übernehmen', 409);
    if (applying.has(id)) throw new IngestError('Wird gerade übernommen', 409);
    if (!folderAllowed(WIKI_FOLDERS.source)) throw new IngestError(`${WIKI_FOLDERS.source} ist vertraulich oder ausgeschlossen; dort schreibt das Cockpit nicht`, 409);

    const draft = row.draft;
    const byId = new Map(draft.items.map((i) => [i.id, i]));
    const ids = [...new Set([chosenIds].flat().filter((x) => x != null && x !== '').map(String))];
    const unknown = ids.filter((x) => !byId.has(x));
    if (unknown.length) throw new IngestError(`Unbekannte Vorschläge: ${unknown.join(', ')}`, 400);
    const chosen = ids.map((x) => byId.get(x));

    const applied = row.applied ?? { steps: [], items: {}, written: [], linked: [] };
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
        const r = exporter.save(id, { read: true, fullText: true });
        if (r.state === 'übersprungen' || r.state === 'weg') throw new IngestError(r.reason ?? 'Die Rohquelle ließ sich nicht anlegen', 409);
        applied.raw = r.path ?? exporter.notePath(id);
        if (!applied.raw) throw new IngestError('Die Rohquelle ließ sich nicht anlegen', 409);
      });
      const rawPath = applied.raw;

      // Slug der Source-Page: bei Kollision mit fremder Seite Kurz-ID anhängen.
      if (!applied.source) {
        let slug = source.slug;
        const taken = (s) => {
          const p = `${WIKI_FOLDERS.source}/${s}.md`;
          if (!existsSync(join(vaultPath, p))) return false;
          // Eine schon geschriebene eigene Seite (Abbruch vor dem Merken) erkennt man an der Rohquelle.
          return !sourcesOf(index.getNote(p)?.frontmatter).includes(rawPath);
        };
        if (taken(slug)) slug = `${slug}-${blockId(id).slice(3, 9)}`;
        if (taken(slug)) throw new IngestError(`wiki/sources/${slug}.md gibt es schon`, 409);
        applied.slug = slug;
        applied.source = `${WIKI_FOLDERS.source}/${slug}.md`;
        applied.title = source.title;
        save();
      }
      const slug = applied.slug;

      // Neue Seiten, deren Pfad inzwischen belegt ist, werden verknüpft statt angelegt.
      const newPath = (i) => `${WIKI_FOLDERS[i.kind]}/${i.slug}.md`;
      const chosenNew = chosen.filter((i) => i.action === 'neu');
      const notChosen = draft.items.filter((i) => i.action === 'neu' && !ids.includes(i.id));
      // Links auf abgewählte neue Seiten werden Text.
      const drop = new Map(notChosen.map((i) => [i.slug, i.title]));
      const unlink = (text) =>
        String(text ?? '').replace(/\[\[([^[\]\n|#]+)(?:#[^[\]\n|]*)?(?:\|([^[\]\n]*))?\]\]/g, (m, target, alias) => (drop.has(target.trim()) ? alias || drop.get(target.trim()) : m));
      source.body = unlink(source.body);

      const relations = chosen.filter((i) => i.kind === 'relation' && writable(i.to)).map((i) => `${i.type} [[${stemOf(i.to)}]]`);
      const chosenStems = [...new Set([...chosenNew.map((i) => i.slug), ...chosen.filter((i) => i.action === 'verknuepfen').map((i) => stemOf(i.path))])];

      // (b) Source-Page.
      await step('source', () => {
        if (existsSync(join(vaultPath, applied.source))) return;
        const highlights = store.listHighlights({ docId: id });
        createPage(applied.source, sourceContent({ doc, source, rawPath, relations, chosenStems, highlights }));
        applied.written.push(applied.source);
      });

      // (c) Gewählte neue Seiten.
      for (const item of chosenNew) {
        if (applied.items[item.id]) continue;
        const path = newPath(item);
        if (existsSync(join(vaultPath, path))) {
          const ours = sourcesOf(index.getNote(path)?.frontmatter).some((s) => linkTarget(s) === slug);
          if (!ours) {
            linkPage(path, slug, { update: true });
            applied.linked.push(path);
          } else if (!applied.written.includes(path)) applied.written.push(path);
        } else {
          createPage(path, itemContent({ ...item, body: unlink(item.body) }, { slug, confidence: source.confidence }));
          applied.written.push(path);
        }
        applied.items[item.id] = path;
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
        if (!applied.linked.includes(path)) applied.linked.push(path);
        for (const x of t.ids) applied.items[x] = path;
        save();
      }

      // (e) Log.
      await step('log', () => {
        const list = (paths) => (paths.length ? paths.map((p) => `[[${stemOf(p)}]]`).join(', ') : '—');
        const confirmed = [...new Set(chosen.filter((i) => i.kind === 'bestaetigung').map((i) => i.path))];
        // Nur bestätigt, nicht auch verknüpft: steht allein unter „Bestätigt“.
        const onlyConfirmed = (p) => confirmed.includes(p) && !chosen.some((i) => i.action === 'verknuepfen' && i.path === p);
        const entry = [
          `## [${today()}] ingest (cockpit) | ${oneLine(applied.title ?? source.title, 200)}`,
          `- Source-Page: [[${slug}]]`,
          `- Rohquelle: ${rawPath}`,
          `- Neu: ${list(applied.written.filter((p) => p !== applied.source))}`,
          `- Verknüpft: ${list(applied.linked.filter((p) => !onlyConfirmed(p)))}`,
          `- Bestätigt: ${list(confirmed)}`,
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

      const result = { source: applied.source, raw: rawPath, written: [...applied.written], linked: [...applied.linked] };
      applied.result = result;
      store.saveIngest(id, { status: 'uebernommen', applied, applied_at: iso(), error: null });
      logger.info?.(`Ingest „${source.title}“ übernommen: ${result.written.length} geschrieben, ${result.linked.length} verknüpft`);
      return result;
    } catch (err) {
      store.saveIngest(id, { applied, error: err.message });
      if (err instanceof IngestError) throw err;
      throw new IngestError(`Übernehmen unterbrochen: ${err.message}. Der Fortschritt ist gesichert, ein neuer Versuch setzt dort fort.`, 409);
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
 * `file` (unter /data), damit ein Neustart in der Stunde nicht doppelt läuft.
 */
export function createNightlyClock({ ingest, settings, file = null, now = () => new Date(), logger = console }) {
  let memory = null;
  const last = () => {
    if (!file) return memory;
    try {
      return readFileSync(file, 'utf8').trim() || null;
    } catch {
      return null;
    }
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
      if (zonedParts(t, s.tz).hour !== cfg.hour) return null;
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
