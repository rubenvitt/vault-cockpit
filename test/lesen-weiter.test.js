import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReadingStore } from '../src/lesen/store.js';
import { isRead, stackRoutes } from '../src/lesen/stack.js';
import { listenQueue } from '../src/lesen/listen.js';
import { readInfo, stageOf, trackOf, weiterModel, weiterRoutes } from '../src/lesen/weiter.js';

/** Lesestapel im Speicher; `add` legt einen Text auf den Stapel (oder mit `status` anderswohin). */
function setup() {
  const store = createReadingStore({ path: ':memory:' });
  const add = (title, { minutes = 10, status = 'stapel', progress = 0 } = {}) => {
    const { doc } = store.addDocument({ url: `https://blatt.test/${encodeURIComponent(title)}`, title, reading_minutes: minutes, status });
    if (progress) store.setProgress(doc.id, progress);
    return doc.id;
  };
  return { store, add };
}

/** Kleiner Fake des Ingest-Dienstes: Zeilen wie `ingest.list()`, `request` reiht ein. */
function fakeIngest(store, { available = { ok: true } } = {}) {
  const rows = new Map();
  const calls = [];
  return {
    rows,
    calls,
    put: (id, status, extra = {}) => rows.set(id, { doc_id: id, status, error: null, applied: null, drafted_at: '2026-10-25T03:00:00.000Z', ...extra }),
    available: () => available,
    list: () => [...rows.values()].map((r) => ({ ...r, doc: (({ id, title, url, site, reading_minutes, status }) => ({ id, title, url, site, reading_minutes, status }))(store.get(r.doc_id)) })),
    request(ids, opts) {
      calls.push([ids, opts]);
      for (const id of ids) rows.set(id, { doc_id: id, status: 'wartet', error: null, applied: null });
      return { queued: ids, done: Promise.resolve() };
    },
  };
}

const ctx = (path = '/lesen/weiter') => ({ url: new URL(`https://vault.test${path}`), user: 'ruben', tz: 'Europe/Berlin', write: { csrf: 'c', back: path }, flash: null });
const noInline = (html) => assert.ok(!/style=|<script>/.test(html), 'keine Inline-Styles oder -Skripte');
const titles = (items) => items.map((x) => x.doc.title);

test('Weiter: gehört, mit Lesedatum oder zu Ende gelesen gilt als gelesen', () => {
  assert.equal(isRead({ progress: 0 }), false);
  assert.equal(isRead({ progress: 0.5 }), false);
  assert.equal(isRead({ progress: 1 }), true);
  assert.equal(isRead({ progress: 0, heard_at: '2026-10-24T08:00:00.000Z' }), true, 'im Podcast gehört = gelesen');
  assert.equal(isRead({ progress: 0, read_at: '2026-10-24T08:00:00.000Z' }), true);
  assert.deepEqual(readInfo({ progress: 0, heard_at: '2026-10-24T08:00:00.000Z' }, new Map([[undefined, null]])), { how: 'gehoert', at: '2026-10-24T08:00:00.000Z', episode: null });
  assert.equal(readInfo({ progress: 0, heard_at: '2026-10-24T08:00:00.000Z', read_at: '2026-10-25T08:00:00.000Z' }).how, 'gelesen', 'später gelesen schlägt früher gehört');
  assert.deepEqual(readInfo({ progress: 1 }), { how: 'gelesen', at: null, episode: null });
  assert.equal(readInfo({ progress: 0.3 }), null);
});

