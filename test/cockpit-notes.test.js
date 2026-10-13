import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildIndex, openIndex } from '../src/vault/index.js';
import { compilePolicy } from '../src/vault/policy.js';
import { createEditor } from '../src/vault/edit.js';
import { createNoteDesk } from '../src/cockpit/notes.js';
import { createSettingsStore } from '../src/cockpit/settings.js';
import { renderMarkdown, inlineMd } from '../src/web/markdown-render.js';

const quiet = { info() {}, warn() {}, error() {} };
const policy = compilePolicy({ exclude: ['^privat/'], sensitive: { '20-bereiche/Gesundheit': 'gesundheit' } });
let root, idx, desk;
const put = (p, text) => {
  mkdirSync(join(root, p, '..'), { recursive: true });
  writeFileSync(join(root, p), text);
};
const read = (p) => readFileSync(join(root, p), 'utf8');

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cockpit-notes-'));
  put('00-inbox/Idee.md', '---\nsource: cockpit\ntags: [alt]\n---\n# Idee\n\n- [ ] Preise vergleichen\n- [x] Termin\n');
  put('10-projekte/Hund/Plan.md', '# Plan\n');
  put('20-bereiche/Gesundheit/Werte.md', '# Werte\n');
  put('40-archiv/2025/Alt.md', '# Alt\n');
  put('privat/geheim.md', '# Geheim\n');
  put('10-projekte/Feuer KW42.md', '---\ntype: 1-wochen-feuer\n---\n# KW 42\n\n## Feuer-Ziel\nAlt\n');
  buildIndex({ vaultPath: root, dbPath: ':memory:', policy, persist: (db, vp) => (idx = openIndex(db, { vaultPath: vp, policy })) });
  const settings = createSettingsStore({ defaults: { inboxFolder: '00-inbox' }, logger: quiet });
  desk = createNoteDesk({ index: idx, editor: createEditor({ vaultPath: root, index: idx }), policy, settings });
});
afterEach(() => {
  idx.close();
  rmSync(root, { recursive: true, force: true });
});

test('get: eigene Notiz mit Tags und Inbox-Kennzeichen; vertraulich und ausgeschlossen bleiben unsichtbar', () => {
  const n = desk.get('00-inbox/Idee.md');
  assert.equal(n.title, 'Idee');
  assert.deepEqual(n.tags, ['alt']);
  assert.equal(n.inInbox, true);
  assert.match(n.body, /Preise vergleichen/);
  assert.equal(desk.get('20-bereiche/Gesundheit/Werte.md'), null);
  assert.equal(desk.get('privat/geheim.md'), null);
  assert.equal(desk.get('../etc/passwd'), null);
});

test('targets und Archiv: ohne vertrauliche Ordner, Archiv wird erkannt', () => {
  const t = desk.targets('00-inbox/Idee.md');
  assert.ok(t.includes('10-projekte/Hund'));
  assert.ok(t.includes('40-archiv/2025'));
  assert.ok(!t.includes('00-inbox'));
  assert.ok(!t.some((f) => f.startsWith('20-bereiche/Gesundheit') || f.startsWith('privat')));
  assert.equal(desk.archiveFolder(), '40-archiv');
});

test('move: ablegen, aber nie in vertrauliche oder ausgeschlossene Ordner', () => {
  for (const bad of ['20-bereiche/Gesundheit', 'privat', '20-bereiche/Gesundheit/neu']) {
    assert.throws(() => desk.move('00-inbox/Idee.md', bad), (e) => e.status === 403);
  }
  assert.throws(() => desk.move('00-inbox/Idee.md', '../raus'), (e) => e.status === 400);
  assert.throws(() => desk.move('20-bereiche/Gesundheit/Werte.md', '40-archiv'), (e) => e.status === 404);
  const r = desk.move('00-inbox/Idee.md', '40-archiv');
  assert.equal(r.path, '40-archiv/Idee.md');
  assert.equal(existsSync(join(root, '00-inbox/Idee.md')), false);
  assert.equal(desk.get('40-archiv/Idee.md').inInbox, false);
});

