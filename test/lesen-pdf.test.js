import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/http/app.js';
import { createWebHttp } from '../src/web/http.js';
import { createCookieSigner } from '../src/web/session.js';
import { createSettingsStore } from '../src/cockpit/settings.js';
import { createTokenStore } from '../src/cockpit/tokens.js';
import { createReadingStore, ReadingError } from '../src/lesen/store.js';
import { readingRoutes } from '../src/lesen/http.js';
import { createReadingApi } from '../src/lesen/api.js';
import { savePdf, paragraphsOf, MAX_PDF } from '../src/lesen/pdf.js';

const quiet = { info() {}, warn() {}, error() {} };
const SECRET = 'x'.repeat(40);

/** Kleinstes gültiges PDF mit einer Seite; jede Zeile ein Textstück in Helvetica. */
function makePdf(lines, { title = null } = {}) {
  const content = `BT /F1 12 Tf 72 720 Td ${lines.map((l, i) => `${i ? '0 -16 Td ' : ''}(${l}) Tj`).join(' ')} ET`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ...(title ? [`<< /Title (${title}) /Author (Ada) >>`] : []),
  ];
  let out = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R${title ? ` /Info ${objs.length} 0 R` : ''} >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

const TEXT = ['Vom Lesen auf Papier.', 'Ein Absatz, der auf der zweiten', 'Zeile weitergeht und endet.', 'Der letzte Satz.'];

test('PDF: Absätze aus Zeilen, Silbentrennung zusammengezogen', () => {
  assert.deepEqual(paragraphsOf('Ein Wort mit Tren-\nnung im Satz.\nNeuer Absatz\nohne Punkt\n\nNach Leerzeile'), [
    'Ein Wort mit Trennung im Satz.',
    'Neuer Absatz ohne Punkt',
    'Nach Leerzeile',
  ]);
});

test('PDF: Text wird Lesetext mit Lesezeit, Titel aus den Metadaten oder dem Dateinamen, idempotent per Inhalt', async () => {
  const store = createReadingStore({ path: ':memory:' });
  const { doc, duplicate } = await savePdf({ store, data: makePdf(TEXT), filename: 'Vom Lesen.pdf', clientId: 'p-1' });
  assert.equal(duplicate, false);
  assert.equal(doc.kind, 'pdf');
  assert.equal(doc.origin, 'formular');
  assert.equal(doc.title, 'Vom Lesen');
  assert.match(doc.url, /^pdf:sha256-[0-9a-f]{64}$/);
  assert.equal(doc.content_html, '<p>Vom Lesen auf Papier.</p><p>Ein Absatz, der auf der zweiten Zeile weitergeht und endet.</p><p>Der letzte Satz.</p>');
  assert.equal(doc.word_count, 17);
  assert.equal(doc.reading_minutes, 1);
  assert.equal(doc.excerpt, 'Vom Lesen auf Papier.');
  assert.equal((await savePdf({ store, data: makePdf(TEXT), filename: 'anders.pdf' })).duplicate, true, 'gleiche Datei');
  assert.equal(store.list().length, 1);

  const meta = (await savePdf({ store, data: makePdf(['Anderer Text.'], { title: 'Echter Titel' }), filename: 'x.pdf' })).doc;
  assert.equal(meta.title, 'Echter Titel');
  assert.equal(meta.author, 'Ada');
});

test('PDF: Vertrauensgrenze (keine PDF, kaputt, zu groß, ohne Text)', async () => {
  const store = createReadingStore({ path: ':memory:' });
  const rejects = (data, re) => assert.rejects(savePdf({ store, data }), (e) => e instanceof ReadingError && re.test(e.message));
  await rejects(Buffer.from('<html>kein pdf</html>'), /keine PDF-Datei/);
  await rejects(Buffer.from('%PDF-1.4 kaputt'), /lässt sich nicht lesen/);
  await rejects(Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(MAX_PDF)]), /zu groß/);
  await rejects(makePdf([]), /keinen Text/);
  assert.equal(store.list().length, 0);
});

