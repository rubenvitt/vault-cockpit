import { parseHTML } from 'linkedom';
import { Readability } from '@mozilla/readability';
import { esc } from '../web/layout.js';

/**
 * Aus einer Webseite den Lesetext machen: Readability findet Titel, Autor und
 * Hauptinhalt, `sanitizeHtml` macht daraus HTML, das das Cockpit gefahrlos
 * ausliefern kann. Wörter pro Minute für die Lesezeit: 220.
 */

const WORDS_PER_MINUTE = 220;

// Fliegen samt Inhalt raus.
const DROP = new Set(['script', 'style', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'svg', 'math', 'form', 'template', 'base', 'link', 'meta', 'noscript', 'button', 'input', 'select', 'textarea', 'option', 'canvas', 'title', 'head', 'source', 'track', 'map', 'dialog']);
// Bleiben als Element (ohne Attribute, außer den unten erlaubten).
const KEEP = new Set(['p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'code', 'kbd', 'samp', 'var', 'em', 'strong', 'b', 'i', 'u', 's', 'del', 'ins', 'sub', 'sup', 'small', 'mark', 'q', 'cite', 'abbr', 'dfn', 'time', 'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'a', 'figure', 'figcaption', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'div', 'section', 'article', 'aside', 'details', 'summary']);
const VOID = new Set(['br', 'hr']);
// Bilder, Videos und Ton werden zu Links: Die CSP lädt nichts von fremden Servern.
const MEDIA = { img: 'Bild', video: 'Video', audio: 'Audio' };
const ATTRS = { a: ['href', 'title'], abbr: ['title'], th: ['colspan', 'rowspan'], td: ['colspan', 'rowspan'], ol: ['start'] };
const LINK_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

/** Adresse relativ zu `base` auflösen; nur http, https und mailto, sonst `null`. */
function safeUrl(value, base) {
  if (!value) return null;
  try {
    const u = new URL(String(value).trim(), base || undefined);
    return LINK_PROTOCOLS.has(u.protocol) ? u.href : null;
  } catch {
    return null;
  }
}

function attrsOf(el, tag, base) {
  let out = '';
  for (const name of ATTRS[tag] ?? []) {
    const raw = el.getAttribute(name);
    if (raw == null) continue;
    if (name === 'href') {
      const href = safeUrl(raw, base);
      if (href) out += ` href="${esc(href)}" rel="noopener noreferrer"`;
    } else if (name === 'title') out += ` title="${esc(raw)}"`;
    else if (/^\d{1,4}$/.test(raw.trim())) out += ` ${name}="${raw.trim()}"`;
  }
  return out;
}

function mediaLink(el, tag, base) {
  const src = el.getAttribute('src') ?? el.querySelector?.('source[src]')?.getAttribute('src');
  // Zählpixel (1×1, vor allem in Newslettern) fallen ganz weg, auch nicht als Link.
  if (tag === 'img' && ['width', 'height'].some((a) => /^\s*[01](?:px)?\s*$/i.test(el.getAttribute(a) ?? ''))) return '';
  const href = safeUrl(src, base);
  const label = (el.getAttribute('alt') ?? el.getAttribute('title') ?? '').trim();
  const text = `${MEDIA[tag]}${label ? `: ${label}` : ''}`;
  return href ? `<a href="${esc(href)}" rel="noopener noreferrer" class="media-link">${esc(text)}</a>` : '';
}

function walk(node, base) {
  let out = '';
  for (const child of node.childNodes ?? []) {
    if (child.nodeType === 3) {
      out += esc(child.textContent);
      continue;
    }
    if (child.nodeType !== 1) continue;
    const tag = child.localName?.toLowerCase();
    if (DROP.has(tag)) continue;
    if (MEDIA[tag]) out += mediaLink(child, tag, base);
    else if (KEEP.has(tag)) out += VOID.has(tag) ? `<${tag}>` : `<${tag}${attrsOf(child, tag, base)}>${walk(child, base)}</${tag}>`;
    // Unbekanntes (span, font, picture, …) fällt weg, der Inhalt bleibt.
    else out += walk(child, base);
  }
  return out;
}

/**
 * HTML streng nach Allowlist säubern, für Artikel, Mails und Feeds. Kein
 * Skript, kein Stil, keine Event-Attribute, keine Frames; Links nur http(s)
 * und mailto, aufgelöst gegen `baseUrl`. Bilder werden zu Links.
 */
export function sanitizeHtml(html, baseUrl = null) {
  const { document } = parseHTML(`<!doctype html><html><body>${html ?? ''}</body></html>`);
  return walk(document.body, baseUrl).trim();
}

