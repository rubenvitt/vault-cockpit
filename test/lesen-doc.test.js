import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/http/app.js';
import { createWebHttp } from '../src/web/http.js';
import { createCookieSigner } from '../src/web/session.js';
import { createSettingsStore } from '../src/cockpit/settings.js';
import { createReadingStore } from '../src/lesen/store.js';
import { readingRoutes } from '../src/lesen/http.js';
import { sanitizeHtml } from '../src/lesen/extract.js';
import { htmlText, anchorAt } from '../src/lesen/anchor.js';

const quiet = { info() {}, warn() {}, error() {} };
const SECRET = 'x'.repeat(40);
const EVIL = '"><img src=x onerror=alert(1)><script>alert(2)</script>';

/** Cockpit mit Lesestapel im Speicher, angemeldet; `captured` sammelt, was „In Inbox“ anlegt. */
async function withDoc(run) {
  const store = createReadingStore({ path: ':memory:' });
  const captured = [];
  const capture = async ({ text, captureId }) => {
    captured.push({ text, captureId });
    return { kind: 'note', path: 'inbox/2026-10-23 1200 - Cockpit.md', duplicate: false };
  };
  const webHttp = createWebHttp({
    cockpit: { week: async () => null },
    settings: createSettingsStore({ defaults: { tz: 'Europe/Berlin' }, logger: quiet }),
    reading: readingRoutes({ store, capture, logger: quiet }),
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
  const call = async (path, { method = 'GET', form = null, json = false } = {}) => {
    const headers = { 'x-forwarded-host': 'vault.test', cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; '), ...(json ? { accept: 'application/json' } : {}) };
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
  const { doc } = store.addDocument({
    url: 'https://blatt.test/a',
    title: `Vom <Lesen> ${EVIL}`,
    site: 'Blatt',
    status: 'stapel',
    reading_minutes: 10,
    topics: ['Lesen', 'Gewohnheit'],
    content_html: sanitizeHtml('<h2>Anfang</h2><p>Der Stapel wächst &amp; wächst.</p><p>Ein zweiter Absatz mit einem Satz, den man sich merkt.</p>'),
  });
  const page = () => call(`/lesen/doc?id=${doc.id}`).then((r) => r.text());
  const csrf = (await page()).match(/name="csrf" value="([^"]+)"/)[1];
  try {
    await run({ call, store, doc, page, csrf, captured });
  } finally {
    app.close();
  }
}

test('Leseansicht: Lesetext, Fortschritt, „Fertig, weg“ als Formular, Spalten und Kürzel; ohne Inline-Skripte', async () => {
  await withDoc(async ({ call, store, doc, page }) => {
    store.setProgress(doc.id, 0.5, String(htmlText(doc.content_html).indexOf('Ein zweiter')));
    const html = await page();
    assert.match(html, /<script src="\/static\/lesen-doc\.js\?v=[\w-]+" defer><\/script>/);
    assert.ok(!/style=|<script>/.test(html), 'keine Inline-Styles oder -Skripte');
    assert.ok(!html.includes('<img'), 'Titel maskiert');
    assert.match(html, /<h1>Vom &lt;Lesen&gt; &quot;&gt;&lt;img/);
    assert.match(html, /<progress max="1" value="0.5" aria-label="Gelesen"><\/progress>\s*<span class="meta" data-rest>noch 5 min<\/span>\s*<a href="#weiter"/);
    assert.match(html, /<div class="lesen-text"><h2>Anfang<\/h2><p>Der Stapel wächst &amp; wächst\.<\/p><p><span id="weiter" class="lesen-weiter"><\/span>Ein zweiter/);
    assert.match(html, /<form method="post" action="\/aktion\/lesen\/doc\/fertig" class="act" data-decide="fertig">[^]*?Fertig, weg <kbd>E<\/kbd>/);
    assert.ok(!html.includes('data-decide="vault"'), 'ohne Lesestapel-Notizen kein „In den Vault“');
    assert.ok(!html.includes('data-decide="zurueck"'), 'noch nicht entschieden');
    assert.match(html, /aria-label="Bereiche"[^]*aria-label="Stapel"[^]*aria-current="page"/);
    assert.match(html, /Querverbindungen/);
    for (const k of ['H', 'N', 'L', 'E', 'V', 'J / K']) assert.ok(html.includes(`<kbd>${k}</kbd>`), `Kürzel ${k}`);
    assert.match(html, /data-cmd="mark"[^]*data-cmd="note"[^]*data-cmd="link"[^]*data-cmd="inbox"/);

    assert.equal((await call('/lesen/doc?id=gibtsnicht')).status, 404);
  });
});

test('Leseansicht: Archivieren ohne JavaScript mit Meldung und Rückgängig, Fortschritt still per JSON', async () => {
  await withDoc(async ({ call, store, doc, page, csrf }) => {
    const back = `/lesen/doc?id=${doc.id}`;
    const res = await call('/aktion/lesen/doc/status', { method: 'POST', form: { csrf, back, id: doc.id, status: 'archiv' } });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), back);
    assert.equal(store.get(doc.id).status, 'archiv');
    const html = await page();
    assert.match(html, /<span class="toast-text">Archiviert: Vom &lt;Lesen&gt;/);
    assert.match(html, /name="status" value="stapel"[^]*?<button type="submit" class="toast-action">Rückgängig/);
    assert.match(html, /Zurück auf den Stapel/);
    assert.equal((await call('/aktion/lesen/doc/status', { method: 'POST', form: { csrf, id: doc.id, status: 'quatsch' }, json: true })).status, 400);

    // „Fertig, weg“ (VCP-96) ohne JavaScript: Weiterleitung, Meldung, Rückgängig, „Zurück auf den Stapel“.
    const done = await call('/aktion/lesen/doc/fertig', { method: 'POST', form: { csrf, back, id: doc.id } });
    assert.equal(done.status, 303);
    assert.equal(done.headers.get('location'), back);
    assert.equal(store.get(doc.id).status, 'weg');
    assert.ok(store.get(doc.id).read_at);
    const after = await page();
    assert.match(after, /<span class="toast-text">Fertig, weg: Vom &lt;Lesen&gt;[^]*?name="status" value="archiv"[^]*?Rückgängig/);
    assert.match(after, /data-decide="zurueck">[^]*?Zurück auf den Stapel/);
    assert.ok(!after.includes('data-decide="fertig"'));

    const saved = await call('/aktion/lesen/doc/fortschritt', { method: 'POST', form: { csrf, id: doc.id, fortschritt: '0.42', anker: '17' }, json: true });
    assert.equal(saved.status, 200);
    assert.equal((await saved.json()).progress, 0.42);
    assert.equal(store.get(doc.id).scroll_anchor, '17');
    // Fremder Anker wird ignoriert, leerer Fortschritt abgelehnt.
    await call('/aktion/lesen/doc/fortschritt', { method: 'POST', form: { csrf, id: doc.id, fortschritt: '0.5', anker: 'x<y' }, json: true });
    assert.equal(store.get(doc.id).scroll_anchor, '17');
    assert.equal((await call('/aktion/lesen/doc/fortschritt', { method: 'POST', form: { csrf, id: doc.id }, json: true })).status, 400);
  });
});

test('Markierungen: anlegen, Notiz, im Text als <mark>, nach neuem Holen noch an ihrer Stelle, entfernen mit Rückgängig', async () => {
  await withDoc(async ({ call, store, doc, page, csrf }) => {
    const text = htmlText(doc.content_html);
    const start = text.indexOf('einem Satz');
    const a = anchorAt(text, start, start + 'einem Satz'.length);
    const res = await call('/aktion/lesen/markierung/neu', { method: 'POST', form: { csrf, id: doc.id, quote: a.quote, prefix: a.prefix, suffix: a.suffix, start: a.start_hint, notiz: EVIL }, json: true });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.message, 'Markiert, mit Notiz');
    assert.deepEqual(body.undo, { action: '/aktion/lesen/markierung/loeschen', fields: { id: body.highlight.id } });
    const id = body.highlight.id;

    let html = await page();
    assert.ok(html.includes(`mit <mark id="h-${id}" class="hl has-note" data-hl="${id}" title="&quot;&gt;&lt;img src=x onerror=alert(1)&gt;&lt;script&gt;alert(2)&lt;/script&gt;">einem Satz</mark>, den`));
    assert.ok(!html.includes('<img') && !html.includes('<script>alert'), 'Notiz maskiert');
    assert.match(html, new RegExp(`<a href="#h-${id}" class="lesen-quote">einem Satz</a>`));

    // Artikel neu geholt: Absatz davor, anders umbrochen; die Markierung sitzt wieder.
    store.updateDocument(doc.id, { content_html: sanitizeHtml('<p>Neu davor.</p>\n<h2>Anfang</h2>\n<p>Der Stapel wächst &amp; wächst.</p>\n<p>Ein zweiter Absatz mit\n<em>einem</em> Satz, den man sich merkt.</p>') });
    html = await page();
    assert.ok(html.includes(`mit\n<em><mark id="h-${id}" class="hl has-note" data-hl="${id}"`));

    // Notiz ändern, leeren, Fehler bei unbekannter Markierung.
    await call('/aktion/lesen/markierung/notiz', { method: 'POST', form: { csrf, id, notiz: 'Merken' }, json: true });
    assert.equal(store.getHighlight(id).note, 'Merken');
    await call('/aktion/lesen/markierung/notiz', { method: 'POST', form: { csrf, id, notiz: '  ' }, json: true });
    assert.equal(store.getHighlight(id).note, null);
    assert.equal((await call('/aktion/lesen/markierung/notiz', { method: 'POST', form: { csrf, id: 'nein', notiz: 'x' }, json: true })).status, 404);
    assert.equal((await call('/aktion/lesen/markierung/neu', { method: 'POST', form: { csrf, id: doc.id, quote: ' ' }, json: true })).status, 400);

    // Entfernen ohne JavaScript; Rückgängig legt sie mit demselben Anker neu an.
    const del = await call('/aktion/lesen/markierung/loeschen', { method: 'POST', form: { csrf, id, back: `/lesen/doc?id=${doc.id}` } });
    assert.equal(del.status, 303);
    assert.equal(store.getHighlight(id), null);
    html = await page();
    assert.match(html, /Markierung entfernt[^]*action="\/aktion\/lesen\/markierung\/neu"[^]*name="cid" value="[^"]+"[^]*name="quote" value="einem Satz"/);
    const undo = await call('/aktion/lesen/markierung/neu', { method: 'POST', form: { csrf, id: doc.id, cid: id, quote: 'einem Satz', prefix: a.prefix, suffix: a.suffix, start: '' }, json: true });
    assert.equal(undo.status, 200);
    assert.deepEqual(store.listHighlights({ docId: doc.id }).map((h) => h.id), [id], 'gleiche ID, Block-ID bleibt');
  });
});