test('Weiter: Stufe je Text, Ingest geht vor dem Lesestand', () => {
  const doc = (extra = {}) => ({ id: 'a', status: 'stapel', progress: 0, ...extra });
  const heard = { heard_at: '2026-10-24T08:00:00.000Z' };
  assert.equal(stageOf(doc()), null, 'ungelesen auf dem Stapel: nur gezählt');
  assert.equal(stageOf(doc({ progress: 0.4 })), 'weiterlesen');
  assert.equal(stageOf(doc(heard)), 'entscheiden');
  assert.equal(stageOf(doc(heard), { status: 'verworfen' }), 'entscheiden', 'verworfener Entwurf: die Entscheidung ist wieder offen');
  assert.equal(stageOf(doc(heard), { status: 'bereit' }), 'pruefen');
  assert.equal(stageOf(doc(), { status: 'entwirft' }), 'laeuft');
  assert.equal(stageOf(doc(), { status: 'fehler' }), 'fehler');
  assert.equal(stageOf(doc({ ...heard, status: 'weg' })), null, 'schon entschieden');
  assert.equal(stageOf(doc({ status: 'archiv' }), { status: 'uebernommen', applied: { plant: { status: 'laeuft' } } }), 'laeuft');
  assert.equal(stageOf(doc({ status: 'archiv' }), { status: 'uebernommen', applied: { plant: { status: 'fehler' } } }), 'fehler');
  assert.equal(stageOf(doc({ status: 'archiv' }), { status: 'uebernommen', applied: { plant: { status: 'fertig' } } }), null);
  assert.equal(stageOf(null, { status: 'bereit' }), 'pruefen', 'Entwurf zu einem Text, der nicht mehr auf dem Stapel liegt');
});

test('Weiter: Spur zeigt Gehört, Entwurf, Im Wiki und Eingepflanzt', () => {
  const states = (t) => Object.fromEntries(t.map((s) => [s.key, s.state]));
  const t = trackOf({ progress: 0, heard_at: '2026-10-24T08:00:00.000Z' }, { status: 'entwirft' });
  assert.equal(t[0].label, 'Gehört');
  assert.deepEqual(states(t), { gelesen: 'done', entwurf: 'busy', wiki: 'todo', eingepflanzt: 'todo' });
  assert.deepEqual(states(trackOf({ progress: 0.5 })), { gelesen: 'busy', entwurf: 'todo', wiki: 'todo', eingepflanzt: 'todo' });
  assert.deepEqual(states(trackOf({ progress: 1 }, { status: 'uebernommen', applied: { plant: { status: 'fertig' } } })), { gelesen: 'done', entwurf: 'done', wiki: 'done', eingepflanzt: 'done' });
  assert.equal(states(trackOf({ progress: 1 }, { status: 'fehler' })).entwurf, 'failed');
});

test('Weiter: Modell sortiert nach Stufen, zählt Ungelesenes und nennt den nächsten Schritt', () => {
  const { store, add } = setup();
  const ingest = fakeIngest(store);
  const gehoert = add('Gehört im Podcast', { minutes: 12 });
  const gelesen = add('Zu Ende gelesen', { minutes: 5, progress: 1 });
  add('Halb gelesen', { minutes: 20, progress: 0.5 });
  add('Noch ungelesen', { minutes: 7 });
  add('Im Eingang', { status: 'eingang', minutes: 3 });
  const bereit = add('Entwurf bereit');
  const weg = add('Schon weg', { status: 'weg' });
  store.markHeard([gehoert], '2026-10-24T08:00:00.000Z');
  ingest.put(bereit, 'bereit');
  ingest.put(weg, 'fehler', { error: 'Claude antwortete nicht' });
  const episodes = { list: () => [{ id: 'ep1', status: 'fertig', heard_at: '2026-10-24T09:00:00.000Z', title: 'Podcast: Gehört im Podcast', kind: 'podcast', docs: [gehoert] }] };

  const m = weiterModel({ store, ingest, episodes });
  assert.deepEqual(titles(m.stages.pruefen), ['Entwurf bereit']);
  assert.deepEqual(titles(m.stages.entscheiden).sort(), ['Gehört im Podcast', 'Zu Ende gelesen']);
  assert.deepEqual(titles(m.stages.fehler), ['Schon weg'], 'Fehler auch für Texte, die nicht mehr auf dem Stapel liegen');
  assert.deepEqual(titles(m.stages.weiterlesen), ['Halb gelesen']);
  assert.deepEqual(m.stages.laeuft, []);
  assert.equal(m.counts.stapel, 1, 'nur Ungelesenes ohne Entwurf zählt als Stapel');
  assert.equal(m.counts.eingang, 1);
  assert.deepEqual(m.stages.entscheiden.find((x) => x.doc.id === gehoert).read.episode, { id: 'ep1', title: 'Podcast: Gehört im Podcast', kind: 'podcast' });
  assert.deepEqual(new Set(m.draftable), new Set([gehoert, gelesen]));
  assert.equal(m.next.stage, 'pruefen', 'fertige Entwürfe zuerst: Claude hat die Arbeit schon getan');

  ingest.rows.delete(bereit);
  const next = weiterModel({ store, ingest, episodes }).next;
  assert.equal(next.stage, 'entscheiden');
  assert.equal(next.label, 'Alle 2 entwerfen lassen');
  assert.equal(weiterModel({ store, ingest: null, episodes }).next.href, '#entscheiden', 'ohne Ingest: zur Liste, nicht zum Entwerfen');
});

