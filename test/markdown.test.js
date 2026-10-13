import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseNote } from '../src/vault/markdown.js';

test('trennt Frontmatter vom Rumpf', () => {
  const n = parseNote('---\ntitle: Test\n---\n\n# Überschrift\n\nText.');
  assert.equal(n.frontmatter.title, 'Test');
  assert.match(n.body, /^# Überschrift/);
  assert.doesNotMatch(n.body, /title:/);
});

test('kommt ohne Frontmatter zurecht', () => {
  const n = parseNote('# Nur Text\n');
  assert.deepEqual(n.frontmatter, {});
  assert.match(n.body, /Nur Text/);
});

test('liest Tags als Block-Liste', () => {
  assert.deepEqual(parseNote('---\ntags:\n  - ai\n  - security\n---\n').tags, ['ai', 'security']);
});

test('liest Tags als Inline-Liste', () => {
  assert.deepEqual(parseNote('---\ntags: [ai, security]\n---\n').tags, ['ai', 'security']);
});

test('liest Tags als Skalar mit Rautenpräfixen', () => {
  // Kommt real vor, z.B. "tags: #person #freundin #drk"
  assert.deepEqual(parseNote('---\ntags: #person #freundin #drk\n---\n').tags, ['person', 'freundin', 'drk']);
});

test('verträgt tags: null', () => {
  assert.deepEqual(parseNote('---\ntags: null\n---\n').tags, []);
});

test('normalisiert phoenix-progression auf phönix-progression', () => {
  assert.deepEqual(parseNote('---\ntags: [phoenix-progression]\n---\n').tags, ['phönix-progression']);
});

test('behandelt unaufgelöste Templater-Platzhalter als leer', () => {
  const n = parseNote('---\ncreated: <% tp.date.now("YYYY-MM-DD") %>\n---\n');
  assert.equal(n.frontmatter.created, null);
});

test('normalisiert Datumsangaben auf ISO', () => {
  assert.equal(parseNote("---\ncreated: '2026-07-27'\n---\n").dates.created, '2026-07-27');
  assert.equal(parseNote('---\ncreated: 2026-04-15T00:00:00.000Z\n---\n').dates.created, '2026-04-15');
  assert.equal(parseNote('---\ncreated: 2026-06-19 14:30\n---\n').dates.created, '2026-06-19');
});

test('führt deutsche Schlüssel-Aliase auf die englischen zurück', () => {
  const n = parseNote('---\ntyp: konzept\nquelle: irgendwo\n---\n');
  assert.equal(n.frontmatter.type, 'konzept');
  assert.equal(n.frontmatter.source, 'irgendwo');
});

test('faltet den Status auf Kleinschreibung', () => {
  assert.equal(parseNote('---\nstatus: Aktiv\n---\n').frontmatter.status, 'aktiv');
});

test('findet Inline-Tags im Text', () => {
  assert.deepEqual(parseNote('Ein #definition und ein #drk Tag.').inlineTags, ['definition', 'drk']);
});

test('ignoriert Inline-Tags in Code-Blöcken', () => {
  const md = 'Text #echt\n\n```c\n#include <stdio.h>\n#define X 1\n```\n';
  assert.deepEqual(parseNote(md).inlineTags, ['echt']);
});

test('ignoriert Hex-Farben als Tags', () => {
  assert.deepEqual(parseNote('Farbe #e2e3e4 und #ffffff hier.').inlineTags, []);
});

test('findet Wikilinks und trennt Alias ab', () => {
  const n = parseNote('Siehe [[claude-code|das Tool]] und [[anthropic]].');
  assert.deepEqual(n.links.map((l) => l.target), ['claude-code', 'anthropic']);
  assert.equal(n.links[0].alias, 'das Tool');
});

test('schneidet Heading- und Block-Anker vom Linkziel ab', () => {
  const n = parseNote('[[notiz#abschnitt]] und [[andere^block1]]');
  assert.deepEqual(n.links.map((l) => l.target), ['notiz', 'andere']);
});

test('erkennt Embeds als solche', () => {
  const n = parseNote('![[bild.png]]');
  assert.equal(n.links[0].embed, true);
});

test('ignoriert Wikilinks in Code-Blöcken', () => {
  assert.deepEqual(parseNote('```\n[[nicht-echt]]\n```\n').links, []);
});

test('liefert den Titel aus dem Frontmatter, sonst aus der ersten H1', () => {
  assert.equal(parseNote('---\ntitle: Aus Frontmatter\n---\n# Aus H1\n').title, 'Aus Frontmatter');
  assert.equal(parseNote('# Aus H1\n').title, 'Aus H1');
  assert.equal(parseNote('Nur Fließtext.').title, null);
});

test('sammelt H2-Überschriften ohne Emoji', () => {
  const n = parseNote('## 📝 Notizen\n\n## 🔥 Tages-Review\n');
  assert.deepEqual(n.headings, ['Notizen', 'Tages-Review']);
});

test('zählt offene und erledigte Aufgaben', () => {
  const n = parseNote('- [ ] eins\n- [ ] zwei\n- [x] drei\n');
  assert.equal(n.tasks.open, 2);
  assert.equal(n.tasks.done, 1);
});
