import { esc } from './render.js';

/**
 * Markdown einer Notiz für die Vorschau im Cockpit, in zwei Schritten:
 * `parseMarkdown` liest den Text als Baum aus Blöcken und Inline-Teilen
 * (`/api/notiz` liefert ihn so an die iOS-App), `renderMarkdown` macht daraus
 * HTML für die Notizseite. Beide sehen also genau dasselbe.
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
  return renderBlocks(parseMarkdown(body, { links, ids }), { checkbox });
}

/**
 * Der Baum einer Notiz: eine Liste von Blöcken (JSON-tauglich).
 *
 * - `{ type: 'heading', level, id, content }`: `level` wie im Markdown (1–6), `id` der Anker
 * - `{ type: 'paragraph', content }`: Zeilen getrennt durch `{ type: 'break' }`
 * - `{ type: 'image', … }` / `{ type: 'embed', link, children? }`: ein Absatz, der nur aus
 *   einem eingebetteten Bild (`![[bild.png]]`) bzw. einer eingebetteten Notiz
 *   oder Datei (`![[Notiz]]`) besteht; `children` sind die Blöcke der
 *   eingebetteten Notiz, wenn das Cockpit sie zeigen darf
 * - `{ type: 'list', ordered, items: [{ depth, task, content }] }`: `task` ist
 *   null oder `{ done, n, line }`, `n` und `line` (getrimmt) sind genau die
 *   Felder für `/aktion/notiz/checkbox`; in Callouts null (nur Anzeige)
 * - `{ type: 'quote', content }`
 * - `{ type: 'callout', kind, family, label, title, foldable, open, children }`
 * - `{ type: 'table', align, head, rows }`: `align` je Spalte `center`, `right`
 *   oder null, Zellen sind Inline-Listen, alle Zeilen so breit wie der Kopf
 * - `{ type: 'code', lang, text }`, `{ type: 'rule' }`
 *
 * Inline-Teile siehe `parseInline`. `ids` sammelt die Anker über die ganze
 * Notiz (gleiche Überschriften bekommen `-2`, `-3` …).
 */
