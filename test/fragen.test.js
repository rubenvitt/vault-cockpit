import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeBlocks, renderBlocks, blocksText, normalizeWeb, SCHEMA } from '../src/fragen/ui.js';
import { createVaultChat } from '../src/fragen/chat.js';
import { readingRoutes } from '../src/lesen/http.js';
import { readingNav } from '../src/lesen/pages.js';
import { createReadingStore } from '../src/lesen/store.js';

const quiet = { info() {}, warn() {}, error() {} };

function withDir(run) {
  const dir = mkdtempSync(join(tmpdir(), 'cockpit-fragen-'));
  return Promise.resolve(run(dir)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

const NOTES = { 'projekte/Hund.md': 'Hund', 'daily/2026-10-20.md': '2026-10-20' };
const visible = (p) => (NOTES[p] ? { path: p, title: NOTES[p] } : null);
const ctx = { links: null, visible, write: { csrf: 'c', back: '/fragen' }, thread: 't1', turn: 1 };

test('Fragen: Bausteine in feste Form, Unbekanntes und Unvollständiges fällt weg', () => {
  const blocks = normalizeBlocks([
    { type: 'text', markdown: '  Hallo  ' },
    { type: 'script', code: 'alert(1)' },
    { type: 'notes', items: [{ path: '/projekte/Hund', why: 'passt' }, { path: '../geheim', why: 'x' }, { why: 'ohne Pfad' }] },
    { type: 'table', columns: ['A', 'B'], rows: [['1', '2', '3'], ['nur eins']] },
    { type: 'chart', title: 'C', bars: [{ label: 'a', value: 2 }, { label: 'b', value: 'viel' }] },
    { type: 'callout', tone: 'panik', text: 'x' },
    { type: 'stats', items: [] },
    { type: 'proposal', action: 'append', path: 'projekte/Hund', text: '- neu', why: 'w' },
    { type: 'proposal', action: 'replace', path: 'projekte/Hund.md', old_text: 'a', new_text: 'a' },
    { type: 'proposal', action: 'create', folder: '10-projekte/', name: 'Plan.md', text: 'Inhalt' },
    { type: 'proposal', action: 'create', folder: '../raus', name: 'Plan', text: 'Inhalt' },
    { type: 'proposal', action: 'frontmatter', path: 'projekte/Hund.md', set: [{ key: 'status', value: 'aktiv' }, { key: 'böse key', value: 'x' }] },
    { type: 'proposal', action: 'delete', path: 'projekte/Hund.md' },
  ]);
  assert.deepEqual(blocks.map((b) => b.type + (b.action ? `:${b.action}` : '')), ['text', 'notes', 'table', 'chart', 'callout', 'proposal:append', 'proposal:create', 'proposal:frontmatter']);
  assert.equal(blocks[0].markdown, 'Hallo');
  assert.deepEqual(blocks[1].items.map((i) => i.path), ['projekte/Hund.md']);
  assert.deepEqual(blocks[2].rows, [['1', '2'], ['nur eins', '']]);
  assert.deepEqual(blocks[3].bars, [{ label: 'a', value: 2 }]);
  assert.equal(blocks[4].tone, 'hinweis');
  assert.equal(blocks[5].path, 'projekte/Hund.md');
  assert.deepEqual([blocks[6].folder, blocks[6].name], ['10-projekte', 'Plan']);
  assert.deepEqual(blocks[7].set, [{ key: 'status', value: 'aktiv' }]);
  assert.deepEqual(normalizeWeb([{ title: 'A', url: 'https://a.test/x' }, { url: 'javascript:alert(1)' }]), [{ title: 'A', url: 'https://a.test/x' }]);
  assert.ok(SCHEMA.properties.blocks.items.anyOf.length >= 10);
  assert.ok(!JSON.stringify(SCHEMA).includes('"const"'), 'enum statt const');
});

test('Fragen: Bausteine als HTML, alles maskiert, keine Inline-Stile, Knöpfe nur zum Schreiben', () => {
  const blocks = normalizeBlocks([
    { type: 'text', markdown: 'Siehe <img src=x onerror=alert(1)> und **fett**' },
    { type: 'notes', items: [{ path: 'projekte/Hund.md', why: 'passt' }, { path: 'fehlt/da.md', why: '<b>' }] },
    { type: 'table', columns: ['<i>A</i>'], rows: [['<script>']] },
    { type: 'checklist', items: [{ text: 'Eins' }, { text: 'Zwei', path: 'projekte/Hund.md' }] },
    { type: 'timeline', items: [{ date: '2026-10-20', title: 'Vier von fünf', path: 'daily/2026-10-20.md' }] },
    { type: 'stats', items: [{ label: 'Quote', value: '80 %' }] },
    { type: 'chart', title: 'Q', unit: 'von 5', bars: [{ label: 'Sep', value: 2 }, { label: 'Okt', value: 4 }] },
    { type: 'quote', text: 'Nie strafen', path: 'projekte/Hund.md' },
    { type: 'callout', tone: 'warnung', text: 'Reh!' },
    { type: 'proposal', action: 'replace', path: 'projekte/Hund.md', old_text: 'alt', new_text: '<neu>', why: 'besser' },
  ]);
  const html = renderBlocks(blocks, ctx);
  assert.doesNotMatch(html, /<img|<script>|<i>A/);
  assert.match(html, /&lt;img/);
  assert.match(html, /<strong>fett<\/strong>/);
  assert.match(html, /<a href="\/notiz\?pfad=projekte%2FHund\.md">Hund<\/a>/);
  assert.match(html, /<span class="fragen-fehlt"[^>]*>da<\/span>/, 'unbekannte Notiz bleibt Text');
  assert.doesNotMatch(html, /style=/, 'CSP erlaubt keine Inline-Stile');
  assert.match(html, /<rect width="50"/);
  assert.match(html, /<rect width="100"/);
  assert.match(html, /action="\/aktion\/fragen\/aufgaben"[\s\S]*name="block" value="3"/);
  assert.match(html, /action="\/aktion\/fragen\/uebernehmen"[\s\S]*name="block" value="9"/);
  assert.match(html, /class="fragen-minus">alt<\/pre><pre class="fragen-plus">&lt;neu&gt;/);
  assert.doesNotMatch(renderBlocks(blocks, { ...ctx, write: null }), /<form/, 'ohne Schreibrecht keine Knöpfe');
  blocks[9].applied = { path: 'projekte/Hund.md' };
  assert.match(renderBlocks(blocks, ctx), /Übernommen: <a/);

  const md = blocksText(blocks);
  assert.match(md, /- \[\[projekte\/Hund\]\]: passt/);
  assert.match(md, /\| &lt;i&gt;A&lt;\/i&gt; \||\| <i>A<\/i> \|/);
  assert.match(md, /- \[ \] Zwei \(\[\[projekte\/Hund\]\]\)/);
  assert.match(md, /> \[!warning\]\n> Reh!/);
  assert.doesNotMatch(md, /besser/, 'Vorschläge gehören nicht in die Antwort');
});

/** Falscher Claude und falscher Vault-Zugang; `answers` der Reihe nach. */
function setup(dir, { answers = [], options = {} } = {}) {
  const calls = { writes: [], inbox: [], tasks: [], edits: [], opened: 0 };
  let k = 0;
  const writer = {
    available: () => true,
    write: async (job) => {
      calls.writes.push(job);
      const a = answers[k++] ?? { title: 'Rückruf', blocks: [{ type: 'text', markdown: 'Antwort' }], followups: ['Und dann?'] };
      if (a instanceof Error) throw a;
      return a;
    },
  };
  const research = {
    open: async ({ inbox }) => {
      calls.opened += 1;
      assert.equal(typeof inbox, 'function', 'Inbox-Werkzeug ist dabei');
      return { mcp: { name: 'vault', config: {} }, read: () => ['projekte/Hund.md', 'privat/x.md'], created: () => [{ path: 'inbox/Plan.md', title: 'Plan' }], close: async () => {} };
    },
  };
  const editor = {
    append: (a) => calls.edits.push(['append', a]),
    replace: (a) => {
      if (a.oldText === 'fehlt') throw new Error('old_text kommt in der Notiz nicht vor');
      calls.edits.push(['replace', a]);
    },
    setFrontmatter: (a) => calls.edits.push(['frontmatter', a]),
    create: (a) => {
      calls.edits.push(['create', a]);
      return { path: `${a.folder}/${a.name}` };
    },
  };
  const chat = createVaultChat({
    dir,
    writer,
    research,
    inbox: async (n) => {
      calls.inbox.push(n);
      return { path: `inbox/${n.title}.md` };
    },
    task: async (t) => {
      if (t.includes('Fehler')) throw new Error('Zunder weg');
      calls.tasks.push(t);
    },
    editor,
    canCreate: (folder) => {
      if (folder.startsWith('privat')) throw new Error(`„${folder}“ ist vertraulich`);
    },
    tz: 'Europe/Berlin',
    now: () => new Date('2026-10-25T10:00:00Z'),
    logger: quiet,
    ...options,
  });
  return { chat, calls };
}

test('Fragen: Frage, Antwort mit Quellen und angelegter Notiz, Nachfrage mit Verlauf', () =>
  withDir(async (dir) => {
    const { chat, calls } = setup(dir, {
      answers: [
        { title: 'Brunos Rückruf', blocks: [{ type: 'text', markdown: 'Vier von fünf.' }, { type: 'bogus' }], followups: ['Wie geht es weiter?', ''], web: [{ title: 'W', url: 'https://w.test' }] },
        { title: 'egal', blocks: [{ type: 'text', markdown: 'Weiter so.' }], followups: [] },
      ],
    });
    const r = chat.ask({ question: '  Wie läuft der Rückruf?  ' });
    assert.equal(r.turn, 1);
    await r.done;
    const t = chat.get(r.thread.id);
    assert.equal(t.title, 'Brunos Rückruf');
    const a = t.turns[1];
    assert.equal(a.status, 'fertig');
    assert.deepEqual(a.blocks, [{ type: 'text', markdown: 'Vier von fünf.' }]);
    assert.deepEqual(a.followups, ['Wie geht es weiter?']);
    assert.deepEqual(a.web, [], 'ohne Internet keine Webquellen');
    assert.deepEqual(a.created, [{ path: 'inbox/Plan.md', title: 'Plan' }]);
    assert.deepEqual(a.read, ['projekte/Hund.md', 'privat/x.md']);
    const job = calls.writes[0];
    assert.deepEqual(job.tools, []);
    assert.match(job.prompt, /Kein Internet/);
    assert.match(job.system, /vault_inbox_note/);
    assert.match(job.system, /proposal/);
    assert.match(job.input, /Heute ist 2026-10-25/);
    assert.match(job.input, /Seine Frage jetzt:\nWie läuft der Rückruf\?$/);
    assert.ok(existsSync(join(dir, `${t.id}.json`)));

    const f = chat.ask({ id: t.id, question: 'Und mit Internet?', web: true });
    assert.equal(f.turn, 3);
    await f.done;
    const second = calls.writes[1];
    assert.deepEqual(second.tools, ['WebSearch', 'WebFetch']);
    assert.match(second.input, /Bisher im Gespräch:\n\n<frage>\nWie läuft der Rückruf\?\n<\/frage>\n<antwort>\nVier von fünf\.\n<\/antwort>/);
    assert.equal(chat.get(t.id).title, 'Brunos Rückruf', 'Titel bleibt nach der ersten Antwort');
    assert.equal(chat.list().length, 1);

    // Nach einem Neustart: dieselben Gespräche.
    assert.equal(setup(dir).chat.get(t.id).turns.length, 4);
  }));

test('Fragen: Eingaben, Fehler, erneut fragen, nicht doppelt fragen, Neustart', () =>
  withDir(async (dir) => {
    const { chat } = setup(dir, { answers: [new Error('Usage limit reached'), { title: 'T', blocks: [] }] });
    assert.throws(() => chat.ask({ question: '   ' }), /Frage eingeben/);
    assert.throws(() => chat.ask({ question: 'x'.repeat(4001) }), /höchstens 4000/);
    assert.throws(() => chat.ask({ id: '00000000-0000-0000-0000-000000000000', question: 'x' }), (e) => e.status === 404);
    const r = chat.ask({ question: 'Eins' });
    assert.throws(() => chat.ask({ id: r.thread.id, question: 'Zwei' }), /noch eine Frage/);
    await r.done;
    assert.match(chat.get(r.thread.id).turns[1].error, /Usage limit/);
    const again = chat.retry(r.thread.id, 1);
    await again.done;
    assert.match(chat.get(r.thread.id).turns[1].error, /keine Antwort/, 'leere Antwort ist ein Fehler');

    const off = setup(dir, { options: { writer: { available: () => false } } }).chat;
    assert.throws(() => off.ask({ question: 'x' }), (e) => e.status === 409 && /CLAUDE_CODE_OAUTH_TOKEN/.test(e.message));

    const id = '11111111-1111-1111-1111-111111111111';
    writeFileSync(join(dir, `${id}.json`), JSON.stringify({ id, title: 'Alt', created_at: 'x', updated_at: 'x', turns: [{ role: 'du', text: 'q' }, { role: 'claude', status: 'denkt' }] }));
    assert.match(setup(dir).chat.get(id).turns[1].error, /Neustart/);
  }));

test('Fragen: Vorschläge übernehmen oder verwerfen, Antwort als Notiz, Checkliste als Aufgaben', () =>
  withDir(async (dir) => {
    const { chat, calls } = setup(dir, {
      answers: [
        {
          title: 'T',
          blocks: [
            { type: 'proposal', action: 'append', path: 'projekte/Hund.md', heading: 'Log', text: '- neu', why: 'w' },
            { type: 'proposal', action: 'replace', path: 'projekte/Hund.md', old_text: 'fehlt', new_text: 'x', why: 'w' },
            { type: 'proposal', action: 'frontmatter', path: 'projekte/Hund.md', set: [{ key: 'status', value: 'aktiv' }, { key: 'alt', value: '' }], why: 'w' },
            { type: 'proposal', action: 'create', folder: 'privat', name: 'Geheim', text: 'x', why: 'w' },
            { type: 'proposal', action: 'create', folder: '10-projekte', name: 'Plan', text: '# Plan', why: 'w' },
            { type: 'checklist', items: [{ text: 'Reh üben' }, { text: 'Fehler hier' }, { text: '!Leine' }] },
          ],
        },
      ],
    });
    const r = chat.ask({ question: 'Was tun?' });
    await r.done;
    const id = r.thread.id;
    await chat.apply(id, 1, 0);
    assert.deepEqual(calls.edits[0], ['append', { path: 'projekte/Hund.md', text: '- neu', heading: 'Log' }]);
    await assert.rejects(chat.apply(id, 1, 0), /Schon übernommen/);
    await assert.rejects(chat.apply(id, 1, 1), (e) => e.status === 409 && /kommt in der Notiz nicht vor/.test(e.message));
    await chat.apply(id, 1, 2);
    assert.deepEqual(calls.edits[1], ['frontmatter', { path: 'projekte/Hund.md', set: { status: 'aktiv', alt: null } }]);
    await assert.rejects(chat.apply(id, 1, 3), /vertraulich/);
    const made = await chat.apply(id, 1, 4);
    assert.equal(made.path, '10-projekte/Plan.md');
    assert.deepEqual(calls.edits[2], ['create', { folder: '10-projekte', name: 'Plan.md', content: '# Plan\n' }]);
    await assert.rejects(chat.apply(id, 1, 5), /Vorschlag gibt es nicht/);
    chat.dismiss(id, 1, 1);
    assert.equal(chat.get(id).turns[1].blocks[1].dismissed, true);

    const note = await chat.saveAsNote(id, 1);
    assert.equal(note.path, 'inbox/Frage – Was tun?.md');
    assert.match(calls.inbox[0].text, /^> Was tun\?\n\n/);
    assert.match(calls.inbox[0].text, /- \[ \] Reh üben/);
    assert.match(calls.inbox[0].text, /## Quellen\n\n- \[\[projekte\/Hund\]\]/);
    await assert.rejects(chat.saveAsNote(id, 1), /Schon/);

    await assert.rejects(chat.tasksFrom(id, 1, 5), /Zunder weg/);
    assert.deepEqual(calls.tasks, ['!Reh üben']);
    assert.equal(chat.get(id).turns[1].tasks[5], '1 von 3 als Aufgaben in Zunder');
    chat.get(id).turns[1].blocks[5].items[1].text = 'Geht jetzt';
    const again = await chat.tasksFrom(id, 1, 5);
    assert.deepEqual(again, { made: 2, total: 3 });
    assert.deepEqual(calls.tasks, ['!Reh üben', '!Geht jetzt', '!Leine'], 'nichts doppelt, kein doppeltes !');

    chat.remove(id);
    assert.equal(chat.get(id), null);
    assert.ok(!existsSync(join(dir, `${id}.json`)));
  }));

test('Fragen: Seiten, Aktionen und Unternavigation', () =>
  withDir(async (dir) => {
    const { chat } = setup(dir, { answers: [{ title: 'Rückruf', blocks: [{ type: 'notes', items: [{ path: 'projekte/Hund.md', why: 'passt' }] }], followups: ['Wie weiter?'] }] });
    const routes = readingRoutes({ store: createReadingStore({ path: ':memory:' }), fragen: { chat, index: { resolveLink: (t) => (NOTES[`${t}.md`] ? `${t}.md` : null) }, visible }, logger: quiet });
    const c = (path) => ({ url: new URL(`https://vault.test${path}`), user: 'ruben', tz: 'Europe/Berlin', write: { csrf: 'c', back: path }, flash: null, nav: routes.nav });
    const start = (await routes.pages['/fragen'](c('/fragen'))).html;
    assert.match(start, /<form method="post" action="\/aktion\/fragen\/frage"/);
    assert.match(start, /name="internet" value="1">/);
    assert.match(start, /href="\/fragen" class="subnav-item" aria-current="page"><span>Fragen/);
    assert.match(start, /<summary class="subnav-link" aria-current="page">Fragen<svg/);
    assert.match(start, /fragen\.js/);
    assert.doesNotMatch(readingNav('wissen', null), /Fragen/, 'ohne Fragen kein Eintrag');

    const r = await routes.actions['/aktion/fragen/frage'](new URLSearchParams({ frage: 'Wie läuft es?' }), {});
    assert.match(r.redirect, /^\/fragen\?id=[0-9a-f-]{36}#antwort-1$/);
    const id = r.id;
    await new Promise((res) => setTimeout(res, 20));
    const stand = JSON.parse((await routes.pages['/fragen/stand'](c(`/fragen/stand?id=${id}`))).body);
    assert.equal(stand.busy, false);

    const page = (await routes.pages['/fragen'](c(`/fragen?id=${id}`))).html;
    assert.match(page, /<div class="fragen-frage"><p>Wie läuft es\?<\/p>/);
    assert.match(page, /<a href="\/notiz\?pfad=projekte%2FHund\.md">Hund<\/a>/);
    assert.match(page, /Neu in der Inbox: Plan/, 'unsichtbare angelegte Notiz nur als Name');
    assert.match(page, /1 Notiz gelesen/, 'vertrauliche gelesene Notiz fehlt in den Quellen');
    assert.match(page, /name="frage" value="Wie weiter\?"[\s\S]*class="chip">Wie weiter\?/);
    assert.match(page, /href="\/lesen\/folgen\/thema\?thema=Wie\+l%C3%A4uft\+es%3F&amp;ziel=/);
    assert.match(page, /Als Notiz speichern/);
    assert.match(page, /Nachfragen/);

    const api = JSON.parse((await routes.pages['/api/fragen'](c(`/api/fragen?id=${id}`))).body);
    assert.deepEqual(api.thread.turns[1].read, [{ path: 'projekte/Hund.md', title: 'Hund' }]);
    assert.equal(JSON.parse((await routes.pages['/api/fragen'](c('/api/fragen'))).body).threads.length, 1);

    await assert.rejects(routes.actions['/aktion/fragen/uebernehmen'](new URLSearchParams({ id, turn: '1', block: '0' }), {}), /Vorschlag gibt es nicht/);
    const gone = await routes.actions['/aktion/fragen/loeschen'](new URLSearchParams({ id }), {});
    assert.equal(gone.redirect, '/fragen');
    assert.deepEqual(await routes.pages['/fragen'](c(`/fragen?id=${id}`)), { redirect: '/fragen' });
  }));

test('Fragen: Während Claude antwortet, Fortschritt mit gelesenen Notizen', () =>
  withDir(async (dir) => {
    let release;
    const gate = new Promise((res) => (release = res));
    const writer = { available: () => true, write: async () => (await gate, { title: 'T', blocks: [{ type: 'text', markdown: 'Fertig' }] }) };
    const research = { open: async () => ({ mcp: {}, read: () => ['projekte/Hund.md', 'daily/2026-10-20.md'], created: () => [], close: async () => {} }) };
    const chat = createVaultChat({ dir, writer, research, logger: quiet });
    const routes = readingRoutes({ store: createReadingStore({ path: ':memory:' }), fragen: { chat, index: { resolveLink: () => null }, visible }, logger: quiet });
    const c = (path) => ({ url: new URL(`https://vault.test${path}`), user: 'ruben', tz: 'Europe/Berlin', write: { csrf: 'c', back: path }, flash: null });
    const r = chat.ask({ question: 'Langsam?', web: true });
    await new Promise((res) => setTimeout(res, 10));
    const page = (await routes.pages['/fragen'](c(`/fragen?id=${r.thread.id}`))).html;
    assert.match(page, /data-busy="[0-9a-f-]{36}"/);
    assert.match(page, /Claude sucht im Vault und im Internet · 2 Notizen gelesen/);
    assert.doesNotMatch(page, /name="frage"/, 'keine Nachfrage, solange Claude antwortet');
    const stand = JSON.parse((await routes.pages['/fragen/stand'](c(`/fragen/stand?id=${r.thread.id}`))).body);
    assert.equal(stand.busy, true);
    assert.throws(() => chat.remove(r.thread.id), /antwortet gerade/);
    release();
    await r.done;
    assert.equal(JSON.parse((await routes.pages['/fragen/stand'](c(`/fragen/stand?id=${r.thread.id}`))).body).busy, false);
  }));
