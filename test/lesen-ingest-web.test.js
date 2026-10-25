import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/http/app.js';
import { createWebHttp } from '../src/web/http.js';
import { createCookieSigner } from '../src/web/session.js';
import { createSettingsStore } from '../src/cockpit/settings.js';
import { createReadingStore } from '../src/lesen/store.js';
import { readingRoutes } from '../src/lesen/http.js';
import { readFileSync } from 'node:fs';
import { appliedMessage, groupItems, kindLabel, standBack, tally, tallyLabel } from '../src/lesen/ingest-page.js';

const quiet = { info() {}, warn() {}, error() {} };
const SECRET = 'x'.repeat(40);

/** Wie der echte Dienst: Fehler mit `status` und deutscher Meldung. */
class IngestError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'IngestError';
    this.status = status;
  }
}

const EVIL = '<script>alert(1)</script><img src=x onerror=alert(2)>';

/** Entwurf nach dem Vertrag (version 1), mit Fremdtext, der kein HTML werden darf. */
const draftFor = (title, { evil = false } = {}) => ({
  version: 1,
  digest: {
    kernaussagen: [`Erste Aussage über **${title}**${evil ? ` ${EVIL}` : ''}`, 'Zweite Aussage', 'Dritte Aussage', 'Vierte Aussage, nur in der Prüfansicht'],
    neu: ['Agenten brauchen ein Gedächtnis außerhalb des Kontexts'],
    bestaetigt: [{ path: 'wiki/concepts/context-engineering.md', title: 'Context Engineering', claim: 'Kontext ist knapp' }],
    widerspricht: [{ path: 'wiki/concepts/rag.md', title: 'RAG', claim: 'RAG sei überholt', vorschlag: 'Als Gegenposition aufnehmen' }],
    dockt_an: [{ path: 'wiki/entities/claude-code.md', title: 'Claude Code', warum: 'Beispiel im Text' }],
  },
  source: {
    slug: 'glaser-agenten-gedaechtnis',
    title: evil ? `${title} ${EVIL}` : title,
    summary: 'Wie Agenten sich erinnern, ohne den Kontext zu füllen',
    confidence: 'medium',
    tags: ['agents', 'memory'],
    body: `## Kern\n\nSiehe [[context-engineering]] und [Link](javascript:alert(3)).\n\n${evil ? EVIL : 'Ohne Tricks.'}`,
  },
  items: [
    { id: 'v1', kind: 'concept', action: 'verknuepfen', path: 'wiki/concepts/context-engineering.md', title: 'Context Engineering', warum: 'Kernthema', default: true },
    { id: 'b1', kind: 'bestaetigung', path: 'wiki/concepts/context-engineering.md', title: 'Context Engineering', claim: 'Kontext ist knapp', default: true },
    { id: 's1', kind: 'synthesis', action: 'neu', slug: 'gedaechtnis-vs-rag', title: 'Gedächtnis statt RAG?', summary: 'Zwei Wege, Wissen nachzuladen', art: 'vergleich', body: `Ein **Vergleich**.${evil ? EVIL : ''}`, beteiligte: ['wiki/concepts/rag.md'], warum: 'Zwei Seiten treffen sich', default: false },
    { id: 'q1', kind: 'question', action: 'neu', slug: 'wann-vergessen', title: 'Wann sollen Agenten vergessen?', summary: 'Offene Frage', body: 'Noch offen.', warum: 'Der Text lässt es offen', default: false },
    { id: 'n1', kind: 'entity', action: 'neu', slug: 'robert-glaser', title: 'Robert Glaser', summary: 'Autor', entity_type: 'person', body: 'Schreibt über Agenten.', warum: 'Autor des Textes', default: false },
    { id: 'r1', kind: 'relation', type: 'authored-by', to: 'wiki/entities/robert-glaser.md', title: 'Robert Glaser', default: true },
  ],
  hinweise: ['Widerspruch zu [[rag]] – Auflösung per /wiki-lint'],
});

/** Fake des Ingest-Dienstes nach der Vertrags-API; `calls` hält fest, was die Oberfläche aufruft. */
function fakeIngest(store, { available = { ok: true } } = {}) {
  const rows = new Map();
  const calls = [];
  let t = 0;
  const stamp = () => new Date(Date.UTC(2026, 9, 25, 3, t++)).toISOString();
  const view = (r) => {
    const d = store.get(r.doc_id);
    return { ...r, doc: d ? { id: d.id, title: d.title, url: d.url, site: d.site, reading_minutes: d.reading_minutes, status: d.status } : null };
  };
  const api = {
    calls,
    rows,
    state: { available, failApply: null, applyExtra: {} },
    put(docId, status, extra = {}) {
      rows.set(docId, { doc_id: docId, status, origin: 'nacht', draft: null, error: null, applied: null, requested_at: stamp(), drafted_at: null, applied_at: null, updated_at: stamp(), model: 'sonnet', ...extra });
    },
    available: () => api.state.available,
    request(ids, { origin = 'knopf', force = false } = {}) {
      calls.push(['request', ids, { origin, force }]);
      for (const id of ids) {
        const r = rows.get(id);
        if (!force && r && ['bereit', 'entwirft', 'wartet', 'uebernommen'].includes(r.status)) continue;
        api.put(id, 'wartet', { origin });
      }
      return ids.length;
    },
    // Wie der Dienst: ohne Entwurf oder fehlgeschlagen; verworfene nicht.
    requestStack({ origin = 'knopf' } = {}) {
      calls.push(['requestStack', { origin }]);
      const ids = store.list({ status: 'stapel', limit: -1 }).map((d) => d.id).filter((id) => !rows.has(id) || rows.get(id).status === 'fehler');
      for (const id of ids) api.put(id, 'wartet', { origin });
      return ids.length;
    },
    get(id) {
      const r = rows.get(id);
      return r ? view(r) : null;
    },
    list({ status = null } = {}) {
      return [...rows.values()].filter((r) => !status || r.status === status).reverse().map(view);
    },
    counts() {
      const c = { wartet: 0, entwirft: 0, bereit: 0, fehler: 0 };
      for (const r of rows.values()) if (r.status in c) c[r.status] += 1;
      return c;
    },
    statusFor(ids) {
      calls.push(['statusFor', ids.length]);
      return new Map(ids.filter((id) => rows.has(id)).map((id) => [id, rows.get(id).status]));
    },
    async apply(id, payload) {
      calls.push(['apply', id, payload]);
      if (api.state.failApply) throw api.state.failApply;
      const r = rows.get(id);
      if (!r || r.status !== 'bereit') throw new IngestError('Kein bereiter Entwurf', 409);
      r.status = 'uebernommen';
      r.applied = { source: `wiki/sources/${payload.source.slug ?? 'x'}.md` };
      store.setStatus(id, 'archiv', { read: true });
      return { source: r.applied.source, raw: 'raw/x.md', written: [r.applied.source, 'wiki/entities/robert-glaser.md', 'wiki/log.md'], linked: ['wiki/concepts/context-engineering.md'], ...api.state.applyExtra };
    },
    discard(id, { done = false } = {}) {
      calls.push(['discard', id, { done }]);
      const r = rows.get(id);
      if (!r) throw new IngestError('Kein Entwurf', 404);
      r.status = 'verworfen';
      if (done) store.setStatus(id, 'weg', { read: true });
    },
  };
  return api;
}

