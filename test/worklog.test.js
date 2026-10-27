import { test } from 'node:test';
import assert from 'node:assert/strict';
import { logStep, logTool, worklogHtml, worklogJson } from '../src/lesen/worklog.js';

test('Worklog: gleichartige Aufrufe hintereinander werden eine Zeile, Schritte bleiben einzeln', () => {
  const log = [];
  const at = new Date('2026-10-27T08:40:00Z');
  logStep(log, 'Claude startet', at);
  logStep(log, 'Claude startet', at);
  for (const p of ['a/Eins.md', 'b/Zwei.md', 'b/Zwei.md', 'c/Drei.md', 'd/Vier.md', 'e/Fünf.md']) logTool(log, 'mcp__vault__vault_read', { path: p }, at);
  logTool(log, 'WebSearch', { query: 'Hundetraining   Rückruf' }, at);
  logTool(log, 'WebFetch', { url: 'https://www.example.org/x?y=1' }, at);
  logTool(log, 'mcp__vault__vault_append', { path: 'wiki/x.md', text: 'geheim' }, at);
  logTool(log, 'Unbekannt', {}, at);
  assert.deepEqual(worklogJson(log).map((e) => e.text), [
    'Claude startet',
    'Liest „Eins“, „Zwei“, „Drei“ und 2 weitere',
    'Sucht im Internet nach „Hundetraining Rückruf“',
    'Liest im Internet: example.org',
    'Ergänzt „x“',
    'Nutzt Unbekannt',
  ]);
  assert.equal(logStep(null, 'x'), null, 'ohne Log nichts');
  for (let i = 0; i < 50; i += 1) logStep(log, `Schritt ${i}`, at);
  assert.equal(log.length, 40, 'ältere fallen weg');
  assert.equal(log.at(-1).text, 'Schritt 49');
});

test('Worklog: HTML ausklappbar, maskiert, Zeit in der Zeitzone, leer ohne Einträge', () => {
  const log = [];
  logTool(log, 'mcp__vault__vault_search', { query: '<script>' }, new Date('2026-10-27T08:40:00Z'));
  const html = worklogHtml(log, { tz: 'Europe/Berlin', live: true });
  assert.match(html, /^<details class="worklog" data-worklog><summary>Worklog <span class="meta">· 1 Schritt<\/span><\/summary>/);
  assert.match(html, /<time datetime="2026-10-27T08:40:00.000Z">09:40<\/time>/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /<li aria-current="step">/);
  assert.equal(worklogHtml([]), '');
  assert.equal(worklogHtml(undefined), '');
});