test('In Inbox: Zitat als Blockzitat mit Quelle, nie als Aufgabe; aus einer Markierung mit fester Erfassungs-ID', async () => {
  await withDoc(async ({ call, store, doc, csrf, captured }) => {
    const res = await call('/aktion/lesen/markierung/inbox', { method: 'POST', form: { csrf, id: doc.id, quote: '!wichtig\nzweite Zeile', notiz: 'Gedanke', cid: 'c-1' }, json: true });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).message, 'In der Inbox: inbox/2026-10-23 1200 - Cockpit.md');
    assert.equal(captured[0].captureId, 'c-1');
    assert.ok(!captured[0].text.startsWith('!'));
    assert.match(captured[0].text, /^> !wichtig\n> zweite Zeile\n\nGedanke\n\nAus \[Vom <Lesen> "><img src=x onerror=alert\(1\)><script>alert\(2\)<\/script>\]\(https:\/\/blatt\.test\/a\)$/);

    const h = store.addHighlight({ doc_id: doc.id, quote: 'Der Stapel', note: 'n' });
    await call('/aktion/lesen/markierung/inbox', { method: 'POST', form: { csrf, markierung: h.id }, json: true });
    assert.equal(captured[1].captureId, `lesen-${h.id}`);
    assert.equal(captured[1].text, '> Der Stapel\n\nn\n\nAus [Vom <Lesen> "><img src=x onerror=alert(1)><script>alert(2)</script>](https://blatt.test/a)');
  });
});

