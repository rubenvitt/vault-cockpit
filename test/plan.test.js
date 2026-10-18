import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createWeekPlanner, markOf } from '../src/cockpit/plan.js';
import { createCockpit } from '../src/cockpit/data.js';
import { createCockpitActions, ActionError } from '../src/cockpit/actions.js';
import { createSettingsStore } from '../src/cockpit/settings.js';
import { createStateStore } from '../src/capture/state.js';
import { createZunderClient } from '../src/capture/zunder.js';
import { compilePolicy } from '../src/vault/policy.js';
import { createWebHttp } from '../src/web/http.js';
import { createCookieSigner } from '../src/web/session.js';
import { renderPlan } from '../src/web/plan-page.js';

const TZ = 'Europe/Berlin';
const quiet = { info() {}, warn() {}, error() {} };
const fixedNow = () => new Date('2026-10-14T10:00:00Z'); // Mi, KW 42

const area = (id, name) => ({ kind: 'area', id, name });
const project = (id, name, areaId, areaName) => ({ kind: 'project', id, name, area_id: areaId, area_name: areaName });

const STRUCTURE = [
  { id: 'a1', name: 'Finanzen', state: 'active', projects: [{ id: 'p1', name: 'Steuer 2026', status: 'active', kind: 'standard' }] },
  { id: 'a2', name: 'Gesundheit', state: 'active', projects: [] },
  { id: 'a4', name: 'Programmieren', state: 'active', projects: [{ id: 'pdev', name: 'Vault Cockpit', status: 'active', kind: 'dev' }] },
  { id: 'a9', name: 'Alt', state: 'archived', projects: [] },
];

const seed = () => [
  { id: 't1', ref: null, title: 'Belege sortieren', status: 'open', due: null, location: project('p1', 'Steuer 2026', 'a1', 'Finanzen') },
  { id: 't2', ref: null, title: 'Steuererklärung abgeben', status: 'open', due: '2026-10-16', location: area('a1', 'Finanzen') },
  { id: 't3', ref: null, title: 'Steuerberater anrufen', status: 'done', due: null, location: area('a1', 'Finanzen') },
  { id: 't4', ref: 'VCP-47', title: 'Planen im Cockpit', status: 'in_progress', due: null, location: project('pdev', 'Vault Cockpit', 'a4', 'Programmieren') },
  { id: 't5', ref: null, title: 'Zahnarzt Termin', status: 'open', due: null, location: area('a2', 'Gesundheit') },
  { id: 't6', ref: null, title: 'Laufschuhe', status: 'open', due: null, location: area('a2', 'Gesundheit'), phoenix: { role: 'feuer_schritt', fire: '2026-W42' } },
  { id: 't7', ref: null, title: 'Steuer-Flamme', status: 'open', due: '2026-10-13', location: area('a1', 'Finanzen'), phoenix: { role: 'flamme', fire: '2026-W42' } },
  { id: 't8', ref: 'GES-3', title: 'Impfpass suchen', status: 'open', due: '2026-12-01', location: area('a2', 'Gesundheit') },
];

