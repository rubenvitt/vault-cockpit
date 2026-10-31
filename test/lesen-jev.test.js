import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/http/app.js';
import { createWebHttp } from '../src/web/http.js';
import { createCookieSigner } from '../src/web/session.js';
import { createSettingsStore, validateSettings, SettingsError } from '../src/cockpit/settings.js';
import { createReadingStore } from '../src/lesen/store.js';
import { readingRoutes } from '../src/lesen/http.js';
import { createJevDecider, createFeedTriage, triageFromAnswers, triageState, JevError, JEV_DEFAULT_MODEL } from '../src/lesen/jev.js';
import { mergeSettingsForm, settingsJson } from '../src/web/settings-json.js';
import { createSecretBox } from '../src/cockpit/secret-box.js';

const quiet = { info() {}, warn() {}, error() {} };
const SECRET = 'x'.repeat(40);

/** Antwort wie von `POST /v1/systemone`. */
const answer = (choice, p, score = 2) => ({
  model: 'jev-1.14.0',
  answers: {
    entscheidung: { type: 'choice', choice, probabilities: p, confidence: 0.7 },
    naehe: { type: 'score', score, probabilities: { 0: 0.1, 1: 0.2, 2: 0.4, 3: 0.3 }, confidence: 0.5 },
  },
  usage: { input_tokens: 400, output_tokens: 20 },
});

function feedDocs(store) {
  const { feed } = store.addFeed({ url: 'https://blatt.test/feed.xml', title: 'Blatt' });
  const add = (n) => store.addDocument({ url: `https://blatt.test/${n}`, title: `Artikel ${n}`, excerpt: `Auszug ${n}`, kind: 'feed', origin: `feed:${feed.id}` }).doc;
  return { feed, add };
}

test('Jev-Client: schickt state, gepinntes Modell und Fragen mit Bearer-Key, liest answers', async () => {
  let sent;
  const fetchImpl = async (url, init) => {
    sent = { url, init, body: JSON.parse(init.body) };
    return new Response(JSON.stringify(answer('lesen', { lesen: 0.6, stapel: 0.3, weg: 0.05, unklar: 0.05 })), { status: 200 });
  };
  const d = createJevDecider({ key: 'tsk_geheim', fetchImpl });
  assert.equal(d.model, JEV_DEFAULT_MODEL);
  const r = await d.decide({ state: { titel: 'X' }, questions: { q: { type: 'noul', instructions: '?' } } });
  assert.equal(sent.url, 'https://api.typesafe.ai/v1/systemone');
  assert.equal(sent.init.headers.authorization, 'Bearer tsk_geheim');
  assert.deepEqual(sent.body, { state: { titel: 'X' }, model: JEV_DEFAULT_MODEL, questions: { q: { type: 'noul', instructions: '?' } } });
  assert.equal(r.model, 'jev-1.14.0');
  assert.equal(r.usage.input_tokens, 400);
});