test('Weiter: Seite mit „Als Nächstes“, Stufen als Zeilen und Knöpfen, alles ohne Inline-Skripte', async () => {
  const { store, add } = setup();
  const ingest = fakeIngest(store);
  const gehoert = add('Gehört <b>fett</b>');
  add('Halb', { progress: 0.5 });
  const busy = add('In Arbeit');
  store.markHeard([gehoert], '2026-10-24T08:00:00.000Z');
  ingest.put(busy, 'entwirft');
  const routes = weiterRoutes({ store, ingest, vault: true, episodes: { list: () => [{ id: 'e', status: 'fertig', heard_at: '2026-10-24T09:00:00.000Z', title: 'Podcast: Gehört', docs: [gehoert] }] } });
  const { html } = await routes.pages['/lesen/weiter'](ctx());
  noInline(html);
  assert.match(html, /<a href="\/lesen\/weiter" class="subnav-link" aria-current="page">Weiter<\/a>/);
  assert.match(html, /<h2 id="weiter-next">Als Nächstes<\/h2><p>Gelesen oder gehört: Gehört &lt;b&gt;fett&lt;\/b&gt;\. Wie weiter\?<\/p>/);
  assert.match(html, /<section class="weiter-stufe" id="entscheiden"/);
  assert.match(html, /gehört am 24\. Okt\. in „Podcast: Gehört“/);
  assert.match(html, /action="\/aktion\/lesen\/ingest\/entwerfen"[^]*Ins Wiki: entwerfen/);
  assert.match(html, /action="\/aktion\/lesen\/doc\/vault"[^]*name="volltext" value="1"[^]*Nur in den Vault/);
  assert.match(html, /action="\/aktion\/lesen\/doc\/fertig"[^]*Fertig, weg/);
  // Keine Reihe aus Status-Chips mehr: Der Abschnitt sagt, wo der Text steht, der Rest steht in der Metazeile.
  assert.ok(!html.includes('weiter-spur'));
  const item = (id) => html.match(new RegExp(`<li class="weiter-item[^"]*" data-weiter-doc="${id}"[^]*?\\n  </li>`))[0];
  assert.match(item(gehoert), /^<li class="weiter-item is-entscheiden"[^]*<span class="meta">10 Min\. · gehört am 24\. Okt\. in „Podcast: Gehört“<\/span>/);
  assert.match(item(gehoert), /<div class="weiter-acts">(<form [^]*?<\/form>){3}<\/div>/, 'drei Wege, zum Text führt der Titel');
  assert.match(html, /href="\/lesen\/doc\?id=[^"]+#weiter" class="btn">Weiterlesen/);
  assert.equal(html.match(/class="btn primary"/g).length, 1, 'der eine Hauptknopf steht unter „Als Nächstes“');
  // Läuft: das Ingest-Skript beobachtet den Stand; was läuft, steht in der Metazeile.
  assert.match(html, new RegExp(`data-ingest-watch="${busy}" data-ingest-status="entwirft"`));
  assert.match(item(busy), /<span class="meta">10 Min\. · Claude entwirft<\/span>/);
  assert.ok(!item(busy).includes('weiter-acts'));
  assert.match(html, /\/static\/lesen-ingest\.js/);
  assert.ok(!html.includes('<b>fett</b>'), 'Titel maskiert');
  // Hinweise nur, wo sie eine Regel erklären.
  assert.match(html, /<p class="meta">Gelesen oder gehört\. Ins Wiki/);
  assert.ok(!html.includes('Die Seite aktualisiert sich von selbst'));

  // Ohne Lesestapel-Notizen kein „Nur in den Vault“; ohne Claude kein Entwerfen.
  const plain = (await weiterRoutes({ store, ingest: fakeIngest(store, { available: { ok: false } }) }).pages['/lesen/weiter'](ctx())).html;
  assert.ok(!plain.includes('Nur in den Vault'));
  assert.ok(!plain.includes('Ins Wiki: entwerfen'));
});

