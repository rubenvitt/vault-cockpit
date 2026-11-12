import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildIndex, openIndex } from '../src/vault/index.js';
import { compilePolicy } from '../src/vault/policy.js';
import { createEditor } from '../src/vault/edit.js';
import { createNoteDesk } from '../src/cockpit/notes.js';
import { createSettingsStore } from '../src/cockpit/settings.js';
import { createReadingStore } from '../src/lesen/store.js';
import { readingRoutes } from '../src/lesen/http.js';
import { createWebHttp } from '../src/web/http.js';
import { createCookieSigner } from '../src/web/session.js';
import { OFFLINE_MARK, OFFLINE_DOCS } from '../src/web/offline.js';

/**
 * Offline lesen (VCP-80): was `/api/lesen/offline` zum Speichern freigibt,
 * welche Seiten der Server dafür kennzeichnet, und dass Markierungen aus dem
 * Offline-Puffer beim Nachsenden nicht doppelt entstehen.
 */

const quiet = { info() {}, warn() {}, error() {} };
const SECRET = 'x'.repeat(40);
const policy = compilePolicy({ sensitive: { 'wiki/synthesis/privat': 'privat', privat: 'privat', 'inbox/geheim': 'privat' }, exclude: ['^wiki/synthesis/entwurf/', '^inbox/raus/'] });

