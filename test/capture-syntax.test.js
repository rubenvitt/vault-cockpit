import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseTaskLine, resolveTask, matchTarget, targetsOf, dateToken, dueText, previewLine } from '../src/capture/syntax.js';
import { createCaptureRouter, createStructureCache } from '../src/capture/router.js';
import { createCaptureHttp } from '../src/capture/http.js';
import { createCapture } from '../src/vault/capture.js';
import { createStateStore } from '../src/capture/state.js';
import { createApp } from '../src/http/app.js';

const quiet = { info() {}, warn() {}, error() {} };
// Mittwoch, 14.10.2026, KW 42 (12 Uhr in Berlin).
const NOW = new Date('2026-10-14T10:00:00Z');
const TODAY = '2026-10-14';

const AREAS = [
  { id: 'a-ges', name: 'Gesundheit', state: 'active', projects: [] },
  { id: 'a-bw', name: 'Berufliche Weiterentwicklung', state: 'active', projects: [] },
  { id: 'a-pw', name: 'Persönliche Weiterentwicklung', state: 'active', projects: [] },
  {
    id: 'a-drk',
    name: 'Ehrenamt (DRK Bereitschaft)',
    state: 'active',
    projects: [
      { id: 'p-ik', name: 'Gruppe I&K', status: 'active', kind: 'standard', key: null },
      { id: 'p-aik', name: 'Ausbildung I&K', status: 'active', kind: 'standard', key: null },
      { id: 'p-uav', name: 'Ausbildung UAV', status: 'active', kind: 'standard', key: null },
    ],
  },
  { id: 'a-prog', name: 'Programmieren', state: 'active', projects: [{ id: 'p-vcp', name: 'Vault Cockpit', status: 'active', kind: 'dev', key: 'VCP' }] },
  { id: 'a-haus', name: 'Zuhause', state: 'active', projects: [{ id: 'p-alt', name: 'Gesundheitscheck', status: 'done', kind: 'standard' }] },
  { id: 'a-weg', name: 'Sport', state: 'archived', projects: [] },
];

const plan = (line, areas = AREAS) => resolveTask(parseTaskLine(line, { today: TODAY }), { fire: '2026-W42', areas });

// --- Fälligkeit -------------------------------------------------------------

test('Syntax: Abnahme-Beispiel „Zahnarzt anrufen morgen #gesundheit“', () => {
  const p = plan('Zahnarzt anrufen morgen #gesundheit');
  assert.equal(p.title, 'Zahnarzt anrufen');
  assert.equal(p.due, '2026-10-15');
  assert.deepEqual(p.location, { kind: 'area', id: 'a-ges', name: 'Gesundheit' });
  assert.deepEqual(p.notes, []);
  assert.equal(p.phoenix, null);
});

test('Syntax: heute, morgen, übermorgen und Wochentage ab morgen', () => {
  assert.equal(dateToken('heute', TODAY).due, '2026-10-14');
  assert.equal(dateToken('Heute', TODAY).due, '2026-10-14');
  assert.equal(dateToken('morgen', TODAY).due, '2026-10-15');
  assert.equal(dateToken('übermorgen', TODAY).due, '2026-10-16');
  assert.equal(dateToken('Freitag', TODAY).due, '2026-10-16');
  assert.equal(dateToken('donnerstag', TODAY).due, '2026-10-15');
  // Heute ist Mittwoch: „Mittwoch“ meint den nächsten, nicht heute.
  assert.equal(dateToken('Mittwoch', TODAY).due, '2026-10-21');
  assert.equal(dateToken('Dienstag', TODAY).due, '2026-10-20');
  // Über den Jahreswechsel.
  assert.equal(dateToken('Montag', '2026-12-31').due, '2027-01-04');
});

test('Syntax: Datum ohne Jahr ist dieses Jahr, liegt es zurück, nächstes', () => {
  assert.equal(dateToken('14.10.', TODAY).due, '2026-10-14', 'heute liegt nicht zurück');
  assert.equal(dateToken('1.11.', TODAY).due, '2026-11-01');
  assert.equal(dateToken('13.10.', TODAY).due, '2027-10-13');
  assert.equal(dateToken('14.10.2027', TODAY).due, '2027-10-14');
  assert.equal(dateToken('3.1.27', TODAY).due, '2027-01-03');
  assert.equal(dateToken('29.02.', TODAY).due, '2028-02-29', 'den 29.02. gibt es erst 2028 wieder');
  assert.deepEqual(dateToken('31.02.', TODAY), { invalid: true });
  assert.equal(dateToken('14.10', TODAY), null, 'ohne Schlusspunkt kein Datum');
});

