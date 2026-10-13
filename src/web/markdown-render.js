import { esc } from './render.js';

/**
 * Markdown einer Notiz als HTML für die Vorschau im Cockpit.
 *
 * Bewusst klein: Überschriften, Absätze, Listen mit Checkboxen, Zitate,
 * Codeblöcke, Trennlinien und die üblichen Inline-Formate. Alles wird
 * maskiert; Links nur mit http(s), kein rohes HTML, keine Bilder. Was die
 * Vorschau nicht kann, steht als Text da, Obsidian bleibt das Werkzeug für
 * den Rest.
 *
 * `checkbox(n, line, done)` liefert das HTML für die n-te Checkbox (ab 0, in
 * derselben Zählung wie `editor.toggleTask`), z. B. ein Formular zum Abhaken.
 */
export function renderMarkdown(body, { checkbox = null } = {}) {
  const lines = String(body ?? '').split(/\r?\n/);
  const out = [];
  let para = [];
  let list = null; // 'ul' | 'ol'
  let quote = [];
  let n = -1;

  const flushPara = () => {
    if (para.length) out.push(`<p>${para.map(inlineMd).join('<br>')}</p>`);
    para = [];
  };
  const flushList = () => {
    if (list) out.push(`</${list}>`);
    list = null;
  };
  const flushQuote = () => {
    if (quote.length) out.push(`<blockquote>${quote.map(inlineMd).join('<br>')}</blockquote>`);
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
      out.push(`<h${level}>${inlineMd(heading[2])}</h${level}>`);
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush();
      out.push('<hr>');
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
        out.push(`<li class="todo${done ? ' done' : ''}${depth ? ` d${depth}` : ''}">${control}<span>${inlineMd(box[2])}</span></li>`);
      } else {
        out.push(`<li${depth ? ` class="d${depth}"` : ''}>${inlineMd(item[3])}</li>`);
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

const SAFE_URL = /^https?:\/\/[^\s"'<>]+$/i;

/** Inline-Formate: Code, fett, kursiv, Links, Wikilinks, nackte URLs, #tags. */
export function inlineMd(text) {
  const slots = [];
  const keep = (html) => `\u0000${slots.push(html) - 1}\u0000`;
  let s = String(text ?? '');
  s = s.replace(/`([^`]+)`/g, (_, c) => keep(`<code>${esc(c)}</code>`));
  s = s.replace(/!?\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, target, label) => keep(`<span class="wikilink" title="${esc(target)}">${esc(label ?? target)}</span>`));
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label, url) =>
    SAFE_URL.test(url) ? keep(`<a href="${esc(url)}" rel="noopener noreferrer" target="_blank">${esc(label)}</a>`) : keep(esc(label)),
  );
  s = s.replace(/https?:\/\/[^\s<>"')\]]+/g, (url) => keep(`<a href="${esc(url)}" rel="noopener noreferrer" target="_blank">${esc(url)}</a>`));
  s = esc(s)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
    .replace(/(^|\s)_([^_\s][^_]*)_(?=\s|$|[.,;:!?])/g, '$1<em>$2</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>')
    .replace(/(^|\s)#([\p{L}\p{N}_/-]+)/gu, '$1<span class="tag">#$2</span>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => slots[Number(i)]);
}