test('Jev-Client: Fehler kommen als JevError mit Status, ohne Key gibt es keinen Client', async () => {
  const d = createJevDecider({ key: 'k', fetchImpl: async () => new Response('{"error":"unknown key"}', { status: 401 }) });
  await assert.rejects(d.decide({ state: 'x', questions: {} }), (e) => e instanceof JevError && e.status === 401 && /401/.test(e.message));
  const offline = createJevDecider({ key: 'k', fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
  await assert.rejects(offline.decide({ state: 'x', questions: {} }), /nicht erreichbar/);
  assert.throws(() => createJevDecider({ key: null }), JevError);
});

test('Urteil: volle Verteilung, Nähe, Rang; ohne choice gilt das Maximum', () => {
  const t = triageFromAnswers(answer('weg', { lesen: 0.1, stapel: 0.2, weg: 0.6, unklar: 0.1 }, 0.5));
  assert.equal(t.choice, 'weg');
  assert.deepEqual(t.probabilities, { lesen: 0.1, stapel: 0.2, weg: 0.6, unklar: 0.1 });
  assert.equal(t.near, 0.5);
  assert.equal(t.near_max, 3);
  assert.deepEqual(t.near_probabilities, { 0: 0.1, 1: 0.2, 2: 0.4, 3: 0.3 });
  assert.equal(t.input_tokens, 400);
  const a = answer(undefined, { lesen: 0.2, stapel: 0.7, weg: 0.1, unklar: 0 });
  delete a.answers.entscheidung.choice;
  assert.equal(triageFromAnswers(a).choice, 'stapel');
  assert.ok(triageFromAnswers(answer('lesen', { lesen: 0.8, stapel: 0.1, weg: 0.1, unklar: 0 })).rank > t.rank);
  assert.throws(() => triageFromAnswers({ answers: {} }), JevError);
});

test('Was an Jev geht: nur Titel, Quelle, Feed, Gruppe, Auszug (gekürzt) und behaltene Titel', () => {
  const s = triageState({ title: 'T', site: 'blatt.test', excerpt: 'a'.repeat(5000), reading_minutes: 4, content_text: 'GEHEIM', url: 'https://x' }, { feed: { title: 'Blatt' }, group: 'Tech', kept: ['A', 'B'] });
  assert.deepEqual(Object.keys(s).sort(), ['auszug', 'feed', 'gruppe', 'lesezeit_min', 'quelle', 'titel', 'zuletzt_behalten']);
  assert.equal(s.auszug.length, 1200);
  assert.ok(!JSON.stringify(s).includes('GEHEIM'));
});

test('Vorsortieren: beurteilt Feed-Einträge im Eingang einmal, ohne Key nichts; Fehler zählen Versuche', async () => {
  const store = createReadingStore({ path: ':memory:' });
  const { add } = feedDocs(store);
  const a = add(1);
  const b = add(2);
  store.addDocument({ url: 'https://selbst.test/x', title: 'Selbst gespeichert' });
  const calls = [];
  let fail = false;
  const decider = { model: 'jev-1.14.0', decide: async ({ state }) => { calls.push(state.titel); if (fail) throw new JevError('kaputt', 500); return answer('lesen', { lesen: 0.6, stapel: 0.2, weg: 0.1, unklar: 0.1 }); } };
  assert.equal(await createFeedTriage({ store, decider: () => null, logger: quiet }).runPending(), 0);
  const triage = createFeedTriage({ store, decider: () => decider, logger: quiet });
  assert.equal(await triage.runPending(), 2);
  assert.deepEqual(calls, ['Artikel 1', 'Artikel 2']);
  assert.equal(store.getTriage(a.id).choice, 'lesen');
  assert.equal(await triage.runPending(), 0, 'kein zweites Urteil');
  fail = true;
  const c = add(3);
  for (let i = 0; i < 4; i++) await triage.runPending();
  assert.equal(store.getTriage(c.id).attempts, 3, 'nach drei Fehlern nicht mehr');
  assert.equal(store.getTriage(c.id).judged_at, null);
  assert.equal(triage.health().state, 'error');
  assert.ok(store.getTriage(b.id));
});

test('Vorsortieren: 401 bricht den Durchgang ab, statt jeden Eintrag anzufragen', async () => {
  const store = createReadingStore({ path: ':memory:' });
  const { add } = feedDocs(store);
  add(1);
  add(2);
  let n = 0;
  const decider = { model: 'm', decide: async () => { n += 1; throw new JevError('Jev antwortet 401', 401); } };
  await createFeedTriage({ store, decider: () => decider, logger: quiet }).runPending();
  assert.equal(n, 1);
});

test('Vorsortieren: falscher Key oder leeres Kontingent verbraucht keine Versuche', async () => {
  const store = createReadingStore({ path: ':memory:' });
  const { add } = feedDocs(store);
  const a = add(1);
  for (const status of [401, 403, 429, 429]) {
    const decider = { model: 'm', decide: async () => { throw new JevError(`Jev antwortet ${status}`, status); } };
    await createFeedTriage({ store, decider: () => decider, logger: quiet }).runPending();
  }
  assert.equal(store.getTriage(a.id)?.attempts ?? 0, 0);
  assert.deepEqual(store.pendingTriage().map((d) => d.id), [a.id], 'bleibt für den nächsten Durchgang');
});

test('Vorsortieren: Einträge aus Feeds mit Zugangsdaten gehen nie an Jev', async () => {
  const store = createReadingStore({ path: ':memory:', secrets: createSecretBox(SECRET) });
  const { add } = feedDocs(store);
  const open = add(1);
  const { feed: priv } = store.addFeed({ url: 'https://privat.test/feed', auth: { user: 'ruben', password: 'pw_geheim_123' } });
  store.addDocument({ url: 'https://privat.test/1', title: 'Privat', excerpt: 'geheim', kind: 'feed', origin: `feed:${priv.id}` });
  store.addDocument({ url: 'https://privat.test/2', title: 'Geheimer Titel', kind: 'feed', origin: `feed:${priv.id}`, status: 'stapel' });
  assert.deepEqual(store.recentKeptTitles(), [], 'behaltene Titel privater Feeds gehen nicht mit');
  store.setFeedAuth(priv.id, null);
  assert.equal(store.getFeed(priv.id).has_auth, false);
  assert.deepEqual(store.recentKeptTitles(), [], 'auch nicht, wenn das Login entfernt ist');
  store.deleteFeed(priv.id);
  assert.deepEqual(store.recentKeptTitles(), [], 'auch nicht, wenn der Feed gelöscht ist');
  const seen = [];
  const decider = { model: 'm', decide: async ({ state }) => { seen.push(state); return answer('lesen', { lesen: 0.8, stapel: 0.1, weg: 0.05, unklar: 0.05 }); } };
  await createFeedTriage({ store, decider: () => decider, logger: quiet }).runPending();
  assert.equal(seen.length, 1);
  assert.ok(!JSON.stringify(seen).toLowerCase().includes('geheim'));
  assert.deepEqual(store.pendingTriage(), []);
  assert.ok(store.getTriage(open.id)?.judged_at);
});

test('Folgequote: Entscheidung gegen Vorschlag, unklar zählt nicht, Rückgängig nimmt das Label zurück', () => {
  const store = createReadingStore({ path: ':memory:' });
  const { add } = feedDocs(store);
  const [a, b, c] = [add(1), add(2), add(3)];
  store.saveTriage(a.id, triageFromAnswers(answer('lesen', { lesen: 0.7, stapel: 0.1, weg: 0.1, unklar: 0.1 })));
  store.saveTriage(b.id, triageFromAnswers(answer('weg', { lesen: 0.1, stapel: 0.1, weg: 0.7, unklar: 0.1 })));
  store.saveTriage(c.id, triageFromAnswers(answer('unklar', { lesen: 0.1, stapel: 0.1, weg: 0.1, unklar: 0.7 })));
  store.setTriageDecision(a.id, 'lesen');
  store.setTriageDecision(b.id, 'stapel');
  store.setTriageDecision(c.id, 'weg');
  assert.deepEqual(store.triageStats(), { judged: 3, decided: 2, followed: 1, unclear: 1, input_tokens: 1200 });
  store.setTriageDecision(b.id, null);
  assert.equal(store.triageStats().decided, 1);
});

test('Eingang: vorsortiert erst Unbeurteiltes, dann nach Rang; ohne Jev wie bisher neueste zuerst', () => {
  const store = createReadingStore({ path: ':memory:' });
  const { add } = feedDocs(store);
  const [a, b, c] = [add(1), add(2), add(3)];
  store.saveTriage(a.id, triageFromAnswers(answer('lesen', { lesen: 0.9, stapel: 0.1, weg: 0, unklar: 0 })));
  store.saveTriage(b.id, triageFromAnswers(answer('weg', { lesen: 0, stapel: 0.1, weg: 0.9, unklar: 0 })));
  const ids = (triage) => store.list({ status: 'eingang', triage }).map((d) => d.title);
  assert.deepEqual(ids(true), ['Artikel 3', 'Artikel 1', 'Artikel 2']);
  assert.deepEqual(ids(false), ['Artikel 3', 'Artikel 2', 'Artikel 1']);
  void c;
});

test('Einstellungen: Jev-Key und feste Version, Aliase abgelehnt; Key geht nie hinaus', () => {
  assert.throws(() => validateSettings({ jev: { key: 'k', model: 'jev-latest' } }), (e) => e instanceof SettingsError && e.field === 'jev.model');
  assert.throws(() => validateSettings({ jev: { key: 'k', model: 'jev-preview' } }), SettingsError);
  const settings = createSettingsStore({ logger: quiet });
  assert.equal(settings.get().jev, null, 'ohne Key aus');
  settings.save({ ...settings.stored(), jev: { key: 'tsk_1', model: null } });
  assert.deepEqual(settings.get().jev, { key: 'tsk_1', model: JEV_DEFAULT_MODEL, source: 'einstellungen' });
  const json = JSON.stringify(settingsJson({ stored: settings.stored(), defaults: settings.defaults() }));
  assert.ok(!json.includes('tsk_1'));
  assert.ok(json.includes('Eingang vorsortieren'));
  const form = mergeSettingsForm(settings.stored(), new URLSearchParams({ 'jev.model': 'jev-1.13.0' }));
  assert.equal(form.get('jev.model'), 'jev-1.13.0');
  assert.equal(mergeSettingsForm(settings.stored(), new URLSearchParams({ 'jev.clear': '0' })).has('jev.clear'), false);
});

async function withInbox(run) {
  const store = createReadingStore({ path: ':memory:' });
  const settings = createSettingsStore({ defaults: { tz: 'Europe/Berlin' }, logger: quiet });
  const webHttp = createWebHttp({
    cockpit: { week: async () => null },
    settings,
    reading: readingRoutes({ store, triage: () => true, logger: quiet }),
    oidc: {},
    sessionSecret: SECRET,
    publicUrl: 'https://vault.test',
    allowedSubjects: ['ruben'],
    logger: quiet,
  });
  const app = createApp({
    config: { publicUrl: 'https://vault.test', resource: 'https://vault.test/mcp', issuer: 'https://id.test', supportedScopes: [], allowedHosts: ['vault.test'], trustProxy: true },
    verifyToken: async () => { throw new Error('nicht benutzt'); },
    mcpHandler: async () => {},
    webHttp,
    logger: quiet,
  });
  app.listen(0, '127.0.0.1');
  await new Promise((res) => app.once('listening', res));
  const base = `http://127.0.0.1:${app.address().port}`;
  const t = Math.floor(Date.now() / 1000);
  const cookie = `vc_session=${createCookieSigner(SECRET).seal({ sub: 'ruben', sid: 's1', gen: 0, iat: t, seen: t, exp: t + 3600 })}`;
  let extra = '';
  const call = async (path, { form = null, accept = null } = {}) => {
    const headers = { 'x-forwarded-host': 'vault.test', cookie: `${cookie}${extra}`, ...(accept ? { accept } : {}) };
    if (form) headers['content-type'] = 'application/x-www-form-urlencoded';
    const res = await fetch(base + path, { method: form ? 'POST' : 'GET', redirect: 'manual', headers, body: form ? new URLSearchParams(form).toString() : undefined });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split('; ');
      if (!pair.startsWith('vc_session=')) extra = `; ${pair}`;
    }
    return res;
  };
  try {
    await run({ call, store });
  } finally {
    app.close();
  }
}

test('Eingang: Karte zeigt den Vorschlag, JSON trägt ihn, die Entscheidung wird zum Label', async () => {
  await withInbox(async ({ call, store }) => {
    const { add } = feedDocs(store);
    const doc = add(1);
    store.saveTriage(doc.id, triageFromAnswers(answer('stapel', { lesen: 0.2, stapel: 0.6, weg: 0.1, unklar: 0.1 })));
    const html = await (await call('/lesen/eingang')).text();
    assert.match(html, /Vorschlag: Stapel/);
    assert.match(html, /60 %/);
    const api = await (await call('/api/lesen/eingang')).json();
    assert.equal(api.doc.suggestion.choice, 'stapel');
    assert.equal(api.doc.suggestion.model, 'jev-1.14.0');
    const csrf = html.match(/name="csrf" value="([^"]+)"/)[1];
    await call('/aktion/lesen/sortieren', { form: { csrf, id: doc.id, ziel: 'weg' }, accept: 'application/json' });
    assert.equal(store.getTriage(doc.id).decision, 'weg');
    await call('/aktion/lesen/sortieren', { form: { csrf, id: doc.id, ziel: 'eingang' }, accept: 'application/json' });
    assert.equal(store.getTriage(doc.id).decision, null);
  });
});