/** Zunder-Attrappe mit Zustand: Änderungen sind bei der nächsten Abfrage sichtbar. */
function fakeZunder(tasks = seed()) {
  const calls = [];
  const day = (t) => (t.due ? t.due.slice(0, 10) : null);
  const areaOf = (t) => (t.location?.kind === 'area' ? t.location.id : t.location?.area_id);
  let n = 0;
  return {
    tasks,
    calls,
    taskUrl: (id) => `https://zunder.test/#/aufgabe/${id}`,
    async listStructure() {
      calls.push(['listStructure']);
      return STRUCTURE;
    },
    async filterTasks(f) {
      calls.push(['filterTasks', f]);
      return tasks.filter((t) => {
        if (f.flame_running) return Boolean(t.flame_running);
        if (f.phoenix_fire && t.phoenix?.fire !== f.phoenix_fire) return false;
        if (f.due_after && !(day(t) && day(t) >= f.due_after)) return false;
        if (f.due_before && !(day(t) && day(t) <= f.due_before)) return false;
        if (f.area_id && areaOf(t) !== f.area_id) return false;
        if (f.has_due === false && t.due) return false;
        if (f.location && t.location?.kind !== f.location) return false;
        if (f.status && !f.status.includes(t.status)) return false;
        if (f.closed_after) return false;
        return true;
      });
    },
    async search(query) {
      calls.push(['search', query]);
      const words = query.toLowerCase().split(/\s+/);
      return tasks.filter((t) => words.every((w) => t.title.toLowerCase().includes(w)));
    },
    async getTask(id) {
      calls.push(['getTask', id]);
      const t = tasks.find((x) => x.id === id || x.ref === id);
      if (!t) throw new Error('Zunder lehnt ab: Aufgabe nicht gefunden');
      return { ...t };
    },
    async updateTask(id, fields) {
      calls.push(['updateTask', id, fields]);
      const t = tasks.find((x) => x.id === id);
      Object.assign(t, fields);
      return { ...t };
    },
    async setStatus(id, status) {
      calls.push(['setStatus', id, status]);
      const t = tasks.find((x) => x.id === id);
      t.status = status;
      return { ...t };
    },
    async addTask(fields) {
      calls.push(['addTask', fields]);
      const parent = fields.parent_id ? tasks.find((x) => x.id === fields.parent_id) : null;
      const t = { id: `n${++n}`, ref: null, status: 'open', ...fields, location: parent ? parent.location : (fields.location ?? { kind: 'inbox' }) };
      tasks.push(t);
      return { ...t };
    },
  };
}

const settingsWith = () =>
  createSettingsStore({ defaults: { tz: TZ, inboxFolder: 'inbox', zunderUrl: 'https://zunder.test', zunderToken: 'zt_x' }, logger: quiet });

const planner = (z = fakeZunder()) => createWeekPlanner({ settings: settingsWith(), zunder: () => z, now: fixedNow, logger: quiet });

// --- Planungsdaten ----------------------------------------------------------

test('Planen: Suche ohne Dev-Projekte und Erledigtes, markiert, was schon in der Woche steht', async () => {
  const m = await planner().view('2026-W42', { q: 'steuer' });
  assert.equal(m.ok, true);
  assert.equal(m.week.id, '2026-W42');
  assert.equal(m.week.current, true);
  assert.deepEqual(m.week.days.map((d) => d.today), [false, false, true, false, false, false, false]);
  // t3 ist erledigt, t4 steckt im Dev-Projekt; t2 ist in der Woche fällig, t7 ist eine Flamme der Woche.
  assert.deepEqual(m.results.data.map((t) => [t.id, t.planned]), [['t2', 'faellig'], ['t7', 'flamme']]);
  assert.deepEqual(m.areas.map((a) => a.name), ['Finanzen', 'Gesundheit', 'Programmieren']);
});

test('Planen: Kennung findet die Aufgabe direkt, Bereich filtert die Suche oder listet offene Aufgaben', async () => {
  const z = fakeZunder();
  const p = planner(z);
  assert.deepEqual((await p.view('2026-W42', { q: 'GES-3' })).results.data.map((t) => t.id), ['t8']);
  assert.deepEqual((await p.view('2026-W42', { q: 'steuer', area: 'a2' })).results.data, []);
  const byArea = await p.view('2026-W42', { area: 'a1' });
  // Offen im Bereich (auch über das Projekt), nach Fälligkeit; ohne Erledigtes.
  assert.deepEqual(byArea.results.data.map((t) => t.id), ['t7', 't2', 't1']);
  assert.equal(byArea.results.data[2].area, 'Finanzen');
  assert.equal(byArea.results.data[2].project, 'Steuer 2026');
  // Ohne Suchbegriff und Bereich wird nicht gesucht; ungültige Parameter fallen weg.
  const none = await p.view('2026-W42', { area: '../x', from: 'a b' });
  assert.equal(none.results, null);
  assert.equal(none.query.area, '');
  assert.equal(none.from, null);
  assert.equal(await p.view('2026-W99'), null);
});