test('PDF über den Endpunkt: application/pdf mit Lesestapel-Token, Titel und ID als Query', async () => {
  const store = createReadingStore({ path: ':memory:' });
  const tokens = createTokenStore({ logger: quiet });
  const reading = tokens.create('iPhone', 'lesestapel');
  const app = createApp({
    config: { publicUrl: 'https://vault.test', resource: 'https://vault.test/mcp', issuer: 'https://id.test', supportedScopes: [], allowedHosts: ['vault.test'], trustProxy: true },
    verifyToken: async () => {
      throw new Error('nicht benutzt');
    },
    mcpHandler: async () => {},
    readingApi: createReadingApi({ tokens, store, logger: quiet }),
    logger: quiet,
  });
  app.listen(0, '127.0.0.1');
  await new Promise((res) => app.once('listening', res));
  const post = (query, auth = reading.token) =>
    fetch(`http://127.0.0.1:${app.address().port}/lesestapel/speichern${query}`, {
      method: 'POST',
      headers: { 'x-forwarded-host': 'vault.test', 'content-type': 'application/pdf', ...(auth ? { authorization: `Bearer ${auth}` } : {}) },
      body: makePdf(TEXT),
    });
  try {
    const res = await post('?title=Aus%20Dateien&id=pdf-1');
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.message, 'Im Lesestapel: Aus Dateien');
    assert.equal(store.get(body.id).kind, 'pdf');
    assert.equal(store.get(body.id).origin, 'kurzbefehl');
    assert.equal((await post('?id=pdf-1')).status, 200);
    assert.equal((await post('', null)).status, 401);
    assert.equal(store.list().length, 1);
  } finally {
    app.close();
  }
});

test('PDF im Cockpit: Seite /lesen/hinzufuegen und Upload über /aktion/lesen/pdf', async () => {
  const store = createReadingStore({ path: ':memory:' });
  const webHttp = createWebHttp({
    cockpit: { week: async () => null },
    settings: createSettingsStore({ defaults: { tz: 'Europe/Berlin' }, logger: quiet }),
    reading: readingRoutes({ store, logger: quiet }),
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
  const cookie = `vc_session=${createCookieSigner(SECRET).seal({ sub: 'ruben', sid: 's1', gen: 0, iat: t, seen: t, exp: t + 3600 })}`;
  const headers = { 'x-forwarded-host': 'vault.test', cookie };
  try {
    const page = await fetch(`${base}/lesen/hinzufuegen`, { headers });
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /action="\/aktion\/lesen\/pdf" enctype="multipart\/form-data"/);
    assert.match(html, /action="\/aktion\/lesen\/speichern"/);
    const csrf = html.match(/name="csrf" value="([^"]+)"/)[1];

    const upload = (fields, file, extra = {}) => {
      const form = new FormData();
      for (const [k, v] of Object.entries(fields)) form.append(k, v);
      if (file) form.append('datei', new Blob([file], { type: 'application/pdf' }), 'Vom Lesen.pdf');
      return fetch(`${base}/aktion/lesen/pdf`, { method: 'POST', redirect: 'manual', headers: { ...headers, ...extra }, body: form });
    };
    const ok = await upload({ csrf, back: '/lesen/hinzufuegen', cid: 'up-1' }, makePdf(TEXT));
    assert.equal(ok.status, 303);
    assert.equal(ok.headers.get('location'), '/lesen/hinzufuegen');
    const [doc] = store.list();
    assert.equal(doc.title, 'Vom Lesen');
    assert.equal(doc.kind, 'pdf');

    const again = await upload({ csrf, back: '/lesen/hinzufuegen', cid: 'up-1' }, makePdf(TEXT), { accept: 'application/json' });
    assert.match((await again.json()).message, /^Schon im Lesestapel/);
    assert.equal((await upload({ csrf: 'falsch', back: '/lesen/hinzufuegen' }, makePdf(TEXT))).status, 403);
    const bad = await upload({ csrf, back: '/lesen/hinzufuegen' }, Buffer.from('kein pdf'), { accept: 'application/json' });
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).message, /keine PDF-Datei/);
    assert.equal(store.list().length, 1);
  } finally {
    app.close();
  }
});
