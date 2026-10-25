import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildIndex, openIndex } from '../src/vault/index.js';
import { compilePolicy } from '../src/vault/policy.js';
import { createEditor } from '../src/vault/edit.js';
import { createNoteDesk } from '../src/cockpit/notes.js';
import { createSettingsStore } from '../src/cockpit/settings.js';
import { ActionError } from '../src/cockpit/actions.js';
import { normalize } from '../src/semantic/embedder.js';
import { createSemanticIndex } from '../src/semantic/index.js';
import { createReadingStore } from '../src/lesen/store.js';
import { createReadingExport, blockId } from '../src/lesen/vault-export.js';
import { createEmbedCache } from '../src/lesen/embed-cache.js';
import { createSynthesisEvidence, evidenceRoutes, SECTION } from '../src/lesen/synthesis-evidence.js';
import { findSection, sectionBlock } from '../src/vault/generated-section.js';
import { renderNote } from '../src/web/note-render.js';
import { wissenView, renderWissen } from '../src/web/wissen-page.js';

const quiet = { info() {}, warn() {}, error() {} };
const WORDS = ['apfel', 'birne', 'kirsche'];

/** Feste Vektoren: je Obstsorte eine Dimension, dazu ein kleiner Rest, damit kein Vektor null ist. */
const fruitEmbedder = () => ({
  model: 'obst-1',
  async embed(texts) {
    return texts.map((t) => {
      const words = t.toLowerCase().match(/\p{L}+/gu) ?? [];
      return normalize(Float32Array.from([...WORDS.map((w) => words.filter((x) => x === w).length), 0.05]));
    });
  },
});

const OBST = 'wiki/obst.md';
const BEFORE = '---\ntype: synthesis\nupdated: 2026-10-20\n---\n# Obst\n\nEigener Text vor dem Bereich: Apfel, Apfel und noch einmal Apfel, lang genug für einen Abschnitt.\n\n## Aus dem Lesestapel\n\n';
const AFTER = '\n\n## Eigene Gedanken\n\nText nach dem Bereich, *von Hand*.\n';
const OLD_ENTRY = '> Ein alter Beleg\n>\n> — [[alt#^hl-00000000]] · Alt';

let root, policy, idx, editor, store, exporter, semantic, desk, clock, hl;
const at = (iso) => (clock = Date.parse(iso));

function put(path, text) {
  mkdirSync(join(root, path, '..'), { recursive: true });
  writeFileSync(join(root, path), text);
}
const read = (path) => readFileSync(join(root, path), 'utf8');

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'belege-'));
  put(OBST, `${BEFORE}${sectionBlock(SECTION, OLD_ENTRY, { spaced: true })}${AFTER}`);
  put('wiki/birnen.md', '---\ntype: synthesis\nupdated: 2026-10-20\n---\n# Birnen\n\nBirne Birne Birne.\n');
  put('wiki/ohne-datum.md', '---\ntype: synthesis\n---\n# Ohne Datum\n\nApfel Apfel.\n');
  utimesSync(join(root, 'wiki/ohne-datum.md'), new Date('2026-10-15T12:00:00Z'), new Date('2026-10-15T12:00:00Z'));
  put('wiki/notiz.md', '---\ntype: note\n---\n# Notiz\n\nApfel.\n');
  put('20-bereiche/Gesundheit/geheim.md', '---\ntype: synthesis\nupdated: 2026-10-20\n---\n# Geheim\n\nApfel.\n');
  policy = compilePolicy({ sensitive: { '20-bereiche/Gesundheit': 'gesundheit' } });
  buildIndex({ vaultPath: root, dbPath: ':memory:', policy, logger: quiet, persist: (db, vp) => (idx = openIndex(db, { vaultPath: vp, policy })) });
  editor = createEditor({ vaultPath: root, index: idx });
  at('2026-09-01T10:00:00Z');
  store = createReadingStore({ path: ':memory:', now: () => clock });
  const doc = store.addDocument({ url: 'https://obst.test/1', title: 'Über Obst' }).doc;
  hl = {
    old: (at('2026-10-01T10:00:00Z'), store.addHighlight({ doc_id: doc.id, quote: 'Apfel von früher', start_hint: 1 })),
    sameDay: (at('2026-10-20T05:00:00Z'), store.addHighlight({ doc_id: doc.id, quote: 'Apfel am selben Tag', start_hint: 2 })),
    fresh: (at('2026-10-21T10:00:00Z'), store.addHighlight({ doc_id: doc.id, quote: 'Ein Apfel', start_hint: 3 })),
    other: store.addHighlight({ doc_id: doc.id, quote: 'Kirsche', start_hint: 4 }),
  };
  const settings = createSettingsStore({ defaults: { tz: 'Europe/Berlin', inboxFolder: 'inbox' }, logger: quiet });
  exporter = createReadingExport({ vaultPath: root, index: idx, editor, policy, store, settings, delayMs: 60_000, logger: quiet });
  semantic = createSemanticIndex({ dbPath: ':memory:', vaultPath: root, index: idx, embedder: fruitEmbedder(), logger: quiet });
  await semantic.schedule();
  desk = createNoteDesk({ index: idx, editor, policy, settings });
});
afterEach(() => {
  exporter.stop();
  semantic.close();
  idx.close();
  rmSync(root, { recursive: true, force: true });
});