/** Cockpit mit Lesestapel im Speicher und Ingest-Fake (oder ohne: `ingest: false`), angemeldet. */
async function withIngest(run, { ingest: withService = true, available } = {}) {
  const store = createReadingStore({ path: ':memory:' });
  const ingest = withService ? fakeIngest(store, available ? { available } : {}) : null;
  const webHttp = createWebHttp({
    cockpit: { week: async () => null },
    settings: createSettingsStore({ defaults: { tz: 'Europe/Berlin' }, logger: quiet }),
    reading: readingRoutes({ store, ingest, logger: quiet }),
    oidc: {},
    sessionSecret: SECRET,
    publicUrl: 'https://vault.test',
    allowedSubjects: ['ruben'],
    logger: quiet,
  });
  const app = createApp({
    config: { publicUrl: 'https://vault.test', resource: 'https://vault.test/mcp', issuer: 'https://id.test', supportedScopes: [], allowedHosts: ['vault.test'], trustProxy: true },
    verifyToken: async () => {
      throw new Error('nicht benutzt');
    },
    mcpHandler: async () => {},
    webHttp,
    logger: quiet,
  });
  app.listen(0, '127.0.0.1');
  await new Promise((res) => app.once('listening', res));
  const base = `http://127.0.0.1:${app.address().port}`;
  const t = Math.floor(Date.now() / 1000);
  const jar = { vc_session: createCookieSigner(SECRET).seal({ sub: 'ruben', sid: 's1', gen: 0, iat: t, seen: t, exp: t + 3600 }) };
  const call = async (path, { method = 'GET', form = null, accept = null } = {}) => {
    const headers = { 'x-forwarded-host': 'vault.test', cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; '), ...(accept ? { accept } : {}) };
    if (form) headers['content-type'] = 'application/x-www-form-urlencoded';
    const res = await fetch(base + path, { method, redirect: 'manual', headers, body: form ? new URLSearchParams(form).toString() : undefined });
    for (const c of res.headers.getSetCookie()) {
      const [pair, ...attrs] = c.split('; ');
      const [k, v] = pair.split('=');
      if (attrs.includes('Max-Age=0')) delete jar[k];
      else if (k !== 'vc_session') jar[k] = v;
    }
    return res;
  };
  const html = async (path) => (await call(path)).text();
  const add = (title, status = 'stapel') => store.addDocument({ url: `https://blatt.test/${encodeURIComponent(title)}`, title, site: 'Blatt', reading_minutes: 7, status }).doc;
  try {
    await run({ call, html, store, ingest, add });
  } finally {
    app.close();
  }
}

const csrfFrom = (page) => page.match(/name="csrf" value="([^"]+)"/)[1];
const noInline = (page) => assert.ok(!/style=|<script>(?!<\/script>)|<script(?![^>]*\bsrc=)/.test(page), 'keine Inline-Styles oder -Skripte');

test('Ingest: Gruppen und Zählung folgen dem Entwurf', () => {
  const d = draftFor('X');
  assert.deepEqual(groupItems(d.items).map((g) => [g.key, g.items.map((i) => i.id)]), [
    ['verknuepfen', ['v1']],
    ['bestaetigung', ['b1']],
    ['synthese', ['s1', 'q1']],
    ['neu', ['n1']],
    ['relation', ['r1']],
  ]);
  assert.equal(tallyLabel(tally(d)), '1 Verknüpfung · 1 Bestätigung · 1 Synthese · 1 Frage · 1 neue Seite · 1 Relation');
  assert.equal(tallyLabel(tally({ items: [] })), 'nur die Source-Page');
  assert.equal(tallyLabel(tally({ items: [d.items[0], { ...d.items[0], id: 'v2' }, d.items[4], { ...d.items[4], id: 'n2' }] })), '2 Verknüpfungen · 2 neue Seiten');
});

test('Ingest: Kennzeichen auf Deutsch, auch für Verknüpfungen mit Quellen und Entities', () => {
  // Der Dienst nimmt beim Verknüpfen den Seitentyp als Art, also auch `source`, und `entity_type` aus dem Frontmatter.
  assert.equal(kindLabel({ kind: 'source', action: 'verknuepfen' }), 'Quelle');
  assert.equal(kindLabel({ kind: 'entity', action: 'verknuepfen', entity_type: 'tool' }), 'Werkzeug');
  assert.equal(kindLabel({ kind: 'entity', action: 'verknuepfen' }), 'Entity');
});

test('Ingest: ohne Dienst keine Oberfläche, die App-JSON sagt enabled: false', async () => {
  await withIngest(
    async ({ call, html, add }) => {
      add('Vom Lesen');
      const stack = await html('/lesen/stapel');
      assert.ok(!stack.includes('/lesen/ingest'), 'kein Eintrag, kein Abzeichen');
      assert.ok(!stack.includes('Ingest'));
      assert.ok(!stack.includes('lesen-ingest.js'));
      assert.equal((await call('/lesen/ingest')).status, 404);
      assert.equal((await call('/aktion/lesen/ingest/entwerfen', { method: 'POST', form: { id: 'x' }, accept: 'application/json' })).status, 404);
      assert.deepEqual(await (await call('/api/lesen/ingest')).json(), { ok: true, enabled: false, ready: [], busy: [], failed: [] });
      const stapel = await (await call('/api/lesen/stapel')).json();
      assert.equal('ingest' in stapel.items[0], false);
    },
    { ingest: false },
  );
});

