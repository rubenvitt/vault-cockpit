import { esc } from './render.js';

/**
 * Markdown einer Notiz als HTML für die Vorschau im Cockpit.
 *
 * Bewusst klein: Überschriften (mit Anker), Absätze, Listen mit Checkboxen,
 * Zitate und Obsidian-Callouts (`> [!note] Titel`, mit `+`/`-` aufklappbar),
 * Tabellen, Codeblöcke, Trennlinien und die üblichen Inline-Formate. Alles
 * wird maskiert; Links nach außen nur mit http(s), kein rohes HTML. Was die
 * Vorschau nicht kann, steht als Text da, Obsidian bleibt das Werkzeug für
 * den Rest.
 *
 * `checkbox(n, line, done)` liefert das HTML für die n-te Checkbox (ab 0, in
 * derselben Zählung wie `editor.toggleTask`), z. B. ein Formular zum Abhaken.
 *
 * `links` löst Verweise auf (siehe `createLinkResolver` in
 * `src/cockpit/note-links.js`): Wikilinks werden Links auf `/notiz?pfad=…`
 * oder, wenn das Ziel fehlt, sichtbar als „fehlt“ markiert; Bilder kommen über
 * `/notiz/bild?pfad=…`. Ohne `links` bleiben Wikilinks Text, Bilder entfallen.
 */
export function renderMarkdown(body, { checkbox = null, links = null, ids = new Map() } = {}) {
  const lines = String(body ?? '').split(/\r?\n/);
  const out = [];
  let para = [];
  let list = null; // 'ul' | 'ol'
  let quote = [];
  let n = -1;
  const inline = (s) => inlineMd(s, links);

  const flushPara = () => {
    if (para.length) out.push(`<p>${para.map(inline).join('<br>')}</p>`);
    para = [];
  };
  const flushList = () => {
    if (list) out.push(`</${list}>`);
    list = null;
  };
  const flushQuote = () => {
    if (quote.length) out.push(callout(quote, { links, ids }) ?? `<blockquote>${quote.map(inline).join('<br>')}</blockquote>`);
    quote = [];
  };
  const flush = () => {
    flushPara();
    flushList();
    flushQuote();
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const fence = /^\s*(```|~~~)\s*([\w+-]*)/.exec(line);
    if (fence) {
      flush();
      const code = [];
      for (i += 1; i < lines.length && !lines[i].trim().startsWith(fence[1]); i += 1) code.push(lines[i]);
      out.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`);
      continue;
    }
    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      flush();
      // Die Seite hat schon eine h1; Überschriften der Notiz rutschen eine Ebene tiefer.
      const level = Math.min(heading[1].length + 1, 6);
      out.push(`<h${level} id="${esc(uniqueId(heading[2], ids))}">${inline(heading[2])}</h${level}>`);
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush();
      out.push('<hr>');
      continue;
    }
    if (line.includes('|') && i + 1 < lines.length && TABLE_RULE.test(lines[i + 1]) && lines[i + 1].includes('|')) {
      flush();
      const rows = [line];
      const rule = lines[i + 1];
      for (i += 2; i < lines.length && lines[i].includes('|') && lines[i].trim(); i += 1) rows.push(lines[i]);
      i -= 1;
      out.push(table(rows, rule, links));
      continue;
    }
    const item = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (item) {
      flushPara();
      flushQuote();
      const kind = /\d/.test(item[2]) ? 'ol' : 'ul';
      if (list !== kind) {
        flushList();
        out.push(`<${kind}>`);
        list = kind;
      }
      const depth = Math.min(Math.floor(item[1].replace(/\t/g, '  ').length / 2), 4);
      const box = /^\[([ xX])\]\s?(.*)$/.exec(item[3]);
      if (box && kind === 'ul') {
        n += 1;
        const done = box[1] !== ' ';
        const control = checkbox ? checkbox(n, line, done) : `<span class="box">${done ? '☑' : '☐'}</span>`;
        out.push(`<li class="todo${done ? ' done' : ''}${depth ? ` d${depth}` : ''}">${control}<span>${inline(box[2])}</span></li>`);
      } else {
        out.push(`<li${depth ? ` class="d${depth}"` : ''}>${inline(item[3])}</li>`);
      }
      continue;
    }
    const q = /^\s*>\s?(.*)$/.exec(line);
    if (q) {
      flushPara();
      flushList();
      quote.push(q[1]);
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    flushList();
    flushQuote();
    para.push(line.trim());
  }
  flush();
  return out.join('\n');
}

/** Anker einer Überschrift, gleich für `<h… id>` und `[[Notiz#Überschrift]]`. */
export function headingId(text) {
  const plain = String(text ?? '')
    .replace(/!?\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
    .replace(/!?\[\[([^\]]+)\]\]/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s+/g, '-');
  return `h-${plain || 'abschnitt'}`;
}