test('Weiter: „Prüfen“ zeigt die Entwürfe wie die Ingest-Übersicht, Fehler mit Meldung, Verworfenes als Wort', async () => {
  const { store, add } = setup();
  const ingest = fakeIngest(store);
  const halb = add('Halb gelesen <i>x</i>', { minutes: 8, progress: 0.4 });
  const neu = add('Ungelesen');
  const fertig = add('Zu Ende', { progress: 1 });
  const kaputt = add('Kaputt');
  const verworfen = add('Verworfen', { progress: 1 });
  add('Liegt nur da', { minutes: 6 });
  const draft = { source: { title: 'Halb gelesen <i>x</i>', tldr: 'Worum es **geht**.' }, digest: { kernaussagen: ['Erste'] }, items: [{ id: 'v1', action: 'verknuepfen', default: true }, { id: 's1', kind: 'synthesis', action: 'neu', default: false }] };
  ingest.put(halb, 'bereit', { draft, origin: 'nacht' });
  ingest.put(neu, 'bereit');
  ingest.put(fertig, 'bereit');
  ingest.put(kaputt, 'fehler', { error: 'Claude antwortete <b>nicht</b>' });
  ingest.put(verworfen, 'verworfen');
  const { html } = await weiterRoutes({ store, ingest, vault: true }).pages['/lesen/weiter'](ctx());
  noInline(html);
  // Dieselbe Zeile wie in der Übersicht, mit Link dorthin.
  const section = html.match(/<section class="weiter-stufe" id="pruefen"[^]*?<\/section>/)[0];
  assert.match(section, /<div class="weiter-stufe-kopf"><h2 id="weiter-pruefen">Prüfen <span class="hint">3<\/span><\/h2><a href="\/lesen\/ingest" class="weiter-alle">Alle Entwürfe<\/a><\/div>/);
  assert.equal(section.match(/<li class="ingest-zeile"/g).length, 3);
  const row = (id) => section.match(new RegExp(`<li class="ingest-zeile" data-ingest-doc="${id}">[^]*?</li>`))[0];
  assert.match(row(halb), new RegExp(`<a href="/lesen/ingest/doc\\?id=${halb}" class="lesen-title ingest-zeile-titel" title="1 Verknüpfung · 1 Synthese">Halb gelesen &lt;i&gt;x&lt;/i&gt;</a>`));
  // Was vom üblichen Weg abweicht, steht als Wort in der Metazeile.
  assert.match(row(halb), /<span class="meta">8 Min\. · noch nicht zu Ende gelesen<span class="ingest-zeile-wann"> · nachts entworfen · 25\. Okt\., 0[34]:00<\/span><\/span>/);
  assert.match(row(halb), /<span class="ingest-zeile-inhalt">Worum es <strong>geht<\/strong>\.<\/span>/);
  assert.match(row(halb), />2 Vorschläge · 1 zu entscheiden<\/span>/);
  assert.match(row(neu), /10 Min\. · noch ungelesen</);
  assert.ok(!/ungelesen|zu Ende gelesen/.test(row(fertig)), 'gelesen ist der übliche Weg');
  assert.match(row(neu), />nur die Source-Page<\/span>/, 'Zeile auch ohne Entwurfstext');
  // Fehler: Meldung in der Zeile, der Titel führt zur Prüfansicht.
  const failed = html.match(/<li class="weiter-item is-fehler"[^]*?\n {2}<\/li>/)[0];
  assert.match(failed, new RegExp(`<a href="/lesen/ingest/doc\\?id=${kaputt}" class="lesen-title">Kaputt</a>`));
  assert.match(failed, /<p class="problem">Entwurf fehlgeschlagen: Claude antwortete &lt;b&gt;nicht&lt;\/b&gt;<\/p>/);
  assert.match(failed, /name="force" value="1"><button type="submit" class="btn">Erneut entwerfen/);
  assert.match(html, /<span class="meta">10 Min\. · zu Ende gelesen · Entwurf verworfen<\/span>/);
  // Ungelesenes nur als Zahl mit Weg dorthin.
  assert.match(html, /<ul class="weiter-unread"><li><a href="\/lesen\/stapel" class="lesen-title">Stapel<\/a><span class="meta">1 Text, etwa 6 Min\.<\/span><a href="\/lesen\/hoeren\?zeit=15" class="btn quiet">Unterwegs hören<\/a><\/li><\/ul>/);
});