test('Syntax: nur am Ende der Titelzeile, mitten im Satz bleibt alles Text', () => {
  for (const line of ['Termin für morgen vorbereiten', 'Kuchen für morgen', 'Joggen am morgen', 'Guten Morgen', 'Training ab Montag', 'Müll jeden Freitag', 'Bericht morgen früh', 'Notiz zu #gesundheit lesen']) {
    const p = plan(line);
    assert.equal(p.title, line, line);
    assert.equal(p.due, null, line);
    assert.equal(p.location, null, line);
  }
});

test('Syntax: „bis“ und „am“ vor der Fälligkeit fallen mit weg', () => {
  assert.deepEqual([plan('Bericht abgeben bis Freitag').title, plan('Bericht abgeben bis Freitag').due], ['Bericht abgeben', '2026-10-16']);
  assert.deepEqual([plan('Treffen am 20.10.').title, plan('Treffen am 20.10.').due], ['Treffen', '2026-10-20']);
  assert.deepEqual([plan('Steuer bis morgen').title, plan('Steuer bis morgen').due], ['Steuer', '2026-10-15']);
  // „am morgen“ ist der Morgen, kein Datum.
  assert.equal(plan('Laufen am morgen').due, null);
});

test('Syntax: das erste Wort ist immer Titel', () => {
  assert.deepEqual([plan('morgen').title, plan('morgen').due], ['morgen', null]);
  assert.deepEqual([plan('#gesundheit').title, plan('#gesundheit').location], ['#gesundheit', null]);
  assert.equal(plan('Morgen morgen').due, '2026-10-15');
});

test('Syntax: zwei Fälligkeiten und ungültige Daten werden nicht geraten', () => {
  const two = plan('Anruf Freitag morgen');
  assert.equal(two.title, 'Anruf Freitag morgen');
  assert.equal(two.due, null);
  assert.match(two.notes[0], /Zwei Fälligkeiten/);
  const bad = plan('Abgabe 31.02.');
  assert.equal(bad.title, 'Abgabe 31.02.');
  assert.equal(bad.due, null);
  assert.match(bad.notes[0], /31\.02\. ist kein gültiges Datum/);
});

test('Syntax: +woche ist ein Phönix-Schritt der laufenden Woche', () => {
  const p = plan('Folien bauen +woche morgen');
  assert.equal(p.title, 'Folien bauen');
  assert.deepEqual(p.phoenix, { role: 'feuer_schritt', fire: '2026-W42' });
  assert.equal(p.due, '2026-10-15');
  assert.equal(plan('Folien +Woche').phoenix.fire, '2026-W42');
  assert.equal(plan('Folien +wochen').phoenix, null);
});

test('Syntax: Satzzeichen am Zeilenende stören nicht (VCP-62)', () => {
  const p = plan('Zahnarzt anrufen morgen.');
  assert.equal(p.title, 'Zahnarzt anrufen');
  assert.equal(p.due, '2026-10-15');
  assert.equal(plan('Folien bauen bis Freitag!').due, '2026-10-16');
  assert.equal(plan('Folien bauen bis Freitag!').title, 'Folien bauen');
  assert.equal(plan('Folien bauen +woche.').phoenix.fire, '2026-W42');
  assert.equal(plan('Arzt anrufen morgen #gesundheit.').location.id, 'a-ges');
  // Der Punkt gehört zum Datum.
  assert.equal(plan('Abgabe 16.10.').due, '2026-10-16');
  assert.equal(plan('Abgabe 16.10.!').due, '2026-10-16');
  assert.equal(plan('Abgabe 16.10.,').title, 'Abgabe');
  // Kein Kürzel: der Satz bleibt, wie er ist.
  assert.equal(plan('Zahnarzt anrufen.').title, 'Zahnarzt anrufen.');
  assert.equal(plan('Termin für morgen.').title, 'Termin für morgen.');
  assert.equal(plan('Termin für morgen.').due, null);
});

// --- Ziel -------------------------------------------------------------------

