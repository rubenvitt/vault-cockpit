import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildIndex, openIndex } from '../src/vault/index.js';
import { compilePolicy } from '../src/vault/policy.js';
import { createEditor } from '../src/vault/edit.js';
import { createNoteDesk } from '../src/cockpit/notes.js';
import { suggestFiling } from '../src/cockpit/suggest.js';
import { createSettingsStore } from '../src/cockpit/settings.js';
import { renderNote } from '../src/web/note-render.js';

const quiet = { info() {}, warn() {}, error() {} };
const policy = compilePolicy({ exclude: ['^privat/'], sensitive: { '20-bereiche/Gesundheit': 'gesundheit' } });
let root, idx;
const put = (p, text) => {
  mkdirSync(join(root, p, '..'), { recursive: true });
  writeFileSync(join(root, p), text);
};
const note = (tags, text) => `---\ntags: [${tags.join(', ')}]\n---\n${text}\n`;

function desk(semantic = null) {
  buildIndex({ vaultPath: root, dbPath: ':memory:', policy, persist: (db, vp) => (idx = openIndex(db, { vaultPath: vp, policy })) });
  const settings = createSettingsStore({ defaults: { inboxFolder: '00-inbox' }, logger: quiet });
  return createNoteDesk({ index: idx, editor: createEditor({ vaultPath: root, index: idx }), policy, settings, vaultPath: root, semantic });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'suggest-'));
  put('00-inbox/Leine.md', note(['hund'], '# Leine\n\nNeue Schleppleine für den Rückruf, Training am Wochenende. #zunder'));
  put('00-inbox/Andere.md', '# Andere\n\nSchleppleine Rückruf Training\n');
  put('10-projekte/Hund/Rückruf.md', note(['hund', 'training'], '# Rückruf\n\nSchleppleine Rückruf Training Pfeife'));
  put('10-projekte/Hund/Leinen.md', note(['hund', 'training', 'ausrüstung'], '# Leinen\n\nSchleppleine Training [[Leine]]'));
  put('10-projekte/Hund/Pfeife.md', note(['hund', 'training', 'zunder'], '# Pfeife\n\nRückruf Pfeife Training'));
  put('30-wissen/Hunde/Lernen.md', note(['training', 'lernen'], '# Lernen\n\nTraining Rückruf Belohnung'));
  put('20-bereiche/Gesundheit/Tierarzt.md', note(['hund', 'gesundheit'], '# Tierarzt\n\nSchleppleine Rückruf Training'));
  put('privat/Notiz.md', '# Privat\n\nSchleppleine Rückruf Training\n');
});
afterEach(() => {
  idx?.close();
  rmSync(root, { recursive: true, force: true });
});

test('suggestFiling: Ordner nach Mehrheit, häufige Tags, unverlinkte Nachbarn; nie Inbox oder vertraulich', () => {
  desk();
  const hits = [
    { path: '10-projekte/Hund/Rückruf.md', folder: '10-projekte/Hund', score: 0.9, linked: false },
    { path: '20-bereiche/Gesundheit/Tierarzt.md', folder: '20-bereiche/Gesundheit', score: 0.88, linked: false },
    { path: '00-inbox/Andere.md', folder: '00-inbox', score: 0.87, linked: false },
    { path: '10-projekte/Hund/Leinen.md', folder: '10-projekte/Hund', score: 0.8, linked: true },
    { path: '30-wissen/Hunde/Lernen.md', folder: '30-wissen/Hunde', score: 0.7, linked: false },
    { path: '10-projekte/Hund/Pfeife.md', folder: '10-projekte/Hund', score: 0.6, linked: false },
  ];
  const s = suggestFiling({ index: idx, policy, inboxFolder: '00-inbox', bridgeTag: 'zunder' }, { path: '00-inbox/Leine.md', folder: '00-inbox', tags: ['hund'] }, { source: 'semantic', hits, problem: null });
  assert.deepEqual(s.folders, [{ folder: '10-projekte/Hund', count: 3 }, { folder: '30-wissen/Hunde', count: 1 }]);
  // „hund“ hat die Notiz schon, „zunder“ ist der Brücken-Tag, Einzelstücke zählen bei sechs Nachbarn nicht.
  assert.deepEqual(s.tags, [{ tag: 'training', count: 4 }]);
  assert.deepEqual(s.unlinked.map((h) => h.path), ['10-projekte/Hund/Rückruf.md', '20-bereiche/Gesundheit/Tierarzt.md', '00-inbox/Andere.md']);
  assert.equal(s.of, 6);

  const none = suggestFiling({ index: idx, policy, inboxFolder: '00-inbox' }, { path: '00-inbox/Leine.md', folder: '00-inbox', tags: [] }, { source: null, hits: [], problem: 'Ohne Embeddings' });
  assert.deepEqual([none.folders, none.tags, none.unlinked, none.of, none.problem], [[], [], [], 0, 'Ohne Embeddings']);
});