const evidenceWith = (embedder) =>
  createSynthesisEvidence({ notes: desk, index: idx, store, exporter, embedCache: createEmbedCache({ embedder: () => embedder, logger: quiet }), semantic: () => semantic, vaultPath: root, editor });

test('Vorschläge: nur passende Markierungen seit `updated` (der Tag zählt mit), ohne ältere und schon angehängte', async () => {
  const evidence = evidenceWith(fruitEmbedder());
  assert.deepEqual((await evidence.suggest(OBST)).map((h) => h.text), ['Ein Apfel', 'Apfel am selben Tag']);
  const [first] = await evidence.suggest(OBST);
  assert.ok(first.score >= 0.6);
  assert.match(first.href, new RegExp(`#h-${hl.fresh.id}$`));

  evidence.attach({ path: OBST, highlightId: hl.fresh.id });
  assert.deepEqual((await evidence.suggest(OBST)).map((h) => h.text), ['Apfel am selben Tag']);

  // Ohne `updated` gilt die Änderungszeit der Datei.
  assert.deepEqual((await evidence.suggest('wiki/ohne-datum.md')).map((h) => h.text), ['Ein Apfel', 'Apfel am selben Tag']);
  assert.deepEqual(await evidence.matching([OBST, 'wiki/birnen.md']), new Set([OBST]));

  // Ohne Embeddings still nichts.
  assert.deepEqual(await evidenceWith(null).suggest(OBST), []);
  assert.equal(renderNote(desk.get(OBST), { evidence: [] }).includes('passt dazu'), false);
});

test('Anhängen schreibt nur in den eigenen Bereich, legt die Lesestapel-Notiz an, Rückgängig entfernt den Eintrag', async () => {
  const evidence = evidenceWith(fruitEmbedder());
  const actions = evidenceRoutes(evidence, { logger: quiet });
  const before = read(OBST);
  const old = findSection(before, SECTION);

  const r = await actions['/aktion/synthese/beleg'](new URLSearchParams({ pfad: OBST, markierung: hl.fresh.id }), { sub: 'ruben' });
  assert.match(r.message, /Als Beleg angehängt: Über Obst/);
  const after = read(OBST);
  const now = findSection(after, SECTION);
  assert.equal(after.slice(0, now.from), before.slice(0, old.from));
  assert.equal(after.slice(now.to), before.slice(old.to));
  const lesestapel = exporter.notePath(store.getHighlight(hl.fresh.id).doc_id);
  assert.ok(lesestapel);
  assert.equal(lesestapel, 'raw/2026-09-01_ueber-obst.md');
  assert.equal(now.inner, `${OLD_ENTRY}\n\n> Ein Apfel\n>\n> — [[2026-09-01_ueber-obst#^${blockId(hl.fresh.id)}]] · Über Obst · obst.test`);
  assert.equal(now.edited, false);

  // Noch einmal: nichts doppelt, kein Rückgängig.
  const again = await actions['/aktion/synthese/beleg'](new URLSearchParams({ pfad: OBST, markierung: hl.fresh.id }), { sub: 'ruben' });
  assert.equal(again.undo, undefined);
  assert.equal(read(OBST), after);

  await actions[r.undo.action](new URLSearchParams(r.undo.fields), { sub: 'ruben' });
  const undone = read(OBST);
  const back = findSection(undone, SECTION);
  assert.equal(back.inner, OLD_ENTRY);
  assert.equal(undone.slice(0, back.from), before.slice(0, old.from));
  assert.equal(undone.slice(back.to), before.slice(old.to));
});