async function withReading(run) {
  const root = mkdtempSync(join(tmpdir(), 'lesen-offline-'));
  const put = (rel, text) => {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), text);
  };
  const synth = (title, updated = '2026-10-01') => `---\ntype: synthesis\nupdated: ${updated}\n---\n# ${title}\n\nText.\n`;
  put('wiki/synthesis/Alt.md', synth('Alt', '2026-01-01'));
  put('wiki/synthesis/Neu.md', synth('Neu', '2026-10-20'));
  put('wiki/synthesis/privat/Geheim.md', synth('Geheim'));
  put('wiki/synthesis/entwurf/Roh.md', synth('Roh'));
  put('privat/Synthese.md', synth('Vertraulich draußen'));
  put('wiki/concepts/Auch Synthese.md', synth('Falscher Ordner'));
  put('inbox/Notiz.md', '# Notiz\n\nGewöhnliche Notiz.\n');
  put('inbox/geheim/Tagebuch.md', '# Tagebuch\n\nVertraulich.\n');
  put('inbox/raus/Weg.md', '# Weg\n\nAusgeschlossen.\n');
  let index;
  buildIndex({ vaultPath: root, dbPath: ':memory:', policy, logger: quiet, persist: (db, vp) => (index = openIndex(db, { vaultPath: vp, policy })) });
  const settings = createSettingsStore({ defaults: { tz: 'Europe/Berlin', inboxFolder: 'inbox' }, logger: quiet });
  const notes = createNoteDesk({ index, editor: createEditor({ vaultPath: root, index }), policy, settings });
  const store = createReadingStore({ path: ':memory:' });
  const web = createWebHttp({
    cockpit: { week: async () => null },
    settings,
    notes,
    reading: readingRoutes({ store, logger: quiet }),
    oidc: {},
    sessionSecret: SECRET,
    publicUrl: 'https://vault.test',
    allowedSubjects: ['ruben'],
    logger: quiet,
  });
  const server = http.createServer((req, res) => web.handle(req, res, new URL(req.url, 'https://vault.test')));
  server.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const t = Math.floor(Date.now() / 1000);
  const session = createCookieSigner(SECRET).seal({ sub: 'ruben', sid: 's1', gen: 0, iat: t, seen: t, exp: t + 3600 });
  const call = (path, { form = null, anon = false } = {}) =>
    fetch(base + path, {
      method: form ? 'POST' : 'GET',
      redirect: 'manual',
      headers: { ...(anon ? {} : { cookie: `vc_session=${session}` }), accept: form ? 'application/json' : 'text/html', ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
      body: form ? new URLSearchParams(form).toString() : undefined,
    });
  try {
    await run({ call, store });
  } finally {
    server.close();
    index.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
}

const add = (store, n, status = 'stapel') => store.addDocument({ url: `https://example.org/${status}/${n}`, title: `Artikel ${n}`, status, content_html: '<p>Ein Satz zum Markieren.</p>', reading_minutes: 3 }).doc;

test('/api/lesen/offline: Stapel bis 30, Eingang, Synthesen aus wiki/synthesis und die Vault-Inbox, nie vertraulich oder ausgeschlossen', async () => {
  await withReading(async ({ call, store }) => {
    const anon = await call('/api/lesen/offline', { anon: true });
    assert.equal(anon.status, 401);

    const docs = Array.from({ length: OFFLINE_DOCS + 5 }, (_, i) => add(store, i));
    store.setProgress(docs[0].id, 0.5);
    const archived = add(store, 'a', 'archiv');
    const inbox = add(store, 'e', 'eingang');

    const res = await call('/api/lesen/offline');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const { urls } = await res.json();
    const docUrls = urls.filter((u) => u.startsWith('/lesen/doc'));
    assert.equal(docUrls.length, OFFLINE_DOCS);
    // Angefangene zuerst, wie „Passt jetzt“ auf dem Stapel.
    assert.equal(docUrls[0], `/lesen/doc?id=${docs[0].id}`);
    assert.ok(!urls.some((u) => u.includes(archived.id) || u.includes(inbox.id)));
    const notes = urls.filter((u) => u.startsWith('/notiz'));
    // Synthesen, dann die Inbox zum Einsortieren ohne Netz (VCP-144), ohne Vertrauliches und Ausgeschlossenes.
    assert.deepEqual(notes, ['/notiz?pfad=wiki%2Fsynthesis%2FNeu.md', '/notiz?pfad=wiki%2Fsynthesis%2FAlt.md', '/notiz?pfad=inbox%2FNotiz.md']);
    assert.deepEqual(urls.filter((u) => !/^\/(lesen\/doc|notiz)\?/.test(u)), ['/lesen/stapel', '/lesen/eingang', '/wissen']);

    // Jede genannte Seite gibt der Server auch zum Speichern frei.
    for (const u of urls) assert.equal((await call(u)).headers.get(OFFLINE_MARK), 'lesen', u);
  });
});

test('Freigabe zum Speichern: nur Leseansicht, Stapel, Eingang, Wissen, Synthesen und Inbox-Notizen, nichts sonst', async () => {
  await withReading(async ({ call, store }) => {
    const doc = add(store, 1);
    for (const path of [`/lesen/doc?id=${doc.id}`, '/lesen/eingang', '/notiz?pfad=inbox%2FNotiz.md']) assert.equal((await call(path)).headers.get(OFFLINE_MARK), 'lesen', path);
    for (const path of ['/lesen/doc?id=gibt-es-nicht', '/lesen/stapel?zeit=15', '/lesen/eingang?gruppe=x', '/lesen/markiert', '/wissen?q=Text', '/notiz?pfad=inbox%2Fgeheim%2FTagebuch.md', '/notiz?pfad=inbox%2Fraus%2FWeg.md', '/notiz?pfad=wiki%2Fconcepts%2FAuch%20Synthese.md', '/notiz?pfad=wiki%2Fsynthesis%2Fprivat%2FGeheim.md', '/notiz?pfad=privat%2FSynthese.md', '/api/lesen/offline']) {
      const res = await call(path);
      assert.equal(res.headers.get(OFFLINE_MARK), null, `${path}: ${res.status}`);
    }
    // Vertrauliche Synthesen zeigt das Cockpit gar nicht erst.
    assert.equal((await call('/notiz?pfad=wiki%2Fsynthesis%2Fprivat%2FGeheim.md')).status, 404);
  });
});

test('Markierung aus dem Puffer: dieselbe cid legt genau eine an, auch gleichzeitig und doppelt', async () => {
  await withReading(async ({ call, store }) => {
    const doc = add(store, 1);
    const other = add(store, 2);
    const { csrf } = await (await call('/api/sitzung')).json();
    const cid = '1b4e28ba-2fa1-11d2-883f-0016d3cca427';
    const mark = (fields) => call('/aktion/lesen/markierung/neu', { form: { id: doc.id, quote: 'Satz', prefix: 'Ein ', suffix: ' zum', start: '4', cid, csrf, ...fields } });

    const first = await Promise.all([mark(), mark()]);
    const bodies = await Promise.all(first.map((r) => r.json()));
    const again = await (await mark()).json();
    assert.ok(bodies.every((b) => b.ok && b.highlight.id === cid));
    assert.equal(bodies.filter((b) => b.duplicate).length, 1);
    assert.equal(again.duplicate, true);
    assert.equal(again.message, 'Schon markiert');
    assert.equal(store.listHighlights({ docId: doc.id }).length, 1);

    // Notiz auf eine offline angelegte Markierung: dieselbe ID, letzter Stand gilt.
    for (const notiz of ['erst', 'dann']) assert.equal((await call('/aktion/lesen/markierung/notiz', { form: { id: cid, notiz, csrf } })).status, 200);
    assert.equal(store.getHighlight(cid).note, 'dann');

    // Dieselbe ID für einen anderen Artikel, ungültige IDs: abgewiesen, nichts angelegt.
    assert.equal((await mark({ id: other.id })).status, 409);
    for (const bad of ['a b', '../x', 'x'.repeat(129)]) assert.equal((await mark({ cid: bad })).status, 400, bad);
    // Ohne cid wie bisher: jede Markierung neu.
    await mark({ cid: '' });
    assert.equal(store.listHighlights({ docId: doc.id }).length, 2);
    assert.equal(store.listHighlights({ docId: other.id }).length, 0);
  });
});