test('Ingest: Unternavigation mit Zahl der bereiten Entwürfe zwischen Stapel und Folgen/Markiert', async () => {
  await withIngest(async ({ html, add, ingest }) => {
    const a = add('Bereit A');
    add('Ohne Entwurf');
    ingest.put(a.id, 'bereit', { draft: draftFor('Bereit A') });
    const page = await html('/lesen/eingang');
    const nav = page.match(/<nav class="subnav"[^]*?<\/nav>/)[0];
    assert.deepEqual([...nav.matchAll(/class="subnav-link"[^>]*>([^<]+)/g)].map((m) => m[1]), ['Eingang', 'Stapel', 'Ingest', 'Folgen', 'Markiert', 'Wiedersehen', 'Wissen', 'Feeds']);
    assert.match(nav, /<a href="\/lesen\/ingest" class="subnav-link">Ingest<span class="subnav-count" data-ingest-count>1<\/span><\/a>/);
    // Ohne bereite Entwürfe bleibt die Zahl versteckt (für die Live-Aktualisierung aber da).
    ingest.rows.get(a.id).status = 'uebernommen';
    assert.match(await html('/lesen/stapel'), /Ingest<span class="subnav-count" data-ingest-count hidden>0<\/span>/);
    assert.match(await html('/lesen/ingest'), /<a href="\/lesen\/ingest" class="subnav-link" aria-current="page">Ingest/);
  });
});

test('Ingest: Übersicht mit Karten, In Arbeit, Fehler und „Ganzen Stapel entwerfen“', async () => {
  await withIngest(async ({ html, add, ingest }) => {
    // Leer: freundlich, mit Knopf, weil ein Text ohne Entwurf auf dem Stapel liegt.
    add('Erst einer');
    let page = await html('/lesen/ingest');
    assert.match(page, /Nichts zum Abhaken/);
    assert.match(page, /<form method="post" action="\/aktion\/lesen\/ingest\/entwerfen" class="act ingest-stapel">[^]*name="stapel" value="1"[^]*Ganzen Stapel entwerfen/);
    assert.match(page, /Ein Text auf dem Stapel hat noch keinen fertigen Entwurf/);
    noInline(page);

    const r = add('Bereit');
    const b = add('Läuft');
    const f = add('Kaputt');
    ingest.put(r.id, 'bereit', { draft: draftFor('Bereit'), drafted_at: '2026-10-25T02:10:00Z' });
    ingest.put(b.id, 'entwirft', { origin: 'knopf' });
    ingest.put(f.id, 'fehler', { error: 'Claude hat nicht geantwortet <b>!</b>' });
    page = await html('/lesen/ingest');
    const card = page.match(/<li class="ingest-card"[^]*?Prüfen/)[0];
    assert.match(card, /Blatt · 7 Min\. · nachts entworfen · 25\. Okt\., 03:10/);
    assert.match(card, /<a href="\/lesen\/ingest\/doc\?id=[^"]+" class="ingest-card-title">Bereit<\/a>/);
    assert.match(card, /<li>Erste Aussage über <strong>Bereit<\/strong><\/li><li>Zweite Aussage<\/li><li>Dritte Aussage<\/li><\/ul>/);
    assert.ok(!card.includes('Vierte Aussage'), 'nur drei Kernaussagen auf der Karte');
    assert.match(card, /1 Verknüpfung · 1 Bestätigung · 1 Synthese · 1 Frage · 1 neue Seite · 1 Relation/);
    assert.match(card, /Synthese angeboten/);
    assert.match(page, /<h2 id="ingest-bereit">Bereit zum Abhaken <span class="hint">1<\/span>/);
    assert.match(page, new RegExp(`<li class="ingest-row is-busy" data-ingest-doc="${b.id}" data-ingest-watch="${b.id}" data-ingest-status="entwirft">[^]*Claude entwirft`));
    assert.match(page, /<h2 id="ingest-fehler">Fehler/);
    assert.match(page, /<p class="problem">Claude hat nicht geantwortet &lt;b&gt;!&lt;\/b&gt;<\/p>/);
    assert.match(page, new RegExp(`name="id" value="${f.id}"><input type="hidden" name="force" value="1"><button type="submit" class="btn">Erneut entwerfen`));
    assert.match(page, /2 Texte auf dem Stapel haben noch keinen fertigen Entwurf/, '„Erst einer“ und der fehlgeschlagene');
    assert.match(page, /<script src="\/static\/lesen-ingest\.js\?v=[^"]+" defer><\/script>/);
    noInline(page);
  });
});

test('Ingest: ohne Claude ein Hinweis und keine Entwerfen-Knöpfe, Abhaken geht weiter', async () => {
  await withIngest(
    async ({ html, add, ingest }) => {
      const r = add('Bereit');
      add('Ohne');
      ingest.put(r.id, 'bereit', { draft: draftFor('Bereit') });
      const page = await html('/lesen/ingest');
      assert.match(page, /<p class="problem unconfigured">Claude ist gerade nicht verfügbar: Kein Claude-Token hinterlegt\./);
      assert.ok(!page.includes('Ganzen Stapel entwerfen'));
      const stack = await html('/lesen/stapel');
      assert.ok(!stack.includes('Ingest entwerfen'));
      assert.match(stack, /Ingest bereit/);
      assert.match(await html(`/lesen/ingest/doc?id=${r.id}`), /Ins Wiki übernehmen/);
    },
    { available: { ok: false, reason: 'Kein Claude-Token hinterlegt' } },
  );
});