const words = (text) => (text.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) ?? []).length;
export const readingMinutes = (wordCount) => Math.max(1, Math.round(wordCount / WORDS_PER_MINUTE));
const squash = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/**
 * `html` der Seite, `url` nach allen Weiterleitungen. Liefert die Felder für
 * `store.addDocument` (ohne Status und Herkunft).
 */
export function extractArticle(html, url) {
  const { document } = parseHTML(html);
  const canonical = safeUrl(document.querySelector('link[rel~="canonical"]')?.getAttribute('href'), url);
  const pageTitle = squash(document.querySelector('title')?.textContent);
  let article = null;
  try {
    article = new Readability(document).parse();
  } catch {
    // keine verwertbare Seite: unten mit dem Seitentitel weiter
  }
  const text = textFields(sanitizeHtml(article?.content ?? '', url));
  return {
    url,
    // Nur gleiche Herkunft: Sonst könnte eine Seite sich per Canonical über einen fremden Artikel legen.
    canonical_url: canonical && canonical !== url && new URL(canonical).origin === new URL(url).origin ? canonical : null,
    title: squash(article?.title) || pageTitle || new URL(url).hostname,
    author: squash(article?.byline) || null,
    site: squash(article?.siteName) || new URL(url).hostname.replace(/^www\./, ''),
    ...text,
    excerpt: squash(article?.excerpt).slice(0, 500) || text.excerpt,
  };
}

/**
 * Aus schon gesäubertem HTML (`sanitizeHtml`) Lesetext, Wortzahl, Lesezeit und
 * Anriss (erster Absatz) als Felder für `store.addDocument`; für Artikel,
 * Newsletter und PDFs.
 */
export function textFields(contentHtml) {
  // Blöcke durch Zeilenumbrüche trennen, sonst klebt „Titel“ an „Erster Absatz“.
  const clean = parseHTML(`<!doctype html><html><body>${contentHtml.replace(/<br>|<hr>|<\/(?:p|div|h[1-6]|li|dt|dd|blockquote|pre|tr|th|td|figcaption|caption|section|article|aside|summary)>/g, '$&\n')}</body></html>`).document;
  const contentText = clean.body.textContent.split(/\n+/).map(squash).filter(Boolean).join('\n\n');
  const wordCount = words(contentText);
  return {
    excerpt: (squash(clean.querySelector('p')?.textContent) || squash(contentText)).slice(0, 500) || null,
    content_html: contentHtml,
    content_text: contentText,
    word_count: wordCount,
    reading_minutes: wordCount ? readingMinutes(wordCount) : 0,
  };
}

// --- Lesetext als Markdown (VCP-96) ---------------------------------------------

// Blöcke im gesäuberten HTML; alles andere aus KEEP steht im Fließtext.
const MD_BLOCKS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'blockquote', 'pre', 'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'figure', 'figcaption', 'table', 'div', 'section', 'article', 'aside', 'details', 'summary']);
const MD_WRAP = { strong: '**', b: '**', em: '*', i: '*', s: '~~', del: '~~', mark: '==' };

/** Text, der in Markdown und Obsidian nichts auslöst: kein Tag, keine Formel, kein Wikilink, kein Kommentar, kein Marker. */
const escapeText = (s) => s.replace(/[\\`*_[\]<>#|~$]/g, '\\$&').replace(/==/g, '=\\=').replace(/%%/g, '%\\%').replace(/&(?=#?\w+;)/g, '\\&');

/** Zeilenanfang, der sonst eine Liste würde (`- `, `+ `, `1. `). */
const escapeLineStart = (line) => line.replace(/^([-+])(?=\s|$)/, '\\$1').replace(/^(\d+)([.)])(?=\s|$)/, '$1\\$2');

/** Leerraum außerhalb der Auszeichnung, sonst greift `**` nicht. */
function wrap(mark, s) {
  const [, lead, core, trail] = /^(\s*)([^]*?)(\s*)$/.exec(s);
  return core ? `${lead}${mark}${core}${mark}${trail}` : s;
}

/** Zaun aus `ch`, länger als jede Folge von `ch` im Text, mindestens `min`. */
const fenceFor = (text, ch, min) => ch.repeat(Math.max(min, ...[...text.matchAll(new RegExp(`\\${ch}+`, 'g'))].map((m) => m[0].length + 1)));

function inlineMd(node) {
  if (node.nodeType === 3) return escapeText(node.textContent.replace(/\s+/g, ' '));
  if (node.nodeType !== 1) return '';
  const tag = node.localName;
  const inner = () => [...node.childNodes].map(inlineMd).join('');
  if (tag === 'br') return '\n';
  if (MD_WRAP[tag]) return wrap(MD_WRAP[tag], inner());
  if (tag === 'code' || tag === 'kbd' || tag === 'samp') {
    const text = node.textContent.replace(/\s+/g, ' ');
    if (!text.trim()) return text;
    const pad = /^`|`$/.test(text) ? ' ' : '';
    const fence = fenceFor(text, '`', 1);
    return `${fence}${pad}${text}${pad}${fence}`;
  }
  if (tag === 'a') {
    const text = inner().replace(/\s+/g, ' ').trim();
    const href = node.getAttribute('href');
    if (!href) return text;
    return `[${text || escapeText(href)}](<${href.replace(/[<>\s]/g, encodeURIComponent)}>)`;
  }
  // Ein Block mitten im Fließtext (etwa ein Absatz in einem Link) wird Text.
  return MD_BLOCKS.has(tag) ? ` ${inner()} ` : inner();
}

