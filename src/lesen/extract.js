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
    canonical_url: canonical && canonical !== url && /^https?:/.test(canonical) ? canonical : null,
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