test('Ziel: exakt, Schlüssel, Anfang, Wortanfang und Tippfehler', () => {
  const targets = targetsOf(AREAS);
  assert.equal(matchTarget('gesundheit', targets).target.id, 'a-ges');
  assert.equal(matchTarget('Gesundheit', targets).target.id, 'a-ges');
  assert.equal(matchTarget('vcp', targets).target.id, 'p-vcp');
  assert.equal(matchTarget('ehrenamt', targets).target.id, 'a-drk');
  assert.equal(matchTarget('gruppe-ik', targets).target.id, 'p-ik');
  assert.equal(matchTarget('cockpit', targets).target.id, 'p-vcp');
  assert.equal(matchTarget('drk', targets).target.id, 'a-drk');
  assert.equal(matchTarget('gesundhiet', targets).target.id, 'a-ges', 'Vertauschung');
  assert.equal(matchTarget('persoenliche', targets).target.id, 'a-pw');
  assert.equal(matchTarget('persönliche', targets).target.id, 'a-pw');
});

test('Ziel: mehrdeutig, unbekannt, archiviert und abgeschlossen', () => {
  const targets = targetsOf(AREAS);
  assert.deepEqual(matchTarget('weiterentwicklung', targets).ambiguous.map((t) => t.id), ['a-bw', 'a-pw']);
  assert.deepEqual(matchTarget('ausbildung', targets).ambiguous.map((t) => t.id), ['p-aik', 'p-uav']);
  assert.equal(matchTarget('ge', targets).none, true, 'zu kurz zum Raten');
  assert.equal(matchTarget('sport', targets).none, true, 'archivierter Bereich');
  assert.equal(matchTarget('gesundheitscheck', targets).none, true, 'abgeschlossenes Projekt zählt nicht');
});

test('Ziel: mehrdeutig landet in der Inbox, das Kürzel bleibt im Titel und die Meldung sagt warum', () => {
  const p = plan('Kurs buchen #weiterentwicklung');
  assert.equal(p.location, null);
  assert.equal(p.title, 'Kurs buchen #weiterentwicklung');
  assert.equal(p.notes[0], '#weiterentwicklung passt zu mehreren Zielen (Berufliche Weiterentwicklung, Persönliche Weiterentwicklung).');
  const none = plan('Kurs buchen #yoga');
  assert.equal(none.title, 'Kurs buchen #yoga');
  assert.match(none.notes[0], /#yoga passt zu keinem Bereich/);
});

test('Ziel: Bereich plus eigenes Projekt ist das Projekt, zwei fremde Ziele ein Widerspruch', () => {
  const p = plan('Funkgeräte prüfen #ehrenamt #gruppe-ik');
  assert.equal(p.title, 'Funkgeräte prüfen');
  assert.equal(p.location.id, 'p-ik');
  assert.equal(p.location.area_name, 'Ehrenamt (DRK Bereitschaft)');
  const clash = plan('Etwas #gesundheit #vcp');
  assert.equal(clash.location, null);
  assert.equal(clash.title, 'Etwas #gesundheit #vcp');
  assert.match(clash.notes[0], /zeigen auf verschiedene Ziele/);
  // Ein unbekanntes Kürzel neben einem bekannten: das bekannte gilt, das andere bleibt Text.
  const mixed = plan('Zahnarzt #gesundheit #dringend');
  assert.equal(mixed.location.id, 'a-ges');
  assert.equal(mixed.title, 'Zahnarzt #dringend');
});

test('Ziel: ohne Struktur bleibt alles Text, Nummern sind keine Ziele', () => {
  const p = resolveTask(parseTaskLine('Zahnarzt morgen #gesundheit', { today: TODAY }), { fire: '2026-W42', areas: null });
  assert.equal(p.title, 'Zahnarzt #gesundheit');
  assert.equal(p.due, '2026-10-15');
  assert.match(p.notes[0], /nicht abrufbar, #gesundheit bleibt im Titel/);
  assert.equal(plan('Siehe Issue #42').title, 'Siehe Issue #42');
  assert.equal(plan('Siehe Issue #42').notes.length, 0);
});

test('Meldungen: Fälligkeit relativ zu heute, Vorschau wie im Ticket', () => {
  assert.equal(dueText('2026-10-14', TODAY), 'heute');
  assert.equal(dueText('2026-10-15', TODAY), 'morgen');
  assert.equal(dueText('2026-10-16', TODAY), 'Fr 16.10.');
  assert.equal(dueText('2027-10-13', TODAY), 'Mi 13.10.2027');
  assert.equal(previewLine({ dueLabel: 'morgen', location: { kind: 'area', name: 'Gesundheit' } }), 'Aufgabe · morgen · Gesundheit');
  assert.equal(previewLine({ dueLabel: '', location: null, phoenix: { fire: '2026-W42' } }), 'Aufgabe · Inbox · Phönix-Schritt KW 42');
});

// --- Router und /capture ----------------------------------------------------

let root, capture, state, calls, structureCalls, structureFail;

function fakeZunder() {
  return {
    async createTask(args) {
      calls.push(args);
      return { id: `t${calls.length}`, ref: `ZUN-${calls.length}`, url: `https://zunder.test/#/aufgabe/t${calls.length}` };
    },
    async listStructure() {
      structureCalls++;
      if (structureFail) throw new Error('Zunder antwortet mit HTTP 502');
      return AREAS;
    },
  };
}

const makeRouter = (zunder = fakeZunder(), extra = {}) =>
  createCaptureRouter({ capture, zunder, state, tz: 'Europe/Berlin', now: () => NOW, structure: createStructureCache(), logger: quiet, ...extra });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'capture-syntax-'));
  capture = createCapture({ vaultPath: root, folder: 'inbox', now: () => NOW });
  state = createStateStore(null);
  calls = [];
  structureCalls = 0;
  structureFail = false;
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

