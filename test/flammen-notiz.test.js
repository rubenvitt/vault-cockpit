import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildIndex, openIndex } from '../src/vault/index.js';
import { compilePolicy } from '../src/vault/policy.js';
import { createEditor } from '../src/vault/edit.js';
import { createSettingsStore } from '../src/cockpit/settings.js';
import { createCockpitActions } from '../src/cockpit/actions.js';
import { createStateStore } from '../src/capture/state.js';
import { createFlameNote, flameRows, renderFlameTable, planFlameUpdate, flameBlock, flameBlocks, flameMinutes } from '../src/cockpit/flammen-notiz.js';

const quiet = { info() {}, warn() {}, error() {} };
const tz = 'Europe/Berlin';
const FEUER = '20-bereiche/Phönix/feuer/Feuer W3 - 2026-Q4.md';
const flamme = { fire: '2026-W42', role: 'flamme' };
let root, idx, editor, settings, tasks, calls, svc, policy;

const put = (p, text) => {
  mkdirSync(join(root, p, '..'), { recursive: true });
  writeFileSync(join(root, p), text);
  idx?.refresh(p);
};
const read = (p) => readFileSync(join(root, p), 'utf8');

const feuerNote = (zeitraum = '12.10.2026 – 18.10.2026', extra = '') =>
  `---\ntype: 1-wochen-feuer\nwoche: W3\nzeitraum: "${zeitraum}"\nstatus: aktiv\n---\n# Feuer W3\n\n## Feuer-Ziel\n\nZiel\n\n## Flammen\n\n| # | Tag | Uhrzeit | Thema | Status |\n|---|-----|---------|-------|--------|\n${extra}\n## Notizen\n\nVon Hand.\n`;

const zunder = {
  taskUrl: (id) => `https://zunder.test/#/aufgabe/${id}`,
  async filterTasks(f) {
    calls.push(f);
    return tasks.filter((t) => t.phoenix?.fire === f.phoenix_fire);
  },
};

const make = (opts = {}) =>
  createFlameNote({ vaultPath: root, index: idx, editor, policy, settings, zunder: () => zunder, now: () => new Date('2026-10-14T10:00:00Z'), logger: quiet, ...opts });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'flammen-notiz-'));
  idx = null;
  policy = compilePolicy({ sensitive: { '20-bereiche/Gesundheit': 'gesundheit' } });
  put(FEUER, feuerNote());
  buildIndex({ vaultPath: root, dbPath: ':memory:', policy, persist: (db, vp) => (idx = openIndex(db, { vaultPath: vp, policy })) });
  editor = createEditor({ vaultPath: root, index: idx });
  settings = createSettingsStore({ defaults: { tz }, logger: quiet });
  calls = [];
  tasks = [
    { id: 'f1', title: 'Folien | Teil [1]', status: 'done', due: '2026-10-12T15:00:00+02:00', phoenix: flamme, flame_started_at: '2026-10-13T13:00:00Z', flame_ended_at: '2026-10-13T14:30:00Z' },
    { id: 'f2', title: 'Steuer', status: 'open', due: '2026-10-15', phoenix: flamme },
    { id: 'x1', title: 'Verworfen', status: 'dropped', due: '2026-10-14', phoenix: flamme },
    { id: 's1', title: 'Schritt', status: 'open', due: '2026-10-14', phoenix: { fire: '2026-W42', role: 'feuer_schritt' } },
  ];
  svc = make();
});
afterEach(() => {
  idx.close();
  rmSync(root, { recursive: true, force: true });
});

test('Zeilen: Tag der Messung, geplanter Tag aus due, Minuten und Status; nur Flammen', () => {
  const rows = flameRows([...tasks, { id: 'f3', title: 'Jetzt', status: 'in_progress', due: null, phoenix: flamme, flame_running: true, flame_started_at: '2026-10-14T08:00:00Z' }], { tz, taskUrl: zunder.taskUrl });
  assert.deepEqual(
    rows.map((r) => [r.day, r.title, r.planned, r.measured, r.status]),
    [
      ['Di 13.10.', '[Folien \\| Teil \\[1\\]](https://zunder.test/#/aufgabe/f1)', 'Mo 12.10. 15:00', '90', 'erledigt'],
      ['Mi 14.10.', '[Jetzt](https://zunder.test/#/aufgabe/f3)', '–', 'läuft', 'brennt'],
      ['Do 15.10.', '[Steuer](https://zunder.test/#/aufgabe/f2)', 'Do 15.10.', '–', 'offen'],
    ],
  );
  assert.match(renderFlameTable(rows), /^\| Tag \| Flamme \| geplant \| gemessen \(min\) \| Status \|\n\|-----/);
  assert.equal(renderFlameTable([]), 'Keine Flammen für diese Woche in Zunder.');
});

