import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeHtml, extractArticle, readingMinutes, htmlToMarkdown } from '../src/lesen/extract.js';
import { createReadingStore } from '../src/lesen/store.js';
import { saveUrl } from '../src/lesen/save.js';

test('Säubern: Skripte, Stile, Frames, Event-Attribute und javascript:-Links fliegen raus', () => {
  const html = sanitizeHtml(
    `<p onclick="x()" style="color:red" class="a" id="b">Hallo <b onmouseover="y()">Welt</b><script>alert(1)</script></p>
     <style>p { color: red }</style><iframe src="https://evil.test"></iframe><object data="x"></object><svg><a href="/s">svg</a></svg>
     <a href="javascript:alert(1)">eins</a><a href=" JaVaScRiPt:alert(1)">zwei</a><a href="java&#x09;script:alert(1)">drei</a><a href="data:text/html,x">vier</a>
     <a href="/relativ" target="_blank" onclick="z()">fünf</a><a href="mailto:a@b.test">sechs</a>
     <form action="/x"><input name="a"></form><noscript>nein</noscript><span><em>bleibt</em></span><!-- Kommentar -->`,
    'https://quelle.test/artikel/',
  );
  for (const bad of ['<script', 'alert', '<style', 'color', '<iframe', '<object', '<svg', 'onclick', 'onmouseover', 'javascript', 'data:', '<form', '<input', 'nein', 'class=', 'id=', 'target=', 'Kommentar']) {
    assert.ok(!html.toLowerCase().includes(bad.toLowerCase()), `${bad} in ${html}`);
  }
  assert.match(html, /<p>Hallo <b>Welt<\/b><\/p>/);
  assert.match(html, /<a>eins<\/a><a>zwei<\/a><a>drei<\/a><a>vier<\/a>/);
  assert.match(html, /<a href="https:\/\/quelle\.test\/relativ" rel="noopener noreferrer">fünf<\/a>/);
  assert.match(html, /<a href="mailto:a@b\.test" rel="noopener noreferrer">sechs<\/a>/);
  assert.match(html, /<em>bleibt<\/em>/);
});

test('Säubern: Bilder und Videos werden zu Links, Tabellen behalten nur Zahlen-Attribute', () => {
  const html = sanitizeHtml(
    '<figure><img src="/bild.jpg" alt="Ein &quot;Bild&quot;" onerror="x()"><figcaption>Text</figcaption></figure><img src="javascript:alert(1)"><picture><source srcset="a.webp"><img src="b.png"></picture><video><source src="film.mp4"></video><table><tr><td colspan="2" rowspan="x" width="9">1</td></tr></table>',
    'https://quelle.test/a/',
  );
  assert.ok(!html.includes('<img'));
  assert.match(html, /<figure><a href="https:\/\/quelle\.test\/bild\.jpg" rel="noopener noreferrer" class="media-link">Bild: Ein &quot;Bild&quot;<\/a><figcaption>Text<\/figcaption><\/figure>/);
  assert.match(html, /href="https:\/\/quelle\.test\/a\/b\.png"[^>]*>Bild</);
  assert.match(html, /href="https:\/\/quelle\.test\/a\/film\.mp4"[^>]*>Video</);
  assert.ok(!html.includes('javascript'));
  assert.match(html, /<td colspan="2">1<\/td>/);
});

const PAGE = `<!doctype html><html><head><title>Langsam lesen – Beispielblatt</title>
<link rel="canonical" href="/kanon/langsam-lesen"><meta property="og:site_name" content="Beispielblatt"></head>
<body><nav><a href="/">Start</a> <a href="/abo">Abo</a></nav>
<article><h1>Langsam lesen</h1><p class="byline">Von Erika Mustermann</p>
<p>Wer langsam liest, behält mehr. Das ist der erste Absatz dieses Artikels, und er ist lang genug für Readability.</p>
${'<p>Ein weiterer Absatz mit Gedanken über das Lesen, die Aufmerksamkeit und den Stapel ungelesener Texte auf dem Nachttisch.</p>'.repeat(20)}
<script>track()</script></article><footer>Impressum</footer></body></html>`;