test('Planen: Woche wie in der Wochenansicht, Vorschläge je Bereich der Big Rocks ohne Termin', async () => {
  const m = await planner().view('2026-W42');
  assert.deepEqual(m.planned.flames.map((t) => t.id), ['t7']);
  assert.deepEqual(
    m.planned.rocks.map((g) => [g.area, g.areaId, g.tasks.map((t) => [t.id, t.planned])]),
    [
      ['Finanzen', 'a1', [['t2', 'faellig']]],
      ['Gesundheit', 'a2', [['t6', 'feuer_schritt']]],
    ],
  );
  // Finanzen: t1 (offen, ohne Termin); t2 hat einen Termin, t3 ist erledigt, t7 ist die Flamme.
  // Gesundheit: t5; t6 steht schon in der Woche, t8 hat einen Termin.
  assert.deepEqual(m.suggestions.map((g) => [g.area, g.tasks.map((t) => t.id)]), [['Finanzen', ['t1']], ['Gesundheit', ['t5']]]);
});

test('Planen: Vorschläge lassen Dev-Projekte aus und zeigen höchstens fünf je Bereich', async () => {
  const tasks = [
    { id: 'r1', title: 'Dev-Schritt', status: 'open', due: null, location: project('pdev', 'Vault Cockpit', 'a4', 'Programmieren'), phoenix: { role: 'feuer_schritt', fire: '2026-W42' } },
    { id: 'r2', title: 'Noch ein Dev-Ding', status: 'open', due: null, location: project('pdev', 'Vault Cockpit', 'a4', 'Programmieren') },
    ...Array.from({ length: 7 }, (_, i) => ({ id: `g${i}`, title: `Gesund ${i}`, status: 'open', due: null, location: area('a2', 'Gesundheit') })),
    { id: 'g9', title: 'Schritt', status: 'open', due: null, location: area('a2', 'Gesundheit'), phoenix: { role: 'feuer_schritt', fire: '2026-W42' } },
  ];
  const m = await planner(fakeZunder(tasks)).view('2026-W42');
  const prog = m.suggestions.find((g) => g.area === 'Programmieren');
  assert.deepEqual(prog.tasks, []);
  const ges = m.suggestions.find((g) => g.area === 'Gesundheit');
  assert.equal(ges.tasks.length, 5);
  assert.equal(ges.more, 2);
});

test('Planen: ohne Zunder-Zugang eine Meldung, Ausfälle bleiben im Abschnitt', async () => {
  const off = createWeekPlanner({ settings: settingsWith(), zunder: () => null, now: fixedNow, logger: quiet });
  const m = await off.view();
  assert.equal(m.ok, false);
  assert.equal(m.unconfigured, true);
  assert.equal(m.week.id, '2026-W42');

  const z = fakeZunder();
  z.search = async () => {
    throw new Error('Zunder antwortet mit HTTP 502');
  };
  const failed = await planner(z).view('2026-W42', { q: 'x' });
  assert.deepEqual(failed.results, { ok: false, error: 'Zunder antwortet mit HTTP 502' });
  assert.equal(failed.planned.ok, true);
});

test('Planen: „Als Flamme“ füllt das Formular aus einer bestehenden Aufgabe vor', async () => {
  const m = await planner().view('2026-W42', { from: 't1' });
  assert.equal(m.from.id, 't1');
  assert.equal(m.from.title, 'Belege sortieren');
});

// --- Planungsaktionen -------------------------------------------------------

test('Holen: als Phönix-Schritt oder fällig an einem Tag der Woche, mit Rückgängig', async () => {
  const z = fakeZunder();
  const p = planner(z);
  const step = await p.add('t1', '2026-W42', 'schritt');
  assert.equal(step.changed, true);
  assert.deepEqual(step.task.phoenix, { role: 'feuer_schritt', fire: '2026-W42' });
  assert.deepEqual(step.undo, { phoenix: '' });

  const dated = await p.add('t5', '2026-W42', '2026-10-15');
  assert.equal(dated.task.due, '2026-10-15');
  assert.deepEqual(dated.undo, { due: '' });
  const moved = await p.add('t8', '2026-W42', '2026-10-17');
  assert.deepEqual(moved.undo, { due: '2026-12-01' });

  // Schon in der Woche (auch als Flamme): nichts wird überschrieben.
  const flame = await p.add('t7', '2026-W42', 'schritt');
  assert.equal(flame.changed, false);
  assert.equal(z.tasks.find((t) => t.id === 't7').phoenix.role, 'flamme');

  await assert.rejects(p.add('t1', '2026-W42', '2026-10-19'), /Tag dieser Woche/);
  await assert.rejects(p.add('t1', '2026-W77', 'schritt'), /keine Kalenderwoche/);
  await assert.rejects(p.add('t3', '2026-W42', 'schritt'), /schon abgeschlossen/);
  await assert.rejects(p.add('../t1', '2026-W42', 'schritt'), ActionError);
});