test('Blöcke: alle Blöcke aus dem Verlauf zählen, ohne Verlauf der letzte (VCP-61)', () => {
  const history = [
    { seq: 1, field: 'title', value: 'Folien' },
    { seq: 2, field: 'flame_started_at', value: '2026-10-12T08:00:00Z' },
    { seq: 3, field: 'flame_ended_at', value: null },
    { seq: 5, field: 'flame_ended_at', value: '2026-10-12T08:30:00Z' },
    // Ein abgebrochener Start ohne Stopp zählt nicht, der nächste Start ersetzt ihn.
    { seq: 6, field: 'flame_started_at', value: '2026-10-13T09:00:00Z' },
    { seq: 7, field: 'flame_ended_at', value: null },
    { seq: 8, field: 'flame_started_at', value: '2026-10-13T13:00:00Z' },
    { seq: 9, field: 'flame_ended_at', value: null },
    { seq: 10, field: 'flame_ended_at', value: '2026-10-13T14:30:00Z' },
  ];
  const blocks = flameBlocks([...history].reverse());
  assert.deepEqual(blocks, [
    { start: '2026-10-12T08:00:00Z', end: '2026-10-12T08:30:00Z' },
    { start: '2026-10-13T13:00:00Z', end: '2026-10-13T14:30:00Z' },
  ]);
  assert.equal(flameMinutes(tasks[0], blocks), 120);
  assert.equal(flameMinutes(tasks[0]), 90);
  assert.equal(flameMinutes(tasks[0], []), 90);
  assert.equal(flameMinutes(tasks[1]), null);
  // Der Tag ist der des ersten Blocks.
  const [row] = flameRows([tasks[0]], { tz, blocks: new Map([['f1', blocks]]) });
  assert.deepEqual([row.day, row.measured], ['Mo 12.10.', '120']);
});

test('Plan: Marker einfügen, aktuell lassen, ersetzen, von Hand Geändertes und kaputte Marker nicht anfassen', () => {
  const note = feuerNote();
  const inner = renderFlameTable(flameRows(tasks, { tz }));
  const insert = planFlameUpdate(note, inner);
  assert.equal(insert.action, 'insert');
  assert.match(insert.text, /^\n<!-- cockpit:flammen:start[^\n]*-->\n\| Tag[^]*\n<!-- cockpit:flammen:ende [0-9a-f]{8} -->$/);
  // Ohne Flammen keine neuen Marker, ohne Abschnitt gar nichts.
  assert.equal(planFlameUpdate(note, 'x', { hasRows: false }).action, 'keep');
  assert.equal(planFlameUpdate('# Ohne\n\n## Notizen\n', inner).action, 'skip');

  const withBlock = note.replace('## Notizen', `${flameBlock(inner)}\n\n## Notizen`);
  assert.equal(planFlameUpdate(withBlock, inner).action, 'keep');
  const replace = planFlameUpdate(withBlock, 'Keine Flammen für diese Woche in Zunder.');
  assert.equal(replace.action, 'replace');
  assert.equal(replace.oldText, flameBlock(inner));

  // Von Hand im Bereich geschrieben: Prüfsumme passt nicht mehr.
  const edited = withBlock.replace('| 90 |', '| 95 |');
  assert.match(planFlameUpdate(edited, inner).reason, /von Hand/);
  // Leerer Bereich (zum Neuschreiben geleert) darf neu gefüllt werden.
  const emptied = note.replace('## Notizen', '<!-- cockpit:flammen:start -->\n<!-- cockpit:flammen:ende -->\n\n## Notizen');
  assert.equal(planFlameUpdate(emptied, inner).action, 'replace');
  // Doppelte oder halbe Marker.
  assert.equal(planFlameUpdate(`${withBlock}\n${flameBlock(inner)}\n`, inner).action, 'skip');
  assert.equal(planFlameUpdate(note.replace('## Notizen', '<!-- cockpit:flammen:start -->\n## Notizen'), inner).action, 'skip');

  // CRLF bleibt CRLF.
  const crlf = withBlock.replace(/\n/g, '\r\n');
  const r = planFlameUpdate(crlf, 'neu');
  assert.equal(r.action, 'replace');
  assert.ok(crlf.includes(r.oldText));
  assert.ok(!/[^\r]\n/.test(r.newText));
});

