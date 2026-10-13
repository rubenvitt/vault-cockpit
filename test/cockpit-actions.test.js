import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCockpitActions, ActionError, resolveDue } from '../src/cockpit/actions.js';
import { createSettingsStore } from '../src/cockpit/settings.js';
import { createStateStore } from '../src/capture/state.js';
import { compilePolicy } from '../src/vault/policy.js';

const quiet = { info() {}, warn() {}, error() {} };
let root, settings, calls, changed, zunder;

function fakeZunder({ fail = false } = {}) {
  return {
    async setStatus(id, status) {
      calls.push(['setStatus', id, status]);
      if (fail) throw new Error('Zunder antwortet mit HTTP 500');
      return { id, ref: 'VCP-1', title: 'Steuer', status };
    },
    async updateTask(id, fields) {
      calls.push(['updateTask', id, fields]);
      if (fail) throw new Error('Zunder antwortet mit HTTP 500');
      return { id, ref: 'VCP-1', title: 'Steuer', status: 'open', ...fields };
    },
    async moveTask(id, location) {
      calls.push(['moveTask', id, location]);
      return { id, ref: 'VCP-1', title: 'Steuer', status: 'open', location: { ...location, name: 'Finanzen' } };
    },
    async createTask(args) {
      calls.push(['createTask', args]);
      return { id: `t${calls.length}`, ref: `ZUN-${calls.length}`, url: `https://zunder.test/#/aufgabe/t${calls.length}` };
    },
  };
}

const actions = (overrides = {}) =>
  createCockpitActions({
    vaultPath: root,
    settings,
    policy: compilePolicy({ sensitive: { privat: 'Privat' }, exclude: ['^archiv/'] }),
    state: createStateStore(null),
    zunder: () => zunder,
    index: { applyChanges: (paths) => changed.push(...paths) },
    logger: quiet,
    ...overrides,
  });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cockpit-actions-'));
  settings = createSettingsStore({ defaults: { tz: 'Europe/Berlin', inboxFolder: '00-inbox' }, logger: quiet });
  calls = [];
  changed = [];
  zunder = fakeZunder();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

test('setStatus: setzt den Status über Zunder und meldet die Aufgabe zurück', async () => {
  const t = await actions().setStatus('abc123', 'done');
  assert.deepEqual(t, { id: 'abc123', ref: 'VCP-1', title: 'Steuer', status: 'done', due: null, phoenix: null, location: null });
  assert.deepEqual(calls, [['setStatus', 'abc123', 'done']]);
});

test('setStatus: unbekannte IDs und Status werden vor Zunder abgewiesen', async () => {
  const a = actions();
  await assert.rejects(a.setStatus('../x', 'done'), (e) => e instanceof ActionError && e.status === 400);
  await assert.rejects(a.setStatus('abc', 'archived'), /nicht vorgesehen/);
  await assert.rejects(a.setStatus('abc', 'review'), /nicht vorgesehen/);
  assert.equal(calls.length, 0);
});

test('setStatus: Zunder-Fehler wird 502, fehlender Zugang 503', async () => {
  zunder = fakeZunder({ fail: true });
  await assert.rejects(actions().setStatus('abc', 'done'), (e) => e.status === 502 && /HTTP 500/.test(e.message));
  zunder = null;
  await assert.rejects(actions().setStatus('abc', 'done'), (e) => e.status === 503 && /Einstellungen/.test(e.message));
});

test('resolveDue: Kurzwahl relativ zu heute, Datum geprüft', () => {
  const today = '2026-10-14'; // Mittwoch
  assert.equal(resolveDue('heute', today), '2026-10-14');
  assert.equal(resolveDue('morgen', today), '2026-10-15');
  assert.equal(resolveDue('naechste-woche', today), '2026-10-19');
  assert.equal(resolveDue('naechste-woche', '2026-10-18'), '2026-10-19'); // Sonntag → morgen ist Montag
  assert.equal(resolveDue('naechste-woche', '2026-10-19'), '2026-10-26');
  assert.equal(resolveDue('morgen', '2026-12-31'), '2027-01-01');
  assert.equal(resolveDue('keine', today), null);
  assert.equal(resolveDue('', today), null);
  assert.equal(resolveDue('2026-11-03', today), '2026-11-03');
  assert.equal(resolveDue('2026-02-30', today), undefined);
  assert.equal(resolveDue('übermorgen', today), undefined);
});

test('setDue: Kurzwahl gilt in der Zeitzone der Einstellungen', async () => {
  // 23:30 UTC am 13.10. ist in Berlin schon der 14.10.
  const a = actions({ now: () => new Date('2026-10-13T23:30:00Z') });
  const t = await a.setDue('abc', 'morgen');
  assert.equal(t.due, '2026-10-15');
  assert.deepEqual(calls, [['updateTask', 'abc', { due: '2026-10-15' }]]);
  await a.setDue('abc', 'keine');
  assert.deepEqual(calls[1], ['updateTask', 'abc', { due: null }]);
});

