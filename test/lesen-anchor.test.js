import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findAnchor, anchorAt, htmlText, markHighlights } from '../src/lesen/anchor.js';
import { sanitizeHtml } from '../src/lesen/extract.js';

const ORIGINAL = sanitizeHtml(`<h2>Vom Lesen</h2>
<p>Der Stapel wächst. Man liest zu wenig und speichert zu viel.</p>
<p>Ein zweiter Absatz. Man liest zu wenig, sagt jeder, aber niemand ändert etwas.</p>
<p>Zum Schluss: <em>Weniger</em> speichern & mehr lesen.</p>`);

/** Anker wie im Browser: Auswahl der `n`-ten Fundstelle von `quote` im Lesetext. */
function anchorFor(html, quote, n = 0) {
  const text = htmlText(html);
  let start = -1;
  for (let i = 0; i <= n; i++) start = text.indexOf(quote, start + 1);
  assert.ok(start >= 0, `„${quote}“ steht im Text`);
  return anchorAt(text, start, start + quote.length);
}

const found = (html, anchor) => {
  const text = htmlText(html);
  const r = findAnchor(text, anchor);
  return r && { quote: text.slice(r.start, r.end), before: text.slice(0, r.start) };
};

test('Anker: findet das Zitat nach eingefügtem Absatz und Umformatieren wieder, an der richtigen von zwei gleichen Stellen', () => {
  const anchor = anchorFor(ORIGINAL, 'Man liest zu wenig', 1);
  // Neu geholt: Absatz davor, andere Umbrüche, Hervorhebung mitten im Zitat.
  const changed = sanitizeHtml(`<h2>Vom Lesen</h2><p>Neu: eine Einleitung, die vorher fehlte. Man liest zu wenig.</p>
<p>Der Stapel wächst. Man liest zu wenig und speichert zu viel.</p>
<p>Ein zweiter
   Absatz. Man <strong>liest</strong>   zu wenig, sagt jeder, aber niemand ändert etwas.</p>`);
  const r = found(changed, anchor);
  assert.match(r.quote, /^Man liest\s+zu wenig$/);
  assert.ok(r.before.endsWith('Absatz. '), 'die Stelle im zweiten Absatz, nicht die erste gleiche');
});

test('Anker: Zitat über zwei Absätze überlebt neue Umbrüche zwischen den Absätzen', () => {
  const text = htmlText(ORIGINAL);
  const across = anchorAt(text, text.indexOf('zu viel.'), text.indexOf('Ein zweiter') + 'Ein zweiter'.length);
  const changed = ORIGINAL.replace(/<\/p>\s*<p>/g, '</p>\n\n\n<p>');
  assert.match(found(changed, across).quote, /^zu viel\.\s+Ein zweiter$/);
});

test('Anker: Gleichstand entscheidet die alte Stelle; fehlt das Zitat, gibt es keinen Anker', () => {
  const text = 'abc xyz abc xyz abc';
  assert.equal(findAnchor(text, { quote: 'abc', start_hint: 16 }).start, 16);
  assert.equal(findAnchor(text, { quote: 'abc', start_hint: 0 }).start, 0);
  assert.equal(findAnchor(text, { quote: 'fehlt' }), null);
  assert.equal(findAnchor(text, { quote: '   ' }), null);
});

test('Markieren: <mark> nur um Text, über Tags hinweg, Text bleibt maskiert, verlorene Markierungen gemeldet', () => {
  const html = sanitizeHtml('<p>Vorher &lt;b&gt; und <em>kursiv</em> danach.</p><p>Zweiter "Absatz"</p>');
  const text = htmlText(html);
  assert.equal(text, 'Vorher <b> und kursiv danach.Zweiter "Absatz"');
  const start = text.indexOf('<b>');
  const hl = { id: 'h1', note: 'Notiz "mit" <script>alert(1)</script>', ...anchorAt(text, start, text.indexOf('danach') + 6) };
  const { html: out, orphans } = markHighlights(html, [hl, { id: 'h2', quote: 'gibt es nicht' }], { weiter: text.indexOf('Zweiter') });
  assert.deepEqual(orphans.map((h) => h.id), ['h2']);
  assert.equal(
    out,
    '<p>Vorher <mark id="h-h1" class="hl has-note" data-hl="h1" title="Notiz &quot;mit&quot; &lt;script&gt;alert(1)&lt;/script&gt;">&lt;b&gt; und </mark><em><mark class="hl has-note" data-hl="h1" title="Notiz &quot;mit&quot; &lt;script&gt;alert(1)&lt;/script&gt;">kursiv</mark></em><mark class="hl has-note" data-hl="h1" title="Notiz &quot;mit&quot; &lt;script&gt;alert(1)&lt;/script&gt;"> danach</mark>.</p><p><span id="weiter" class="lesen-weiter"></span>Zweiter &quot;Absatz&quot;</p>',
  );
  // Der Lesetext bleibt derselbe: Die Anker im Browser zählen weiter richtig.
  assert.equal(htmlText(out), text);
});

test('Markieren: Überlappungen werden gekürzt, Leerraum zwischen Blöcken bleibt ohne <mark>, #weiter ohne Stand am Anfang', () => {
  const html = '<ul>\n<li>eins zwei</li>\n<li>drei</li>\n</ul>';
  const text = htmlText(html);
  const a = { id: 'a', ...anchorAt(text, text.indexOf('eins'), text.indexOf('zwei') + 4) };
  const b = { id: 'b', ...anchorAt(text, text.indexOf('zwei'), text.indexOf('drei') + 4) };
  const { html: out } = markHighlights(html, [b, a]);
  assert.equal(
    out,
    '<ul>\n<li><span id="weiter" class="lesen-weiter"></span><mark id="h-a" class="hl" data-hl="a">eins zwei</mark></li>\n<li><mark id="h-b" class="hl" data-hl="b">drei</mark></li>\n</ul>',
  );
});