test('setTags, append, toggle schreiben in die Notiz', () => {
  assert.deepEqual(desk.setTags('00-inbox/Idee.md', '#hund, training  hund').tags, ['hund', 'training']);
  assert.match(read('00-inbox/Idee.md'), /tags:\n {2}- hund\n {2}- training/);
  assert.throws(() => desk.setTags('00-inbox/Idee.md', 'a"b'), /kein gültiger Tag/);
  desk.setTags('00-inbox/Idee.md', '');
  assert.ok(!read('00-inbox/Idee.md').includes('tags'));

  desk.append('00-inbox/Idee.md', 'Nachtrag');
  assert.match(read('00-inbox/Idee.md'), /- \[x\] Termin\nNachtrag\n$/);
  assert.throws(() => desk.append('00-inbox/Idee.md', '  '), /leer/);

  desk.toggle('00-inbox/Idee.md', '0', '- [ ] Preise vergleichen', true);
  assert.match(read('00-inbox/Idee.md'), /- \[x\] Preise vergleichen/);
  assert.throws(() => desk.toggle('00-inbox/Idee.md', 'x', '', true), /Unbekannte Checkbox/);
  assert.throws(() => desk.toggle('00-inbox/Idee.md', '0', '- [ ] anders', true), (e) => e.status === 400);
});

test('renderMarkdown: maskiert alles, Links nur mit http(s), Checkboxen gezählt', () => {
  const html = renderMarkdown(
    '# Titel\n\nText mit **fett**, *kursiv*, `<code>` und <script>alert(1)</script>\n\n- [ ] eins\n- [x] zwei\n\n```\n- [ ] kein Kasten\n```\n\n[gut](https://a.test/x) [böse](javascript:alert(1)) [[Seite|Anzeige]] #tag\n\n> Zitat',
    { checkbox: (n, line, done) => `[${n}:${done}]` },
  );
  assert.match(html, /<h2>Titel<\/h2>/);
  assert.ok(!html.includes('<script>'));
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /<code>&lt;code&gt;<\/code>/);
  assert.match(html, /\[0:false\]<span>eins<\/span>[^]*\[1:true\]<span>zwei<\/span>/);
  assert.match(html, /<pre><code>- \[ \] kein Kasten<\/code><\/pre>/);
  assert.match(html, /<a href="https:\/\/a\.test\/x" rel="noopener noreferrer" target="_blank">gut<\/a>/);
  assert.ok(!html.includes('javascript:'));
  assert.match(html, /<span class="wikilink" title="Seite">Anzeige<\/span>/);
  assert.match(html, /<span class="tag">#tag<\/span>/);
  assert.match(html, /<blockquote>Zitat<\/blockquote>/);
  assert.equal(inlineMd('a "b" & c'), 'a &quot;b&quot; &amp; c');
});

test('setFeuer: schreibt Feuer-Ziel und Ersten Zug, nur in Feuer-Notizen', () => {
  const r = desk.setFeuer('10-projekte/Feuer KW42.md', 'ziel', 'Cockpit fertig bauen');
  assert.equal(r.previous, 'Alt');
  desk.setFeuer('10-projekte/Feuer KW42.md', 'zug', 'Menü zuerst');
  assert.match(read('10-projekte/Feuer KW42.md'), /## Feuer-Ziel\nCockpit fertig bauen\n[^]*## Erster Zug\n\nMenü zuerst\n$/);
  assert.throws(() => desk.setFeuer('00-inbox/Idee.md', 'ziel', 'x'), /keine Feuer-Notiz/);
  assert.throws(() => desk.setFeuer('10-projekte/Feuer KW42.md', 'titel', 'x'), /Unbekanntes Feld/);
  assert.throws(() => desk.setFeuer('10-projekte/Feuer KW42.md', 'ziel', ' '), /leer/);
});