test('suggest: aus den Embeddings, ohne sie per Volltext; vertrauliche Ordner erscheinen nie', () => {
  const semantic = {
    similarTo(path, { limit, allow }) {
      return [
        ['20-bereiche/Gesundheit/Tierarzt.md', 0.95],
        ['privat/Notiz.md', 0.94],
        ['10-projekte/Hund/Rückruf.md', 0.9],
        ['10-projekte/Hund/Leinen.md', 0.85],
        ['10-projekte/Hund/Pfeife.md', 0.8],
        ['30-wissen/Hunde/Lernen.md', 0.75],
        ['00-inbox/Andere.md', 0.7],
      ]
        .filter(([p]) => p !== path && allow(p))
        .map(([p, score]) => ({ path: p, score }))
        .slice(0, limit);
    },
  };
  let d = desk(() => semantic);
  const s = d.suggest('00-inbox/Leine.md');
  assert.equal(s.source, 'semantic');
  assert.equal(s.folders[0].folder, '10-projekte/Hund');
  assert.ok(!s.folders.some((f) => f.folder.startsWith('20-bereiche/Gesundheit') || f.folder.startsWith('privat') || f.folder.startsWith('00-inbox')));
  assert.ok(!s.unlinked.some((h) => h.path.startsWith('20-bereiche/') || h.path.startsWith('privat/')));
  assert.ok(!s.unlinked.some((h) => h.path === '10-projekte/Hund/Leinen.md'), 'verlinkt die Notiz schon');
  assert.deepEqual(s.tags.map((t) => t.tag), ['training']);
  assert.equal(d.suggest('10-projekte/Hund/Rückruf.md'), null, 'nur für Inbox-Notizen');
  assert.equal(d.suggest('20-bereiche/Gesundheit/Tierarzt.md'), null);

  // Ohne Embeddings: Volltext, sichtbar markiert.
  idx.close();
  d = desk();
  const t = d.suggest('00-inbox/Leine.md');
  assert.equal(t.source, 'text');
  assert.match(t.problem, /Ohne Embeddings/);
  assert.equal(t.folders[0].folder, '10-projekte/Hund');
  assert.ok(!t.folders.some((f) => f.folder.startsWith('20-bereiche/Gesundheit') || f.folder.startsWith('privat')));
});

test('Vorschläge auf der Notizseite: zwei Klicks zum Taggen und Ablegen, Verlinken, Hinweis ohne Embeddings', () => {
  const d = desk();
  const n = d.get('00-inbox/Leine.md');
  const related = d.related(n.path);
  const html = renderNote(n, { write: { csrf: 'c', notes: true }, back: '/notiz?pfad=x', related, suggestions: d.suggest(n.path, related) });
  // Klick 1: alle Tags übernehmen (vorhandene bleiben), Klick 2: Ordner.
  assert.match(html, /<section class="suggest">[^]*?action="\/aktion\/notiz\/tags"[^]*?name="tags" value="hund, training"[^]*?\+ #training/);
  assert.match(html, /action="\/aktion\/notiz\/ablegen" class="act">[^]*?name="pfad" value="00-inbox\/Leine\.md"><input type="hidden" name="ordner" value="10-projekte\/Hund"><button type="submit" class="chip">10-projekte\/Hund\/ <span class="hint">3 von/);
  assert.match(html, /action="\/aktion\/verlinken" class="act">[^]*?name="ziel" value="10-projekte\/Hund\/Rückruf\.md"[^]*?Verlinken/);
  assert.match(html, /<p class="hint">Ohne Embeddings[^<]*Volltext<\/p>\s*<\/section>/);
  assert.ok(!html.includes('Gesundheit') && !html.includes('privat/'));

  // Ohne Nachbarn entfallen die Vorschläge sichtbar.
  const empty = renderNote(n, { write: { csrf: 'c', notes: true }, suggestions: { source: null, problem: 'Ohne Embeddings (Einstellungen → Embeddings) ähnlich nach Volltext', of: 0, folders: [], tags: [], unlinked: [] } });
  assert.match(empty, /Keine Vorschläge: keine ähnlichen Notizen gefunden \(Ohne Embeddings/);
  // Ohne Schreibrecht kein Panel.
  assert.ok(!renderNote(n, { suggestions: d.suggest(n.path) }).includes('class="suggest"'));
});