test('Extraktion: Titel, Quelle, Autor, kanonische Adresse, Auszug und Lesezeit', () => {
  const a = extractArticle(PAGE, 'https://beispiel.test/2026/langsam?utm=x');
  assert.match(a.title, /Langsam lesen/);
  assert.equal(a.site, 'Beispielblatt');
  assert.match(a.author, /Erika Mustermann/);
  assert.equal(a.canonical_url, 'https://beispiel.test/kanon/langsam-lesen');
  assert.match(a.excerpt, /^Wer langsam liest/);
  assert.ok(!a.content_html.includes('track()') && !a.content_html.includes('Impressum'));
  assert.match(a.content_text, /behält mehr\./);
  assert.ok(a.word_count > 300 && a.word_count < 400, String(a.word_count));
  assert.equal(a.reading_minutes, readingMinutes(a.word_count));
  assert.equal(readingMinutes(1), 1);
  assert.equal(readingMinutes(1100), 5);
});

test('Speichern: holt einmal, legt im Eingang ab; dieselbe Adresse oder client_id holt nicht noch einmal', async () => {
  const store = createReadingStore({ path: ':memory:' });
  const fetched = [];
  const fetchPage = async (url) => {
    fetched.push(url);
    return { url: 'https://beispiel.test/2026/langsam', body: PAGE };
  };
  const first = await saveUrl({ store, url: 'https://beispiel.test/kurz#oben', clientId: 'c1', origin: 'kurzbefehl', fetchPage });
  assert.equal(first.duplicate, false);
  assert.deepEqual(fetched, ['https://beispiel.test/kurz']);
  assert.equal(first.doc.url, 'https://beispiel.test/2026/langsam');
  assert.equal(first.doc.origin, 'kurzbefehl');
  assert.equal(first.doc.status, 'eingang');

  assert.equal((await saveUrl({ store, url: 'https://anders.test/', clientId: 'c1', fetchPage })).duplicate, true);
  assert.equal((await saveUrl({ store, url: 'https://beispiel.test/2026/langsam', fetchPage })).duplicate, true);
  // Über die Kurzadresse noch einmal: geholt wird, angelegt nicht.
  assert.equal((await saveUrl({ store, url: 'https://beispiel.test/kurz', fetchPage })).duplicate, true);
  assert.equal(fetched.length, 2);
  assert.equal(store.list().length, 1);
  await assert.rejects(saveUrl({ store, url: 'ftp://x.test', fetchPage }), /Nur http/);
});

test('extractArticle: fremde Canonical-URL wird ignoriert', () => {
  const html = '<!doctype html><html><head><title>T</title><link rel="canonical" href="https://fremd.test/artikel"></head><body><article><p>Text.</p></article></body></html>';
  assert.equal(extractArticle(html, 'https://beispiel.test/a').canonical_url, null);
});

test('extractArticle: Seite ohne <head> und <body> (erlaubt in HTML5) liefert trotzdem den Text', () => {
  const html = `<!DOCTYPE html><html lang=en><meta charset=utf-8><title>Kühn</title><style>p{}</style><header><strong>Kühn</strong><hr></header><main>${'<p>Ein Absatz ohne schließende Tags, aber mit genug Wörtern für Readability.'.repeat(12)}</main><footer>Fuß</footer>`;
  const a = extractArticle(html, 'https://kuehn.test/a/');
  assert.equal(a.title, 'Kühn');
  assert.ok(a.word_count > 100, `nur ${a.word_count} Wörter`);
  assert.match(a.content_text, /Ein Absatz ohne schließende Tags/);
});