test('Markiert: alle Markierungen, filterbar nach Quelle und Thema, verlinkt auf die Stelle, maskiert', async () => {
  await withDoc(async ({ call, store, doc }) => {
    assert.match(await (await call('/lesen/markiert')).text(), /Noch nichts markiert/);
    const { doc: other } = store.addDocument({ url: 'https://anders.test/b', title: 'Anders', site: 'Anders', topics: ['Kochen'], content_html: '<p>Salz</p>' });
    const h = store.addHighlight({ doc_id: doc.id, quote: `Zitat ${EVIL}`, note: `Notiz ${EVIL}` });
    store.addHighlight({ doc_id: other.id, quote: 'Salz' });

    const all = await (await call('/lesen/markiert')).text();
    assert.ok(!all.includes('<img') && !all.includes('<script>alert'), 'Zitat und Notiz maskiert');
    assert.ok(all.includes(`href="/lesen/doc?id=${doc.id}#h-${h.id}"`));
    assert.match(all, /<select name="quelle"><option value="">alle<\/option><option value="Anders">Anders<\/option><option value="Blatt">Blatt<\/option><\/select>/);
    assert.match(all, /<select name="thema">[^]*Gewohnheit[^]*Kochen[^]*Lesen/);
    assert.match(all, /Salz/);

    const bySite = await (await call('/lesen/markiert?quelle=Blatt')).text();
    assert.ok(!bySite.includes('>Salz<') && bySite.includes('Zitat &quot;&gt;'));
    assert.match(bySite, /<option value="Blatt" selected>/);
    const byTopic = await (await call('/lesen/markiert?thema=Kochen')).text();
    assert.ok(byTopic.includes('>Salz<') && !byTopic.includes('Zitat &quot;'));
    assert.match(await (await call('/lesen/markiert?thema=Nichts')).text(), /Für diese Auswahl ist nichts markiert/);
  });
});
