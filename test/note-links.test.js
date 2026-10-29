import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, readFileSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildIndex, openIndex } from '../src/vault/index.js';
import { compilePolicy } from '../src/vault/policy.js';
import { createEditor } from '../src/vault/edit.js';
import { createNoteDesk } from '../src/cockpit/notes.js';
import { cleanPath } from '../src/cockpit/note-links.js';
import { createSettingsStore } from '../src/cockpit/settings.js';
import { renderMarkdown, headingId } from '../src/web/markdown-render.js';

const quiet = { info() {}, warn() {}, error() {} };
const policy = compilePolicy({ exclude: ['^privat/'], sensitive: { '20-bereiche/Gesundheit': 'gesundheit' }, readwise: 'readwise' });
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
let root, outside, idx, desk;
const put = (p, data) => {
  mkdirSync(join(root, p, '..'), { recursive: true });
  writeFileSync(join(root, p), data);
};

function open(semantic = null) {
  buildIndex({ vaultPath: root, dbPath: ':memory:', policy, persist: (db, vp) => (idx = openIndex(db, { vaultPath: vp, policy })) });
  const settings = createSettingsStore({ defaults: { inboxFolder: '00-inbox' }, logger: quiet });
  desk = createNoteDesk({ index: idx, editor: createEditor({ vaultPath: root, index: idx }), policy, settings, vaultPath: root, semantic });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'note-links-'));
  outside = mkdtempSync(join(tmpdir(), 'note-links-out-'));
  writeFileSync(join(outside, 'fremd.png'), PNG);
  put('00-inbox/Idee.md', '# Idee\n\n[[Hund]] [[Bello]] [[Plan]] [[Werte]] [[Geheim]] [[Gibts nicht]] [[Hund#Training]] [[#Unten]]\n\n![[foto.png]] ![[bilder/foto.png|120]] ![[gesund.png]] ![[plan.svg]]\n![x](../anhang/skizze.png) [Plan](../10-projekte/Hund/Plan.md)\n\n## Unten\n');
  put('wiki/Hund.md', '---\naliases: [Bello, Wuff]\n---\n# Hund\n\n## Training\n');
  put('10-projekte/Hund/Plan.md', '# Plan\n\n[[Idee]]\n');
  put('10-projekte/Katze/Plan.md', '# Anderer Plan\n');
  put('20-bereiche/Gesundheit/Werte.md', '# Werte\n\n[[Idee]]\n');
  put('20-bereiche/Gesundheit/gesund.png', PNG);
  put('privat/Geheim.md', '# Geheim\n');
  put('privat/foto.png', PNG);
  put('readwise/Buch.md', '# Buch\n\n[[Idee]]\n');
  put('00-inbox/bilder/foto.png', PNG);
  put('anhang/foto.png', PNG);
  put('anhang/skizze.png', PNG);
  put('anhang/plan.svg', '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  put('.obsidian/x.png', PNG);
  symlinkSync(join(outside, 'fremd.png'), join(root, 'anhang/link.png'));
  symlinkSync(outside, join(root, 'raus'));
  open();
});
afterEach(() => {
  idx.close();
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

test('Index: Wikilinks lösen auch über Aliase auf, mehrdeutige Basenamen bleiben offen', () => {
  assert.equal(idx.resolveLink('Bello'), 'wiki/Hund.md');
  assert.equal(idx.resolveLink('wuff'), 'wiki/Hund.md');
  assert.equal(idx.resolveLink('hund'), 'wiki/Hund.md');
  assert.equal(idx.resolveLink('Plan'), null, 'zwei Notizen heißen Plan');
  assert.equal(idx.resolveLink('10-projekte/Hund/Plan'), '10-projekte/Hund/Plan.md');
  // Backlinks kennen den Alias-Link.
  assert.ok(idx.backlinks('wiki/Hund.md').some((b) => b.path === '00-inbox/Idee.md'));
  assert.deepEqual(idx.tagsOf(['wiki/Hund.md']).get('wiki/Hund.md'), []);
});

test('Vorschau: Wikilinks werden Links auf Notizseiten, vertrauliche und fehlende Ziele „fehlen“', () => {
  const note = desk.get('00-inbox/Idee.md');
  const html = renderMarkdown(note.body, { links: note.links });
  assert.match(html, /<a href="\/notiz\?pfad=wiki%2FHund\.md" class="wikilink" title="wiki\/Hund\.md">Hund<\/a>/);
  assert.match(html, /<a href="\/notiz\?pfad=wiki%2FHund\.md" class="wikilink"[^>]*>Bello<\/a>/, 'Alias');
  assert.match(html, /href="\/notiz\?pfad=wiki%2FHund\.md#h-training"[^>]*>Hund › Training<\/a>/);
  assert.match(html, /<a href="#h-unten" class="wikilink"[^>]*>Unten<\/a>/);
  assert.match(html, /<h3 id="h-unten">Unten<\/h3>/);
  for (const name of ['Plan', 'Werte', 'Geheim', 'Gibts nicht']) {
    assert.match(html, new RegExp(`<span class="wikilink missing" title="Fehlt: ${name}">${name}<span class="missing-mark"> \\(fehlt\\)</span></span>`));
  }
  assert.ok(!html.includes('Gesundheit') && !html.includes('privat'), 'kein Pfad aus vertraulichen oder ausgeschlossenen Ordnern');
  // Markdown-Link auf eine Notiz, relativ zur Notiz.
  assert.match(html, /<a href="\/notiz\?pfad=10-projekte%2FHund%2FPlan\.md" class="wikilink"[^>]*>Plan<\/a>/);
});

test('Vorschau: Bilder aus dem Vault, nächstgelegenes zuerst; vertraulich, ausgeschlossen und SVG nicht', () => {
  const note = desk.get('00-inbox/Idee.md');
  const html = renderMarkdown(note.body, { links: note.links });
  // „foto.png“ gibt es dreimal: das im Unterordner der Notiz gewinnt, das ausgeschlossene zählt nie.
  assert.match(html, /<img src="\/notiz\/bild\?pfad=00-inbox%2Fbilder%2Ffoto\.png" alt="foto\.png" loading="lazy">/);
  assert.match(html, /<img src="\/notiz\/bild\?pfad=00-inbox%2Fbilder%2Ffoto\.png" alt="foto\.png" loading="lazy" width="120">/);
  assert.match(html, /<img src="\/notiz\/bild\?pfad=anhang%2Fskizze\.png" alt="x" loading="lazy">/);
  assert.match(html, /<span class="wikilink missing" title="Fehlt: gesund\.png">gesund\.png/);
  assert.match(html, /<span class="wikilink file" title="Nur in Obsidian">plan\.svg<\/span>/);
  assert.ok(!html.includes('<script'));
});

test('Index: Bilder stehen in der Tabelle images, ausgeschlossene, versteckte und Symlinks nicht', () => {
  const rows = idx.db.prepare('SELECT path, name, folder, size FROM images ORDER BY path').all().map((r) => ({ ...r }));
  assert.deepEqual(rows, [
    { path: '00-inbox/bilder/foto.png', name: 'foto.png', folder: '00-inbox/bilder', size: PNG.length },
    { path: '20-bereiche/Gesundheit/gesund.png', name: 'gesund.png', folder: '20-bereiche/Gesundheit', size: PNG.length },
    { path: 'anhang/foto.png', name: 'foto.png', folder: 'anhang', size: PNG.length },
    { path: 'anhang/skizze.png', name: 'skizze.png', folder: 'anhang', size: PNG.length },
  ]);
  assert.deepEqual(idx.imagesNamed('FOTO.png'), ['00-inbox/bilder/foto.png', 'anhang/foto.png']);
});

test('Vorschau: Bilder kommen aus dem Index, ein neues erst nach dem Nachlesen', () => {
  put('anhang/neu.png', PNG);
  put('00-inbox/Neu.md', '# Neu\n\n![[neu.png]]\n');
  idx.refresh('00-inbox/Neu.md');
  const before = desk.get('00-inbox/Neu.md');
  assert.match(renderMarkdown(before.body, { links: before.links }), /wikilink missing/);
  idx.refresh('anhang/neu.png');
  const after = desk.get('00-inbox/Neu.md');
  assert.match(renderMarkdown(after.body, { links: after.links }), /<img src="\/notiz\/bild\?pfad=anhang%2Fneu\.png"/);
});

test('openImage: nur Bilder im Vault, ohne Symlinks, Traversal, vertrauliche und versteckte Ordner', () => {
  const ok = desk.openImage('anhang/foto.png');
  assert.equal(ok.type, 'image/png');
  assert.equal(ok.size, PNG.length);
  assert.deepEqual(readFileSync(ok.fd), PNG);
  closeSync(ok.fd);
  for (const bad of [
    'anhang/plan.svg',
    'anhang/link.png',
    'raus/fremd.png',
    '../note-links-out/fremd.png',
    'anhang/../anhang/foto.png',
    '/etc/passwd',
    'anhang\\foto.png',
    '20-bereiche/Gesundheit/gesund.png',
    'privat/foto.png',
    '.obsidian/x.png',
    '00-inbox/Idee.md',
    'anhang/fehlt.png',
    '',
  ]) {
    assert.equal(desk.openImage(bad), null, bad);
  }
  assert.equal(cleanPath('a/./b.png'), null);
  assert.equal(cleanPath('a/b c.png'), 'a/b c.png');
});

test('related: Backlinks nur aus sichtbaren Notizen, ähnlich aus den Embeddings, sonst Volltext', () => {
  put('wiki/Training.md', '# Hundetraining\n\nRückruf üben mit dem Hund, Leckerli und Pfeife.\n');
  put('00-inbox/Rueckruf.md', '# Rückruf\n\nHund Rückruf üben, Pfeife kaufen.\n');
  idx.close();
  open();
  const r = desk.related('00-inbox/Idee.md');
  assert.deepEqual(r.backlinks.map((b) => b.path), ['10-projekte/Hund/Plan.md'], 'weder vertraulich noch Readwise');
  assert.equal(desk.related('20-bereiche/Gesundheit/Werte.md'), null);

  // Ohne Embeddings: Volltext über die markantesten Wörter.
  const text = desk.related('00-inbox/Rueckruf.md');
  assert.equal(text.similar.source, 'text');
  assert.match(text.similar.problem, /Ohne Embeddings/);
  assert.equal(text.similar.hits[0].path, 'wiki/Training.md');
  assert.equal(text.similar.hits[0].score, null);

  // Mit Embeddings: Vektorindex, vertrauliche Treffer fallen heraus, verlinkte sind markiert.
  const calls = [];
  const semantic = {
    similarTo(path, { limit, allow }) {
      calls.push(path);
      if (path !== '00-inbox/Idee.md') return null;
      return ['20-bereiche/Gesundheit/Werte.md', 'wiki/Hund.md', 'wiki/Training.md', 'privat/Geheim.md'].filter(allow).map((p, i) => ({ path: p, score: 0.9 - i / 10 })).slice(0, limit);
    },
  };
  idx.close();
  open(() => semantic);
  const s = desk.related('00-inbox/Idee.md');
  assert.equal(s.similar.source, 'semantic');
  assert.equal(s.similar.problem, null);
  assert.deepEqual(s.similar.hits.map((h) => [h.path, h.linked, h.folder]), [['wiki/Hund.md', true, 'wiki'], ['wiki/Training.md', false, 'wiki']]);
  assert.equal(s.similar.hits[0].score, 0.9);
  // Noch nicht eingebettet: Volltext mit Hinweis.
  assert.match(desk.related('00-inbox/Rueckruf.md').similar.problem, /noch keine Embeddings/);
});

test('renderMarkdown: Tabellen, Callouts und Anker, alles maskiert', () => {
  const html = renderMarkdown(
    '| Name | Wert \\| roh |\n|:---|---:|\n| <b>x</b> | `a|b` |\n| [[Ziel\\|Anzeige]] |\n\n> [!WARNING]- Achtung <i>\n> - [ ] innen\n> Text\n\n> [!unbekannt]\n\n> Zitat\n\n- [ ] außen\n\n## Gleich\n## Gleich',
    { checkbox: (n) => `[${n}]` },
  );
  assert.match(html, /<div class="table-wrap"><table><thead><tr><th>Name<\/th><th class="al-r">Wert \| roh<\/th><\/tr><\/thead>/);
  assert.match(html, /<td>&lt;b&gt;x&lt;\/b&gt;<\/td><td class="al-r"><code>a\|b<\/code><\/td>/);
  assert.match(html, /<td><span class="wikilink" title="Ziel">Anzeige<\/span><\/td><td class="al-r"><\/td>/);
  assert.match(html, /<details class="callout callout-warn" data-callout="warning"><summary class="callout-title">Achtung &lt;i&gt;<\/summary><div class="callout-body"><ul>\n<li class="todo"><span class="box">☐<\/span><span>innen<\/span>/);
  assert.match(html, /<div class="callout callout-info" data-callout="unbekannt"><p class="callout-title">Unbekannt<\/p><\/div>/);
  assert.match(html, /<blockquote>Zitat<\/blockquote>/);
  // Checkboxen im Callout zählt der Editor nicht, die Nummern bleiben gleich.
  assert.match(html, /\[0\]<span>außen<\/span>/);
  assert.match(html, /<h3 id="h-gleich">Gleich<\/h3>\n<h3 id="h-gleich-2">Gleich<\/h3>/);
  assert.equal(headingId('Über [[Hund|den Hund]] & mehr!'), 'h-über-den-hund-mehr');
  // Ohne Auflöser keine Bilder.
  assert.ok(!renderMarkdown('![x](bild.png) ![[bild.png]]').includes('<img'));
});
