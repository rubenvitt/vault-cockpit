import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildIndex, openIndex } from '../src/vault/index.js';
import { compilePolicy } from '../src/vault/policy.js';
import { createEditor } from '../src/vault/edit.js';
import { createNoteDesk } from '../src/cockpit/notes.js';
import { createSettingsStore } from '../src/cockpit/settings.js';
import { createCockpitActions, ActionError } from '../src/cockpit/actions.js';
import { createStateStore } from '../src/capture/state.js';
import { hybridSearch } from '../src/semantic/search.js';
import { openPoints } from '../src/web/synthesis-render.js';
import { renderNote } from '../src/web/note-render.js';
import { wissenView, renderWissen } from '../src/web/wissen-page.js';

const quiet = { info() {}, warn() {}, error() {} };
const policy = compilePolicy({ sensitive: { privat: 'privat' } });
let root, index, desk;

const SYNTHESE = `---
type: synthesis
art: querverbindung
status: entwurf
confidence: mittel
summary: Gute Struktur ersetzt Willenskraft, wenn die Umgebung das Richtige leicht macht.
updated: 2026-10-20
---
# Architektur statt Disziplin

## Umgebung schlägt Vorsatz
Wo Struktur fehlt, muss Willenskraft alles tragen. [TODO Quelle zu Ego-Depletion prüfen]

## Reibung gezielt setzen
Text mit [[TODO kein Punkt]].

## Offene Punkte
- [ ] Beispiel aus dem [[Alltag]] ergänzen
- [x] Schon erledigt
- Gegenposition suchen

\`\`\`
[TODO im Code zählt nicht]
\`\`\`

## Quellen
- Keine offene Frage
`;

function put(rel, text) {
  mkdirSync(join(root, rel, '..'), { recursive: true });
  writeFileSync(join(root, rel), text);
}

before(() => {
  root = mkdtempSync(join(tmpdir(), 'vault-synthesis-'));
  put('wiki/synthesis/Architektur statt Disziplin.md', SYNTHESE);
  put('wiki/synthesis/Gewohnheiten.md', '---\ntype: synthesis\nart: vertiefung\nstatus: reif\nupdated: 2026-09-01\n---\n# Gewohnheiten\n\nKleine Schritte.\n');
  put('wiki/synthesis/Ohne Datum.md', '---\ntype: synthesis\n---\n# Ohne Datum\n\nNoch roh.\n');
  put('wiki/concepts/Willenskraft.md', '---\ntype: concept\n---\n# Willenskraft\n\nWo hilft Willenskraft mehr als Struktur? Willenskraft, Struktur, Struktur.\n');
  put('privat/Geheime Synthese.md', '---\ntype: synthesis\nart: querverbindung\nupdated: 2026-10-22\n---\n# Geheime Synthese\n\nWo hilft Struktur mehr als Willenskraft?\n');
  buildIndex({ vaultPath: root, dbPath: ':memory:', policy, logger: quiet, persist: (db, vp) => (index = openIndex(db, { vaultPath: vp, policy })) });
  const settings = createSettingsStore({ defaults: { inboxFolder: 'inbox' }, logger: quiet });
  desk = createNoteDesk({ index, editor: createEditor({ vaultPath: root, index }), policy, settings });
});
after(() => {
  index.close();
  rmSync(root, { recursive: true, force: true });
});

test('openPoints: [TODO …] im Text und offene Einträge unter „Offene Punkte“, ohne Code, Erledigtes und Doppelte', () => {
  assert.deepEqual(openPoints(SYNTHESE), ['Quelle zu Ego-Depletion prüfen', 'Beispiel aus dem Alltag ergänzen', 'Gegenposition suchen']);
  assert.deepEqual(openPoints('### Offene Punkte:\n- A\n#### Unterpunkt\n- B\n### Weiter\n- C [TODO: D]\n- [TODO: D]'), ['A', 'B', 'D']);
  assert.deepEqual(openPoints('Erst [TODO:Quelle] und [TODO] ohne Text.'), ['Quelle']);
  assert.deepEqual(openPoints(''), []);
});

const search = (query, opts) => hybridSearch({ index, query, limit: 30, ...opts });