test('Ingest: Prüfansicht mit Digest, Source-Page, gruppierten Vorschlägen und Aktionen', async () => {
  await withIngest(async ({ html, add, ingest }) => {
    const d = add('Agenten mit Gedächtnis');
    const other = add('Noch einer');
    ingest.put(other.id, 'bereit', { draft: draftFor('Noch einer') });
    ingest.put(d.id, 'bereit', { draft: draftFor('Agenten mit Gedächtnis') });
    const page = await html(`/lesen/ingest/doc?id=${d.id}`);
    noInline(page);
    // Kopf: Titel in Leseschrift, Text lesen, Original, Stelle unter den bereiten.
    assert.match(page, /<h1 class="ingest-h1">Agenten mit Gedächtnis<\/h1>/);
    assert.match(page, new RegExp(`<a href="/lesen/doc\\?id=${d.id}">Text lesen</a><a href="https://blatt\\.test/[^"]+" rel="noopener noreferrer" target="_blank">Original</a>`));
    assert.match(page, new RegExp(`<span class="pager-now">1 von 2</span><a href="/lesen/ingest/doc\\?id=${other.id}" rel="next" data-ingest-next`));
    // Digest
    assert.match(page, /<ul class="ingest-kern"><li>Erste Aussage über <strong>Agenten mit Gedächtnis<\/strong><\/li>[^]*Vierte Aussage/);
    assert.match(page, /<h3>Neu für dich<\/h3><ul><li>Agenten brauchen ein Gedächtnis/);
    assert.match(page, /<h3>Bestätigt<\/h3><ul><li><a href="\/notiz\?pfad=wiki%2Fconcepts%2Fcontext-engineering\.md" class="ingest-ref">Context Engineering<\/a><span>Kontext ist knapp<\/span>/);
    assert.match(page, /<h3>Widerspricht<\/h3><div class="problem"><p><a href="\/notiz\?pfad=wiki%2Fconcepts%2Frag\.md" class="ingest-ref">RAG<\/a>: RAG sei überholt<\/p><p class="meta">Vorschlag: Als Gegenposition aufnehmen<\/p><p class="meta">Das Cockpit ändert die Seite nicht\. Auflösung per <code>\/wiki-lint<\/code>/);
    assert.match(page, /<h3>Dockt an<\/h3><ul><li><a href="\/notiz\?pfad=wiki%2Fentities%2Fclaude-code\.md" class="ingest-ref">Claude Code<\/a><span>Beispiel im Text<\/span>/);
    // Source-Page: Felder mit den Werten des Entwurfs, Zähler bis 80, Text als Markdown.
    assert.match(page, /<input type="text" name="title" value="Agenten mit Gedächtnis" required>/);
    assert.match(page, /<span class="ingest-count" data-ingest-count-for="summary">53\/80<\/span><\/span><input type="text" name="summary" value="Wie Agenten sich erinnern, ohne den Kontext zu füllen" maxlength="80" data-ingest-summary>/);
    assert.match(page, /<input type="text" name="slug" value="glaser-agenten-gedaechtnis" pattern=/);
    assert.match(page, /<input type="text" name="tags" value="agents, memory"/);
    assert.match(page, /<div class="md ingest-md"><h3 id="h-kern">Kern<\/h3>/);
    // Gruppen in Vertragsreihenfolge, Häkchen nach `default`.
    assert.deepEqual([...page.matchAll(/data-ingest-group="(\w+)"/g)].map((m) => m[1]), ['verknuepfen', 'bestaetigung', 'synthese', 'neu', 'relation']);
    const boxes = Object.fromEntries([...page.matchAll(/<input type="checkbox" name="item" value="(\w+)"( checked)?>/g)].map((m) => [m[1], Boolean(m[2])]));
    assert.deepEqual(boxes, { v1: true, b1: true, s1: false, q1: false, n1: false, r1: true });
    assert.match(page, /<section class="ingest-group is-featured" data-ingest-group="synthese"/);
    assert.match(page, /<span class="ingest-pill is-offer">Synthese · Vergleich<\/span><span class="ingest-item-title">Gedächtnis statt RAG\?<\/span>/);
    assert.match(page, /<span class="ingest-pill is-offer">Frage<\/span>/);
    assert.match(page, /<details class="ingest-body"><summary>Ganzen Text lesen<\/summary><div class="md ingest-md"><p>Ein <strong>Vergleich<\/strong>\.<\/p>/);
    // Beteiligte stehen im Entwurf nur als Pfad; der Titel kommt aus dem Digest, sonst bliebe der Slug.
    assert.match(page, /<span class="meta">Beteiligt:<\/span> <a href="\/notiz\?pfad=wiki%2Fconcepts%2Frag\.md" class="ingest-ref">RAG<\/a><\/p>/);
    assert.ok(!page.includes('ingest-halted') && !page.includes('Übernehmen unterbrochen'), 'kein Hinweis ohne Abbruch');
    assert.ok(!/name="title"[^>]*readonly/.test(page), 'Felder änderbar');
    assert.match(page, /<span class="ingest-pill">Person<\/span><span class="ingest-item-title">Robert Glaser<\/span>/);
    assert.match(page, /<span class="ingest-rel" title="authored-by">verfasst von<\/span> Robert Glaser/);
    assert.match(page, /<span class="ingest-all" data-ingest-all hidden><button type="button" class="chip quiet" data-select="all">alle<\/button>/);
    // Aktionen: ein Formular, Enter in einem Feld schickt nichts ab, die Nebenaktionen über formaction.
    assert.match(page, new RegExp(`<form method="post" action="/aktion/lesen/ingest/uebernehmen" class="ingest-form" data-ingest-form>\\s*<input type="hidden" name="csrf" value="[^"]+"><input type="hidden" name="back" value="/lesen/ingest/doc\\?id=${d.id}"><input type="hidden" name="id" value="${d.id}">\\s*<button type="submit" class="ingest-guard" disabled hidden`));
    assert.match(page, /<b data-ingest-sum>Source-Page und 3 Vorschläge<\/b>/);
    assert.match(page, /<button type="submit" class="btn primary" data-ingest-apply>Ins Wiki übernehmen <span class="ingest-n" data-ingest-n>4<\/span><\/button>/);
    assert.match(page, /formaction="\/aktion\/lesen\/ingest\/entwerfen" formnovalidate name="force" value="1"[^>]*>Neu entwerfen/);
    assert.match(page, /formaction="\/aktion\/lesen\/ingest\/verwerfen" formnovalidate name="done" value="1" data-ingest-done>Ohne Wiki erledigen/);
    assert.match(page, /formaction="\/aktion\/lesen\/ingest\/verwerfen" formnovalidate data-confirm="[^"]+">Entwurf verwerfen/);
  });
});

test('Ingest: Claudes Text ist Fremdtext, kein HTML und keine javascript:-Links kommen durch', async () => {
  await withIngest(async ({ html, call, add, ingest }) => {
    const d = add('Böse');
    ingest.put(d.id, 'bereit', { draft: draftFor('Böse', { evil: true }) });
    for (const page of [await html(`/lesen/ingest/doc?id=${d.id}`), await html('/lesen/ingest')]) {
      assert.ok(!page.includes('<script>alert'), 'kein Skript');
      assert.ok(!/<img src=x/i.test(page), 'kein Bild mit onerror');
      assert.ok(!/href="javascript:/i.test(page), 'kein javascript:-Link');
      assert.ok(page.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), 'als Text sichtbar');
    }
    const api = await (await call(`/api/lesen/ingest/doc?id=${d.id}`)).json();
    assert.ok(api.draft.source.title.includes('<script>'), 'JSON trägt den Rohtext, die App maskiert selbst');
  });
});

