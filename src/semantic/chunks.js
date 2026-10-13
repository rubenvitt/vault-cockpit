import { createHash } from 'node:crypto';
import { parseNote } from '../vault/markdown.js';

/**
 * Zerlegt eine Notiz in Abschnitte für Embeddings.
 *
 * Geschnitten wird an Überschriften, zu lange Abschnitte zusätzlich an
 * Absätzen. Jeder Abschnitt trägt Titel und Überschrift als Kontext, damit
 * auch ein kurzer Absatz („siehe oben“) einordenbar bleibt. Sehr lange
 * Notizen werden nach `maxChunks` abgeschnitten: Sie sollen den Embedding-Lauf
 * nicht dominieren, und ihr Anfang trägt meist das Thema.
 */
export function chunkNote(raw, { title: fallbackTitle = '', maxChars = 1500, maxChunks = 24, minChars = 40 } = {}) {
  const note = parseNote(raw);
  const title = note.title ?? fallbackTitle;
  const body = note.body.replace(/<!--[\s\S]*?-->/g, '').replace(/%%[\s\S]*?%%/g, '');

  const sections = [];
  let heading = null;
  let lines = [];
  const flush = () => {
    const text = lines.join('\n').trim();
    if (text) sections.push({ heading, text });
    lines = [];
  };
  let fence = null;
  for (const line of body.split(/\r?\n/)) {
    const f = line.match(/^\s*(```|~~~)/);
    if (f) fence = fence === null ? f[1] : fence === f[1] ? null : fence;
    const h = fence === null && !f ? line.match(/^#{1,6}\s+(.+?)\s*#*\s*$/) : null;
    if (h) {
      flush();
      heading = h[1].trim();
    } else {
      lines.push(line);
    }
  }
  flush();

  const chunks = [];
  for (const s of sections) {
    for (const part of splitLong(s.text, maxChars)) {
      if (part.replace(/\s+/g, '').length < minChars && sections.length > 1) continue;
      const text = [title, s.heading, part].filter(Boolean).join('\n');
      chunks.push({ heading: s.heading, text });
      if (chunks.length >= maxChunks) return chunks;
    }
  }
  // Notiz nur aus Titel und Frontmatter: der Titel allein ist besser als nichts.
  if (!chunks.length && title) chunks.push({ heading: null, text: title });
  return chunks;
}

function splitLong(text, maxChars) {
  if (text.length <= maxChars) return [text];
  const out = [];
  let current = '';
  for (const para of text.split(/\n\s*\n/)) {
    const pieces = para.length > maxChars ? para.match(new RegExp(`[\\s\\S]{1,${maxChars}}`, 'g')) : [para];
    for (const p of pieces) {
      if (current && current.length + p.length + 2 > maxChars) {
        out.push(current.trim());
        current = '';
      }
      current += (current ? '\n\n' : '') + p;
    }
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

export const hashText = (text) => createHash('sha1').update(text).digest('hex');