test('Weiter: leer heißt erledigt', async () => {
  const { store } = setup();
  const { html } = await weiterRoutes({ store }).pages['/lesen/weiter'](ctx());
  assert.match(html, /class="weiter-next is-clear"[^]*Alles erledigt/);
});

test('Weiter: „Alle entwerfen“ reiht nur gelesene Texte ohne Entwurf ein', async () => {
  const { store, add } = setup();
  const ingest = fakeIngest(store);
  const a = add('A', { progress: 1 });
  const b = add('B');
  const c = add('C');
  add('Ungelesen');
  store.markHeard([b, c]);
  ingest.put(c, 'verworfen');
  const routes = weiterRoutes({ store, ingest });
  const r = await routes.actions['/aktion/lesen/weiter/entwerfen'](new URLSearchParams());
  assert.equal(r.count, 3);
  assert.match(r.message, /3 Texte werden entworfen/);
  assert.deepEqual(new Set(ingest.calls[0][0]), new Set([a, b, c]));
  assert.equal((await routes.actions['/aktion/lesen/weiter/entwerfen'](new URLSearchParams())).count, 0, 'jetzt hat jeder einen Entwurf');
  await assert.rejects(weiterRoutes({ store }).actions['/aktion/lesen/weiter/entwerfen'](new URLSearchParams()), /nicht angebunden/);
});

test('Weiter: JSON für die App mit Stufen, Spur und nächstem Schritt', async () => {
  const { store, add } = setup();
  const id = add('Gehört');
  store.markHeard([id], '2026-10-24T08:00:00.000Z');
  const { body, status } = await weiterRoutes({ store, ingest: fakeIngest(store) }).pages['/api/lesen/weiter'](ctx('/api/lesen/weiter'));
  assert.equal(status, 200);
  const data = JSON.parse(body);
  assert.equal(data.next.stage, 'entscheiden');
  assert.equal(data.counts.entscheiden, 1);
  assert.deepEqual(data.stages.map((s) => s.key), ['pruefen', 'anhoeren', 'entscheiden', 'fehler', 'weiterlesen', 'laeuft']);
  const item = data.stages[2].items[0];
  assert.equal(item.heardAt, '2026-10-24T08:00:00.000Z');
  assert.deepEqual(item.read, { how: 'gehoert', at: '2026-10-24T08:00:00.000Z', episode: null });
  assert.equal(item.track[0].label, 'Gehört');
  assert.equal(data.draftable, 1);
});