test('Ingest: Übernehmen schickt gewählte Vorschläge und Felder, führt zum nächsten Entwurf und verlinkt die Source-Page', async () => {
  await withIngest(async ({ html, call, add, ingest, store }) => {
    const a = add('Erster');
    const b = add('Zweiter');
    ingest.put(b.id, 'bereit', { draft: draftFor('Zweiter') });
    ingest.put(a.id, 'bereit', { draft: draftFor('Erster') });
    const page = await html(`/lesen/ingest/doc?id=${a.id}`);
    const csrf = csrfFrom(page);
    const form = new URLSearchParams({ csrf, back: `/lesen/ingest/doc?id=${a.id}`, id: a.id, title: '  Erster, besser  ', summary: 'Kurz', slug: 'erster-besser', tags: 'Agents, #memory, agents' });
    for (const id of ['v1', 's1', 'n1']) form.append('item', id);
    const res = await call('/aktion/lesen/ingest/uebernehmen', { method: 'POST', form });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), `/lesen/ingest/doc?id=${b.id}`);
    const applied = ingest.calls.find((c) => c[0] === 'apply');
    assert.deepEqual(applied, ['apply', a.id, { items: ['v1', 's1', 'n1'], source: { title: 'Erster, besser', summary: 'Kurz', slug: 'erster-besser', tags: ['agents', 'memory'] } }]);
    assert.equal(store.get(a.id).status, 'archiv');
    const next = await html(res.headers.get('location'));
    assert.match(next, /<span class="toast-text">Im Wiki: Erster, besser \+ 1 Seite, 1 verknüpft<\/span><a href="\/notiz\?pfad=wiki%2Fsources%2Ferster-besser\.md" class="toast-action">Source-Page öffnen<\/a>/);

    // Der letzte: zurück zur Übersicht; mit JavaScript als JSON samt Weiterleitung und Link.
    const json = await call('/aktion/lesen/ingest/uebernehmen', { method: 'POST', form: { csrf, id: b.id, back: `/lesen/ingest/doc?id=${b.id}` }, accept: 'application/json' });
    assert.equal(json.status, 200);
    const body = await json.json();
    assert.equal(body.redirect, '/lesen/ingest');
    assert.equal(body.link.href, '/notiz?pfad=wiki%2Fsources%2Fx.md');
    assert.deepEqual(ingest.calls.filter((c) => c[0] === 'apply').at(-1)[2].items, [], 'nichts abgehakt: nur die Source-Page');
  });
});

test('Ingest: unterbrochenes Übernehmen steht in der Prüfansicht, die Felder der schon geschriebenen Source-Page sind fest', async () => {
  await withIngest(async ({ html, add, ingest }) => {
    const a = add('Halb');
    // So hinterlässt der Dienst einen Abbruch: bereit, mit Fehler und dem Stand der Schritte.
    ingest.put(a.id, 'bereit', {
      draft: draftFor('Halb'),
      error: '"wiki/concepts/rag.md" wurde gerade anderweitig geändert. <b>x</b>',
      applied: { steps: ['raw', 'source'], items: {}, written: ['wiki/sources/halb-1234.md'], linked: [], raw: 'raw/halb.md', slug: 'halb-1234', source: 'wiki/sources/halb-1234.md' },
    });
    const page = await html(`/lesen/ingest/doc?id=${a.id}`);
    assert.match(page, /<section class="ingest-state" role="status"><p class="problem">Übernehmen unterbrochen: &quot;wiki\/concepts\/rag\.md&quot; wurde gerade anderweitig geändert\. &lt;b&gt;x&lt;\/b&gt;<\/p>/);
    assert.match(page, /Die Source-Page <a href="\/notiz\?pfad=wiki%2Fsources%2Fhalb-1234\.md">halb-1234<\/a> ist schon geschrieben/);
    for (const name of ['title', 'summary', 'tags', 'slug']) assert.match(page, new RegExp(`name="${name}"[^>]*readonly>`), `${name} schreibgeschützt`);
    assert.match(page, /<input type="text" name="slug" value="halb-1234"/, 'der Slug, den der Dienst festgelegt hat');
    assert.match(page, /wiki\/sources\/halb-1234\.md<\/span><\/h2>/);

    // Nur die Rohquelle geschrieben: Hinweis ja, Felder noch frei.
    ingest.rows.get(a.id).applied = { steps: ['raw'], items: {}, written: [], linked: [], raw: 'raw/halb.md' };
    const early = await html(`/lesen/ingest/doc?id=${a.id}`);
    assert.match(early, /Übernehmen unterbrochen:[^]*Ein Teil ist schon geschrieben\./);
    assert.ok(!/name="title"[^>]*readonly/.test(early));
  });
});

test('Ingest: Fehler des Dienstes stehen als Meldung da, mit JavaScript als JSON mit Status', async () => {
  await withIngest(async ({ html, call, add, ingest }) => {
    const a = add('Hakt');
    ingest.put(a.id, 'bereit', { draft: draftFor('Hakt') });
    const csrf = csrfFrom(await html(`/lesen/ingest/doc?id=${a.id}`));
    ingest.state.failApply = new IngestError('Die Seite wiki/sources/hakt.md gibt es schon', 409);
    const res = await call('/aktion/lesen/ingest/uebernehmen', { method: 'POST', form: { csrf, id: a.id, back: `/lesen/ingest/doc?id=${a.id}` } });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), `/lesen/ingest/doc?id=${a.id}`);
    assert.match(await html(res.headers.get('location')), /class="toast error"[^>]*><span class="toast-text">Die Seite wiki\/sources\/hakt\.md gibt es schon<\/span>/);
    const json = await call('/aktion/lesen/ingest/uebernehmen', { method: 'POST', form: { csrf, id: a.id }, accept: 'application/json' });
    assert.equal(json.status, 409);
    assert.deepEqual(await json.json(), { error: 'action_failed', message: 'Die Seite wiki/sources/hakt.md gibt es schon' });
    const missing = await call('/aktion/lesen/ingest/uebernehmen', { method: 'POST', form: { csrf, id: 'gibt-es-nicht' }, accept: 'application/json' });
    assert.equal(missing.status, 404);
  });
});

test('Ingest: Entwerfen einzeln, neu (force) und für den ganzen Stapel', async () => {
  await withIngest(async ({ html, call, add, ingest }) => {
    const a = add('Eins');
    add('Zwei');
    add('Im Eingang', 'eingang');
    const csrf = csrfFrom(await html('/lesen/stapel'));
    const one = await call('/aktion/lesen/ingest/entwerfen', { method: 'POST', form: { csrf, id: a.id }, accept: 'application/json' });
    assert.equal((await one.json()).message, 'Wird entworfen: Eins');
    assert.deepEqual(ingest.calls.at(-1), ['request', [a.id], { origin: 'knopf', force: false }]);

    const stack = await call('/aktion/lesen/ingest/entwerfen', { method: 'POST', form: { csrf, stapel: '1', back: '/lesen/ingest' } });
    assert.equal(stack.status, 303);
    assert.equal(stack.headers.get('location'), '/lesen/ingest');
    assert.deepEqual(ingest.calls.at(-1), ['requestStack', { origin: 'knopf' }]);
    assert.match(await html('/lesen/ingest'), /<span class="toast-text">1 Text wird entworfen, einer nach dem anderen\.<\/span>/);
    const none = await call('/aktion/lesen/ingest/entwerfen', { method: 'POST', form: { csrf, stapel: '1' }, accept: 'application/json' });
    assert.equal((await none.json()).message, 'Nichts zu entwerfen: Jeder Text auf dem Stapel hat schon einen Entwurf.');

    ingest.rows.get(a.id).status = 'bereit';
    ingest.rows.get(a.id).draft = draftFor('Eins');
    const again = await call('/aktion/lesen/ingest/entwerfen', { method: 'POST', form: { csrf, id: a.id, force: '1', back: `/lesen/ingest/doc?id=${a.id}` } });
    assert.equal(again.headers.get('location'), `/lesen/ingest/doc?id=${a.id}`);
    assert.deepEqual(ingest.calls.at(-1), ['request', [a.id], { origin: 'knopf', force: true }]);
    // Die Prüfansicht zeigt jetzt den Stand und lädt sich neu, sobald er sich ändert.
    assert.match(await html(`/lesen/ingest/doc?id=${a.id}`), new RegExp(`<section class="ingest-state" data-ingest-watch="${a.id}" data-ingest-status="wartet" data-ingest-reload>`));
  });
});