test('setDue: ungültiges Datum vor Zunder abgewiesen, Zunder-Fehler 502', async () => {
  await assert.rejects(actions().setDue('abc', 'irgendwann'), (e) => e.status === 400 && /kein Datum/.test(e.message));
  await assert.rejects(actions().setDue('../x', 'morgen'), (e) => e.status === 400);
  assert.equal(calls.length, 0);
  zunder = fakeZunder({ fail: true });
  await assert.rejects(actions().setDue('abc', 'morgen'), (e) => e.status === 502);
});

test('move: Ziel aus dem Formular wird zur Zunder-Stelle, Unsinn vorher abgewiesen', async () => {
  const a = actions();
  assert.equal((await a.move('abc', 'area:a1')).location.kind, 'area');
  await a.move('abc', 'project:p_1');
  await a.move('abc', 'loose');
  assert.deepEqual(calls.map((c) => c[2]), [{ kind: 'area', id: 'a1' }, { kind: 'project', id: 'p_1' }, { kind: 'loose' }]);
  for (const bad of ['', 'area:', 'area:../x', 'irgendwo', 'project:a b']) {
    await assert.rejects(a.move('abc', bad), (e) => e.status === 400 && /Bereich oder ein Projekt/.test(e.message));
  }
  assert.equal(calls.length, 3);
});

test('setPhoenix: Schritt einer Woche setzen und wieder entfernen', async () => {
  const a = actions();
  const t = await a.setPhoenix('abc', '2026-W42');
  assert.deepEqual(t.phoenix, { role: 'feuer_schritt', fire: '2026-W42' });
  await a.setPhoenix('abc', '');
  assert.deepEqual(calls, [['updateTask', 'abc', { phoenix: { role: 'feuer_schritt', fire: '2026-W42' } }], ['updateTask', 'abc', { phoenix: null }]]);
  await assert.rejects(a.setPhoenix('abc', '2026-W60'), (e) => e.status === 400 && /keine Kalenderwoche/.test(e.message));
});

test('capture: Notiz landet im Inbox-Ordner aus den Einstellungen und sofort im Index', async () => {
  const r = await actions().capture({ text: 'Idee für den Hundeplatz\nmit Details', captureId: 'c-1' });
  assert.equal(r.kind, 'note');
  assert.match(r.path, /^00-inbox\/\d{4}-\d{2}-\d{2} \d{4} - Idee für den Hundeplatz\.md$/);
  const body = readFileSync(join(root, r.path), 'utf8');
  assert.match(body, /source: cockpit/);
  assert.match(body, /capture_id: c-1/);
  assert.deepEqual(changed, [r.path]);

  // Doppelt abgeschickt: keine zweite Notiz.
  const again = await actions().capture({ text: 'Idee für den Hundeplatz\nmit Details', captureId: 'c-1' });
  assert.equal(again.duplicate, true);
  assert.equal(readdirSync(join(root, '00-inbox')).length, 1);
});

test('capture: mit ! eine Aufgabe in der Zunder-Inbox, einmal je Erfassungs-ID', async () => {
  const a = actions();
  const r = await a.capture({ text: '! Steuererklärung abgeben\nBelege liegen im Ordner', captureId: 'c-2' });
  assert.equal(r.kind, 'task');
  assert.equal(r.ref, 'ZUN-1');
  assert.equal(calls[0][1].title, 'Steuererklärung abgeben');
  assert.match(calls[0][1].description, /Belege liegen im Ordner[\s\S]*Web-Cockpit/);
  assert.equal((await a.capture({ text: '! Steuererklärung abgeben', captureId: 'c-2' })).duplicate, true);
  assert.equal(calls.length, 1);
  assert.equal(existsSync(join(root, '00-inbox')), false);
});

test('capture: ! ohne Zunder und leerer Text werden verständlich abgewiesen', async () => {
  zunder = null;
  await assert.rejects(actions().capture({ text: '! Aufgabe' }), (e) => e.status === 503 && /Zunder-Zugang/.test(e.message));
  await assert.rejects(actions().capture({ text: '   ' }), (e) => e.status === 400 && /leer/.test(e.message));
});

test('capture: schreibt nie in vertrauliche oder ausgeschlossene Ordner', async () => {
  for (const folder of ['privat', 'privat/inbox', 'archiv']) {
    settings.save({ ...settings.stored(), inboxFolder: folder });
    await assert.rejects(actions().capture({ text: 'geheim' }), (e) => e.status === 403);
    assert.equal(existsSync(join(root, folder)), false);
  }
});