/** Wie `headingId`, gleiche Überschriften bekommen `-2`, `-3` … */
function uniqueId(text, ids) {
  const id = headingId(text);
  const seen = ids.get(id) ?? 0;
  ids.set(id, seen + 1);
  return seen ? `${id}-${seen + 1}` : id;
}

const TABLE_RULE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

/** Zellen einer Tabellenzeile; `|` in Code und Wikilinks trennt nicht, `\|` ist ein Strich. */
function cells(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const out = [];
  let cur = '';
  let code = false;
  let wiki = 0;
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (c === '\\' && s[i + 1] === '|') {
      cur += '|';
      i += 1;
    } else if (c === '`') {
      code = !code;
      cur += c;
    } else if (!code && c === '[' && s[i + 1] === '[') {
      wiki += 1;
      cur += '[[';
      i += 1;
    } else if (!code && wiki && c === ']' && s[i + 1] === ']') {
      wiki -= 1;
      cur += ']]';
      i += 1;
    } else if (c === '|' && !code && !wiki) {
      out.push(cur.trim());
      cur = '';
    } else cur += c;
  }
  out.push(cur.trim());
  return out;
}

function table(rows, rule, links) {
  const align = cells(rule).map((c) => (c.startsWith(':') && c.endsWith(':') ? 'al-c' : c.endsWith(':') ? 'al-r' : null));
  const [headRow, ...bodyRows] = rows.map(cells);
  const width = headRow.length;
  const cell = (tag, text, i) => `<${tag}${align[i] ? ` class="${align[i]}"` : ''}>${inlineMd(text ?? '', links)}</${tag}>`;
  const row = (tag, r) => `<tr>${Array.from({ length: width }, (_, i) => cell(tag, r[i], i)).join('')}</tr>`;
  return `<div class="table-wrap"><table><thead>${row('th', headRow)}</thead>${bodyRows.length ? `<tbody>${bodyRows.map((r) => row('td', r)).join('')}</tbody>` : ''}</table></div>`;
}

/** Obsidian-Callouts nach Art, gruppiert zu wenigen Farben. */
const CALLOUT = {
  note: ['info', 'Notiz'], info: ['info', 'Info'], todo: ['info', 'Aufgabe'], abstract: ['info', 'Zusammenfassung'], summary: ['info', 'Zusammenfassung'], tldr: ['info', 'Zusammenfassung'],
  tip: ['ok', 'Tipp'], hint: ['ok', 'Tipp'], important: ['ok', 'Wichtig'], success: ['ok', 'Erledigt'], check: ['ok', 'Erledigt'], done: ['ok', 'Erledigt'],
  question: ['warn', 'Frage'], help: ['warn', 'Frage'], faq: ['warn', 'Frage'], warning: ['warn', 'Warnung'], caution: ['warn', 'Vorsicht'], attention: ['warn', 'Achtung'],
  failure: ['bad', 'Fehlgeschlagen'], fail: ['bad', 'Fehlgeschlagen'], missing: ['bad', 'Fehlt'], danger: ['bad', 'Gefahr'], error: ['bad', 'Fehler'], bug: ['bad', 'Bug'],
  example: ['plain', 'Beispiel'], quote: ['plain', 'Zitat'], cite: ['plain', 'Zitat'],
};

/**
 * Zitat, das mit `[!art]` beginnt, als Callout; sonst null. Der Inhalt wird
 * wie eine kleine Notiz gerendert, Checkboxen darin bleiben Anzeige (der
 * Editor zählt sie nicht mit).
 */
function callout(quote, { links, ids }) {
  const m = /^\[!([\w-]+)\]([+-]?)\s*(.*)$/.exec(quote[0].trim());
  if (!m) return null;
  const type = m[1].toLowerCase();
  const [family, label] = CALLOUT[type] ?? ['info', type.charAt(0).toUpperCase() + type.slice(1)];
  const title = m[3] ? inlineMd(m[3], links) : esc(label);
  const inner = renderMarkdown(quote.slice(1).join('\n'), { links, ids });
  const cls = `callout callout-${family}`;
  if (m[2]) return `<details class="${cls}" data-callout="${esc(type)}"${m[2] === '+' ? ' open' : ''}><summary class="callout-title">${title}</summary>${inner ? `<div class="callout-body">${inner}</div>` : ''}</details>`;
  return `<div class="${cls}" data-callout="${esc(type)}"><p class="callout-title">${title}</p>${inner ? `<div class="callout-body">${inner}</div>` : ''}</div>`;
}