test('Ingest: Ohne Wiki erledigen mit Rückgängig, Verwerfen führt aus der Prüfansicht weiter', async () => {
  await withIngest(async ({ html, call, add, ingest, store }) => {
    const a = add('Gelesen');
    const b = add('Danach');
    ingest.put(b.id, 'bereit', { draft: draftFor('Danach') });
    ingest.put(a.id, 'bereit', { draft: draftFor('Gelesen') });
    const csrf = csrfFrom(await html(`/lesen/ingest/doc?id=${a.id}`));
    const res = await call('/aktion/lesen/ingest/verwerfen', { method: 'POST', form: { csrf, id: a.id, done: '1', back: `/lesen/ingest/doc?id=${a.id}`, item: 'v1' }, accept: 'application/json' });
    const body = await res.json();
    assert.equal(body.message, 'Erledigt, ohne Wiki: Gelesen');
    assert.deepEqual(body.undo, { action: '/aktion/lesen/doc/status', fields: { id: a.id, status: 'stapel' } });
    assert.equal(body.redirect, `/lesen/ingest/doc?id=${b.id}`);
    assert.deepEqual(ingest.calls.at(-1), ['discard', a.id, { done: true }]);
    assert.equal(store.get(a.id).status, 'weg');

    const plain = await call('/aktion/lesen/ingest/verwerfen', { method: 'POST', form: { csrf, id: b.id, back: '/lesen/ingest' } });
    assert.equal(plain.headers.get('location'), '/lesen/ingest', 'aus der Übersicht bleibt es dort');
    assert.deepEqual(ingest.calls.at(-1), ['discard', b.id, { done: false }]);
    assert.match(await html('/lesen/ingest'), /<span class="toast-text">Entwurf verworfen: Danach<\/span>/);
  });
});

test('Ingest: Stapel mit Abzeichen je Eintrag aus einer Abfrage, Leseansicht mit „Ingest prüfen“', async () => {
  await withIngest(async ({ html, add, ingest }) => {
    const ready = add('Bereit');
    const busy = add('Läuft');
    const failed = add('Kaputt');
    const none = add('Ohne');
    ingest.put(ready.id, 'bereit', { draft: draftFor('Bereit') });
    ingest.put(busy.id, 'entwirft');
    ingest.put(failed.id, 'fehler', { error: 'x' });
    const before = ingest.calls.filter((c) => c[0] === 'statusFor').length;
    const page = await html('/lesen/stapel');
    assert.equal(ingest.calls.filter((c) => c[0] === 'statusFor').length - before, 1, 'eine Abfrage für den ganzen Stapel');
    assert.match(page, new RegExp(`<a href="/lesen/ingest/doc\\?id=${ready.id}" class="ingest-badge is-ready" data-ingest-badge="${ready.id}" data-ingest-status="bereit">Ingest bereit<span class="sr-only">: Bereit</span></a>`));
    assert.match(page, new RegExp(`<span class="ingest-badge is-busy" data-ingest-badge="${busy.id}" data-ingest-status="entwirft" data-ingest-watch="${busy.id}">wird entworfen…</span>`));
    assert.match(page, new RegExp(`class="ingest-badge is-failed" data-ingest-badge="${failed.id}" data-ingest-status="fehler">Ingest-Fehler`));
    assert.match(page, new RegExp(`<form method="post" action="/aktion/lesen/ingest/entwerfen" class="act ingest-badge-form" data-ingest-badge="${none.id}" data-ingest-status="">[^]*?name="id" value="${none.id}"><button type="submit" class="btn quiet">Ingest entwerfen<span class="sr-only">: Ohne</span></button></form>`));
    assert.match(page, /<script src="\/static\/lesen-ingest\.js\?v=[^"]+" defer><\/script>/);
    noInline(page);

    const json = await (await fetchJson(html, '/api/lesen/stapel'));
    assert.equal(json.ingest, true);
    assert.deepEqual(Object.fromEntries(json.items.map((i) => [i.title, i.ingest])), { Bereit: 'bereit', Läuft: 'entwirft', Kaputt: 'fehler', Ohne: null });

    assert.match(await html(`/lesen/doc?id=${ready.id}`), new RegExp(`<div class="lesen-decide">\\s*<a href="/lesen/ingest/doc\\?id=${ready.id}" class="ingest-badge is-ready"[^>]*>Ingest prüfen</a>`));
    assert.match(await html(`/lesen/doc?id=${none.id}`), /<div class="lesen-decide">\s*<form method="post" action="\/aktion\/lesen\/ingest\/entwerfen" class="act ingest-badge-form"[^]*?Ingest entwerfen/);
  });
});

/** JSON über dieselbe Sitzung (`html` holt den Text). */
const fetchJson = async (html, path) => JSON.parse(await html(path));

