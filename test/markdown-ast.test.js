import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseMarkdown, parseInline, renderMarkdown, renderBlocks, plainText } from '../src/web/markdown-render.js';
import { synthesisOutline } from '../src/web/synthesis-render.js';

/**
 * Auflöser wie `createLinkResolver`, fest verdrahtet. Muss zu dem passen, mit dem
 * `fixtures/markdown-golden.json` erzeugt wurde (noch mit dem Renderer ohne Baum).
 */
const links = {
  wikilink(t) {
    if (!t) return { kind: 'note', path: '00-inbox/Idee.md', title: 'Idee', self: true };
    if (t === 'Hund' || t === 'Bello') return { kind: 'note', path: 'wiki/Hund.md', title: 'Hund', self: false };
    if (t === 'Idee') return { kind: 'note', path: '00-inbox/Idee.md', title: 'Idee', self: true };
    if (/\.(png|jpe?g)$/i.test(t)) return t.startsWith('weg') ? null : { kind: 'image', path: `anhang/${t.split('/').pop()}` };
    if (/\.(pdf|svg|canvas)$/i.test(t)) return { kind: 'file' };
    return null;
  },
  image: (src) => (/^(\.\.\/)?anhang\//.test(src) ? { kind: 'image', path: `anhang/${src.split('/').pop()}` } : null),
  markdownLink(href) {
    const [target, anchor = null] = href.split('#');
    return /^(\.\.\/)?Plan\.md$/.test(target) ? { kind: 'note', path: '10-projekte/Plan.md', title: 'Plan', self: false, anchor } : null;
  },
};
const checkbox = (n, line, done) => `<cb n="${n}" line="${line.trim()}" done="${done}">`;
const golden = JSON.parse(readFileSync(new URL('./fixtures/markdown-golden.json', import.meta.url), 'utf8'));

test('renderMarkdown aus dem Baum: HTML genau wie vorher (Vergleichsbestand)', () => {
  assert.ok(golden.length >= 15);
  for (const g of golden) {
    assert.equal(renderMarkdown(g.markdown, { links, checkbox }), g.html, g.name);
    assert.equal(renderMarkdown(g.markdown), g.plain, `${g.name} (ohne Auflöser)`);
    // Der Baum ist reines JSON: hin und zurück ergibt dasselbe HTML.
    const tree = JSON.parse(JSON.stringify(parseMarkdown(g.markdown, { links })));
    assert.equal(renderBlocks(tree, { checkbox }), g.html, `${g.name} (aus JSON)`);
  }
});

test('parseMarkdown: Blöcke mit Ankern, Checkbox-Nummern, Callouts, Tabellen und Medien', () => {
  const blocks = parseMarkdown(
    '# Titel\n\n- [ ] offen\n  - [x] erledigt\n1. [ ] nummeriert\n\n> [!tip]- Zu\n> - [ ] im Callout\n> ## Titel\n\n| a | b |\n|:-:|--:|\n| 1 |\n\n![[foto.png|200x100]]\n\n![[Hund]]\n\n```js\nx\n```\n\n---\nZeile\nzwei',
    { links },
  );
  assert.deepEqual(blocks.map((b) => b.type), ['heading', 'list', 'list', 'callout', 'table', 'image', 'embed', 'code', 'rule', 'paragraph']);
  assert.deepEqual(blocks[0], { type: 'heading', level: 1, id: 'h-titel', content: [{ type: 'text', text: 'Titel' }] });
  assert.deepEqual(blocks[1].items.map((i) => [i.depth, i.task]), [
    [0, { done: false, n: 0, line: '- [ ] offen' }],
    [1, { done: true, n: 1, line: '- [x] erledigt' }],
  ]);
  assert.deepEqual(blocks[2], { type: 'list', ordered: true, items: [{ depth: 0, task: null, content: [{ type: 'text', text: '[ ] nummeriert' }] }] });
  const callout = blocks[3];
  assert.deepEqual({ ...callout, children: undefined, title: undefined }, { type: 'callout', kind: 'tip', family: 'ok', label: 'Tipp', foldable: true, open: false, children: undefined, title: undefined });
  assert.deepEqual(callout.title, [{ type: 'text', text: 'Zu' }]);
  assert.deepEqual(callout.children[0].items[0].task, { done: false, n: null, line: null }, 'Checkboxen im Callout sind nur Anzeige');
  assert.equal(callout.children[1].id, 'h-titel-2', 'Anker über die ganze Notiz eindeutig');
  assert.deepEqual(blocks[4], { type: 'table', align: ['center', 'right'], head: [[{ type: 'text', text: 'a' }], [{ type: 'text', text: 'b' }]], rows: [[[{ type: 'text', text: '1' }], []]] });
  assert.deepEqual(blocks[5], { type: 'image', path: 'anhang/foto.png', src: '/notiz/bild?pfad=anhang%2Ffoto.png', alt: 'foto.png', width: 200, height: 100 });
  assert.equal(blocks[6].link.status, 'note');
  assert.equal(blocks[6].link.embed, true);
  assert.deepEqual(blocks[7], { type: 'code', lang: 'js', text: 'x' });
  assert.deepEqual(blocks[9].content, [{ type: 'text', text: 'Zeile' }, { type: 'break' }, { type: 'text', text: 'zwei' }]);
});

test('parseInline: Formate, Links, Tags und Wikilinks als Teile', () => {
  assert.deepEqual(parseInline('*kursiv **fett** drin* und ~~weg~~ ==hell== `<code>` #tag'), [
    { type: 'italic', children: [{ type: 'text', text: 'kursiv ' }, { type: 'bold', children: [{ type: 'text', text: 'fett' }] }, { type: 'text', text: ' drin' }] },
    { type: 'text', text: ' und ' },
    { type: 'strike', children: [{ type: 'text', text: 'weg' }] },
    { type: 'text', text: ' ' },
    { type: 'mark', children: [{ type: 'text', text: 'hell' }] },
    { type: 'text', text: ' ' },
    { type: 'code', text: '<code>' },
    { type: 'text', text: ' ' },
    { type: 'tag', tag: 'tag' },
  ]);
  assert.deepEqual(parseInline('[a](https://e.org/x) https://e.org/y [b](javascript:x)'), [
    { type: 'link', url: 'https://e.org/x', text: 'a' },
    { type: 'text', text: ' ' },
    { type: 'url', url: 'https://e.org/y' },
    { type: 'text', text: ' b' },
  ]);
  const [hund, , anchor, , self, , gone, , file] = parseInline('[[Hund#Training|Üben]] [[#Unten]] [[Idee]] [[Weg]] [[plan.pdf]]', links);
  assert.deepEqual(hund, { type: 'wikilink', status: 'note', text: 'Üben', target: 'Hund', heading: 'Training', alias: 'Üben', embed: false, path: 'wiki/Hund.md', self: false, anchor: 'h-training' });
  assert.deepEqual([anchor.status, anchor.self, anchor.anchor, anchor.text], ['note', true, 'h-unten', 'Unten']);
  assert.deepEqual([self.status, self.self, self.anchor], ['note', true, null]);
  assert.deepEqual([gone.status, gone.path, gone.text], ['missing', null, 'Weg']);
  assert.deepEqual([file.status, file.text], ['file', 'plan.pdf']);
  assert.deepEqual(parseInline('[Plan](Plan.md#Ziel)', links)[0], { type: 'wikilink', status: 'note', text: 'Plan', target: 'Plan.md#Ziel', heading: 'Ziel', alias: 'Plan', embed: false, path: '10-projekte/Plan.md', self: false, anchor: 'h-ziel' });
  assert.equal(plainText(parseInline('**[[Hund|Bello]]** und #tag', links)), 'Bello und #tag');
});

test('Überkreuzte Auszeichnungen werden sauber verschachtelt statt kaputtem HTML', () => {
  assert.deepEqual(parseInline('**a ==b** c=='), [
    { type: 'bold', children: [{ type: 'text', text: 'a ' }, { type: 'mark', children: [{ type: 'text', text: 'b' }] }] },
    { type: 'mark', children: [{ type: 'text', text: ' c' }] },
  ]);
  assert.equal(renderMarkdown('**a ==b** c=='), '<p><strong>a <mark>b</mark></strong><mark> c</mark></p>');
});

test('synthesisOutline: H2 als Thesen, auch in Callouts, ohne den Lesestapel-Bereich', () => {
  const blocks = parseMarkdown('# Titel\n## Erste [[Hund]] & mehr\n### Unter\n> [!note]\n> ## In der Box\n## Aus dem Lesestapel\n## Erste [[Hund]] & mehr', { links });
  assert.deepEqual(synthesisOutline(blocks), [
    { id: 'h-erste-hund-mehr', text: 'Erste Hund & mehr', html: 'Erste Hund &amp; mehr' },
    { id: 'h-in-der-box', text: 'In der Box', html: 'In der Box' },
    { id: 'h-erste-hund-mehr-2', text: 'Erste Hund & mehr', html: 'Erste Hund &amp; mehr' },
  ]);
});