test('/wissen: Frage findet die Synthese, Filter nach Querverbindung und Status, vertrauliche bleiben draußen', async () => {
  const m = await wissenView({ notes: desk, search }, { q: 'Wo hilft Struktur mehr als Willenskraft?' });
  assert.equal(m.hits[0].title, 'Architektur statt Disziplin');
  assert.ok(!m.hits.some((h) => h.path.startsWith('privat/') || h.path.includes('concepts')));
  assert.equal(m.total, 3);
  assert.deepEqual(m.recent.map((n) => n.title), ['Architektur statt Disziplin', 'Gewohnheiten', 'Ohne Datum']);
  assert.deepEqual(m.arts, ['querverbindung', 'vertiefung']);
  assert.deepEqual(m.statuses, ['entwurf', 'reif']);

  const filtered = await wissenView({ notes: desk, search }, { art: 'vertiefung' });
  assert.equal(filtered.hits, null);
  assert.deepEqual(filtered.recent.map((n) => n.title), ['Gewohnheiten']);
  const draft = await wissenView({ notes: desk, search }, { q: 'Struktur', status: 'reif' });
  assert.deepEqual(draft.hits, []);

  const html = renderWissen(m);
  assert.match(html, /<form method="get" action="\/wissen"/);
  assert.match(html, /<option>querverbindung<\/option><option>vertiefung<\/option>/);
  assert.match(html, /<a href="\/notiz\?pfad=wiki%2Fsynthesis%2FArchitektur%20statt%20Disziplin\.md">Architektur statt Disziplin<\/a>/);
  assert.ok(!html.includes('Geheime'));
  assert.ok(!/style=|<script>/.test(html), 'keine Inline-Styles oder -Skripte');
});

test('Notizseite einer Synthese: Zusammenfassung, Chips, Thesen als Sprungmarken, offene Punkte, Knopf nur mit Zunder', () => {
  const note = desk.get('wiki/synthesis/Architektur statt Disziplin.md');
  const write = { csrf: 'c', captureId: 'x', notes: true, plan: false };
  const html = renderNote(note, { write, back: '/notiz', zunder: true });
  const head = html.slice(html.indexOf('<section class="synth-head">'), html.indexOf('<details class="fm">'));
  assert.match(head, /<p class="synth-summary">Gute Struktur ersetzt Willenskraft/);
  assert.match(head, /Status<\/span> entwurf[^]*Vertrauen<\/span> mittel/);
  assert.match(head, /<li><a href="#h-umgebung-schlägt-vorsatz">Umgebung schlägt Vorsatz<\/a><\/li>/);
  assert.match(html, /<h3 id="h-umgebung-schlägt-vorsatz">/);
  assert.match(head, /<li>Quelle zu Ego-Depletion prüfen<\/li><li>Beispiel aus dem Alltag ergänzen<\/li><li>Gegenposition suchen<\/li>/);
  assert.match(head, /action="\/aktion\/synthese\/aufgaben"[^]*name="pfad" value="wiki\/synthesis\/Architektur statt Disziplin\.md"[^]*Als Aufgaben nach Zunder/);

  assert.ok(!renderNote(note, { write, zunder: false }).includes('Als Aufgaben nach Zunder'), 'ohne Zunder kein Knopf');
  assert.ok(!renderNote(note, { write: null, zunder: true }).includes('Als Aufgaben nach Zunder'), 'ohne Schreibrecht kein Knopf');
  assert.ok(!renderNote(desk.get('wiki/concepts/Willenskraft.md'), { write, zunder: true }).includes('synth-head'), 'nur Synthesen');
  assert.equal(desk.get('privat/Geheime Synthese.md'), null);
});

test('Als Aufgaben nach Zunder: je Punkt eine Aufgabe, zweimal klicken legt nichts doppelt an', async () => {
  const created = [];
  let fail = false;
  const zunder = {
    async createTask(t) {
      if (fail) throw new Error('Zunder antwortet mit HTTP 500');
      created.push(t);
      return { id: `z${created.length}`, ref: `ZUN-${created.length}`, url: `https://zunder.test/#/aufgabe/z${created.length}` };
    },
  };
  const state = createStateStore();
  const actions = createCockpitActions({ vaultPath: root, settings: createSettingsStore({ defaults: {}, logger: quiet }), policy, state, zunder: () => zunder, logger: quiet });
  const path = 'wiki/synthesis/Architektur statt Disziplin.md';

  // Zwei gleichzeitige Klicks.
  const [a, b] = await Promise.all([actions.synthesisTasks({ path, points: ['A', 'B'] }), actions.synthesisTasks({ path, points: ['A', 'B'] })]);
  assert.deepEqual(a, { created: 2, existing: 0 });
  assert.deepEqual(b, { created: 0, existing: 2 });
  assert.deepEqual(created.map((t) => t.title), ['A', 'B']);
  assert.deepEqual(created[0].vaultLinks, [path]);
  assert.match(created[0].description, /\[\[wiki\/synthesis\/Architektur statt Disziplin\]\]/);

  // Neuer Punkt kommt dazu; ein Fehler bei Zunder verliert nichts und doppelt nichts.
  fail = true;
  await assert.rejects(actions.synthesisTasks({ path, points: ['A', 'B', 'C'] }), (err) => err instanceof ActionError && err.status === 502);
  fail = false;
  assert.deepEqual(await actions.synthesisTasks({ path, points: ['A', 'B', 'C'] }), { created: 1, existing: 2 });
  assert.deepEqual(created.map((t) => t.title), ['A', 'B', 'C']);

  const none = createCockpitActions({ vaultPath: root, settings: createSettingsStore({ defaults: {}, logger: quiet }), policy, state, zunder: () => null, logger: quiet });
  await assert.rejects(none.synthesisTasks({ path, points: ['D'] }), (err) => err.status === 503);
});