test('Ingest: Live-Stand und App-JSON', async () => {
  await withIngest(async ({ call, add, ingest }) => {
    const a = add('Bereit');
    const b = add('Läuft');
    const c = add('Ohne');
    ingest.put(a.id, 'bereit', { draft: draftFor('Bereit') });
    ingest.put(b.id, 'wartet');
    const stand = await call(`/lesen/ingest/stand?ids=${a.id},${b.id},${c.id}&back=/lesen/stapel`);
    assert.equal(stand.headers.get('cache-control'), 'no-store');
    const s = await stand.json();
    assert.deepEqual(s.counts, { wartet: 1, entwirft: 0, bereit: 1, fehler: 0 });
    assert.deepEqual(s.items.map((i) => [i.title, i.status, i.busy]), [['Bereit', 'bereit', false], ['Läuft', 'wartet', true], ['Ohne', null, false]]);
    assert.match(s.items[0].badge, /class="ingest-badge is-ready"/);
    assert.match(s.items[2].badge, /<input type="hidden" name="back" value="\/lesen\/stapel">/);
    // Aus der Leseansicht heißt das fertige Abzeichen wie dort „Ingest prüfen“, sonst benennt der Austausch es um.
    const fromDoc = await (await call(`/lesen/ingest/stand?ids=${a.id}&back=/lesen/doc`)).json();
    assert.match(fromDoc.items[0].badge, /class="ingest-badge is-ready"[^>]*>Ingest prüfen<span class="sr-only">: Bereit<\/span><\/a>/);
    const all = await (await call('/lesen/ingest/stand')).json();
    assert.deepEqual(all.items.map((i) => i.id).sort(), [a.id, b.id].sort(), 'ohne ids: alle offenen');

    const list = await (await call('/api/lesen/ingest')).json();
    assert.equal(list.enabled, true);
    assert.equal(list.available, true);
    assert.equal(list.openOnStack, 1);
    assert.deepEqual(list.ready.map((e) => [e.id, e.title, e.tallyLabel, e.kernaussagen.length]), [[a.id, 'Bereit', '1 Verknüpfung · 1 Bestätigung · 1 Synthese · 1 Frage · 1 neue Seite · 1 Relation', 4]]);
    assert.deepEqual(list.busy.map((e) => [e.id, e.label]), [[b.id, 'Wartet auf den Nachtlauf']]);
    assert.equal(list.actions.apply, '/aktion/lesen/ingest/uebernehmen');

    const doc = await (await call(`/api/lesen/ingest/doc?id=${a.id}`)).json();
    assert.deepEqual(doc.groups.map((g) => [g.key, g.items.map((i) => i.id)]), [['verknuepfen', ['v1']], ['bestaetigung', ['b1']], ['synthese', ['s1', 'q1']], ['neu', ['n1']], ['relation', ['r1']]]);
    assert.deepEqual(doc.selected, ['v1', 'b1', 'r1']);
    assert.equal(doc.draft.source.slug, 'glaser-agenten-gedaechtnis');
    assert.equal(doc.position, 1);
    assert.equal((await call('/api/lesen/ingest/doc?id=nix')).status, 404);
  });
});

test('Ingest: Prüfansicht ohne bereiten Entwurf zeigt den Stand, unbekannte Texte 404, Skript wird ausgeliefert', async () => {
  await withIngest(async ({ call, html, add, ingest }) => {
    const a = add('Ohne Entwurf');
    let page = await html(`/lesen/ingest/doc?id=${a.id}`);
    assert.match(page, /Für diesen Text gibt es noch keinen Entwurf\./);
    assert.match(page, /<button type="submit" class="btn primary">Ingest entwerfen<\/button>/);
    ingest.put(a.id, 'fehler', { error: 'Zeitüberschreitung' });
    page = await html(`/lesen/ingest/doc?id=${a.id}`);
    assert.match(page, /<p class="problem">Zeitüberschreitung<\/p>[^]*Erneut entwerfen/);
    ingest.put(a.id, 'uebernommen', { applied: { source: 'wiki/sources/ohne.md' } });
    assert.match(await html(`/lesen/ingest/doc?id=${a.id}`), /<a href="\/notiz\?pfad=wiki%2Fsources%2Fohne\.md" class="btn">Source-Page öffnen<\/a>/);
    assert.equal((await call('/lesen/ingest/doc?id=gibt-es-nicht')).status, 404);
    const js = await call('/static/lesen-ingest.js');
    assert.equal(js.status, 200);
    assert.match(js.headers.get('content-type'), /javascript/);
  });
});

test('Ingest: „Ganzen Stapel entwerfen“ zählt wie der Dienst – ohne Entwurf und fehlgeschlagen, nicht verworfen', async () => {
  await withIngest(async ({ html, call, add, ingest }) => {
    add('Ohne');
    const f = add('Fehlgeschlagen');
    const v = add('Verworfen');
    const w = add('Auch verworfen');
    const r = add('Bereit');
    ingest.put(f.id, 'fehler', { error: 'x' });
    ingest.put(v.id, 'verworfen');
    ingest.put(w.id, 'verworfen');
    ingest.put(r.id, 'bereit', { draft: draftFor('Bereit') });
    assert.match(await html('/lesen/ingest'), /2 Texte auf dem Stapel haben noch keinen fertigen Entwurf\./);
    assert.equal((await (await call('/api/lesen/ingest')).json()).openOnStack, 2);
    const csrf = csrfFrom(await html('/lesen/ingest'));
    const res = await call('/aktion/lesen/ingest/entwerfen', { method: 'POST', form: { csrf, stapel: '1' }, accept: 'application/json' });
    assert.equal((await res.json()).count, 2, 'der Knopf verspricht, was der Dienst anstößt');
    assert.equal(ingest.rows.get(v.id).status, 'verworfen');
  });
});

test('Ingest: Prüfansicht öffnet bestehende Seiten über ein Symbol neben dem Häkchen statt „Seite ansehen“, Neues ohne Link', async () => {
  await withIngest(async ({ html, add, ingest }) => {
    const d = add('Kompakt');
    const draft = draftFor('Kompakt');
    draft.items.push({ id: 'r2', kind: 'relation', type: 'related-to', to: 'wiki/concepts/rag.md', title: 'RAG', default: true });
    ingest.put(d.id, 'bereit', { draft });
    const page = await html(`/lesen/ingest/doc?id=${d.id}`);
    assert.ok(!/>Seite ansehen/.test(page), 'kein eigener Link je Karte');
    assert.ok(!page.includes('ingest-open'));
    const item = (id) => page.match(new RegExp(`<li class="ingest-item[^"]*" data-item="${id}">[^]*?</li>`))[0];
    const openLink = (path) => new RegExp(`<a href="\\/notiz\\?pfad=${path}" class="ingest-item-open"[^>]*>↗<\\/a><label class="ingest-pick">`);
    assert.match(item('v1'), openLink('wiki%2Fconcepts%2Fcontext-engineering\\.md'));
    assert.match(item('v1'), /<span class="ingest-item-head"><span class="ingest-pill">Konzept<\/span><span class="ingest-item-title">Context Engineering<\/span><\/span><span class="ingest-why">Kernthema<\/span>/);
    assert.match(item('b1'), openLink('wiki%2Fconcepts%2Fcontext-engineering\\.md'));
    assert.match(item('b1'), /<span class="ingest-item-title">Context Engineering<\/span><span class="ingest-claim">Kontext ist knapp<\/span>/);
    assert.match(item('r2'), openLink('wiki%2Fconcepts%2Frag\\.md'));
    assert.match(item('r2'), /verwandt mit<\/span> RAG<\/span>/);
    // Im <label> steht kein Link: ein Tipp auf den Titel schaltet nur das Häkchen.
    for (const id of ['v1', 'b1', 'r2']) assert.ok(!item(id).match(/<label[^]*<\/label>/)[0].includes('<a '), `${id}: Link außerhalb des Labels`);
    // Robert Glaser entsteht erst mit diesem Entwurf: weder als neue Seite noch als Ziel der Relation ein Link.
    assert.ok(!item('n1').includes('ingest-item-open'), 'neue Seite ohne Link');
    assert.match(item('r1'), /verfasst von<\/span> Robert Glaser<\/span>/);
    // Der Titel steht im <label>, die Häkchen bleiben dort.
    assert.match(item('v1'), /<label class="ingest-pick"><input type="checkbox" name="item" value="v1" checked>/);
  });
});

