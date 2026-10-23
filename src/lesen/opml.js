import { DOMParser } from 'linkedom';
import { normalizeUrl } from './fetch.js';
import { ReadingError } from './store.js';
import { esc } from '../web/layout.js';
import { xmlAttr } from './feeds.js';

/**
 * OPML, das Austauschformat der Feed-Reader. Beim Import zählt jedes
 * `outline` mit `xmlUrl`, egal wie tief in Ordnern verschachtelt; Ordner
 * selbst werden nicht übernommen. Ungültige Adressen fallen still weg.
 */
export function parseOpml(text) {
  const root = new DOMParser().parseFromString(String(text ?? '').replace(/^\uFEFF/, ''), 'text/xml').documentElement;
  if (root?.tagName?.toLowerCase() !== 'opml') throw new ReadingError('Keine OPML-Datei');
  const feeds = new Map();
  for (const o of root.getElementsByTagName('outline')) {
    const attr = (name) => xmlAttr(o, name) ?? xmlAttr(o, name.toLowerCase());
    let url;
    try {
      url = normalizeUrl(attr('xmlUrl'));
    } catch {
      continue;
    }
    const title = (attr('title') ?? attr('text') ?? '').trim() || null;
    let site = null;
    try {
      site = normalizeUrl(attr('htmlUrl'));
    } catch {
      // ohne Website-Adresse
    }
    if (!feeds.has(url)) feeds.set(url, { url, title, site_url: site });
  }
  return [...feeds.values()];
}

/** Alle Feeds als OPML 2.0, flach ohne Ordner. */
export function toOpml(feeds, { now = new Date() } = {}) {
  const outline = (f) => `    <outline type="rss" text="${esc(f.title || f.url)}" title="${esc(f.title || f.url)}" xmlUrl="${esc(f.url)}"${f.site_url ? ` htmlUrl="${esc(f.site_url)}"` : ''}/>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head>
    <title>Feeds aus dem Vault Cockpit</title>
    <dateCreated>${now.toUTCString()}</dateCreated>
  </head>
  <body>
${feeds.map(outline).join('\n')}
  </body>
</opml>
`;
}
