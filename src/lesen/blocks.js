import { decode, textSegments } from './anchor.js';

/**
 * Lesetext als Blöcke für die native Leseansicht der App (`/api/lesen/doc`):
 * aus gesäubertem `content_html` (src/lesen/extract.js) eine flache Liste
 *
 *   { kind, start, end, runs: [{ text, start, bold?, italic?, code?, strike?, link?, extra? }], … }
 *
 * mit `kind` `heading` (`level`), `paragraph`, `listItem` (`ordered`, `depth`
 * ab 1, `number` bei nummerierten), `quote`, `code`, `caption`, `row` (Zeile
 * einer Tabelle, `header`), `image` (`src`, `alt`) und `rule`; `quoted: true`
 * steht an Blöcken in einem Zitat, die selbst kein Zitat sind.
 *
 * Zeichen zählen wie die Anker der Markierungen (src/lesen/anchor.js): Stellen
 * im Lesetext, also in `textContent` in UTF-16-Einheiten. `start` und `end`
 * eines Blocks sind die Stellen seines ersten und hinter seinem letzten
 * sichtbaren Zeichen; jeder Lauf trägt seine eigene `start`, und
 * `text` eines Laufs ist genau so lang wie das Stück `start…start+text.length`
 * im Lesetext. Leerraum ist wie im Browser zusammengefasst: Jedes Leerzeichen,
 * jeder Tab und Umbruch wird zu einem Leerzeichen, mehrere hintereinander
 * werden zu einem (dahinter beginnt ein neuer Lauf mit eigener `start`); am
 * Anfang und Ende eines Blocks fällt er weg. In `code` bleibt er, wie er ist.
 * Läufe mit `extra: true` (Zeilenumbruch `<br>`, `\t` zwischen Tabellenzellen)
 * stehen nicht im Lesetext und haben keine Länge darin.
 *
 * Bilder macht `sanitizeHtml` zu Links „Bild: …“ (`a.media-link`); hier werden
 * sie wieder zu `image` mit der Adresse des Originals. Leerraum zwischen den
 * Blöcken gehört zu keinem Block.
 */

const HEADINGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
// Elemente, an denen ein Block endet und ein neuer beginnt.
const BLOCK = new Set(['p', ...HEADINGS, 'blockquote', 'pre', 'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'figure', 'figcaption', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'caption', 'div', 'section', 'article', 'aside', 'details', 'summary']);
const BOLD = new Set(['strong', 'b', 'dt', 'th', 'summary']);
const ITALIC = new Set(['em', 'i', 'cite', 'dfn', 'var']);
const CODE = new Set(['code', 'kbd', 'samp']);
const STRIKE = new Set(['s', 'del']);
// Leerraum im Sinne von HTML; ein geschütztes Leerzeichen bleibt eins.
const SPACE = /[ \t\n\r\f]/;

const attr = (tag, name) => {
  const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return m ? decode(m[1]) : null;
};

/** Art des Blocks aus den offenen Elementen (innerstes entscheidet). */
function kindOf(stack) {
  const quoted = stack.some((e) => e.tag === 'blockquote');
  for (let i = stack.length - 1; i >= 0; i--) {
    const { tag } = stack[i];
    if (HEADINGS.has(tag)) return { kind: 'heading', level: Number(tag[1]), ...(quoted ? { quoted } : {}) };
    if (tag === 'pre') return { kind: 'code', ...(quoted ? { quoted } : {}) };
    if (tag === 'li') {
      const lists = stack.slice(0, i).filter((e) => e.tag === 'ul' || e.tag === 'ol');
      const list = lists.at(-1);
      const ordered = list?.tag === 'ol';
      return { kind: 'listItem', ordered, depth: Math.max(1, lists.length), ...(ordered ? { number: stack[i].number } : {}), ...(quoted ? { quoted } : {}) };
    }
    if (tag === 'figcaption' || tag === 'caption') return { kind: 'caption', ...(quoted ? { quoted } : {}) };
    if (tag === 'tr') return { kind: 'row', header: stack.slice(i + 1).some((e) => e.tag === 'th'), ...(quoted ? { quoted } : {}) };
    if (tag === 'blockquote') return { kind: 'quote' };
  }
  return { kind: 'paragraph' };
}

/** Auszeichnung eines Laufs aus den offenen Elementen. */
function styleOf(stack) {
  const style = {};
  for (const e of stack) {
    if (BOLD.has(e.tag)) style.bold = true;
    if (ITALIC.has(e.tag)) style.italic = true;
    if (CODE.has(e.tag)) style.code = true;
    if (STRIKE.has(e.tag)) style.strike = true;
    if (e.tag === 'a' && e.href) style.link = e.href;
  }
  return style;
}

const sameStyle = (a, b) => a.bold === b.bold && a.italic === b.italic && a.code === b.code && a.strike === b.strike && a.link === b.link && !a.extra && !b.extra;

/**
 * Blöcke des gesäuberten HTML; `text` ist der Lesetext, gegen den
 * Markierungen und Lesestelle rechnen (src/lesen/anchor.js).
 */
export function textBlocks(html) {
  const { parts, segs, text } = textSegments(html);
  const blocks = [];
  const stack = [];
  let block = null;
  // Offener Bild-Link (`a.media-link`): sein Text wird zu `alt`, nicht zu einem Lauf.
  let media = null;

  const open = () => {
    if (block) return block;
    // `space`: Davor steht Leerraum (oder nichts), weiterer fällt weg.
    block = { ...kindOf(stack), runs: [], space: true };
    return block;
  };

  /** Lauf anhängen; an den vorigen, wenn Auszeichnung und Stelle passen. */
  const push = (run) => {
    const b = open();
    const last = b.runs.at(-1);
    if (last && sameStyle(last, run) && last.start + last.text.length === run.start) last.text += run.text;
    else b.runs.push(run);
  };

  const flush = () => {
    const b = block;
    block = null;
    if (!b) return;
    // Leerraum am Ende fällt weg, im Code samt Umbrüchen.
    while (b.runs.length) {
      const last = b.runs.at(-1);
      const trimmed = last.extra ? '' : b.kind === 'code' ? last.text.replace(/[ \t\n\r\f]+$/, '') : last.text.replace(/ $/, '');
      if (trimmed) {
        last.text = trimmed;
        break;
      }
      b.runs.pop();
    }
    const real = b.runs.filter((r) => !r.extra);
    if (!real.length) return;
    const { space, runs, ...info } = b;
    blocks.push({ ...info, start: real[0].start, end: real.at(-1).start + real.at(-1).text.length, runs });
  };

  /** Text `raw` ab Stelle `from` im Lesetext in den offenen Block. */
  const addText = (raw, from) => {
    if (media) {
      media.alt += raw;
      return;
    }
    const kind = block?.kind ?? kindOf(stack).kind;
    if (!block && !/[^ \t\n\r\f]/.test(raw)) return;
    const style = styleOf(stack);
    if (kind === 'code') {
      // Code: Leerraum bleibt, nur Umbrüche am Anfang fallen weg.
      const lead = block?.runs.length ? 0 : raw.match(/^[\n\r]*/)[0].length;
      if (raw.length > lead) push({ text: raw.slice(lead), start: from + lead, ...style });
      return;
    }
    const b = open();
    let piece = '';
    let pieceStart = null;
    const done = () => {
      if (piece) push({ text: piece, start: pieceStart, ...style });
      piece = '';
      pieceStart = null;
    };
    for (let k = 0; k < raw.length; k++) {
      const ch = raw[k];
      if (SPACE.test(ch)) {
        if (b.space) {
          // Zusammengefasst: Das Stück endet hier, das nächste beginnt mit eigener Stelle.
          done();
          continue;
        }
        b.space = true;
        if (pieceStart === null) pieceStart = from + k;
        piece += ' ';
        continue;
      }
      b.space = false;
      if (pieceStart === null) pieceStart = from + k;
      piece += ch;
    }
    done();
  };

  const extra = (t, at) => {
    if (!block || media) return;
    block.runs.push({ text: t, start: at, extra: true });
    block.space = true;
  };

  let seg = 0;
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 0) {
      const s = segs[seg++];
      if (s.end > s.start) addText(text.slice(s.start, s.end), s.start);
      continue;
    }
    const at = segs[seg]?.start ?? text.length;
    const m = /^<(\/?)([a-zA-Z][a-zA-Z0-9]*)/.exec(parts[i]);
    if (!m) continue;
    const [, closing, name] = m;
    const tag = name.toLowerCase();
    if (tag === 'br') {
      extra('\n', at);
      continue;
    }
    if (tag === 'hr') {
      flush();
      blocks.push({ kind: 'rule', start: at, end: at, runs: [] });
      continue;
    }
    if (!closing) {
      if (BLOCK.has(tag)) flush();
      if (tag === 'td' || tag === 'th') {
        if (block?.runs.length) extra('\t', at);
        if (tag === 'th' && block) block.header = true;
      }
      const el = { tag };
      if (tag === 'a') el.href = attr(parts[i], 'href');
      if (tag === 'ol') el.counter = Number(attr(parts[i], 'start') ?? 1) - 1;
      if (tag === 'li') {
        const list = stack.findLast((e) => e.tag === 'ol' || e.tag === 'ul');
        if (list?.tag === 'ol') el.number = ++list.counter;
      }
      // Bild-Link: sein Text steht gleich dahinter (Video und Ton bleiben Links im Text).
      if (tag === 'a' && el.href && /\sclass="media-link"/.test(parts[i]) && /^Bild(?::|$)/.test(decode(parts[i + 1] ?? ''))) {
        flush();
        media = { href: el.href, start: at, alt: '' };
      }
      stack.push(el);
      continue;
    }
    const idx = stack.findLastIndex((e) => e.tag === tag);
    if (idx === -1) continue;
    if (tag === 'a' && media) {
      blocks.push({ kind: 'image', start: media.start, end: at, src: media.href, alt: media.alt.replace(/^Bild:?/, '').trim(), runs: [] });
      media = null;
      stack.splice(idx);
      continue;
    }
    if (BLOCK.has(tag)) flush();
    stack.splice(idx);
  }
  flush();
  return { text, blocks };
}
