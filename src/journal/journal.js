import { readFileSync, writeFileSync, mkdirSync, existsSync, realpathSync } from 'node:fs';
import { join, sep } from 'node:path';

/**
 * Session-Journal für Cloud-Sessions: hängt einen Eintrag an die Tagesdatei
 * `_System/journal/<sphäre>/<tag>.md` an, im Format des Mods
 * `session-journal` (fileHeader/renderEntry dort). Genutzt vom MCP-Werkzeug
 * `vault_journal` (Skill /journal) und von `POST /journal` (Mod in Claude Code
 * im Web). Der Pfad entsteht nur aus Sphäre und Datum, nie aus der Eingabe.
 */

export const JOURNAL_FOLDER = '_System/journal';
const TIME_ZONE = 'Europe/Berlin';
const SPHERES = ['privat', 'arbeit'];
const KINDS = ['auto', 'manual', 'final'];
const SOURCES = ['code-web', 'chat'];

export class JournalError extends Error {
  constructor(message, field) {
    super(message);
    this.field = field;
  }
}

const fmt = (ms, opts) => new Intl.DateTimeFormat('de-DE', { timeZone: TIME_ZONE, ...opts }).format(new Date(ms));
const hhmm = (ms) => fmt(ms, { hour: '2-digit', minute: '2-digit' });
const isoDay = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
const germanDay = (ms) => fmt(ms, { weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric' });
const oneLine = (s, max = 300) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim().slice(0, max) : '');

const SECRETS = [
  /\b(?:vct|ghp|gho|ghs|ghu)_[A-Za-z0-9_]{6,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{10,}/g,
  /\bsk-[A-Za-z0-9_-]{8,}/g,
];

/** Maskiert offensichtliche Zugangsdaten (Ersatz für `$.session.redact`, den der Skill-Weg nicht hat). */
export function redactSecrets(text) {
  let out = String(text);
  for (const re of SECRETS) out = out.replace(re, '[maskiert]');
  return out
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{6,}/g, '$1 [maskiert]')
    .replace(/\b(password|passwort|pwd|token|secret)(\s*[=:]\s*)\S+/gi, '$1$2[maskiert]');
}

function time(value, field) {
  const ms = typeof value === 'number' ? value : Date.parse(String(value));
  if (!Number.isFinite(ms)) throw new JournalError(`„${field}“ ist kein gültiger Zeitpunkt (RFC 3339 erwartet)`, field);
  return ms;
}

/** Prüft und kürzt einen Eintrag wie `parseEntry` im Mod. `now` ersetzt ein fehlendes `to`. */
export function normalizeEntry(input, now = Date.now()) {
  const raw = input ?? {};
  const clean = (s, max) => oneLine(typeof s === 'string' ? redactSecrets(s) : s, max);
  const titel = clean(raw.titel, 80);
  if (!titel) throw new JournalError('Titel fehlt', 'titel');
  const punkte = Array.isArray(raw.punkte) ? raw.punkte.map((p) => clean(p, 240)).filter(Boolean).slice(0, 5) : [];
  if (!punkte.length) throw new JournalError('Mindestens ein Punkt nötig', 'punkte');
  if (!SPHERES.includes(raw.sphaere)) throw new JournalError('sphaere muss „privat“ oder „arbeit“ sein', 'sphaere');
  const kind = raw.kind ?? 'manual';
  if (!KINDS.includes(kind)) throw new JournalError(`kind muss ${KINDS.join(', ')} sein`, 'kind');
  const source = raw.source ?? 'chat';
  if (!SOURCES.includes(source)) throw new JournalError(`source muss ${SOURCES.join(' oder ')} sein`, 'source');
  const session = oneLine(raw.session, 64);
  if (!session) throw new JournalError('session fehlt', 'session');
  const from = time(raw.from, 'from');
  const to = raw.to === undefined || raw.to === null || raw.to === '' ? now : time(raw.to, 'to');
  if (from > to) throw new JournalError('from liegt nach to', 'from');
  return {
    titel,
    sphaere: raw.sphaere,
    projekt: clean(raw.projekt, 60) || 'unbekannt',
    kontext: clean(raw.kontext),
    punkte,
    erkenntnis: clean(raw.erkenntnis) || undefined,
    offen: clean(raw.offen) || undefined,
    from,
    to,
    session,
    kind,
    source,
  };
}

/** Wortgleich mit `renderEntry` im Mod, nur mit der Quelle am Ende der Projektzeile. */
export function renderEntry(e) {
  const lines = [
    `### ${hhmm(e.from)}–${hhmm(e.to)} · ${e.titel}`,
    `- **Projekt:** ${e.projekt} · **Session:** \`${e.session.slice(0, 8)}\` · ${e.kind} · ${e.source}`,
  ];
  if (e.kontext) lines.push(`- **Kontext:** ${e.kontext}`);
  for (const p of e.punkte) lines.push(`- ${p}`);
  if (e.erkenntnis) lines.push(`- 💡 **Erkenntnis:** ${e.erkenntnis} #mycel-candidate`);
  if (e.offen) lines.push(`- ⏳ **Offen:** ${e.offen}`);
  return lines.join('\n') + '\n';
}

/** Wortgleich mit `fileHeader` im Mod. */
export function fileHeader(day, at, sphere) {
  return ['---', 'type: journal', `date: ${day}`, `sphere: ${sphere}`, '---', '', `# Journal ${germanDay(at)} · ${sphere}`, '', ''].join('\n');
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Die Datei zeigt nur 8 Zeichen der Session. Damit zwei Sessions mit gleichem
// Anfang nicht als Duplikat gelten, merkt sich der Server, welche vollen
// Sessions er hinter einem solchen Kürzel geschrieben hat. Nach einem Neustart
// fehlt das Gedächtnis; dann gilt wieder allein die Datei.
function isDuplicate(content, e) {
  const head = new RegExp(`^### \\d{2}:\\d{2}–${escape(hhmm(e.to))} · `);
  const marker = `**Session:** \`${e.session.slice(0, 8)}\``;
  return content.split(/\n(?=### )/).some((block) => {
    const b = block.replace(/^\n+/, '');
    return head.test(b) && b.includes(marker);
  });
}

export function createJournal({ vaultPath, index, now = Date.now }) {
  const vaultReal = realpathSync(vaultPath);
  const written = new Map();
  const keyOf = (rel, e) => `${rel}|${hhmm(e.to)}|${e.session.slice(0, 8)}`;

  return {
    /** Hängt einen Eintrag an; `{written:false, reason:'duplicate'}`, wenn er schon dasteht. */
    write(input) {
      const e = normalizeEntry(input, now());
      const day = isoDay(e.to);
      const dir = join(vaultPath, JOURNAL_FOLDER, e.sphaere);
      mkdirSync(dir, { recursive: true });
      if (!realpathSync(dir).startsWith(vaultReal + sep)) throw new Error('Journal-Ordner zeigt aus dem Vault heraus');
      const rel = `${JOURNAL_FOLDER}/${e.sphaere}/${day}.md`;
      const absolute = join(vaultPath, rel);
      if (existsSync(absolute) && !realpathSync(absolute).startsWith(vaultReal + sep)) throw new Error(`"${rel}" zeigt aus dem Vault heraus`);

      const exists = existsSync(absolute);
      const before = exists ? readFileSync(absolute, 'utf8') : null;
      const key = keyOf(rel, e);
      const known = written.get(key);
      if (before !== null && isDuplicate(before, e) && (!known || known.has(e.session))) return { written: false, reason: 'duplicate' };

      const base = before ?? fileHeader(day, e.to, e.sphaere);
      const gap = base === '' || base.endsWith('\n\n') ? '' : base.endsWith('\n') ? '\n' : '\n\n';
      const text = renderEntry(e);
      const current = existsSync(absolute) ? readFileSync(absolute, 'utf8') : null;
      if (current !== before) throw new Error(`"${rel}" wurde gerade anderweitig geändert. Bitte erneut versuchen.`);
      writeFileSync(absolute, base + gap + text, 'utf8');
      written.set(key, (known ?? new Set()).add(e.session));
      try {
        index?.refresh?.(rel);
      } catch {
        /* der nächste Komplettaufbau holt es nach */
      }
      return { written: true, path: rel, heading: text.split('\n')[0] };
    },
  };
}