export function parseMarkdown(body, { links = null, ids = new Map(), checkboxes = true, prefix = '' } = {}) {
  const lines = String(body ?? '').split(/\r?\n/);
  const out = [];
  let para = [];
  let list = null;
  let quote = [];
  let n = -1;
  const inline = (s) => parseInline(s, links);

  const flushPara = () => {
    if (para.length) out.push(media({ type: 'paragraph', content: joinLines(para.map(inline)) }, links, ids, prefix));
    para = [];
  };
  const flushList = () => {
    if (list) out.push(list);
    list = null;
  };
  const flushQuote = () => {
    if (quote.length) out.push(parseCallout(quote, { links, ids, prefix }) ?? { type: 'quote', content: joinLines(quote.map(inline)) });
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
      out.push({ type: 'code', lang: fence[2] || null, text: code.join('\n') });
      continue;
    }
    // Wie Obsidian: HTML-Kommentare nicht zeigen (etwa die Marker generierter Bereiche).
    // shortcut: nur einzeilige Kommentare; mehrzeilige erst, wenn sie im Vault vorkommen.
    if (/^\s*<!--.*-->\s*$/.test(line)) continue;
    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      flush();
      out.push({ type: 'heading', level: heading[1].length, id: prefix + uniqueId(heading[2], ids), content: inline(heading[2]) });
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush();
      out.push({ type: 'rule' });
      continue;
    }
    if (line.includes('|') && i + 1 < lines.length && TABLE_RULE.test(lines[i + 1]) && lines[i + 1].includes('|')) {
      flush();
      const rows = [line];
      const rule = lines[i + 1];
      for (i += 2; i < lines.length && lines[i].includes('|') && lines[i].trim(); i += 1) rows.push(lines[i]);
      i -= 1;
      out.push(parseTable(rows, rule, links));
      continue;
    }
    const item = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (item) {
      flushPara();
      flushQuote();
      const ordered = /\d/.test(item[2]);
      if (list?.ordered !== ordered) {
        flushList();
        list = { type: 'list', ordered, items: [] };
      }
      const depth = Math.min(Math.floor(item[1].replace(/\t/g, '  ').length / 2), 4);
      const box = /^\[([ xX])\]\s?(.*)$/.exec(item[3]);
      if (box && !ordered) {
        n += 1;
        const done = box[1] !== ' ';
        list.items.push({ depth, task: checkboxes ? { done, n, line: line.trim() } : { done, n: null, line: null }, content: inline(box[2]) });
      } else {
        list.items.push({ depth, task: null, content: inline(item[3]) });
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
  return out;
}

/** Zähler der Einbettungen in `ids`; kein Anker beginnt so. */
const EMBEDS = '\0embeds';

/** Zeilen eines Absatzes oder Zitats: Inline-Teile mit `break` dazwischen. */
const joinLines = (rows) => rows.flatMap((r, i) => (i ? [{ type: 'break' }, ...r] : r));

/**
 * Ein Absatz aus nur einem eingebetteten Bild oder einer eingebetteten Notiz
 * wird ein eigener Block. Eine eingebettete Notiz bringt ihren Inhalt als
 * `children` mit, wenn der Auflöser ihn hergibt (`links.embed`, VCP-63);
 * Checkboxen darin sind nur Anzeige, abgehakt wird in der Notiz selbst.
 */
function media(block, links = null, ids = new Map(), prefix = '') {
  const [only, ...rest] = block.content;
  if (!only || rest.length) return block;
  if (only.type === 'image') return only;
  if (only.type === 'wikilink' && only.embed) {
    const inner = only.status === 'note' && !only.self ? links?.embed?.(only.path, only.heading) : null;
    if (!inner) return { type: 'embed', link: only };
    // Eigene Anker je Einbettung (`e1-h-…`), damit `#Überschrift` der Notiz selbst ihr Ziel behält.
    const n = (ids.get(EMBEDS) ?? 0) + 1;
    ids.set(EMBEDS, n);
    return { type: 'embed', link: only, children: parseMarkdown(inner.body, { links: inner.links, ids: new Map(), prefix: `${prefix}e${n}-`, checkboxes: false }) };
  }
  return block;
}

/** HTML aus dem Baum von `parseMarkdown`; `checkbox` wie bei `renderMarkdown`. */
export function renderBlocks(blocks, { checkbox = null } = {}) {
  return blocks.map((b) => blockHtml(b, checkbox)).join('\n');
}

function blockHtml(b, checkbox) {
  switch (b.type) {
    case 'heading': {
      // Die Seite hat schon eine h1; Überschriften der Notiz rutschen eine Ebene tiefer.
      const level = Math.min(b.level + 1, 6);
      return `<h${level} id="${esc(b.id)}">${renderInline(b.content)}</h${level}>`;
    }
    case 'paragraph':
      return `<p>${renderInline(b.content)}</p>`;
    case 'image':
      return `<p>${inlineHtml(b)}</p>`;
    case 'embed':
      if (b.children) return `<div class="note-embed"><p class="note-embed-head">${inlineHtml(b.link)}</p>${b.children.length ? renderBlocks(b.children) : '<p class="empty">Leer.</p>'}</div>`;
      return `<p>${inlineHtml(b.link)}</p>`;
    case 'list': {
      const tag = b.ordered ? 'ol' : 'ul';
      return [`<${tag}>`, ...b.items.map((item) => itemHtml(item, checkbox)), `</${tag}>`].join('\n');
    }
    case 'quote':
      return `<blockquote>${renderInline(b.content)}</blockquote>`;
    case 'callout':
      return calloutHtml(b);
    case 'table':
      return tableHtml(b);
    case 'code':
      return `<pre><code>${esc(b.text)}</code></pre>`;
    case 'rule':
      return '<hr>';
    default:
      return '';
  }
}

function itemHtml({ depth, task, content }, checkbox) {
  if (!task) return `<li${depth ? ` class="d${depth}"` : ''}>${renderInline(content)}</li>`;
  const { done, n, line } = task;
  const control = checkbox && n != null ? checkbox(n, line, done) : `<span class="box">${done ? '☑' : '☐'}</span>`;
  return `<li class="todo${done ? ' done' : ''}${depth ? ` d${depth}` : ''}">${control}<span>${renderInline(content)}</span></li>`;
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

function parseTable(rows, rule, links) {
  const align = cells(rule).map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : null));
  const [headRow, ...bodyRows] = rows.map(cells);
  const width = headRow.length;
  const row = (r) => Array.from({ length: width }, (_, i) => parseInline(r[i] ?? '', links));
  return { type: 'table', align: Array.from({ length: width }, (_, i) => align[i] ?? null), head: row(headRow), rows: bodyRows.map(row) };
}

const ALIGN_CLASS = { center: 'al-c', right: 'al-r' };