test('Markdown (VCP-96): Absätze, Überschriften, Hervorhebungen, Links, Code, Zitate, Tabellen', () => {
  const html = sanitizeHtml(
    `<h1>Über &amp; Unter</h1><p>Ein <strong> fetter </strong>Satz, <em>betont</em>, <s>alt</s>, <mark>wichtig</mark> und <a href="/a b?x=<1>">ein [Link]</a>.</p>
     <p>Code: <code>a\`b</code> und <kbd>Strg</kbd></p><blockquote><p>Zitat</p><p>zweiter Absatz</p></blockquote>
     <pre><code>if (a) {\n  \`\`\`\n}</code></pre><img src="/bild.png" alt="Ein Bild"><hr>
     <table><tr><th>A</th><th>B|C</th></tr><tr><td>1</td><td><p>2</p></td></tr></table><p>Zeile<br>neue Zeile</p>`,
    'https://blatt.test/x',
  );
  assert.equal(
    htmlToMarkdown(html),
    [
      '### Über & Unter',
      'Ein **fetter** Satz, *betont*, ~~alt~~, ==wichtig== und [ein \\[Link\\]](<https://blatt.test/a%20b?x=%3C1%3E>).',
      'Code: ``a`b`` und `Strg`',
      '> Zitat\n>\n> zweiter Absatz',
      '````\nif (a) {\n  ```\n}\n````',
      '[Bild: Ein Bild](<https://blatt.test/bild.png>)',
      '---',
      '| A | B\\|C |\n| --- | --- |\n| 1 | 2 |',
      'Zeile\nneue Zeile',
    ].join('\n\n'),
  );
  assert.equal(htmlToMarkdown(''), '');
});

test('Markdown: Tabellenzellen einzeilig, `|` auch im Code und in Links maskiert; Marker-Zeilen im Code entschärft', () => {
  const html = sanitizeHtml(
    `<table><tr><th>a|b</th><th><code>x | y</code></th></tr><tr><td><p>eins</p><p>zwei<br>drei</p></td><td><a href="https://x.test/?q=a|b">L|nk</a> <ul><li>p</li></ul></td></tr></table>
     <pre><code>vorher\n&lt;!-- cockpit:text:ende 12345678 --&gt;\n</code></pre>`,
  );
  assert.equal(
    htmlToMarkdown(html),
    '| a\\|b | `x \\| y` |\n| --- | --- |\n| eins zwei drei | [L\\|nk](<https://x.test/?q=a%7Cb>) p |\n\n```\nvorher\n​<!-- cockpit:text:ende 12345678 -->\n```',
  );
});

test('Markdown: verschachtelte Listen, Sonderzeichen und Markdown-Zeichen im Text maskiert', () => {
  const html = sanitizeHtml(
    `<ul><li>Eins<ul><li>Eins-A</li><li>Eins-B<ol start="3"><li>drei</li><li>vier</li></ol></li></ul></li><li><p>Zwei</p><p>noch</p></li></ul>
     <p>- kein Punkt, * kein Stern, # kein Tag, [[kein Link]], $x$, ==nein==, %%nein%%, _x_, \`y\`, a|b, ~z~, \\ und &amp;amp; &lt;!-- cockpit:text:ende --&gt;</p>
     <p>1. keine Liste<br>+ auch nicht</p><p>Ümläüte ß – „Anführung“ 🙂 &gt; Pfeil</p>`,
  );
  assert.equal(
    htmlToMarkdown(html),
    [
      '- Eins\n  - Eins-A\n  - Eins-B\n    3. drei\n    4. vier\n- Zwei\n  noch',
      '\\- kein Punkt, \\* kein Stern, \\# kein Tag, \\[\\[kein Link\\]\\], \\$x\\$, =\\=nein=\\=, %\\%nein%\\%, \\_x\\_, \\`y\\`, a\\|b, \\~z\\~, \\\\ und \\&amp; \\<!-- cockpit:text:ende --\\>',
      '1\\. keine Liste\n\\+ auch nicht',
      'Ümläüte ß – „Anführung“ 🙂 \\> Pfeil',
    ].join('\n\n'),
  );
});