test('Aus der Woche nehmen und zurücksetzen: Rolle und Woche bleiben erhalten', async () => {
  const z = fakeZunder();
  const p = planner(z);
  const out = await p.remove('t7');
  assert.equal(out.changed, true);
  assert.equal(out.task.phoenix, null);
  assert.deepEqual(out.undo, { phoenix: 'flamme:2026-W42' });
  const back = await p.restore('t7', out.undo);
  assert.deepEqual(back.phoenix, { role: 'flamme', fire: '2026-W42' });
  assert.deepEqual(z.calls.filter((c) => c[0] === 'updateTask').at(-1), ['updateTask', 't7', { phoenix: { role: 'flamme', fire: '2026-W42' } }]);

  assert.equal((await p.remove('t1')).changed, false);
  const due = await p.restore('t8', { due: '2026-12-01T09:00:00+01:00' });
  assert.equal(due.due, '2026-12-01T09:00:00+01:00');
  await assert.rejects(p.restore('t8', { phoenix: 'feuer:2026-W42' }), /keine Phönix-Markierung/);
  await assert.rejects(p.restore('t8', { due: 'morgen' }), /kein Datum/);
  await assert.rejects(p.restore('t8', {}), /Nichts zurückzusetzen/);
  assert.equal(markOf(null), '');
});

test('Flamme einplanen: neue Aufgabe mit Rolle flamme, Tag, Uhrzeit in Ortszeit, Ort oder Elternaufgabe', async () => {
  const z = fakeZunder();
  const p = planner(z);
  const a = await p.createFlame({ week: '2026-W42', title: '  Folien bauen ', day: '2026-10-15', place: 'area:a1' });
  assert.deepEqual(z.calls.at(-1), ['addTask', { title: 'Folien bauen', phoenix: { role: 'flamme', fire: '2026-W42' }, due: '2026-10-15', location: { kind: 'area', id: 'a1' } }]);
  assert.equal(a.week, '2026-W42');

  await p.createFlame({ week: '2026-W42', title: 'Früh', day: '2026-10-16', time: '07:30' });
  assert.equal(z.calls.at(-1)[1].due, '2026-10-16T05:30:00Z');
  assert.deepEqual(z.calls.at(-1)[1].location, { kind: 'loose' });

  await p.createFlame({ week: '2026-W42', title: 'Belege', day: '2026-10-12', from: 't1', place: 'area:a2' });
  assert.equal(z.calls.at(-1)[1].parent_id, 't1');
  assert.equal(z.calls.at(-1)[1].location, undefined);

  await assert.rejects(p.createFlame({ week: '2026-W42', title: ' ', day: '2026-10-15' }), /Titel/);
  await assert.rejects(p.createFlame({ week: '2026-W42', title: 'x', day: '2026-10-20' }), /Tag dieser Woche/);
  await assert.rejects(p.createFlame({ week: '2026-W42', title: 'x', day: '2026-10-15', time: '25:00' }), /keine Uhrzeit/);
  await assert.rejects(p.createFlame({ week: '2026-W42', title: 'x', day: '2026-10-15', place: 'nirgends' }), /Bereich/);
});

test('Zunder-Client: search liefert nur Aufgaben, addTask legt mit allen Feldern an', async () => {
  const sent = [];
  let reply;
  const fetch = async (url, init) => {
    sent.push(JSON.parse(init.body).params);
    return Response.json({ jsonrpc: '2.0', id: 1, result: { structuredContent: reply } });
  };
  const z = createZunderClient({ url: 'https://zunder.test/', token: 'zt_x', fetch });
  reply = { count: 2, hits: [{ entity: 'project', id: 'p1' }, { entity: 'task', id: 't1', title: 'A', status: 'open' }] };
  assert.deepEqual(await z.search('steuer', { limit: 5 }), [{ entity: 'task', id: 't1', title: 'A', status: 'open' }]);
  assert.deepEqual(sent.at(-1), { name: 'search', arguments: { query: 'steuer', limit: 5 } });
  reply = { count: 0, hits: [] };
  assert.deepEqual(await z.search('b'), []);

  reply = { task: { id: 'n1', title: 'Flamme' } };
  const t = await z.addTask({ title: 'x'.repeat(600), phoenix: { role: 'flamme', fire: '2026-W42' }, due: '2026-10-15' });
  assert.equal(t.id, 'n1');
  assert.equal(sent.at(-1).name, 'create_task');
  assert.equal(sent.at(-1).arguments.title.length, 500);
  assert.deepEqual(sent.at(-1).arguments.phoenix, { role: 'flamme', fire: '2026-W42' });
  reply = {};
  await assert.rejects(z.addTask({ title: 'x' }), /keine Aufgabe/);
});