function tableHtml({ align, head, rows }) {
  const cell = (tag, content, i) => `<${tag}${align[i] ? ` class="${ALIGN_CLASS[align[i]]}"` : ''}>${renderInline(content)}</${tag}>`;
  const row = (tag, r) => `<tr>${r.map((c, i) => cell(tag, c, i)).join('')}</tr>`;
  return `<div class="table-wrap"><table><thead>${row('th', head)}</thead>${rows.length ? `<tbody>${rows.map((r) => row('td', r)).join('')}</tbody>` : ''}</table></div>`;
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
 * wie eine kleine Notiz gelesen, Checkboxen darin bleiben Anzeige (der
 * Editor zählt sie nicht mit). `family` ist die Farbe (info, ok, warn, bad,
 * plain), `label` der Standardtitel der Art; ohne eigenen Titel ist `title`
 * genau dieser. `foldable` mit `+`/`-`, `open` ist dann der Anfangszustand.
 */
function parseCallout(quote, { links, ids, prefix = '' }) {
  const m = /^\[!([\w-]+)\]([+-]?)\s*(.*)$/.exec(quote[0].trim());
  if (!m) return null;
  const kind = m[1].toLowerCase();
  const [family, label] = CALLOUT[kind] ?? ['info', kind.charAt(0).toUpperCase() + kind.slice(1)];
  const title = m[3] ? parseInline(m[3], links) : [{ type: 'text', text: label }];
  const children = parseMarkdown(quote.slice(1).join('\n'), { links, ids, prefix, checkboxes: false });
  return { type: 'callout', kind, family, label, title, foldable: Boolean(m[2]), open: m[2] !== '-', children };
}

function calloutHtml(b) {
  const title = renderInline(b.title);
  const inner = renderBlocks(b.children);
  const cls = `callout callout-${b.family}`;
  if (b.foldable) return `<details class="${cls}" data-callout="${esc(b.kind)}"${b.open ? ' open' : ''}><summary class="callout-title">${title}</summary>${inner ? `<div class="callout-body">${inner}</div>` : ''}</details>`;
  return `<div class="${cls}" data-callout="${esc(b.kind)}"><p class="callout-title">${title}</p>${inner ? `<div class="callout-body">${inner}</div>` : ''}</div>`;
}

const SAFE_URL = /^https?:\/\/[^\s"'<>]+$/i;
/** Adresse der Notizseite, mit Anker-Id (`h-…`) als Sprungmarke. */
export const noteHref = (path, anchorId = null) => `/notiz?pfad=${encodeURIComponent(path)}${anchorId ? `#${anchorId}` : ''}`;
/** Adresse eines Bildes aus dem Vault (`/notiz/bild`, auch mit Geräte-Token). */
export const imageHref = (path) => `/notiz/bild?pfad=${encodeURIComponent(path)}`;

/**
 * `[[Ziel#Überschrift|Anzeige]]` bzw. `![[…]]` mit Auflöser als Inline-Teil
 * `{ type: 'wikilink', status, text, target, heading, alias, embed, path, self, anchor }`.
 * `text` ist, was angezeigt wird; `status`: `note` (Notiz unter `path`, `self`
 * für die eigene, `anchor` die Anker-Id der Überschrift), `image` (Link auf ein
 * Bild, `path` und `src`), `file` (Anhang, nur in Obsidian), `missing` (fehlt
 * oder darf nicht gezeigt werden), `plain` (ohne Auflöser). Ein eingebettetes
 * Bild wird gleich `{ type: 'image', path, src, alt, width, height }`.
 */
function wikilink(inner, label, embed, links) {
  const base = { type: 'wikilink', target: inner, heading: null, alias: label ?? null, embed, path: null, self: false, anchor: null };
  if (!links) return { ...base, status: 'plain', text: label ?? inner };
  const cut = inner.search(/[#^]/);
  // `\|` trennt in Tabellen die Anzeige ab; außerhalb bleibt der Rückstrich am Ziel hängen.
  const target = (cut >= 0 ? inner.slice(0, cut) : inner).trim().replace(/\\$/, '');
  const heading = cut >= 0 && inner[cut] === '#' ? inner.slice(cut + 1).split('^')[0].trim() || null : null;
  const r = links.wikilink(target, { embed });
  if (r?.kind === 'image') {
    const size = /^(\d{1,4})(?:x(\d{1,4}))?$/.exec(label ?? '');
    const alt = size || !label ? target.split('/').pop() : label;
    if (embed) return { type: 'image', path: r.path, src: imageHref(r.path), alt, width: size ? Number(size[1]) : null, height: size?.[2] ? Number(size[2]) : null };
    return { ...base, target, heading, status: 'image', text: label ?? target, path: r.path, src: imageHref(r.path) };
  }
  const text = label ?? (target ? (heading ? `${target} › ${heading}` : target) : (heading ?? inner));
  if (r?.kind === 'file') return { ...base, target, heading, status: 'file', text };
  if (r?.kind !== 'note') return { ...base, target, heading, status: 'missing', text };
  return { ...base, target, heading, status: 'note', text, path: r.path, self: Boolean(r.self), anchor: heading ? headingId(heading) : null };
}

/** `![Alt](bild.png)`: Bilder aus dem Vault; fremde Bilder lädt die Vorschau nicht, sie werden ein Link. */
function markdownImage(alt, url, links) {
  if (SAFE_URL.test(url)) return { type: 'link', url, text: `Bild: ${alt || url}` };
  const r = links?.image(url);
  if (r) return { type: 'image', path: r.path, src: imageHref(r.path), alt, width: null, height: null };
  return { type: 'wikilink', status: 'missing', text: `Bild: ${alt || url}`, target: url, heading: null, alias: null, embed: true, path: null, self: false, anchor: null };
}

/** `[Text](ziel)`: nach außen nur mit http(s), auf eine Notiz wie ein Wikilink, sonst nur der Text. */
function markdownLink(label, url, links) {
  if (SAFE_URL.test(url)) return { type: 'link', url, text: label };
  const r = links?.markdownLink(url);
  if (!r) return { type: 'text', text: label };
  const heading = r.anchor || null;
  return { type: 'wikilink', status: 'note', text: label, target: url, heading, alias: label, embed: false, path: r.path, self: Boolean(r.self), anchor: heading ? headingId(heading) : null };
}

// Platzhalter im Text: `\0n\0` für einen fertigen Teil, `\0b\0` … `\0/b\0` für Auszeichnungen.
// Für die Regeln unten verhalten sie sich wie die HTML-Tags, die früher an ihrer Stelle standen.
const MARK = { b: 'bold', i: 'italic', s: 'strike', m: 'mark' };
const PLACEHOLDER = /(\u0000(?:\d+|\/?[bism])\u0000)/;

/**
 * Inline-Formate als Liste von Teilen: `text`, `break`, `code`, `bold`,
 * `italic`, `strike`, `mark` (mit `children`), `tag` (ohne `#`), `link`
 * (`url`, `text`; nur http(s)), `url` (nackte Adresse), `wikilink` und
 * `image` (siehe `wikilink`). Code, Links und Bilder zuerst, dann fett,
 * kursiv, durchgestrichen, markiert und #tags im Rest.
 */
export function parseInline(text, links = null) {
  const slots = [];
  const keep = (node) => `\u0000${slots.push(node) - 1}\u0000`;
  let s = String(text ?? '').replace(/\u0000/g, '�');
  s = s.replace(/`([^`]+)`/g, (_, c) => keep({ type: 'code', text: c }));
  s = s.replace(/(!?)\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, bang, target, label) => keep(wikilink(target, label, bang === '!', links)));
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_, alt, url) => keep(markdownImage(alt, url, links)));
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, url) => keep(markdownLink(label, url, links)));
  s = s.replace(/https?:\/\/[^\s<>"')\]]+/g, (url) => keep({ type: 'url', url }));
  s = s
    .replace(/\*\*([^*]+)\*\*/g, '\u0000b\u0000$1\u0000/b\u0000')
    .replace(/(^|[^*\w])\*([^*\s][^*]*)\*/g, '$1\u0000i\u0000$2\u0000/i\u0000')
    .replace(/(^|\s)_([^_\s][^_]*)_(?=\s|$|[.,;:!?])/g, '$1\u0000i\u0000$2\u0000/i\u0000')
    .replace(/~~([^~]+)~~/g, '\u0000s\u0000$1\u0000/s\u0000')
    .replace(/==([^=]+)==/g, '\u0000m\u0000$1\u0000/m\u0000')
    .replace(/(^|\s)#([\p{L}\p{N}_/-]+)/gu, (_, pre, tag) => pre + keep({ type: 'tag', tag }));
  return tree(s, slots);
}

/** Platzhalter-Text → verschachtelte Teile. Überkreuzte Auszeichnungen werden wie im Browser geschlossen und neu geöffnet. */
function tree(s, slots) {
  const root = { children: [] };
  const stack = [root];
  const add = (node) => {
    const list = stack.at(-1).children;
    const last = list.at(-1);
    if (node.type === 'text') {
      if (!node.text) return;
      if (last?.type === 'text') last.text += node.text;
      else list.push({ ...node });
    } else list.push(node);
  };
  for (const part of s.split(PLACEHOLDER)) {
    const m = /^\u0000(\d+|\/?[bism])\u0000$/.exec(part);
    if (!m) add({ type: 'text', text: part });
    else if (/^\d/.test(m[1])) add(slots[Number(m[1])]);
    else if (m[1][0] !== '/') {
      const node = { type: MARK[m[1]], children: [] };
      add(node);
      stack.push(node);
    } else {
      const type = MARK[m[1][1]];
      const at = stack.findLastIndex((f, i) => i > 0 && f.type === type);
      if (at < 0) continue;
      for (const f of stack.splice(at).slice(1)) {
        const node = { type: f.type, children: [] };
        add(node);
        stack.push(node);
      }
    }
  }
  return pruned(root.children);
}

/** Ohne leere Auszeichnungen (entstehen nur beim Auflösen überkreuzter). */
const pruned = (nodes) => nodes.filter((n) => !n.children || (n.children = pruned(n.children)).length);

/** HTML aus Inline-Teilen von `parseInline`. */
export function renderInline(nodes) {
  return nodes.map(inlineHtml).join('');
}

const missing = (text, title) => `<span class="wikilink missing" title="${esc(title)}">${esc(text)}<span class="missing-mark"> (fehlt)</span></span>`;
const TAGS = { bold: 'strong', italic: 'em', strike: 'del', mark: 'mark' };

function inlineHtml(n) {
  switch (n.type) {
    case 'text':
      return esc(n.text);
    case 'break':
      return '<br>';
    case 'code':
      return `<code>${esc(n.text)}</code>`;
    case 'bold':
    case 'italic':
    case 'strike':
    case 'mark':
      return `<${TAGS[n.type]}>${renderInline(n.children)}</${TAGS[n.type]}>`;
    case 'tag':
      return `<span class="tag">#${esc(n.tag)}</span>`;
    case 'link':
      return `<a href="${esc(n.url)}" rel="noopener noreferrer" target="_blank">${esc(n.text)}</a>`;
    case 'url':
      return `<a href="${esc(n.url)}" rel="noopener noreferrer" target="_blank">${esc(n.url)}</a>`;
    case 'image':
      return `<img src="${esc(n.src)}" alt="${esc(n.alt)}" loading="lazy"${n.width ? ` width="${n.width}"${n.height ? ` height="${n.height}"` : ''}` : ''}>`;
    case 'wikilink':
      return wikilinkHtml(n);
    default:
      return '';
  }
}

function wikilinkHtml(n) {
  if (n.status === 'plain') return `<span class="wikilink" title="${esc(n.target)}">${esc(n.text)}</span>`;
  if (n.status === 'image') return `<a href="${esc(n.src)}" class="wikilink">${esc(n.text)}</a>`;
  if (n.status === 'file') return `<span class="wikilink file" title="Nur in Obsidian">${esc(n.text)}</span>`;
  if (n.status !== 'note') return missing(n.text, `Fehlt: ${n.target}`);
  const href = n.self ? (n.anchor ? `#${n.anchor}` : '#') : noteHref(n.path, n.anchor);
  return `<a href="${esc(href)}" class="wikilink${n.embed ? ' embed' : ''}" title="${esc(n.path)}">${n.embed ? '↪ ' : ''}${esc(n.text)}</a>`;
}

/** Inline-Formate als HTML: Code, fett, kursiv, Bilder, Links, Wikilinks, nackte URLs, #tags. */
export function inlineMd(text, links = null) {
  return renderInline(parseInline(text, links));
}

/** Lesbarer Text aus Inline-Teilen (Wikilinks mit ihrer Anzeige, Bilder mit Alt-Text). */
export function plainText(nodes) {
  return nodes
    .map((n) => {
      if (n.children) return plainText(n.children);
      if (n.type === 'break') return '\n';
      if (n.type === 'tag') return `#${n.tag}`;
      if (n.type === 'url') return n.url;
      if (n.type === 'image') return n.alt ?? '';
      return n.text ?? '';
    })
    .join('');
}