const SAFE_URL = /^https?:\/\/[^\s"'<>]+$/i;
const noteHref = (path, anchor) => `/notiz?pfad=${encodeURIComponent(path)}${anchor ? `#${headingId(anchor)}` : ''}`;
const imageHref = (path) => `/notiz/bild?pfad=${encodeURIComponent(path)}`;
const missing = (text, title) => `<span class="wikilink missing" title="${esc(title)}">${esc(text)}<span class="missing-mark"> (fehlt)</span></span>`;

/** `[[Ziel#Überschrift|Anzeige]]` bzw. `![[…]]` mit Auflöser. */
function wikilink(inner, label, embed, links) {
  if (!links) return `<span class="wikilink" title="${esc(inner)}">${esc(label ?? inner)}</span>`;
  const cut = inner.search(/[#^]/);
  // `\|` trennt in Tabellen die Anzeige ab; außerhalb bleibt der Rückstrich am Ziel hängen.
  const target = (cut >= 0 ? inner.slice(0, cut) : inner).trim().replace(/\\$/, '');
  const anchor = cut >= 0 && inner[cut] === '#' ? inner.slice(cut + 1).split('^')[0].trim() || null : null;
  const r = links.wikilink(target, { embed });
  if (r?.kind === 'image') {
    const size = /^(\d{1,4})(?:x(\d{1,4}))?$/.exec(label ?? '');
    const alt = size || !label ? target.split('/').pop() : label;
    const img = `<img src="${esc(imageHref(r.path))}" alt="${esc(alt)}" loading="lazy"${size ? ` width="${size[1]}"${size[2] ? ` height="${size[2]}"` : ''}` : ''}>`;
    return embed ? img : `<a href="${esc(imageHref(r.path))}" class="wikilink">${esc(label ?? target)}</a>`;
  }
  const text = label ?? (target ? (anchor ? `${target} › ${anchor}` : target) : (anchor ?? inner));
  if (r?.kind === 'file') return `<span class="wikilink file" title="Nur in Obsidian">${esc(text)}</span>`;
  if (r?.kind !== 'note') return missing(text, `Fehlt: ${target}`);
  const href = r.self ? (anchor ? `#${headingId(anchor)}` : '#') : noteHref(r.path, anchor);
  return `<a href="${esc(href)}" class="wikilink${embed ? ' embed' : ''}" title="${esc(r.path)}">${embed ? '↪ ' : ''}${esc(text)}</a>`;
}

/** `![Alt](bild.png)`: Bilder aus dem Vault; fremde Bilder lädt die Vorschau nicht, sie werden ein Link. */
function markdownImage(alt, url, links) {
  if (SAFE_URL.test(url)) return `<a href="${esc(url)}" rel="noopener noreferrer" target="_blank">Bild: ${esc(alt || url)}</a>`;
  const r = links?.image(url);
  if (r) return `<img src="${esc(imageHref(r.path))}" alt="${esc(alt)}" loading="lazy">`;
  return missing(`Bild: ${alt || url}`, `Fehlt: ${url}`);
}

/** Inline-Formate: Code, fett, kursiv, Bilder, Links, Wikilinks, nackte URLs, #tags. */
export function inlineMd(text, links = null) {
  const slots = [];
  const keep = (html) => `\u0000${slots.push(html) - 1}\u0000`;
  let s = String(text ?? '');
  s = s.replace(/`([^`]+)`/g, (_, c) => keep(`<code>${esc(c)}</code>`));
  s = s.replace(/(!?)\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, bang, target, label) => keep(wikilink(target, label, bang === '!', links)));
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_, alt, url) => keep(markdownImage(alt, url, links)));
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label, url) => {
    if (SAFE_URL.test(url)) return keep(`<a href="${esc(url)}" rel="noopener noreferrer" target="_blank">${esc(label)}</a>`);
    const r = links?.markdownLink(url);
    if (r) return keep(`<a href="${esc(r.self ? (r.anchor ? `#${headingId(r.anchor)}` : '#') : noteHref(r.path, r.anchor))}" class="wikilink" title="${esc(r.path)}">${esc(label)}</a>`);
    return keep(esc(label));
  });
  s = s.replace(/https?:\/\/[^\s<>"')\]]+/g, (url) => keep(`<a href="${esc(url)}" rel="noopener noreferrer" target="_blank">${esc(url)}</a>`));
  s = esc(s)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
    .replace(/(^|\s)_([^_\s][^_]*)_(?=\s|$|[.,;:!?])/g, '$1<em>$2</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>')
    .replace(/==([^=]+)==/g, '<mark>$1</mark>')
    .replace(/(^|\s)#([\p{L}\p{N}_/-]+)/gu, '$1<span class="tag">#$2</span>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => slots[Number(i)]);
}