test('Ohne Bereich kommt er unter eine neue Überschrift ans Ende; der Rest bleibt byteweise gleich', () => {
  const evidence = evidenceWith(fruitEmbedder());
  const before = read('wiki/birnen.md');
  evidence.attach({ path: 'wiki/birnen.md', highlightId: hl.fresh.id });
  const after = read('wiki/birnen.md');
  assert.ok(after.startsWith(before.trimEnd()));
  assert.match(after.slice(before.trimEnd().length), /^\n\n## Aus dem Lesestapel\n\n<!-- cockpit:aus-dem-lesestapel:start/);
});

test('Gleichzeitige Änderung durch den Sync: verständliche Meldung, Notiz unverändert', () => {
  const evidence = evidenceWith(fruitEmbedder());
  const before = read(OBST);
  const original = editor.replace;
  editor.replace = () => {
    throw new Error(`"${OBST}" wurde gerade anderweitig geändert. Bitte neu lesen und erneut versuchen.`);
  };
  assert.throws(() => evidence.attach({ path: OBST, highlightId: hl.fresh.id }), (err) => err instanceof ActionError && err.status === 409 && /^Nicht angehängt: .*anderweitig geändert/.test(err.message));
  editor.replace = original;
  assert.equal(read(OBST), before);
});

test('`pfad` nur für sichtbare Synthesen: keine andere Notiz, nichts Vertrauliches, nichts Unbekanntes', async () => {
  const evidence = evidenceWith(fruitEmbedder());
  for (const path of ['wiki/notiz.md', '20-bereiche/Gesundheit/geheim.md', 'wiki/fehlt.md', '../obst.md']) {
    const before = (() => {
      try {
        return read(path);
      } catch {
        return null;
      }
    })();
    assert.throws(() => evidence.attach({ path, highlightId: hl.fresh.id }), (err) => err instanceof ActionError && err.status === 404, path);
    assert.throws(() => evidence.detach({ path, highlightId: hl.fresh.id }), (err) => err instanceof ActionError && err.status === 404, path);
    assert.deepEqual(await evidence.suggest(path), [], path);
    if (before !== null) assert.equal(read(path), before, path);
  }
  assert.throws(() => evidence.attach({ path: OBST, highlightId: 'gibt-es-nicht' }), (err) => err instanceof ActionError && err.status === 404);
});

test('Kasten auf der Notizseite und Filter „Passt zu meinem Lesen“ auf /wissen', async () => {
  const evidence = evidenceWith(fruitEmbedder());
  const items = await evidence.suggest(OBST);
  const html = renderNote(desk.get(OBST), { write: { csrf: 't' }, evidence: items });
  assert.match(html, /Aus dem Lesestapel passt dazu[^]*action="\/aktion\/synthese\/beleg"[^]*name="markierung" value="[^"]+"[^]*Als Beleg anhängen/);
  assert.doesNotMatch(html, /<li><a href="#h-aus-dem-lesestapel">/, 'der Bereich ist keine These');

  const m = await wissenView({ notes: desk, evidence }, { lesen: true });
  assert.deepEqual(m.recent.map((n) => n.path).sort(), ['wiki/obst.md', 'wiki/ohne-datum.md']);
  assert.match(renderWissen(m), /name="lesen" value="1" checked> Passt zu meinem Lesen/);
  assert.equal((await wissenView({ notes: desk }, { lesen: true })).recent.length, 3);
  assert.doesNotMatch(renderWissen(await wissenView({ notes: desk })), /Passt zu meinem Lesen/);
});

test('Von Hand geänderter Bereich: Anhängen und Rückgängig melden einen Konflikt, die Notiz bleibt', () => {
  const evidence = evidenceWith(fruitEmbedder());
  put(OBST, read(OBST).replace('Ein alter Beleg', 'Ein von Hand geänderter Beleg'));
  const before = read(OBST);
  for (const run of [() => evidence.attach({ path: OBST, highlightId: hl.fresh.id }), () => evidence.detach({ path: OBST, highlightId: hl.fresh.id })]) {
    assert.throws(run, (err) => err instanceof ActionError && err.status === 409 && /von Hand/.test(err.message));
  }
  assert.equal(read(OBST), before);
});