test('Lauf: Marker ans Ende von „## Flammen“, Vorlage und Handtext bleiben, nur bei Änderung schreiben', async () => {
  const before = read(FEUER);
  const r = await svc.update('2026-W42');
  assert.equal(r.state, 'geschrieben');
  assert.deepEqual(calls[0], { phoenix_fire: '2026-W42', include_closed: true, limit: 200 });
  const text = read(FEUER);
  // Alles von vorher steht noch da, der Bereich sitzt zwischen Vorlagen-Tabelle und „## Notizen“.
  const [head, tail] = before.split('## Notizen');
  assert.ok(text.startsWith(head.trimEnd()));
  assert.ok(text.endsWith(`## Notizen${tail}`));
  assert.match(text, /\|---\|-----\|---------\|-------\|--------\|\n\n<!-- cockpit:flammen:start[^]*\| Di 13\.10\. \| \[Folien[^]*\| 90 \| erledigt \|[^]*\| \[Steuer\][^]*<!-- cockpit:flammen:ende [0-9a-f]{8} -->\n\n## Notizen\n\nVon Hand\.\n$/);
  assert.ok(!text.includes('Verworfen') && !text.includes('Schritt'));
  assert.equal(svc.status().lastWrite.path, FEUER);

  // Zweiter Lauf ohne Änderung in Zunder: kein Schreibvorgang.
  const written = svc.status().lastWrite;
  assert.equal((await svc.update('2026-W42')).state, 'aktuell');
  assert.equal(svc.status().lastWrite, written);
  assert.equal(read(FEUER), text);

  // Handtext außerhalb der Marker, dann neue Zeit aus Zunder: nur der Bereich ändert sich.
  writeFileSync(join(root, FEUER), text.replace('Von Hand.', 'Von Hand, später ergänzt.'));
  tasks[1] = { ...tasks[1], status: 'done', flame_started_at: '2026-10-15T07:00:00Z', flame_ended_at: '2026-10-15T07:45:00Z' };
  assert.equal((await svc.update('2026-W42')).state, 'geschrieben');
  const next = read(FEUER);
  assert.match(next, /\| Do 15\.10\. \| \[Steuer\][^|]*\| Do 15\.10\. \| 45 \| erledigt \|/);
  assert.match(next, /Von Hand, später ergänzt\./);
  assert.equal(next.match(/cockpit:flammen:start/g).length, 1);
});

test('Lauf: von Hand im Bereich geändert oder gleichzeitig vom Sync geändert → abbrechen, nichts überschreiben', async () => {
  await svc.update('2026-W42');
  const edited = read(FEUER).replace('| 90 |', '| 100 |');
  writeFileSync(join(root, FEUER), edited);
  tasks[1] = { ...tasks[1], status: 'done' };
  const r = await svc.update('2026-W42');
  assert.equal(r.state, 'fehler');
  assert.match(svc.status().lastError.message, /von Hand/);
  assert.equal(read(FEUER), edited);

  // Sync schreibt zwischen Planen und Schreiben in den Bereich: der Editor findet den alten Text nicht mehr.
  writeFileSync(join(root, FEUER), feuerNote());
  await svc.update('2026-W42');
  const synced = read(FEUER).replace('| 90 |', '| 91 |');
  const racing = { ...editor, replace: (args) => (writeFileSync(join(root, FEUER), synced), editor.replace(args)) };
  tasks[1] = { ...tasks[1], status: 'blocked' };
  const raced = await make({ editor: racing }).update('2026-W42');
  assert.equal(raced.state, 'fehler');
  assert.equal(read(FEUER), synced);
});

test('Lauf: zweimal gebrannte Flamme zeigt die Summe, der Verlauf wird nur bei Änderung gefragt (VCP-61)', async () => {
  const asked = [];
  const history = {
    f1: [
      { seq: 1, field: 'flame_started_at', value: '2026-10-12T08:00:00Z' },
      { seq: 2, field: 'flame_ended_at', value: '2026-10-12T08:30:00Z' },
      { seq: 3, field: 'flame_started_at', value: '2026-10-13T13:00:00Z' },
      { seq: 4, field: 'flame_ended_at', value: null },
      { seq: 5, field: 'flame_ended_at', value: '2026-10-13T14:30:00Z' },
    ],
  };
  const withHistory = { ...zunder, async taskHistory(id) { asked.push(id); return history[id] ?? []; } };
  const note = make({ zunder: () => withHistory });
  assert.equal((await note.update('2026-W42')).state, 'geschrieben');
  assert.match(read(FEUER), /\| Mo 12\.10\. \| \[Folien[^\n]*\| 120 \| erledigt \|/);
  assert.deepEqual(asked, ['f1']);
  assert.equal((await note.update('2026-W42')).state, 'aktuell');
  assert.deepEqual(asked, ['f1']);

  // Verlauf nicht abrufbar: der letzte Block wie bisher.
  const broken = { ...zunder, async taskHistory() { throw new Error('HTTP 500'); } };
  writeFileSync(join(root, FEUER), feuerNote());
  await make({ zunder: () => broken }).update('2026-W42');
  assert.match(read(FEUER), /\| 90 \| erledigt \|/);
});

test('Lauf: dieselbe Warnung nur einmal ins Log, nach einem guten Lauf wieder (VCP-61)', async () => {
  const warnings = [];
  const note = make({ logger: { ...quiet, warn: (m) => warnings.push(m) } });
  await note.update('2026-W42');
  const edited = read(FEUER).replace('| 90 |', '| 100 |');
  writeFileSync(join(root, FEUER), edited);
  tasks[1] = { ...tasks[1], status: 'done' };
  for (let i = 0; i < 3; i++) assert.equal((await note.update('2026-W42')).state, 'fehler');
  assert.equal(warnings.length, 1);
  assert.match(note.status().lastError.message, /von Hand/);
});

test('Lauf: aus in den Einstellungen, ohne Feuer-Notiz, ohne Zunder oder vertraulich → nichts schreiben, nichts anlegen', async () => {
  const before = read(FEUER);
  settings.save({ flameNote: { enabled: false }, calendars: [] });
  assert.equal(settings.get().flameNote.enabled, false);
  assert.equal((await svc.update('2026-W42')).state, 'aus');
  assert.equal(calls.length, 0);
  settings.save({ flameNote: { enabled: null }, calendars: [] });
  assert.equal(settings.get().flameNote.enabled, true);

  // Woche ohne Feuer-Notiz: keine angelegt.
  tasks.push({ id: 'f9', title: 'Später', status: 'open', due: '2026-10-20', phoenix: { fire: '2026-W43', role: 'flamme' } });
  assert.equal((await svc.update('2026-W43')).state, 'übersprungen');
  assert.deepEqual(readdirSync(join(root, '20-bereiche/Phönix/feuer')), ['Feuer W3 - 2026-Q4.md']);

  assert.equal((await make({ zunder: () => null }).update('2026-W42')).state, 'ruht');

  // Feuer-Notiz in einem vertraulichen Ordner.
  const secret = '20-bereiche/Gesundheit/Feuer W3.md';
  rmSync(join(root, FEUER));
  idx.refresh(FEUER);
  put(secret, feuerNote());
  assert.equal((await svc.update('2026-W42')).state, 'übersprungen');
  assert.equal(read(secret), feuerNote());
  assert.equal(before, feuerNote());
});

test('Intervall: laufende und vorige Woche; nach Stopp die Woche der Flamme', async () => {
  const results = await svc.round();
  // W41 hat keine Feuer-Notiz: übersprungen, ohne Zunder zu fragen.
  assert.deepEqual(calls.map((c) => c.phoenix_fire), ['2026-W42']);
  assert.deepEqual(results.map((r) => [r.state, r.week]), [['übersprungen', '2026-W41'], ['geschrieben', '2026-W42']]);

  // Flamme einer anderen Woche → deren Notiz; ohne Phönix-Woche → die laufende.
  const other = await svc.afterFlame({ id: 'f9', phoenix: { fire: '2026-W43', role: 'flamme' } });
  const plain = await svc.afterFlame({ id: 'r1', phoenix: null });
  assert.deepEqual([other.week, plain.week, plain.state], ['2026-W43', '2026-W42', 'aktuell']);
});

test('Aktion: Stopp im Cockpit stößt die Feuer-Notiz an', async () => {
  const seen = [];
  const stopped = { id: 'f2', title: 'Steuer', status: 'open', phoenix: flamme, flame_started_at: '2026-10-14T07:00:00Z', flame_ended_at: '2026-10-14T07:42:00Z' };
  const z = { stopFlame: async () => ({ task: stopped, running: false, timing: {} }), startFlame: async () => ({ task: { ...stopped, flame_running: true }, running: true, timing: {} }) };
  const actions = createCockpitActions({ vaultPath: root, settings, policy, state: createStateStore(null), zunder: () => z, onFlame: (task, on) => seen.push([task.id, on]), logger: quiet });
  await actions.flame('f2', false);
  await actions.flame('f2', true);
  assert.deepEqual(seen, [['f2', false], ['f2', true]]);
});