// --- Web: Seite, Formulare, Wochenansicht ------------------------------------

const SECRET = 'y'.repeat(40);

/**
 * Cockpit mit echter Wochenansicht, echten Aktionen und echter Planung über
 * derselben Zunder-Attrappe; die Sitzung wird direkt signiert statt per Login.
 */
async function withPlan(run) {
  const z = fakeZunder();
  const settings = settingsWith();
  const index = { notesOfType: () => [], getNote: () => ({ content: null }), listFolder: () => [] };
  const cockpit = createCockpit({ index, settings, zunderFor: () => z, now: fixedNow, logger: quiet });
  const actions = createCockpitActions({ vaultPath: '/nicht-benutzt', settings, policy: compilePolicy({}), state: createStateStore(null), zunder: () => cockpit.zunder(), now: fixedNow, logger: quiet });
  const plan = createWeekPlanner({ settings, zunder: () => cockpit.zunder(), now: fixedNow, logger: quiet });
  const web = createWebHttp({
    cockpit,
    settings,
    actions,
    plan,
    oidc: { start: async () => ({ url: 'https://id.test/authorize', pending: {} }) },
    sessionSecret: SECRET,
    publicUrl: 'https://vault.test',
    allowedSubjects: ['ruben'],
    logger: quiet,
  });
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'https://vault.test');
    if (!web.matches(url.pathname)) {
      res.writeHead(404);
      return res.end();
    }
    web.handle(req, res, url).catch((err) => {
      res.writeHead(500);
      res.end(err.stack);
    });
  });
  server.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const signer = createCookieSigner(SECRET);
  const session = signer.seal({ sub: 'ruben', name: 'Ruben', sid: 's1', exp: Math.floor(Date.now() / 1000) + 3600 });
  const csrf = signer.mac(`csrf\n${session}`);
  const base = `http://127.0.0.1:${server.address().port}`;
  let flash = null;
  const call = async (path, { form = null, json = false, auth = true } = {}) => {
    const cookies = [auth ? `vc_session=${session}` : '', flash ? `vc_flash=${flash}` : ''].filter(Boolean).join('; ');
    const headers = { ...(cookies ? { cookie: cookies } : {}), ...(json ? { accept: 'application/json' } : {}) };
    if (form) headers['content-type'] = 'application/x-www-form-urlencoded';
    const res = await fetch(base + path, { method: form ? 'POST' : 'GET', redirect: 'manual', headers, body: form ? new URLSearchParams(form).toString() : undefined });
    for (const c of res.headers.getSetCookie()) {
      const [pair, ...attrs] = c.split('; ');
      const [k, v] = pair.split('=');
      if (k === 'vc_flash') flash = attrs.includes('Max-Age=0') ? null : v;
    }
    return res;
  };
  try {
    await run({ call, csrf, z });
  } finally {
    server.close();
  }
}

