#!/usr/bin/env node
/**
 * Nächste Version der macOS-App (Direktvertrieb) aus den Commits seit dem letzten Release,
 * nach Conventional Commits wie semantic-release:
 *
 *   `feat!:` oder `BREAKING CHANGE:` im Text  → Major
 *   `feat:`                                    → Minor
 *   alles andere (`fix:`, `perf:`, `chore:` …) → Patch
 *
 * Zählt nur Commits, die die App ändern (`ios/` ohne Markdown); ein Push nur auf den Server gibt
 * kein neues Release. Ohne früheres Release ist die erste Version `INITIAL_VERSION`.
 *
 *   node ios/scripts/mac-release.js
 *
 * Umgebung:
 *   FORCE=1          auch ohne neue Commits ein Release (Patch), z. B. manuell gestartet
 *   NOTES_FILE       schreibt die Release-Notizen (Markdown) in diese Datei
 *   GITHUB_OUTPUT    schreibt release=true|false, version=…, tag=… für den Workflow
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const TAG_PREFIX = 'mac/v';
export const INITIAL_VERSION = '1.0.0';
/** Was zur App gehört: alles unter ios/ außer Dokumentation. */
export const APP_PATHS = ['ios/', ':(exclude)ios/**/*.md', ':(exclude)ios/*.md'];

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

/** `1.2.3` → [1, 2, 3]; nil für alles andere. */
export function parseVersion(value) {
  const match = SEMVER.exec(String(value ?? '').trim());
  return match ? match.slice(1).map(Number) : null;
}

export function compareVersions(a, b) {
  const [x, y] = [parseVersion(a), parseVersion(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

/** Höchste Version unter den Tags `mac/vX.Y.Z`; null ohne solchen Tag. */
export function latestVersion(tags) {
  const versions = tags
    .filter((tag) => tag.startsWith(TAG_PREFIX))
    .map((tag) => tag.slice(TAG_PREFIX.length))
    .filter((version) => parseVersion(version));
  return versions.sort(compareVersions).at(-1) ?? null;
}

/** Betreff in Typ, Bereich, „!“ und Text zerlegen; `type` null ohne Conventional-Commit-Präfix. */
export function parseSubject(subject) {
  const match = /^([a-z]+)(?:\(([^)]*)\))?(!)?: (.+)$/.exec(subject);
  if (!match) return { type: null, scope: null, breaking: false, text: subject };
  return { type: match[1], scope: match[2] ?? null, breaking: Boolean(match[3]), text: match[4] };
}

/** Commit `{ subject, body }` zerlegt; `breaking` auch bei `BREAKING CHANGE:` im Text. */
export function parseCommit({ subject, body = '' }) {
  const parsed = parseSubject(subject);
  return { ...parsed, breaking: parsed.breaking || /^BREAKING[ -]CHANGE: /m.test(body) };
}

/** 'major' | 'minor' | 'patch' für Commits `{ subject, body }`. */
export function bump(commits) {
  const parsed = commits.map(parseCommit);
  if (parsed.some((c) => c.breaking)) return 'major';
  return parsed.some((c) => c.type === 'feat') ? 'minor' : 'patch';
}

export function increment(version, level) {
  const [major, minor, patch] = parseVersion(version);
  if (level === 'major') return `${major + 1}.0.0`;
  if (level === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

/**
 * Release für die Tags und Commits seit dem letzten Tag (neueste zuerst).
 * `{ release: false }`, wenn nichts Neues dabei ist und `force` fehlt.
 */
export function plan({ tags, commits, force = false }) {
  const previous = latestVersion(tags);
  if (!previous) return { release: true, previous: null, version: INITIAL_VERSION, level: null };
  if (commits.length === 0 && !force) return { release: false, previous };
  const level = bump(commits);
  return { release: true, previous, version: increment(previous, level), level };
}

const SECTIONS = [
  ['Neu', (c) => c.type === 'feat'],
  ['Behoben', (c) => c.type === 'fix'],
  ['Sonst', () => true],
];

/** Release-Notizen (Markdown): Betreffe ohne Präfix, nach Art gruppiert. */
export function releaseNotes({ version, previous, commits }) {
  const lines = [];
  if (commits.length === 0) {
    lines.push(previous ? 'Neu gebaut, ohne Änderungen an der App.' : 'Erste Version der macOS-App zum direkten Download.');
  }
  let remaining = commits.map(parseCommit);
  for (const [title, match] of SECTIONS) {
    const items = remaining.filter(match);
    remaining = remaining.filter((c) => !match(c));
    if (items.length === 0) continue;
    if (lines.length) lines.push('');
    lines.push(`### ${title}`, '');
    for (const item of items) lines.push(`- ${item.breaking ? '**Bricht Bisheriges:** ' : ''}${item.text}`);
  }
  lines.push('', '---', '', `**Installieren:** \`Cockpit.dmg\` laden, öffnen und Cockpit in „Programme“ ziehen. Danach aktualisiert sich die App selbst (Menü „Cockpit“ → „Nach Updates suchen …“).`);
  if (previous) lines.push('', `Änderungen seit ${previous}: \`${TAG_PREFIX}${previous}…${TAG_PREFIX}${version}\``);
  return `${lines.join('\n')}\n`;
}

// MARK: git

const git = (args) => execFileSync('git', args, { encoding: 'utf8' });

function readTags() {
  return git(['tag', '--list', `${TAG_PREFIX}*`, '--merged', 'HEAD']).split('\n').filter(Boolean);
}

/** Commits ohne Merges seit `since` (oder alle), die die App ändern, neueste zuerst. */
function readCommits(since) {
  const range = since ? [`${TAG_PREFIX}${since}..HEAD`] : ['HEAD'];
  const out = git(['log', '--no-merges', '--format=%s%x1f%b%x1e', ...range, '--', ...APP_PATHS]);
  return out.split('\x1e').map((entry) => entry.trim()).filter(Boolean).map((entry) => {
    const [subject, body = ''] = entry.split('\x1f');
    return { subject: subject.trim(), body: body.trim() };
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const env = process.env;
  const tags = readTags();
  const previous = latestVersion(tags);
  // Ohne früheres Release sind die Notizen ein Satz, nicht die ganze Geschichte.
  const commits = previous ? readCommits(previous) : [];
  const result = plan({ tags, commits, force: env.FORCE === '1' });
  if (!result.release) {
    console.log(`Keine Änderung an der App seit ${TAG_PREFIX}${previous}, kein Release.`);
  } else {
    console.log(`Release ${TAG_PREFIX}${result.version} (vorher ${result.previous ?? '–'}, ${result.level ?? 'erste Version'}, ${commits.length} Commits)`);
    if (env.NOTES_FILE) writeFileSync(env.NOTES_FILE, releaseNotes({ version: result.version, previous: result.previous, commits }));
  }
  if (env.GITHUB_OUTPUT) {
    const out = [`release=${result.release}`];
    if (result.release) out.push(`version=${result.version}`, `tag=${TAG_PREFIX}${result.version}`);
    appendFileSync(env.GITHUB_OUTPUT, `${out.join('\n')}\n`);
  }
}