test('Ingest: Wikilinks in Digest, Hinweisen und Vorschau werden Links mit Titel, Unbekanntes lesbarer Text', async () => {
  await withIngest(async ({ html, add, ingest }) => {
    const d = add('Verweise');
    const draft = draftFor('Verweise');
    draft.digest.neu = ['Ergänzt [[claude-code]] und [[gibt-es-nicht-im-wiki]]', 'Code bleibt: `[[rag]]`'];
    draft.source.body = 'Siehe [[context-engineering]], [[rag|Retrieval]] und [[gedaechtnis-vs-rag]].\n\n```\n[[rag]]\n```\n\n| Seite | Rolle |\n|---|---|\n| [[rag]] | Gegenpol |';
    // `links` des Dienstes hat Vorrang: hier mit eigenem Titel für claude-code.
    ingest.put(d.id, 'bereit', { draft, links: { 'claude-code': { path: 'wiki/entities/claude-code.md', title: 'Claude Code (CLI)' } } });
    const page = await html(`/lesen/ingest/doc?id=${d.id}`);
    const re = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const link = (path, label) => `<a href="${re(`/notiz?pfad=${encodeURIComponent(path)}`)}" class="wikilink" title="${re(path)}">${re(label)}</a>`;
    // Hinweis des Dienstes: `Widerspruch zu [[rag]]`
    assert.match(page, new RegExp(`<ul class="ingest-hinweise"><li>Widerspruch zu ${link('wiki/concepts/rag.md', 'RAG')} – Auflösung per /wiki-lint</li>`));
    assert.match(page, new RegExp(`<li>Ergänzt ${link('wiki/entities/claude-code.md', 'Claude Code (CLI)')} und gibt es nicht im wiki</li>`));
    assert.match(page, /<li>Code bleibt: <code>\[\[rag\]\]<\/code><\/li>/);
    assert.match(page, new RegExp(link('wiki/concepts/context-engineering.md', 'Context Engineering')));
    assert.match(page, new RegExp(link('wiki/concepts/rag.md', 'Retrieval')), 'eigene Anzeige bleibt');
    assert.match(page, /und Gedächtnis statt RAG\?\.<\/p>/, 'neue Seite: ihr Titel als Text');
    assert.ok(!page.includes('(fehlt)'), 'nichts als fehlend markiert');
    assert.ok(!/\[\[/.test(page.replace(/<code[^>]*>[^]*?<\/code>/g, '')), 'keine rohen Wikilinks außerhalb von Code');
    assert.match(page, /<pre><code[^>]*>\[\[rag\]\]/, 'im Codeblock unverändert');
    assert.match(page, new RegExp(`<td>${link('wiki/concepts/rag.md', 'RAG')}</td>\\s*<td>Gegenpol</td>`), 'in Tabellen bleibt die Spalte heil');
  });
});

test('Ingest: Live-Stand gibt den Abzeichen die Rücksprung-Adresse samt Query', async () => {
  assert.deepEqual(standBack('/lesen/doc?id=abc'), { back: '/lesen/doc?id=abc', path: '/lesen/doc' });
  assert.deepEqual(standBack('/lesen/stapel'), { back: '/lesen/stapel', path: '/lesen/stapel' });
  for (const bad of ['//evil.test/lesen/x', 'https://evil.test/lesen/doc', '/notiz?pfad=x', '/lesen/../aktion', null]) assert.equal(standBack(bad).back, '/lesen/stapel', String(bad));
  await withIngest(async ({ call, add, ingest }) => {
    const a = add('Ohne');
    const b = add('Bereit');
    ingest.put(b.id, 'bereit', { draft: draftFor('Bereit') });
    const back = `/lesen/doc?id=${a.id}`;
    const s = await (await call(`/lesen/ingest/stand?ids=${a.id},${b.id}&back=${encodeURIComponent(back)}`)).json();
    assert.match(s.items[0].badge, new RegExp(`<input type="hidden" name="back" value="/lesen/doc\\?id=${a.id}">`));
    assert.match(s.items[1].badge, />Ingest prüfen</, 'Leseansicht erkannt, auch mit Query');
  });
  // Die Seite schickt ihre ganze Adresse mit.
  const js = readFileSync(new URL('../src/web/static/lesen-ingest.js', import.meta.url), 'utf8');
  assert.match(js, /back: location\.pathname \+ location\.search/);
});

test('Ingest: Meldung nach dem Übernehmen zählt Bestätigungen getrennt, wenn der Dienst sie liefert', async () => {
  const r = { source: 'wiki/sources/a.md', written: ['wiki/sources/a.md', 'wiki/concepts/neu.md', 'wiki/log.md'], linked: ['wiki/concepts/x.md', 'wiki/concepts/y.md'] };
  assert.equal(appliedMessage('A', r), 'Im Wiki: A + 1 Seite, 2 verknüpft', 'ältere Fassung ohne `confirmed`: wie bisher');
  assert.equal(appliedMessage('A', { ...r, linked: ['wiki/concepts/x.md'], confirmed: ['wiki/concepts/y.md', 'wiki/concepts/z.md'] }), 'Im Wiki: A + 1 Seite, 1 verknüpft, 2 bestätigt');
  assert.equal(appliedMessage('A', { ...r, linked: [], confirmed: ['wiki/concepts/y.md'] }), 'Im Wiki: A + 1 Seite, 1 bestätigt');
  assert.equal(appliedMessage('A', { ...r, confirmed: [] }), 'Im Wiki: A + 1 Seite, 2 verknüpft');
  await withIngest(async ({ html, call, add, ingest }) => {
    const a = add('Bestätigt');
    ingest.put(a.id, 'bereit', { draft: draftFor('Bestätigt') });
    ingest.state.applyExtra = { linked: [], confirmed: ['wiki/concepts/context-engineering.md'] };
    const csrf = csrfFrom(await html(`/lesen/ingest/doc?id=${a.id}`));
    const res = await call('/aktion/lesen/ingest/uebernehmen', { method: 'POST', form: { csrf, id: a.id, back: `/lesen/ingest/doc?id=${a.id}` }, accept: 'application/json' });
    assert.equal((await res.json()).message, 'Im Wiki: Bestätigt + 1 Seite, 1 bestätigt');
  });
});