test('Router: legt die Aufgabe mit Fälligkeit und Stelle an', async () => {
  const r = await makeRouter().route({ text: '!Zahnarzt anrufen morgen #gesundheit\nNummer im Adressbuch', source: 'ios-kurzbefehl' });
  assert.equal(calls[0].title, 'Zahnarzt anrufen');
  assert.equal(calls[0].due, '2026-10-15');
  assert.deepEqual(calls[0].location, { kind: 'area', id: 'a-ges' });
  assert.equal(calls[0].phoenix, null);
  assert.match(calls[0].description, /^Nummer im Adressbuch\n\n_Erfasst über iOS-Kurzbefehl/);
  assert.equal(r.title, 'Zahnarzt anrufen');
  assert.equal(r.dueLabel, 'morgen');
  assert.deepEqual(r.location, { kind: 'area', id: 'a-ges', name: 'Gesundheit' });
});

test('Router: ohne Kürzel wie bisher, Zunder-Struktur wird gar nicht gefragt', async () => {
  const r = await makeRouter().route({ text: '!Paket abholen', source: 'api' });
  assert.equal(calls[0].title, 'Paket abholen');
  assert.equal(calls[0].location, null);
  assert.equal(calls[0].due, null);
  assert.deepEqual(r.location, { kind: 'inbox' });
  assert.equal(structureCalls, 0);
});

test('Router: Struktur wird kurz zwischengespeichert, Fehler nicht', async () => {
  let clock = 0;
  const zunder = fakeZunder();
  const router = makeRouter(zunder, { structure: createStructureCache({ ttlMs: 60_000, now: () => clock }) });
  await router.route({ text: '!Eins #gesundheit', source: 'api' });
  await router.route({ text: '!Zwei #gesundheit', source: 'api' });
  assert.equal(structureCalls, 1);
  clock = 61_000;
  await router.route({ text: '!Drei #gesundheit', source: 'api' });
  assert.equal(structureCalls, 2);

  structureFail = true;
  clock = 200_000;
  const r = await router.route({ text: '!Vier morgen #gesundheit', source: 'api' });
  assert.equal(calls.at(-1).title, 'Vier #gesundheit', 'Kürzel bleibt Text, Aufgabe entsteht trotzdem');
  assert.equal(calls.at(-1).location, null);
  assert.equal(calls.at(-1).due, '2026-10-15');
  assert.match(r.notes[0], /nicht abrufbar/);
  structureFail = false;
  await router.route({ text: '!Fünf #gesundheit', source: 'api' });
  assert.equal(calls.at(-1).location.id, 'a-ges', 'nach dem Fehler wird neu gefragt');
});