test('Web: Planungsseite nur mit Sitzung, Suche als GET-Formular, Holen als Formular mit CSRF', async () => {
  await withPlan(async ({ call }) => {
    const anon = await call('/planen?woche=2026-W42', { auth: false });
    assert.equal(anon.status, 303);
    assert.match(anon.headers.get('location'), /^\/login\?next=%2Fplanen/);

    const res = await call('/planen?woche=2026-W42&q=belege');
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /<h1>Woche planen <span class="range">KW 42 · 12\.10\.–18\.10\.<\/span>/);
    assert.match(html, /<form method="get" action="\/planen" class="plan-search" role="search">/);
    assert.match(html, /name="q" value="belege"/);
    assert.match(html, /<option value="a1">Finanzen<\/option>/);
    assert.ok(!html.includes('>Alt<'));
    // Treffer mit „Holen“: Phönix-Schritt oder ein Tag der Woche.
    assert.match(html, /<form method="post" action="\/aktion\/woche\/holen" class="act plan-add"><input type="hidden" name="csrf" value="[^"]+"><input type="hidden" name="back" value="\/planen\?woche=2026-W42&amp;q=belege"><input type="hidden" name="id" value="t1">/);
    assert.match(html, /<option value="schritt">Phönix-Schritt KW 42<\/option>/);
    assert.match(html, /<option value="2026-10-14">Mi 14\.10\. \(heute\)<\/option>/);
    assert.match(html, /href="\/planen\?woche=2026-W42&amp;q=belege&amp;aus=t1#flamme" class="chip quiet">Als Flamme/);
    // Script nur als Verbesserung; ohne bleibt alles Formular.
    assert.match(html, /<script src="\/static\/cockpit\.js\?v=[\w-]{10}" defer>/);
    assert.match(html, /<section id="flamme"/);
    assert.equal((await call('/planen?woche=kaputt')).status, 400);
  });
});

test('Web: geholte Aufgabe steht sofort unter ihrem Bereich in den Big Rocks, Rückgängig nimmt sie wieder heraus', async () => {
  await withPlan(async ({ call, csrf, z }) => {
    const before = await (await call('/?woche=2026-W42')).text();
    assert.ok(!before.includes('Belege sortieren'));
    assert.match(before, /<h2>Big Rocks <a href="\/planen\?woche=2026-W42" class="h2-link">Woche planen<\/a><\/h2>/);

    // Ohne JavaScript: Weiterleitung zurück zur Suche, Meldung mit Rückgängig.
    const res = await call('/aktion/woche/holen', { form: { id: 't1', woche: '2026-W42', wann: 'schritt', csrf, back: '/planen?woche=2026-W42&q=belege' } });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), '/planen?woche=2026-W42&q=belege');
    const page = await (await call('/planen?woche=2026-W42&q=belege')).text();
    assert.match(page, /class="toast-text">Phönix-Schritt KW 42: Belege sortieren/);
    assert.match(page, /action="\/aktion\/woche\/zuruecksetzen" class="act">[^]*?name="id" value="t1"><input type="hidden" name="phoenix" value=""><button type="submit" class="toast-action">Rückgängig/);
    assert.match(page, /<span class="pill ok">Phönix-Schritt KW 42<\/span>/);

    const week = await (await call('/?woche=2026-W42')).text();
    const finanzen = week.match(/<article class="rock[^"]*">\s*<h3>Finanzen[^]*?<\/article>/)[0];
    assert.match(finanzen, /Belege sortieren/);

    // Mit JavaScript: JSON mit Rückgängig; Rückgängig nimmt die Markierung wieder weg.
    const step = await (await call('/aktion/woche/holen', { form: { id: 't5', woche: '2026-W42', wann: '2026-10-15', csrf }, json: true })).json();
    assert.equal(step.message, 'Fällig Do 15.10.: Zahnarzt Termin');
    assert.deepEqual(step.undo, { action: '/aktion/woche/zuruecksetzen', fields: { id: 't5', due: '' } });
    const undo = await (await call('/aktion/woche/zuruecksetzen', { form: { ...step.undo.fields, csrf }, json: true })).json();
    assert.equal(undo.message, 'Zurückgesetzt: Zahnarzt Termin');
    assert.equal(z.tasks.find((t) => t.id === 't5').due, null);

    const out = await (await call('/aktion/woche/raus', { form: { id: 't1', csrf }, json: true })).json();
    assert.equal(out.message, 'Aus KW 42 genommen: Belege sortieren');
    assert.deepEqual(out.undo, { action: '/aktion/woche/zuruecksetzen', fields: { id: 't1', phoenix: 'feuer_schritt:2026-W42' } });
    assert.ok(!(await (await call('/?woche=2026-W42')).text()).includes('Belege sortieren'));

    // Fehler ohne JavaScript: die Planungsseite kommt mit Meldung zurück.
    const bad = await call('/aktion/woche/holen', { form: { id: 't1', woche: '2026-W42', wann: '2027-01-01', csrf, back: '/planen?woche=2026-W42' } });
    assert.equal(bad.status, 400);
    assert.match(await bad.text(), /class="toast error"[^>]*><span class="toast-text">Bitte „Phönix-Schritt“ oder einen Tag dieser Woche wählen/);

    const noCsrf = await call('/aktion/woche/holen', { form: { id: 't1', woche: '2026-W42', wann: 'schritt' }, json: true });
    assert.equal(noCsrf.status, 403);
  });
});