test('Vorsortieren: bekommt ein Feed mitten im Durchgang ein Login, geht nichts mehr von ihm hinaus', async () => {
  const store = createReadingStore({ path: ':memory:', secrets: createSecretBox(SECRET) });
  const { feed, add } = feedDocs(store);
  add(1);
  add(2);
  let n = 0;
  const decider = {
    model: 'm',
    decide: async () => {
      n += 1;
      store.setFeedAuth(feed.id, { user: 'ruben', password: 'pw_geheim_123' });
      return answer('lesen', { lesen: 0.8, stapel: 0.1, weg: 0.05, unklar: 0.05 });
    },
  };
  await createFeedTriage({ store, decider: () => decider, logger: quiet }).runPending();
  assert.equal(n, 1);
});

test('Vorsortieren: mit Login geholt bleibt privat, auch wenn das Login vor dem Speichern wegfiel', async () => {
  const store = createReadingStore({ path: ':memory:' });
  const { add } = feedDocs(store);
  const pub = add(1);
  const { feed } = store.addFeed({ url: 'https://zwei.test/feed.xml', title: 'Zwei' });
  const { doc } = store.addDocument({ url: 'https://zwei.test/1', title: 'Mit Login', kind: 'feed', origin: `feed:${feed.id}`, private: true });
  assert.equal(store.isPrivate(doc.id), true);
  assert.equal(store.isPrivate(pub.id), false);
  assert.deepEqual(store.pendingTriage().map((d) => d.id), [pub.id]);
});