test('Stapel: Gehörtes und Gelesenes verlassen die Leseliste, ein Hinweis führt zu „Weiter“', async () => {
  const { store, add } = setup();
  const gehoert = add('Gehört', { minutes: 5 });
  add('Gelesen', { minutes: 5, progress: 1 });
  add('Offen', { minutes: 5 });
  store.markHeard([gehoert]);
  const { html } = await stackRoutes({ store }).pages['/lesen/stapel'](ctx('/lesen/stapel'));
  assert.match(html, /<a href="\/lesen\/weiter#entscheiden">2 Texte sind gelesen oder gehört – wie weiter\?<\/a>/);
  assert.match(html, /class="lesen-title">Offen</);
  assert.ok(!/class="lesen-title">(Gehört|Gelesen)</.test(html));
  const json = JSON.parse((await stackRoutes({ store }).pages['/api/lesen/stapel'](ctx('/api/lesen/stapel'))).body);
  assert.equal(json.count, 1);
  assert.equal(json.decide, 2);
  // Unterwegs hören fängt Gehörtes nicht noch einmal an.
  assert.deepEqual(listenQueue(store, 15).items.map((d) => d.title), ['Offen']);
});

test('Weiter: ungehörte Folge steht unter „Anhören“, ihre Texte erst nach dem Hören unter „Entscheiden“', async () => {
  const { store, add } = setup();
  const a = add('Im Podcast A');
  const b = add('Im Podcast B', { progress: 1 });
  store.markHeard([a, b], '2026-10-24T08:00:00.000Z');
  const ep = { id: 'ep', status: 'fertig', heard_at: null, kind: 'podcast', title: 'Podcast: A und 1 weitere', bytes: 16_000 * 600, position: 0, docs: [a, b] };
  const episodes = { list: () => [ep] };
  let m = weiterModel({ store, episodes });
  assert.equal(m.counts.anhoeren, 1);
  assert.deepEqual(m.stages.anhoeren[0].docs.map((d) => d.title), ['Im Podcast A', 'Im Podcast B']);
  assert.deepEqual(titles(m.stages.entscheiden), ['Im Podcast B'], 'zu Ende gelesen bleibt zu entscheiden, nur Gehörtes wartet auf die Folge');
  assert.equal(m.counts.stapel, 0, 'wartet auf die Folge, zählt nicht als Stapel');
  assert.deepEqual([m.next.stage, m.next.label, m.next.href], ['anhoeren', 'Anhören', '/lesen/folgen#hoeren']);

  const { html } = await weiterRoutes({ store, episodes }).pages['/lesen/weiter'](ctx());
  noInline(html);
  assert.match(html, /<section class="weiter-stufe" id="anhoeren"/);
  assert.match(html, /Podcast · 10:00/);
  assert.match(html, /2 Texte: <a href="\/lesen\/doc\?id=[^"]+">Im Podcast A<\/a>/);
  assert.match(html, /action="\/aktion\/lesen\/folge\/gehoert"[^]*name="gehoert" value="1"[^]*Als gehört markieren/);
  assert.ok(!html.includes('weiter-summe'), 'keine Chip-Leiste mehr');

  ep.position = 120;
  assert.equal(weiterModel({ store, episodes }).next.label, 'Weiterhören');
  ep.heard_at = '2026-10-25T08:00:00.000Z';
  m = weiterModel({ store, episodes });
  assert.equal(m.counts.anhoeren, 0);
  assert.deepEqual(titles(m.stages.entscheiden).sort(), ['Im Podcast A', 'Im Podcast B']);
  const json = JSON.parse((await weiterRoutes({ store, episodes: { list: () => [{ ...ep, heard_at: null }] } }).pages['/api/lesen/weiter'](ctx('/api/lesen/weiter'))).body);
  assert.deepEqual(json.stages[1].items[0].episode, { id: 'ep', kind: 'podcast', kindLabel: 'Podcast', title: 'Podcast: A und 1 weitere', seconds: 600, position: 120, bytes: 16_000 * 600, finishedAt: null });
});