test('Router: Mail-Betreff und ausdrücklicher Titel bekommen die Syntax, Notizen nie', async () => {
  const router = makeRouter();
  await router.route({ text: '!Rechnung zahlen bis Freitag #vcp\nIm Anhang', source: 'mail' });
  assert.equal(calls[0].title, 'Rechnung zahlen');
  assert.equal(calls[0].due, '2026-10-16');
  assert.deepEqual(calls[0].location, { kind: 'project', id: 'p-vcp' });
  await router.route({ text: '!Details', title: 'Arzt heute', source: 'api' });
  assert.equal(calls[1].title, 'Arzt');
  assert.equal(calls[1].due, '2026-10-14');

  const note = await router.route({ text: 'Gedanke morgen #gesundheit', source: 'api' });
  assert.equal(note.kind, 'note');
  assert.match(readFileSync(join(root, note.path), 'utf8'), /\nGedanke morgen #gesundheit\n$/);
  assert.equal(structureCalls, 1, 'nur die Aufgabe mit #vcp hat gefragt');
  assert.equal(readdirSync(join(root, 'inbox')).length, 1);
});

test('Router: „heute“ gilt in der eingestellten Zeitzone', async () => {
  // 23:30 UTC am 18.10. ist in Berlin schon der 19.10.
  const router = makeRouter(fakeZunder(), { now: () => new Date('2026-10-18T22:30:00Z'), tz: () => 'Europe/Berlin' });
  await router.route({ text: '!Wäsche heute', source: 'api' });
  assert.equal(calls[0].due, '2026-10-19');
  await router.route({ text: '!Folien +woche', source: 'api' });
  assert.deepEqual(calls[1].phoenix, { role: 'feuer_schritt', fire: '2026-W43' });
});

test('Router: Vorschau legt nichts an und nutzt dieselbe Logik', async () => {
  const router = makeRouter();
  const p = await router.preview({ text: '!Zahnarzt anrufen morgen #gesundheit' });
  assert.equal(p.summary, 'Aufgabe · morgen · Gesundheit');
  assert.equal(p.title, 'Zahnarzt anrufen');
  assert.deepEqual(await router.preview({ text: 'Notiz morgen' }), { kind: 'note', summary: 'Notiz' });
  assert.equal((await router.preview({ text: '!' })).summary, 'Aufgabe');
  const amb = await router.preview({ text: '!Kurs #weiterentwicklung' });
  assert.equal(amb.summary, 'Aufgabe · Inbox');
  assert.match(amb.notes[0], /mehreren Zielen/);
  assert.equal(calls.length, 0);
  const off = await makeRouter(null).preview({ text: '!Kurs #gesundheit' });
  assert.match(off.notes[0], /Zunder ist nicht eingerichtet/);
});

test('/capture: message nennt Fälligkeit und Ziel, bei Mehrdeutigem den Grund', async () => {
  const router = makeRouter();
  const app = createApp({
    config: { publicUrl: 'https://vault.test', resource: 'https://vault.test/mcp', issuer: 'https://id.test', supportedScopes: [], allowedHosts: ['vault.test'], trustProxy: true },
    verifyToken: async () => {
      throw new Error('nicht benutzt');
    },
    mcpHandler: async () => {},
    captureHttp: createCaptureHttp({ token: 'capture-geheim', router, zunderEnabled: true }),
    logger: quiet,
  });
  app.listen(0, '127.0.0.1');
  await new Promise((res) => app.once('listening', res));
  const post = async (text) => {
    const res = await fetch(`http://127.0.0.1:${app.address().port}/capture?source=ios-kurzbefehl`, {
      method: 'POST',
      headers: { 'x-forwarded-host': 'vault.test', 'content-type': 'text/plain', authorization: 'Bearer capture-geheim' },
      body: text,
    });
    return res.json();
  };
  try {
    const ok = await post('!Zahnarzt anrufen morgen #gesundheit');
    assert.equal(ok.message, 'Aufgabe ZUN-1 liegt in Gesundheit, fällig morgen.');
    assert.equal(ok.location.name, 'Gesundheit');
    assert.equal(ok.due, '2026-10-15');

    const amb = await post('!Kurs buchen Freitag #weiterentwicklung');
    assert.equal(amb.message, 'Aufgabe ZUN-2 liegt in der Zunder-Inbox, fällig Fr 16.10. #weiterentwicklung passt zu mehreren Zielen (Berufliche Weiterentwicklung, Persönliche Weiterentwicklung).');
    assert.equal(calls[1].title, 'Kurs buchen #weiterentwicklung');

    const project = await post('!Funkgeräte prüfen #gruppe-ik +woche');
    assert.equal(project.message, 'Aufgabe ZUN-3 liegt in Ehrenamt (DRK Bereitschaft) / Gruppe I&K, Phönix-Schritt KW 42.');

    assert.equal((await post('!Einfach so')).message, 'Aufgabe ZUN-4 liegt in der Zunder-Inbox.');
  } finally {
    app.close();
  }
});