test('Web: neue Flamme erscheint oben bei den Flammen, Rückgängig verwirft sie; Flammen lassen sich aus der Woche nehmen', async () => {
  await withPlan(async ({ call, csrf, z }) => {
    const r = await call('/aktion/woche/flamme', { form: { woche: '2026-W42', titel: 'Folien <bauen>', tag: '2026-10-15', zeit: '09:00', ort: 'area:a1', csrf, back: '/planen?woche=2026-W42' } });
    assert.equal(r.status, 303);
    const week = await (await call('/?woche=2026-W42')).text();
    const flames = week.match(/<h2>Flammen[^]*?<\/ul>/)[0];
    assert.match(flames, /<h2>Flammen <a href="\/planen\?woche=2026-W42#flamme" class="h2-link">Einplanen<\/a><\/h2>/);
    assert.match(flames, /Folien &lt;bauen&gt;/);
    assert.match(flames, /Do 15\.10\. 09:00/);
    // Im Menü einer Flamme: „Aus der Woche nehmen“.
    assert.match(flames, /action="\/aktion\/woche\/raus" class="act">[^]*?Aus der Woche nehmen/);

    const json = await (await call('/aktion/woche/flamme', { form: { woche: '2026-W42', titel: 'Belege', tag: '2026-10-12', aus: 't1', csrf }, json: true })).json();
    assert.equal(json.message, 'Flamme Mo 12.10. eingeplant: Belege');
    assert.equal(json.redirect, '/planen?woche=2026-W42#flamme');
    assert.deepEqual(json.undo, { action: '/aktion/status', fields: { id: json.task.id, status: 'dropped' } });
    assert.equal(z.tasks.find((t) => t.id === json.task.id).parent_id, 't1');
    await call('/aktion/status', { form: { ...json.undo.fields, csrf }, json: true });
    assert.equal(z.tasks.find((t) => t.id === json.task.id).status, 'dropped');

    const failed = await (await call('/aktion/woche/flamme', { form: { woche: '2026-W42', titel: '', tag: '2026-10-15', csrf }, json: true })).json();
    assert.equal(failed.message, 'Bitte einen Titel für die Flamme angeben');
  });
});

test('renderPlan: Vorschläge, Woche mit „Aus der Woche“, ohne Schreibrecht nur ein Hinweis', async () => {
  const m = await planner().view('2026-W42', { from: 't1' });
  const write = { csrf: 'c', captureId: 'x', notes: false, plan: true };
  const html = renderPlan(m, { write, back: '/planen?woche=2026-W42&aus=t1' });
  assert.match(html, /<h3>Finanzen <a href="\/planen\?woche=2026-W42&amp;bereich=a1" class="hint">alle offenen<\/a><\/h3>/);
  assert.match(html, /Als Unteraufgabe von <a href="https:\/\/zunder\.test\/#\/aufgabe\/t1">Belege sortieren<\/a>/);
  assert.match(html, /name="titel" required maxlength="500" value="Belege sortieren"/);
  assert.match(html, /name="aus" value="t1"/);
  // Ohne `aus` zurück, damit das Formular danach leer ist.
  assert.match(html, /action="\/aktion\/woche\/flamme" class="act plan-flame-form"><input type="hidden" name="csrf" value="c"><input type="hidden" name="back" value="\/planen\?woche=2026-W42">/);
  assert.match(html, /<option value="2026-10-14" selected>Mi 14\.10\. \(heute\)<\/option>/);
  // In der Woche: t6 (Schritt) und t7 (Flamme) mit „Aus der Woche“, t2 nur fällig.
  const weekPart = html.slice(html.indexOf('class="plan-week"'));
  assert.equal((weekPart.match(/action="\/aktion\/woche\/raus"/g) ?? []).length, 2);
  assert.match(weekPart, /Steuererklärung abgeben[^]*?<span class="hint">fällig<\/span>/);

  const readOnly = renderPlan(m, {});
  assert.ok(!readOnly.includes('/aktion/'));
  assert.ok(!readOnly.includes('cockpit.js'));
});
