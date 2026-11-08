import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { bump, increment, latestVersion, plan, releaseNotes } from '../ios/scripts/mac-release.js';

const c = (subject, body = '') => ({ subject, body });

test('latestVersion: höchste mac/v-Version, andere Tags zählen nicht', () => {
  assert.equal(latestVersion(['0.1.0', 'ios/v1.0-2', 'mac/v1.9.0', 'mac/v1.10.0', 'mac/v1.2.3', 'mac/vkaputt']), '1.10.0');
  assert.equal(latestVersion(['0.1.0', 'ios/v1.0-1']), null);
});

test('bump: Breaking vor feat vor allem anderen', () => {
  assert.equal(bump([c('fix(app): Absturz'), c('chore: Aufräumen')]), 'patch');
  assert.equal(bump([c('fix(app): Absturz'), c('feat(app): Neues')]), 'minor');
  assert.equal(bump([c('feat(app)!: Neues Login')]), 'major');
  assert.equal(bump([c('refactor: x', 'BREAKING CHANGE: Token neu anlegen')]), 'major');
  assert.equal(bump([c('Ohne Präfix')]), 'patch');
});

test('increment', () => {
  assert.equal(increment('1.2.3', 'patch'), '1.2.4');
  assert.equal(increment('1.2.3', 'minor'), '1.3.0');
  assert.equal(increment('1.2.3', 'major'), '2.0.0');
});

test('plan: erste Version, nichts Neues, erzwungen', () => {
  assert.deepEqual(plan({ tags: [], commits: [] }), { release: true, previous: null, version: '1.0.0', level: null });
  assert.deepEqual(plan({ tags: ['mac/v1.0.0'], commits: [] }), { release: false, previous: '1.0.0' });
  assert.equal(plan({ tags: ['mac/v1.0.0'], commits: [], force: true }).version, '1.0.1');
  assert.equal(plan({ tags: ['mac/v1.0.0'], commits: [c('feat(app): x')] }).version, '1.1.0');
});

test('releaseNotes: nach Art gruppiert, ohne Präfix, mit Hinweis zum Installieren', () => {
  const notes = releaseNotes({
    version: '1.1.0', previous: '1.0.0',
    commits: [c('feat(app): Updates in der App'), c('fix: Login auf dem Mac'), c('chore(ios): Aufräumen'), c('feat!: Neuer Server', '')],
  });
  assert.match(notes, /### Neu\n\n- Updates in der App\n- \*\*Bricht Bisheriges:\*\* Neuer Server\n/);
  assert.match(notes, /### Behoben\n\n- Login auf dem Mac\n/);
  assert.match(notes, /### Sonst\n\n- Aufräumen\n/);
  assert.match(notes, /`Cockpit\.dmg` laden/);
  assert.match(notes, /mac\/v1\.0\.0…mac\/v1\.1\.0/);
  assert.match(releaseNotes({ version: '1.0.0', previous: null, commits: [] }), /^Erste Version/);
});

test('Skript: nur Commits unter ios/ (ohne Markdown) zählen, Ausgabe für den Workflow', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mac-release-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  const commit = (path, subject) => {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), `${subject}\n`, { flag: 'a' });
    git('add', '.');
    git('-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-qm', subject);
  };
  const run = (env = {}) => {
    const output = join(dir, `out-${Math.random()}`);
    const notes = join(dir, `notes-${Math.random()}`);
    execFileSync(process.execPath, [resolve('ios/scripts/mac-release.js')], {
      cwd: dir, env: { ...process.env, GITHUB_OUTPUT: output, NOTES_FILE: notes, FORCE: '', ...env }, encoding: 'utf8',
    });
    const out = Object.fromEntries(readFileSync(output, 'utf8').trim().split('\n').map((l) => l.split('=')));
    let text = '';
    try { text = readFileSync(notes, 'utf8'); } catch {}
    return { out, notes: text };
  };

  git('init', '-q');
  commit('ios/Cockpit/App.swift', 'feat(app): Start');
  assert.deepEqual(run().out, { release: 'true', version: '1.0.0', tag: 'mac/v1.0.0' });
  git('tag', 'mac/v1.0.0');

  commit('src/server.js', 'feat(server): nur Server');
  commit('ios/README.md', 'docs(ios): nur Doku');
  assert.deepEqual(run().out, { release: 'false' });
  assert.deepEqual(run({ FORCE: '1' }).out, { release: 'true', version: '1.0.1', tag: 'mac/v1.0.1' });

  commit('ios/Cockpit/App.swift', 'fix(app): Absturz');
  commit('ios/Cockpit/Update.swift', 'feat(app): Updates');
  const { out, notes } = run();
  assert.deepEqual(out, { release: 'true', version: '1.1.0', tag: 'mac/v1.1.0' });
  assert.match(notes, /- Updates/);
  assert.match(notes, /- Absturz/);
  assert.doesNotMatch(notes, /nur Server|nur Doku/);
});
