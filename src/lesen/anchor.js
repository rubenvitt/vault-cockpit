import { esc } from '../web/layout.js';

/**
 * Textanker für Markierungen (VCP-71). Eine Markierung merkt sich ihr Zitat,
 * ein Stück Text davor und danach (`prefix`, `suffix`) und die ungefähre Stelle
 * (`start_hint`, Zeichen im Lesetext). Nach erneutem Holen oder Umformatieren
 * des Artikels findet `findAnchor` sie über das Zitat wieder; Leerraum zählt
 * dabei nicht, Präfix und Suffix entscheiden zwischen gleichen Zitaten, die
 * alte Stelle nur bei Gleichstand.
 *
 * Lesetext heißt hier: die Textstücke von `content_html` aneinandergereiht,
 * also dasselbe wie `textContent` des Lesetext-Elements im Browser. Die Leseansicht
 * (static/lesen-doc.js) rechnet ihre Anker in genau diesen Zeichen.
 */

/** So viele Zeichen Umgebung nimmt ein neuer Anker mit. */
export const CONTEXT = 32;

/** Text ohne Leerraum, dazu je Zeichen die Stelle im Original. */
function compact(s) {
  let out = '';
  const map = [];
  for (let i = 0; i < s.length; i++) {
    if (/\s/.test(s[i])) continue;
    out += s[i];
    map.push(i);
  }
  return { s: out, map };
}

const sameTail = (a, b) => {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
  return n;
};
const sameHead = (a, b) => {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
};

/**
 * Sucht den Anker `{ quote, prefix, suffix, start_hint }` in `text`. Liefert
 * `{ start, end }` (Zeichen in `text`) oder `null`, wenn das Zitat fehlt.
 * `compacted` spart bei vielen Ankern im selben Text das Neuberechnen.
 */
// shortcut: nur exakte Zitate (bis auf Leerraum), kein unscharfes Suchen; erst nachrüsten, wenn umformulierte Artikel Markierungen verlieren.
export function findAnchor(text, { quote, prefix = '', suffix = '', start_hint: hint = null }, compacted = compact(String(text ?? ''))) {
  const q = compact(String(quote ?? '')).s;
  if (!q) return null;
  const pre = compact(String(prefix ?? '')).s;
  const suf = compact(String(suffix ?? '')).s;
  const { s, map } = compacted;
  let best = null;
  for (let i = s.indexOf(q); i !== -1; i = s.indexOf(q, i + 1)) {
    const score = sameTail(s.slice(Math.max(0, i - pre.length), i), pre) + sameHead(s.slice(i + q.length, i + q.length + suf.length), suf);
    const distance = Number.isFinite(hint) ? Math.abs(map[i] - hint) : 0;
    if (!best || score > best.score || (score === best.score && distance < best.distance)) best = { score, distance, start: map[i], end: map[i + q.length - 1] + 1 };
  }
  return best && { start: best.start, end: best.end };
}

/** Anker für die Stelle `start..end` in `text`, so wie ihn der Browser bildet. */
export const anchorAt = (text, start, end) => ({
  quote: text.slice(start, end),
  prefix: text.slice(Math.max(0, start - CONTEXT), start),
  suffix: text.slice(end, end + CONTEXT),
  start_hint: start,
});

// `content_html` kommt aus `sanitizeHtml`: Text ist mit `esc` maskiert, Tags enthalten kein rohes `>`.
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'", nbsp: ' ' };
const decode = (s) => s.replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (_, e) => ENTITIES[e]);

/** Lesetext von gesäubertem HTML, wie `textContent` im Browser. */
export const htmlText = (html) => decode(String(html ?? '').split(/<[^>]*>/).join(''));

const WEITER = '<span id="weiter" class="lesen-weiter"></span>';

/**
 * Setzt Markierungen als `<mark>` in gesäubertes HTML und die Sprungmarke
 * `#weiter` an die Lesestelle `weiter` (Zeichen im Lesetext, ohne Angabe der
 * Anfang). Umschlossen werden nur Textstücke, Tags bleiben, wie sie sind; jedes
 * Stück wird neu maskiert. Die erste `<mark>` einer Markierung trägt
 * `id="h-<id>"`, alle `data-hl="<id>"`.
 *
 * Liefert `{ html, orphans }`; `orphans` sind Markierungen, deren Zitat nicht
 * mehr im Text steht.
 */
export function markHighlights(html, highlights = [], { weiter = null } = {}) {
  const parts = String(html ?? '').split(/(<[^>]*>)/);
  const segs = [];
  let text = '';
  for (let i = 0; i < parts.length; i += 2) {
    const raw = decode(parts[i]);
    segs.push({ i, start: text.length, end: text.length + raw.length });
    text += raw;
  }
  const compacted = compact(text);
  const ranges = [];
  const orphans = [];
  for (const h of highlights) {
    const r = findAnchor(text, h, compacted);
    if (r) ranges.push({ ...r, h, opened: false });
    else orphans.push(h);
  }
  ranges.sort((a, b) => a.start - b.start);
  // Überlappungen kürzen: Jedes Zeichen gehört höchstens einer Markierung.
  // shortcut: Eine Markierung ganz innerhalb einer anderen verschwindet aus dem Text (bleibt in der Seitenleiste); verschachteln, wenn das stört.
  let edge = 0;
  for (const r of ranges) {
    r.start = Math.max(r.start, edge);
    edge = Math.max(edge, r.end);
  }
  const live = ranges.filter((r) => r.end > r.start);
  // Erst am nächsten sichtbaren Zeichen: Leerraum zwischen Blöcken ist kein Platz für die Sprungmarke.
  const from = Number.isInteger(weiter) && weiter > 0 ? weiter : 0;
  const at = from + text.slice(from).search(/\S|$/);
  let placed = false;

  for (const seg of segs) {
    if (seg.end === seg.start) continue;
    const hereWeiter = !placed && at >= seg.start && at < seg.end;
    const hits = live.filter((r) => r.start < seg.end && r.end > seg.start);
    if (!hereWeiter && !hits.length) continue;
    const cuts = new Set([seg.start, seg.end, ...(hereWeiter ? [at] : [])]);
    for (const r of hits) cuts.add(Math.max(r.start, seg.start)).add(Math.min(r.end, seg.end));
    const points = [...cuts].sort((a, b) => a - b);
    let out = '';
    for (let k = 0; k < points.length - 1; k++) {
      const [a, b] = [points[k], points[k + 1]];
      if (hereWeiter && a === at) {
        out += WEITER;
        placed = true;
      }
      const piece = text.slice(a, b);
      const r = hits.find((x) => x.start <= a && x.end >= b);
      // Reiner Leerraum bleibt draußen: zwischen Tabellenzeilen oder Listenpunkten wäre <mark> fehl am Platz.
      if (!r || !piece.trim()) {
        out += esc(piece);
        continue;
      }
      const id = esc(r.h.id);
      const first = r.opened ? '' : ` id="h-${id}"`;
      r.opened = true;
      out += `<mark${first} class="hl${r.h.note ? ' has-note' : ''}" data-hl="${id}"${r.h.note ? ` title="${esc(r.h.note)}"` : ''}>${esc(piece)}</mark>`;
    }
    parts[seg.i] = out;
  }
  return { html: (placed ? '' : WEITER) + parts.join(''), orphans };
}
