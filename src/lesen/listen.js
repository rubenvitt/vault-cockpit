import { esc, assets } from '../web/layout.js';
import { hidden } from '../web/render.js';
import { readingPage } from './pages.js';
import { htmlText } from './anchor.js';
import { WINDOWS, fitToWindow, toRead } from './stack.js';
import { SpeechError } from './tts.js';
import { listeningMinutes } from './extract.js';

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
 *
 * Ist eine Stimme auf dem Server eingerichtet (`speech`, src/lesen/tts.js),
 * trägt der Player `data-voice` und holt jeden Satz als MP3 von
 * `/lesen/hoeren/audio?id=…&von=…&bis=…` (Zeichen wie die Sätze). Vorgelesen
 * wird so nur Text aus dem Stapel, kein beliebiger. Fällt die Stimme aus,
 * übernimmt die Sprachausgabe des Geräts.
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
// Der Satz ändert sich nicht, solange der Text gleich bleibt; der Browser darf ihn behalten.
const AUDIO_HEADERS = { 'content-type': 'audio/mpeg', 'cache-control': 'private, max-age=86400' };
const RATES = [0.8, 1, 1.2, 1.5, 1.8];
// Längstes Stück für die Stimme vom Server; Sätze sind viel kürzer, das hier begrenzt nur Ausreißer.
export const MAX_AUDIO_CHARS = 5000;

function listenBody(items, zeit, ctx, voice) {
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
  <div class="hoeren-player"${voice ? ` data-voice="${esc(voice)}"` : ''} hidden>
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

/**
 * Wiedergabeliste für `zeit` Minuten (ohne gültige Angabe 15), auch für die
 * iOS-App (`/api/app/stapel`). Gelesene oder schon in einer Folge gehörte Texte
 * (`isRead`) fängt sie nicht noch einmal an. Gerechnet wird mit der Hördauer
 * (`listeningMinutes`), nicht der Lesezeit: Vorlesen dauert länger.
 */
export function listenQueue(store, zeit) {
  const n = Number(zeit);
  const minutes = WINDOWS.includes(n) ? n : 15;
  const spoken = toRead(store.list({ status: 'stapel', limit: -1 })).map((d) => (d.word_count > 0 ? { ...d, reading_minutes: listeningMinutes(d.word_count) } : d));
  return { zeit: minutes, items: fitToWindow(spoken, minutes).items };
}

/** Lesetext und Sätze eines Dokuments für die Sprachausgabe, null ohne Dokument; auch für `/api/app/text`. */
export function listenText(store, id) {
  const doc = store.get(id);
  if (!doc) return null;
  return {
    id: doc.id,
    title: doc.title || doc.url,
    text: htmlText(doc.content_html ?? ''),
    sentences: sentences(doc.content_html ?? '').map((s) => [s.start, s.end]),
    progress: doc.progress,
    anchor: Number(doc.scroll_anchor) || 0,
  };
}

const offset = (v) => (/^\d{1,9}$/.test(String(v ?? '')) ? Number(v) : NaN);

/**
 * MP3 für das Stück `von`–`bis` (Zeichen im Lesetext) eines Dokuments, mit den
 * Nachbarsätzen als Kontext, wenn `von` ein Satzanfang ist; auch für
 * `/api/app/audio`. Fehler als `SpeechError` mit HTTP-Status.
 */
export async function listenAudio(store, speech, { id, von, bis }) {
  if (!speech?.voice()) throw new SpeechError('Keine Stimme auf dem Server eingerichtet (Einstellungen → Vorlesen)', 404);
  const doc = id ? store.get(id) : null;
  if (!doc) throw new SpeechError('Diesen Artikel gibt es nicht', 404);
  const html = doc.content_html ?? '';
  const text = htmlText(html);
  const start = offset(von);
  const end = offset(bis);
  if (!(start < end && end <= text.length)) throw new SpeechError('Stelle passt nicht zum Text (von < bis, höchstens bis zum Ende)', 400);
  if (end - start > MAX_AUDIO_CHARS) throw new SpeechError(`Stück zu lang (höchstens ${MAX_AUDIO_CHARS} Zeichen)`, 400);
  const piece = text.slice(start, end).trim();
  if (!piece) throw new SpeechError('Hier steht nichts zum Vorlesen', 400);
  const list = sentences(html);
  const i = list.findIndex((s) => s.start === start);
  const say = (s) => (s ? text.slice(s.start, s.end) : null);
  return speech.audio({ text: piece, previous: i > 0 ? say(list[i - 1]) : null, next: i >= 0 ? say(list[i + 1]) : null });
}

export function listenRoutes({ store, speech = null }) {
  return {
    pages: {
      async '/lesen/hoeren'(ctx) {
        const { zeit, items } = listenQueue(store, ctx.url.searchParams.get('zeit'));
        const body = `<section>${listenBody(items, zeit, ctx, speech?.voice() ?? null)}</section>`;
        return { html: readingPage(ctx, { key: 'stapel', title: 'Unterwegs hören', body, scripts: [assets.lesenHoeren] }) };
      },
      /** Ein Satz als MP3 von der Stimme auf dem Server. */
      async '/lesen/hoeren/audio'(ctx) {
        const q = ctx.url.searchParams;
        try {
          return { body: await listenAudio(store, speech, { id: q.get('id'), von: q.get('von'), bis: q.get('bis') }), headers: AUDIO_HEADERS };
        } catch (err) {
          if (!(err instanceof SpeechError)) throw err;
          return { status: err.status, body: JSON.stringify({ error: 'speech_failed', message: err.message }), headers: JSON_HEADERS };
        }
      },
      /** Lesetext und Sätze eines Dokuments für die Sprachausgabe. */
      async '/lesen/hoeren/text'(ctx) {
        const body = listenText(store, ctx.url.searchParams.get('id'));
        if (!body) return { status: 404, body: JSON.stringify({ error: 'Diesen Artikel gibt es nicht' }), headers: JSON_HEADERS };
        return { body: JSON.stringify(body), headers: JSON_HEADERS };
      },
    },
  };
}
