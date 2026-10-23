import { DOMParser } from 'linkedom';
import { normalizeUrl } from './fetch.js';
import { ReadingError } from './store.js';
import { esc } from '../web/layout.js';
import { xmlAttr } from './feeds.js';

const attrOf = (el, name) => xmlAttr(el, name) ?? xmlAttr(el, name.toLowerCase());
const titleOf = (el) => (attrOf(el, 'title') ?? attrOf(el, 'text') ?? '').trim() || null;
const isOutline = (el) => el?.tagName?.toLowerCase() === 'outline';

/**
 * OPML, das Austauschformat der Feed-Reader. Beim Import zählt jedes
 * `outline` mit `xmlUrl`, egal wie tief in Ordnern verschachtelt; `group` ist
 * der Titel des nächsten Ordners darüber (`outline` ohne `xmlUrl`), sonst
 * `null`. Tiefere Ordner werden so flach: ein Feed hat höchstens eine Gruppe.
 * Ungültige Adressen fallen still weg.
 */
export function parseOpml(text) {
  const root = new DOMParser().parseFromString(String(text ?? '').replace(/^\uFEFF/, ''), 'text/xml').documentElement;
  if (root?.tagName?.toLowerCase() !== 'opml') throw new ReadingError('Keine OPML-Datei');
  const feeds = new Map();
  for (const o of root.getElementsByTagName('outline')) {
    let url;
    try {
      url = normalizeUrl(attrOf(o, 'xmlUrl'));
    } catch {
      continue;
    }
    let site = null;
    try {
      site = normalizeUrl(attrOf(o, 'htmlUrl'));
    } catch {
      // ohne Website-Adresse
    }
    let folder = o.parentElement;
    while (isOutline(folder) && attrOf(folder, 'xmlUrl') != null) folder = folder.parentElement;
    if (!feeds.has(url)) feeds.set(url, { url, title: titleOf(o), site_url: site, group: isOutline(folder) ? titleOf(folder) : null });
  }
  return [...feeds.values()];
}

/** Alle Feeds als OPML 2.0: je Gruppe aus `groups` (in deren Reihenfolge) ein Ordner, Feeds ohne Gruppe flach. */
export function toOpml(feeds, { groups = [], now = new Date() } = {}) {
  const outline = (f, indent) => `${indent}<outline type="rss" text="${esc(f.title || f.url)}" title="${esc(f.title || f.url)}" xmlUrl="${esc(f.url)}"${f.site_url ? ` htmlUrl="${esc(f.site_url)}"` : ''}/>`;
  const inGroup = new Map(groups.map((g) => [g.id, []]));
  const loose = [];
  for (const f of feeds) (inGroup.get(f.group_id) ?? loose).push(f);
  const folders = groups
    .filter((g) => inGroup.get(g.id).length)
    .map((g) => `    <outline text="${esc(g.name)}" title="${esc(g.name)}">\n${inGroup.get(g.id).map((f) => outline(f, '      ')).join('\n')}\n    </outline>`);
  return `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head>
    <title>Feeds aus dem Vault Cockpit</title>
    <dateCreated>${now.toUTCString()}</dateCreated>
  </head>
  <body>
${[...folders, ...loose.map((f) => outline(f, '    '))].join('\n')}
  </body>
</opml>
`;
}
