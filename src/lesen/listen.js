import { esc, assets } from '../web/layout.js';
import { hidden } from '../web/render.js';
import { readingPage } from './pages.js';
import { htmlText } from './anchor.js';
import { WINDOWS, fitToWindow } from './stack.js';

/**
 * Unterwegs hören (VCP-79): `/lesen/hoeren?zeit=15` nimmt die Texte des
 * Zeitfensters (`fitToWindow`) als Wiedergabeliste. Vorgelesen wird auf dem
 * Gerät (`/static/lesen-hoeren.js`, Web Speech API), satzweise; nach jedem
 * Satz speichert das Script die Stelle über `/aktion/lesen/doc/fortschritt`,
 * „Das hier merken“ markiert über `/aktion/lesen/markierung/neu`.
 *
 * Den Text liefert `/lesen/hoeren/text?id=…` als JSON: Lesetext wie in
 * src/lesen/anchor.js und die Sätze als `[start, end]` darin, damit Anker und
 * Lesestelle genau zur Leseansicht passen. Ohne JavaScript listet die Seite
 * nur die Texte.
 */

// Blockgrenzen: Dort endet immer ein Satz, auch wenn im Lesetext kein Leerraum steht („AnfangDer Stapel …“).
const BLOCK = /^<\/?(?:p|h[1-6]|li|ul|ol|dl|dt|dd|blockquote|pre|figure|figcaption|table|tr|td|th|div|section|article|br|hr)\b/i;
// Satzende: Punkt, Ausrufe- oder Fragezeichen (auch mehrere, mit schließendem Anführungszeichen), dann Leerraum und ein Großbuchstabe.
const END = /[.!?…]+["'”“»«’)\]]*(?=\s+["'„“»«(\[]?\p{Lu})/gu;
// Kein Satzende nach Einzelbuchstaben („z. B.“, Initialen), ein- oder zweistelligen Zahlen („3. Oktober“) und üblichen Abkürzungen.
// shortcut: feste Liste, kein Wörterbuch; erweitern, wenn beim Hören Sätze mitten im Satz abreißen.
const ABBR = /(?:^|[^\p{L}\d])(?:\p{L}|\d{1,2}|Dr|Prof|Nr|bzw|ca|vgl|usw|etc|ggf|inkl|evtl|sog|Mio|Mrd|St|Fr|Hr)\.$/u;

/**
 * Sätze von gesäubertem HTML als `[{ start, end }]`, Zeichen in `htmlText(html)`,
 * ohne Leerraum am Rand. Zwischen zwei Sätzen steht nur Leerraum.
 */
export function sentences(html) {
  const parts = String(html ?? '').split(/(<[^>]*>)/);
  const blocks = [];
  let length = 0;
  let from = 0;
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 0) length += htmlText(parts[i]).length;
    else if (BLOCK.test(parts[i])) {
      blocks.push([from, length]);
      from = length;
    }
  }
  blocks.push([from, length]);

  const text = htmlText(html);
  const out = [];
  const push = (a, b) => {
    const piece = text.slice(a, b);
    const lead = piece.search(/\S/);
    if (lead !== -1) out.push({ start: a + lead, end: a + piece.trimEnd().length });
  };
  for (const [a, b] of blocks) {
    const block = text.slice(a, b);
    let cut = 0;
    for (const m of block.matchAll(END)) {
      const end = m.index + m[0].length;
      if (m[0] === '.' && ABBR.test(block.slice(Math.max(0, m.index - 6), end))) continue;
      push(a + cut, a + end);
      cut = end;
    }
    push(a + cut, b);
  }
  return out;
}

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
const RATES = [0.8, 1, 1.2, 1.5, 1.8];

function listenBody(items, zeit, ctx) {
  const picker = `<nav class="chips stapel-zeit" aria-label="Zeitfenster">${WINDOWS.map((m) => `<a href="/lesen/hoeren?zeit=${m}" class="chip"${m === zeit ? ' aria-current="true"' : ''}>${m} Min.</a>`).join('')}</nav>`;
  if (!items.length) return `${picker}<p class="empty">Für dieses Zeitfenster passt nichts vom Stapel.</p>`;
  const list = items
    .map(
      (d) => `<li class="lesen-item" data-doc="${esc(d.id)}">
    <a href="/lesen/doc?id=${encodeURIComponent(d.id)}${d.progress > 0 ? '#weiter' : ''}" class="lesen-title">${esc(d.title || d.url)}</a>
    <span class="meta">${esc([d.progress > 0 ? `noch ${d.remaining} Min.` : `${d.remaining} Min.`, d.site].filter(Boolean).join(' · '))}</span>
  </li>`,
    )
    .join('');
  return `${picker}
  <p class="meta hoeren-nojs">Abspielen braucht JavaScript und Sprachausgabe im Browser. Lesen geht über die Titel.</p>
  <div class="hoeren-player" hidden>
    ${hidden({ csrf: ctx.write.csrf })}
    <p class="hoeren-now"><span class="meta" data-title>Bereit</span><span class="hoeren-sentence" data-sentence></span></p>
    <div class="hoeren-controls">
      <button type="button" class="btn primary" data-cmd="play">Abspielen</button>
      <button type="button" class="btn" data-cmd="next">Nächster Text</button>
      <button type="button" class="btn" data-cmd="mark">Das hier merken</button>
      <label class="hoeren-rate"><span>Tempo</span><select data-rate>${RATES.map((r) => `<option value="${r}"${r === 1 ? ' selected' : ''}>${String(r).replace('.', ',')}×</option>`).join('')}</select></label>
    </div>
  </div>
  <ol class="lesen-list hoeren-list">${list}</ol>`;
}

export function listenRoutes({ store }) {
  return {
    pages: {
      async '/lesen/hoeren'(ctx) {
        const n = Number(ctx.url.searchParams.get('zeit'));
        const zeit = WINDOWS.includes(n) ? n : 15;
        // Zu Ende gehörte oder gelesene Texte nicht noch einmal anfangen.
        const { items } = fitToWindow(store.list({ status: 'stapel', limit: -1 }).filter((d) => d.progress < 1), zeit);
        return { html: readingPage(ctx, { key: 'stapel', title: 'Unterwegs hören', body: `<section>${listenBody(items, zeit, ctx)}</section>`, scripts: [assets.lesenHoeren] }) };
      },
      /** Lesetext und Sätze eines Dokuments für die Sprachausgabe. */
      async '/lesen/hoeren/text'(ctx) {
        const doc = store.get(ctx.url.searchParams.get('id'));
        if (!doc) return { status: 404, body: JSON.stringify({ error: 'Diesen Artikel gibt es nicht' }), headers: JSON_HEADERS };
        const body = {
          id: doc.id,
          title: doc.title || doc.url,
          text: htmlText(doc.content_html ?? ''),
          sentences: sentences(doc.content_html ?? '').map((s) => [s.start, s.end]),
          progress: doc.progress,
          anchor: Number(doc.scroll_anchor) || 0,
        };
        return { body: JSON.stringify(body), headers: JSON_HEADERS };
      },
    },
  };
}
