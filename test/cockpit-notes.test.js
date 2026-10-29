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
import { renderMarkdown, inlineMd, parseMarkdown } from '../src/web/markdown-render.js';

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

const feuerNote = (woche, zeitraum, status = 'abgeschlossen') =>
  `---\ntype: 1-wochen-feuer\nfeuersturm: "[[Feuersturm 2026-Q4]]"\nwoche: ${woche}\nzeitraum: "${zeitraum}"\nstatus: ${status}\n---\n# Feuer ${woche}\n\n## Feuer-Ziel\n\nAlt\n`;

function withFeuer() {
  put('20-bereiche/Phönix/feuer/Feuer W1 - 2026-Q4.md', feuerNote('W1', '28.09.2026 – 04.10.2026'));
  put('20-bereiche/Phönix/feuer/Feuer W2 - 2026-Q4.md', feuerNote('W2', '05.10.2026 – 11.10.2026'));
  idx.refresh('20-bereiche/Phönix/feuer/Feuer W1 - 2026-Q4.md');
  idx.refresh('20-bereiche/Phönix/feuer/Feuer W2 - 2026-Q4.md');
}

test('createFeuer: legt die Notiz nach dem Muster der letzten an, danach bearbeitbar', () => {
  withFeuer();
  const r = desk.createFeuer('2026-W42', 'Cockpit fertig\nbauen', 'Menü zuerst');
  assert.equal(r.path, '20-bereiche/Phönix/feuer/Feuer W3 - 2026-Q4.md');
  assert.equal(r.title, 'Feuer W3 - 2026-Q4');
  const text = read(r.path);
  assert.match(text, /^---\ntype: 1-wochen-feuer\nfeuersturm: "\[\[Feuersturm 2026-Q4\]\]"\nwoche: W3\nzeitraum: "12\.10\.2026 – 18\.10\.2026"\nstatus: aktiv\n/);
  assert.match(text, /## Feuer-Ziel\n\nCockpit fertig bauen\n\n## Erster Zug\n\nMenü zuerst\n\n## Tägliche Schritte/);
  assert.match(text, /\| Mo 12\.10\. \| – \| 🔲 \|[^]*\| So 18\.10\. \| – \| 🔲 \|/);
  assert.match(text, /## Flammen[^]*## Notizen[^]*## Daily Notes/);

  // Steht sofort im Index: setFeuer findet sie, ein zweites Anlegen nicht.
  desk.setFeuer(r.path, 'zug', 'Anders');
  assert.match(read(r.path), /## Erster Zug\n\nAnders\n/);
  assert.throws(() => desk.createFeuer('2026-W42', 'nochmal'), (err) => err.status === 409 && /schon/.test(err.message));
});

test('createFeuer: Wochen weiterzählen, ohne Ersten Zug, Grenzen', () => {
  withFeuer();
  // Zwei Wochen nach W2 → W4, Erster Zug bleibt leer.
  const r = desk.createFeuer('2026-W43', 'Ziel');
  assert.equal(r.path, '20-bereiche/Phönix/feuer/Feuer W4 - 2026-Q4.md');
  assert.match(read(r.path), /## Erster Zug\n\n## Tägliche Schritte/);
  assert.throws(() => desk.createFeuer('2026-W42', ' '), /Feuer-Ziel darf nicht leer/);
  assert.throws(() => desk.createFeuer('KW42', 'x'), /keine Kalenderwoche/);
  // Nach W12 ist der Feuersturm vorbei.
  assert.throws(() => desk.createFeuer('2027-W01', 'x'), /W15[^]*nächsten Feuersturm/);
});

test('createFeuer: ohne frühere Feuer-Notiz gibt es kein Muster', () => {
  assert.throws(() => desk.createFeuer('2026-W42', 'x'), /keine Feuer-Notiz, nach deren Muster/);
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

test('move: nennt vorher betroffene Links, passt sie beim Ablegen an und kann umbenennen (VCP-58)', () => {
  put('10-projekte/Hund/Plan.md', '# Plan\n\n[[00-inbox/Idee]] und [[Idee]]\n');
  put('20-bereiche/Gesundheit/Werte.md', '# Werte\n\n[[00-inbox/Idee]]\n');
  idx.refresh('10-projekte/Hund/Plan.md');
  idx.refresh('20-bereiche/Gesundheit/Werte.md');
  idx.relinkAll();
  const impact = desk.get('00-inbox/Idee.md').impact;
  assert.deepEqual(impact.byPath, [{ path: '10-projekte/Hund/Plan.md', title: 'Plan', target: '00-inbox/Idee' }]);
  assert.deepEqual(impact.byName, [{ path: '10-projekte/Hund/Plan.md', title: 'Plan', target: 'Idee' }]);
  assert.equal(impact.hiddenByPath, 1);

  const r = desk.move('00-inbox/Idee.md', '40-archiv', 'Preise');
  assert.equal(r.path, '40-archiv/Preise.md');
  assert.deepEqual(r.updated.map((u) => [u.path, u.old_target, u.new_target]), [['10-projekte/Hund/Plan.md', '00-inbox/Idee', '40-archiv/Preise'], ['10-projekte/Hund/Plan.md', 'Idee', 'Preise']]);
  assert.equal(r.hidden, 1);
  assert.equal(read('10-projekte/Hund/Plan.md'), '# Plan\n\n[[40-archiv/Preise]] und [[Preise]]\n');
  assert.equal(read('20-bereiche/Gesundheit/Werte.md'), '# Werte\n\n[[00-inbox/Idee]]\n');
  assert.throws(() => desk.move('40-archiv/Preise.md', '40-archiv', 'A#B'), (e) => e.status === 400);
});

test('get: eingebettete Notizen zeigen ihren Inhalt, mit Tiefengrenze, ohne Kreise, nie vertraulich (VCP-63)', () => {
  put('10-projekte/A.md', '# A\n\n![[B]]\n\n![[Werte]]\n\n![[Abschnitte#Zwei]]\n');
  put('10-projekte/B.md', '---\ntags: [b]\n---\nText aus B\n\n- [ ] Box in B\n\n![[C]]\n');
  put('10-projekte/C.md', 'Text aus C\n\n![[A]]\n');
  put('10-projekte/Abschnitte.md', '# Eins\n\nerster\n\n## Zwei\n\nzweiter\n\n### Drei\n\ndritter\n\n## Vier\n\nvierter\n');
  for (const p of ['10-projekte/A.md', '10-projekte/B.md', '10-projekte/C.md', '10-projekte/Abschnitte.md']) idx.refresh(p);
  idx.relinkAll();
  const note = desk.get('10-projekte/A.md');
  const blocks = parseMarkdown(note.body, { links: note.links });
  const embeds = blocks.filter((b) => b.type === 'embed');
  assert.equal(embeds.length, 3);
  const [b, werte, section] = embeds;
  // B ohne Frontmatter, Checkboxen nur zur Anzeige, darin C (Tiefe 2), in C nur noch der Link auf A.
  assert.equal(b.children[0].content[0].text, 'Text aus B');
  assert.deepEqual(b.children[1].items[0].task, { done: false, n: null, line: null });
  const c = b.children.find((x) => x.type === 'embed');
  assert.equal(c.children[0].content[0].text, 'Text aus C');
  assert.equal(c.children.find((x) => x.type === 'embed').children, undefined);
  // Vertraulich: bleibt „fehlt“, ohne Inhalt.
  assert.equal(werte.link.status, 'missing');
  assert.equal(werte.children, undefined);
  // Nur der Abschnitt, mit Unterabschnitt, ohne den nächsten gleicher Ebene.
  const html = renderMarkdown(note.body, { links: desk.get('10-projekte/A.md').links });
  assert.match(html, /<div class="note-embed"><p class="note-embed-head"><a href="\/notiz\?pfad=10-projekte%2FB\.md"/);
  assert.match(html, /zweiter[^]*dritter/);
  assert.doesNotMatch(html, /erster|vierter/);
  assert.equal(section.children.length, 3);
});

test('get: Abschnitt mit formatierter Überschrift, Anker der Einbettung stören die Notiz nicht (VCP-63)', () => {
  put('10-projekte/F.md', '## **Werte**\n\nfett\n\n## Thema\n\nim Embed\n');
  put('10-projekte/G.md', '![[F]]\n\n![[F#Werte]]\n\n## Thema\n\neigenes\n');
  for (const p of ['10-projekte/F.md', '10-projekte/G.md']) idx.refresh(p);
  idx.relinkAll();
  const note = desk.get('10-projekte/G.md');
  const blocks = parseMarkdown(note.body, { links: note.links });
  const [whole, werte] = blocks.filter((b) => b.type === 'embed');
  assert.equal(werte.children[0].content[0].text, 'fett');
  assert.deepEqual(whole.children.filter((b) => b.type === 'heading').map((h) => h.id), ['e1-h-werte', 'e1-h-thema']);
  assert.equal(blocks.find((b) => b.type === 'heading').id, 'h-thema');
});

test('embedNow: eine Notiz ohne Embeddings gleich einbetten, mit Zeitgrenze (VCP-63)', async () => {
  const embedded = new Set();
  const scheduled = [];
  let slow = false;
  const semantic = {
    has: (p) => embedded.has(p),
    similarTo: () => null,
    schedule(paths) {
      scheduled.push(...paths);
      if (slow) return new Promise(() => {});
      for (const p of paths) embedded.add(p);
      return Promise.resolve();
    },
  };
  const settings = createSettingsStore({ defaults: { inboxFolder: '00-inbox' }, logger: quiet });
  const withSem = createNoteDesk({ index: idx, editor: createEditor({ vaultPath: root, index: idx }), policy, settings, semantic: () => semantic });
  assert.equal(await withSem.embedNow('00-inbox/Idee.md'), true);
  assert.deepEqual(scheduled, ['00-inbox/Idee.md']);
  // Schon eingebettet: nichts zu tun. Vertraulich: nie.
  assert.equal(await withSem.embedNow('00-inbox/Idee.md'), false);
  assert.equal(await withSem.embedNow('20-bereiche/Gesundheit/Werte.md'), false);
  assert.equal(scheduled.length, 1);
  // Dauert es zu lang, gibt die Seite nach der Zeitgrenze auf.
  slow = true;
  assert.equal(await withSem.embedNow('10-projekte/Hund/Plan.md', { waitMs: 20 }), false);
  assert.equal(await desk.embedNow('00-inbox/Idee.md'), false);
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

test('link: hängt einen Wikilink an, eindeutig über Basename oder Pfad, nie zu vertraulichen Notizen', () => {
  put('wiki/Hund.md', '# Hund\n\nText\n');
  put('wiki/Plan.md', '# Anderer Plan\n');
  put('wiki/Bewegung.md', '# Bewegung\n');
  idx.close();
  buildIndex({ vaultPath: root, dbPath: ':memory:', policy, persist: (db, vp) => (idx = openIndex(db, { vaultPath: vp, policy })) });
  desk = createNoteDesk({ index: idx, editor: createEditor({ vaultPath: root, index: idx }), policy, settings: createSettingsStore({ defaults: { inboxFolder: '00-inbox' }, logger: quiet }) });

  const r = desk.link('wiki/Hund.md', 'wiki/Bewegung.md');
  assert.equal(r.changed, true);
  assert.equal(r.title, 'Bewegung');
  assert.equal(read('wiki/Hund.md'), '# Hund\n\nText\n- [[Bewegung]]\n');
  assert.ok(idx.outgoingLinks('wiki/Hund.md').some((l) => l.path === 'wiki/Bewegung.md'), 'Index kennt den neuen Link');
  assert.equal(desk.link('wiki/Hund.md', 'wiki/Bewegung.md').changed, false, 'schon verlinkt');

  // „Plan“ gibt es zweimal: dann über den Pfad, damit der Link eindeutig trifft.
  desk.link('wiki/Hund.md', '10-projekte/Hund/Plan.md');
  assert.match(read('wiki/Hund.md'), /- \[\[10-projekte\/Hund\/Plan\]\]\n$/);
  assert.ok(idx.outgoingLinks('wiki/Hund.md').some((l) => l.path === '10-projekte/Hund/Plan.md'));

  assert.throws(() => desk.link('wiki/Hund.md', '20-bereiche/Gesundheit/Werte.md'), /darf es nicht verlinken/);
  assert.throws(() => desk.link('20-bereiche/Gesundheit/Werte.md', 'wiki/Hund.md'), /nicht bearbeiten/);
  assert.throws(() => desk.link('wiki/Hund.md', 'wiki/Hund.md'), /nicht selbst/);
});

test('renderMarkdown: maskiert alles, Links nur mit http(s), Checkboxen gezählt', () => {
  const html = renderMarkdown(
    '# Titel\n\nText mit **fett**, *kursiv*, `<code>` und <script>alert(1)</script>\n\n- [ ] eins\n- [x] zwei\n\n```\n- [ ] kein Kasten\n```\n\n[gut](https://a.test/x) [böse](javascript:alert(1)) [[Seite|Anzeige]] #tag\n\n> Zitat',
    { checkbox: (n, line, done) => `[${n}:${done}]` },
  );
  assert.match(html, /<h2 id="h-titel">Titel<\/h2>/);
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

test('renderMarkdown: Marker generierter Bereiche (HTML-Kommentare) bleiben unsichtbar', () => {
  const html = renderMarkdown('## Flammen\n\n<!-- cockpit:flammen:start -->\n- Block\n<!-- cockpit:flammen:ende 1a2b3c4d -->\n\nText mit <!-- inline --> bleibt');
  assert.doesNotMatch(html, /cockpit:flammen/);
  assert.match(html, /<li>Block<\/li>/);
  assert.match(html, /Text mit/);
});
