/**
 * Tolerantes Parsen der Vault-Notizen.
 *
 * Der Vault ist über Jahre gewachsen: `tags` kommt als Block-Liste, Inline-Liste,
 * Skalar mit Rautenpräfixen und als `null` vor, Datumsfelder in vier Formaten,
 * Schlüssel teils deutsch, teils englisch. Ein strenger YAML-Parser würde hier
 * mehr Notizen verlieren als er gewinnt — deshalb dieser bewusst nachsichtige
 * Parser für genau die Teilmenge, die im Vault tatsächlich vorkommt.
 */

export const KEY_ALIASES = {
  typ: 'type',
  quelle: 'source',
  titel: 'title',
  autor: 'author',
  autoren: 'author',
  erfasst: 'created',
  organization: 'org',
};

const TAG_ALIASES = {
  'phoenix-progression': 'phönix-progression',
};

const DATE_KEYS = ['created', 'updated', 'date', 'captured', 'fetched'];
const TEMPLATER = /<%.*?%>/;
const HEX_COLOR = /^[0-9a-fA-F]{3,8}$/;

function stripQuotes(value) {
  const v = value.trim();
  if ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"'))) {
    return v.slice(1, -1);
  }
  return v;
}

function normalizeScalar(value) {
  const v = stripQuotes(value);
  if (v === '' || v === 'null' || v === '~' || TEMPLATER.test(v)) return null;
  return v;
}

function splitFrontmatter(text) {
  if (!text.startsWith('---')) return { yaml: '', body: text };
  const end = text.indexOf('\n---', 3);
  if (end === -1) return { yaml: '', body: text };
  const yaml = text.slice(text.indexOf('\n') + 1, end);
  const rest = text.slice(end + 4);
  return { yaml, body: rest.replace(/^(\r?\n)+/, '') };
}

function parseYaml(yaml) {
  const out = {};
  const lines = yaml.split(/\r?\n/);
  let currentKey = null;

  for (const line of lines) {
    if (!line.trim() || line.trim().startsWith('#')) continue;

    const listItem = line.match(/^\s*-\s+(.*)$/);
    if (listItem && currentKey) {
      const value = normalizeScalar(listItem[1]);
      if (value !== null) {
        if (!Array.isArray(out[currentKey])) out[currentKey] = [];
        out[currentKey].push(value);
      }
      continue;
    }

    const pair = line.match(/^([A-Za-zÄÖÜäöüß0-9_-]+)\s*:\s*(.*)$/);
    if (!pair) continue;

    const rawKey = pair[1];
    const key = KEY_ALIASES[rawKey] ?? rawKey;
    const rawValue = pair[2].trim();
    currentKey = key;

    if (rawValue === '') {
      out[key] = [];               // Block-Liste folgt in den nächsten Zeilen
      continue;
    }
    if (rawValue.startsWith('[') && rawValue.endsWith(']')) {
      out[key] = rawValue
        .slice(1, -1)
        .split(',')
        .map((v) => normalizeScalar(v))
        .filter((v) => v !== null);
      currentKey = null;
      continue;
    }
    out[key] = normalizeScalar(rawValue);
    currentKey = null;
  }

  // Leere Block-Listen, denen nie Einträge folgten, sind faktisch leer.
  for (const [k, v] of Object.entries(out)) {
    if (Array.isArray(v) && v.length === 0) out[k] = [];
  }
  return out;
}

function normalizeTag(tag) {
  const t = String(tag).replace(/^#/, '').trim().toLowerCase();
  return TAG_ALIASES[t] ?? t;
}

function frontmatterTags(fm) {
  const raw = fm.tags;
  if (raw === undefined || raw === null) return [];
  if (Array.isArray(raw)) return raw.map(normalizeTag).filter(Boolean);
  // Skalar-Form, z.B. "#person #freundin #drk" oder "ai, security"
  return String(raw)
    .split(/[\s,]+/)
    .map(normalizeTag)
    .filter(Boolean);
}

function toIsoDate(value) {
  if (!value) return null;
  const v = stripQuotes(String(value));
  const m = v.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

/** Code-Fences maskieren, damit Tags und Wikilinks darin nicht gefunden werden. */
function withoutCode(body) {
  return body
    .replace(/^```[\s\S]*?^```/gm, '')
    .replace(/^~~~[\s\S]*?^~~~/gm, '')
    .replace(/`[^`\n]*`/g, '');
}

function extractInlineTags(clean) {
  const found = new Set();
  for (const m of clean.matchAll(/(^|[\s(])#([\p{L}\p{N}_/-]{2,})/gu)) {
    const tag = m[2];
    if (HEX_COLOR.test(tag)) continue;      // Hex-Farben aus Design-Notizen
    if (/^\d+$/.test(tag)) continue;
    found.add(normalizeTag(tag));
  }
  return [...found];
}

function extractLinks(clean) {
  const links = [];
  for (const m of clean.matchAll(/(!?)\[\[([^\]]+)\]\]/g)) {
    const embed = m[1] === '!';
    let inner = m[2];
    let alias = null;

    const pipe = inner.indexOf('|');
    if (pipe !== -1) {
      alias = inner.slice(pipe + 1).trim();
      inner = inner.slice(0, pipe);
    }
    const target = inner.split(/[#^]/)[0].trim();
    if (target) links.push({ target, alias, embed });
  }
  return links;
}

const stripEmoji = (s) =>
  s.replace(/[\p{Extended_Pictographic}\p{Emoji_Presentation}️]/gu, '').trim();

export function parseNote(text) {
  const { yaml, body } = splitFrontmatter(text ?? '');
  const frontmatter = parseYaml(yaml);

  if (typeof frontmatter.status === 'string') {
    frontmatter.status = frontmatter.status.toLowerCase();
  }

  const dates = {};
  for (const key of DATE_KEYS) dates[key] = toIsoDate(frontmatter[key]);

  const clean = withoutCode(body);
  const h1 = body.match(/^#\s+(.+)$/m);
  const headings = [...body.matchAll(/^##\s+(.+)$/gm)].map((m) => stripEmoji(m[1]));

  const openTasks = (body.match(/^\s*[-*]\s+\[ \]/gm) ?? []).length;
  const doneTasks = (body.match(/^\s*[-*]\s+\[[xX]\]/gm) ?? []).length;

  return {
    frontmatter,
    body,
    title: (typeof frontmatter.title === 'string' ? frontmatter.title : null) ?? (h1 ? h1[1].trim() : null),
    tags: frontmatterTags(frontmatter),
    inlineTags: extractInlineTags(clean),
    links: extractLinks(clean),
    headings,
    dates,
    tasks: { open: openTasks, done: doneTasks },
  };
}