/** Kinder als Markdown-Blöcke; Fließtext zwischen Blöcken wird ein Absatz. */
function blocksMd(node) {
  const out = [];
  let run = '';
  const flush = () => {
    const text = run.split('\n').map((l) => escapeLineStart(l.replace(/ {2,}/g, ' ').trim())).filter(Boolean).join('\n');
    if (text) out.push(text);
    run = '';
  };
  for (const child of node.childNodes) {
    if (child.nodeType === 1 && MD_BLOCKS.has(child.localName)) {
      flush();
      const block = blockMd(child);
      if (block) out.push(block);
    } else run += inlineMd(child);
  }
  flush();
  return out;
}

function listMd(el) {
  let n = Number(el.getAttribute('start')) || 1;
  return [...el.children]
    .filter((li) => li.localName === 'li')
    .map((li) => {
      const marker = el.localName === 'ol' ? `${n++}. ` : '- ';
      // Enge Liste: ein Punkt ohne Leerzeilen, Folgezeilen unter dem Text eingerückt.
      const lines = blocksMd(li).join('\n').split('\n');
      return marker + lines.map((l, i) => (i && l ? ' '.repeat(marker.length) + l : l)).join('\n');
    })
    .join('\n');
}

function tableMd(el) {
  const rows = [...el.querySelectorAll('tr')]
    .filter((tr) => tr.closest('table') === el)
    .map((tr) => [...tr.children].map((cell) => blocksMd(cell).join(' ').replace(/\n/g, ' ')));
  if (!rows.length) return '';
  const width = Math.max(...rows.map((r) => r.length));
  const line = (cells) => `| ${Array.from({ length: width }, (_, i) => cells[i] ?? '').join(' | ')} |`;
  return [line(rows[0]), line(Array(width).fill('---')), ...rows.slice(1).map(line)].join('\n');
}

function blockMd(el) {
  const tag = el.localName;
  const heading = /^h([1-6])$/.exec(tag);
  if (heading) {
    // Zwei Ebenen tiefer: Der Text steht unter „## Text“ der Lesestapel-Notiz.
    const text = inlineMd(el).replace(/\s+/g, ' ').trim();
    return text && `${'#'.repeat(Math.min(6, Number(heading[1]) + 2))} ${text}`;
  }
  if (tag === 'hr') return '---';
  if (tag === 'pre') {
    const code = el.textContent.replace(/\n$/, '');
    const fence = fenceFor(code, '`', 3);
    return `${fence}\n${code}\n${fence}`;
  }
  if (tag === 'ul' || tag === 'ol') return listMd(el);
  if (tag === 'table') return tableMd(el);
  const body = blocksMd(el).join('\n\n');
  return tag === 'blockquote' ? body.split('\n').map((l) => (l ? `> ${l}` : '>')).join('\n') : body;
}

/**
 * Gesäubertes HTML (`sanitizeHtml`) als Markdown für den Vault: Absätze,
 * Überschriften (zwei Ebenen tiefer), Listen, Zitate, Code, Links,
 * Hervorhebungen, einfache Tabellen; Bilder sind dort schon Links. Zeichen, die
 * in Markdown oder Obsidian etwas auslösen würden, sind mit `\` maskiert.
 */
export function htmlToMarkdown(html) {
  const { document } = parseHTML(`<!doctype html><html><body>${html ?? ''}</body></html>`);
  // linkedom teilt Text an Entitäten (`&amp;copy;` → „&“ + „copy;“); zusammengefügt greift das Maskieren.
  document.body.normalize();
  return blocksMd(document.body).join('\n\n').trim();
}
