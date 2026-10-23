import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMailCapture } from '../src/capture/mail.js';
import { createReadingStore } from '../src/lesen/store.js';
import { createMailReader, isReadingMail } from '../src/lesen/mail.js';
import { safeFetch } from '../src/lesen/fetch.js';

const quiet = { info() {}, warn() {}, error() {} };

const NEWSLETTER = `<html><head><style>body{color:red}</style><script>alert(1)</script></head><body>
<table><tr><td><h1>Wochenpost</h1>
<p>Diese Woche geht es um das Lesen. <a href="https://blatt.test/a" onclick="steal()">Weiterlesen</a></p>
<img src="https://blatt.test/bild.png" alt="Titelbild">
<img src="https://track.test/open.gif?u=42" width="1" height="1">
<p>Ein zweiter Absatz mit <b>fettem</b> Text.</p>
<iframe src="https://evil.test"></iframe>
</td></tr></table></body></html>`;

/** Mail wie aus JMAP `Email/get` mit Text- und HTML-Teil. */
const mail = ({ id = 'n1', from = 'r@x.test', name = 'Blatt', subject, text = '', html = null }) => ({
  id,
  messageId: [`<${id}@mail.test>`],
  from: [{ email: from, name }],
  subject,
  receivedAt: '2026-10-13T08:00:00Z',
  textBody: [{ partId: 't', type: 'text/plain' }],
  htmlBody: html ? [{ partId: 'h', type: 'text/html' }] : [{ partId: 't', type: 'text/plain' }],
  bodyValues: { t: { value: text }, ...(html ? { h: { value: html } } : {}) },
});

test('Mail-Kürzel: [lesen] irgendwo im Betreff oder > vorn', () => {
  assert.equal(isReadingMail({ subject: 'Fwd: [lesen] Wochenpost' }), true);
  assert.equal(isReadingMail({ subject: '[LESEN] Wochenpost' }), true);
  assert.equal(isReadingMail({ subject: '> Wochenpost' }), true);
  assert.equal(isReadingMail({ subject: 'Buchidee' }), false);
  assert.equal(isReadingMail({ subject: '!Rechnung zahlen' }), false);
});

test('Newsletter wird lesbares Dokument, gesäubert, ohne die Artikel-Adresse zu holen', async () => {
  const store = createReadingStore({ path: ':memory:' });
  const reader = createMailReader({ store, fetchPage: () => assert.fail('nichts holen'), logger: quiet });
  const { doc, duplicate } = await reader.save(mail({ subject: 'Fwd: [lesen] Wochenpost', text: 'Diese Woche geht es um das Lesen.', html: NEWSLETTER }));
  assert.equal(duplicate, false);
  assert.equal(doc.kind, 'newsletter');
  assert.equal(doc.origin, 'mail');
  assert.equal(doc.status, 'eingang');
  assert.equal(doc.title, 'Fwd: Wochenpost');
  assert.equal(doc.author, 'Blatt');
  assert.equal(doc.site, 'x.test');
  assert.equal(doc.url, 'mid:n1%40mail.test');
  assert.match(doc.content_html, /<h1>Wochenpost<\/h1>/);
  assert.match(doc.content_html, /<a href="https:\/\/blatt.test\/a" rel="noopener noreferrer">Weiterlesen<\/a>/);
  assert.match(doc.content_html, /class="media-link">Bild: Titelbild</);
  for (const bad of [/<script/i, /alert/, /<style/i, /<img/i, /<iframe/i, /onclick/i, /track\.test/]) assert.doesNotMatch(doc.content_html, bad);
  assert.ok(doc.word_count > 10);
  assert.equal(doc.reading_minutes, 1);
  assert.equal(doc.excerpt, 'Diese Woche geht es um das Lesen. Weiterlesen');
  assert.equal((await reader.save(mail({ subject: '[lesen] Wochenpost', html: NEWSLETTER }))).duplicate, true, 'gleiche Message-ID');
});

test('Mail ohne HTML: Text in Absätzen', async () => {
  const store = createReadingStore({ path: ':memory:' });
  const reader = createMailReader({ store, logger: quiet });
  const { doc } = await reader.save(mail({ subject: '> Gedanken', text: 'Erster <Absatz>\nmit Umbruch\n\nZweiter Absatz' }));
  assert.equal(doc.title, 'Gedanken');
  assert.equal(doc.content_html, '<p>Erster &lt;Absatz&gt;<br>mit Umbruch</p><p>Zweiter Absatz</p>');
});

test('Mail mit nur einer Adresse speichert den Artikel; nicht holbar wird es die Mail mit Link', async () => {
  const store = createReadingStore({ path: ':memory:' });
  const page = '<html><head><title>Vom Lesen</title></head><body><article><p>Ein Absatz über das Lesen.</p></article></body></html>';
  const fetchPage = async (url) => (url === 'https://blatt.test/lesen' ? { url, body: page } : safeFetch(url));
  const reader = createMailReader({ store, fetchPage, logger: quiet });
  const { doc } = await reader.save(mail({ id: 'u1', subject: '[lesen]', text: '  https://blatt.test/lesen \n\nVon meinem iPhone gesendet\n-- \nRuben' }));
  assert.equal(doc.url, 'https://blatt.test/lesen');
  assert.equal(doc.kind, 'artikel');
  assert.equal(doc.origin, 'mail');
  assert.equal(doc.title, 'Vom Lesen');

  // Lokale Adresse: SSRF-Schutz greift, die Mail bleibt nicht ewig liegen.
  const local = (await reader.save(mail({ id: 'u2', subject: '[lesen] Admin', text: 'http://127.0.0.1/admin' }))).doc;
  assert.equal(local.kind, 'newsletter');
  assert.match(local.url, /^mid:/);
  assert.match(local.content_html, /<a href="http:\/\/127.0.0.1\/admin"/);
});

test('Mail-Abruf: [lesen] geht in den Lesestapel, der Rest an den Router, fremde Absender nur in den Lesestapel', async () => {
  const emails = [
    mail({ id: 'm1', subject: '[lesen] Wochenpost', html: NEWSLETTER }),
    mail({ id: 'm2', subject: 'Notiz', text: 'Text' }),
    mail({ id: 'm3', from: 'news@blatt.test', subject: 'Wochenblatt', html: NEWSLETTER }),
    mail({ id: 'm4', from: 'fremd@spam.test', subject: '!Hack', text: 'x' }),
  ];
  const moved = [];
  let getArgs = null;
  const fetch = async (url, init) => {
    if (url.endsWith('/session')) return Response.json({ apiUrl: 'https://jmap.test/api', primaryAccounts: { 'urn:ietf:params:jmap:mail': 'acc1' } });
    const { methodCalls } = JSON.parse(init.body);
    return Response.json({
      methodResponses: methodCalls.map(([name, args, tag]) => {
        if (name === 'Mailbox/get') return [name, { list: [{ id: 'v', name: 'Vault' }, { id: 'a', name: 'Archive' }] }, tag];
        if (name === 'Email/query') return [name, { ids: emails.map((e) => e.id) }, tag];
        if (name === 'Email/get') {
          getArgs = args;
          return [name, { list: emails }, tag];
        }
        moved.push(...Object.keys(args.update));
        return [name, { updated: args.update }, tag];
      }),
    });
  };
  const store = createReadingStore({ path: ':memory:' });
  const routed = [];
  const capture = createMailCapture({
    token: 't',
    sessionUrl: 'https://jmap.test/session',
    allowedSenders: ['r@x.test'],
    router: { route: async (input) => routed.push(input.title) },
    readingMail: createMailReader({ store, logger: quiet }),
    fetch,
    logger: quiet,
  });
  assert.equal(await capture.runOnce(), 4);
  assert.ok(getArgs.properties.includes('htmlBody') && getArgs.fetchHTMLBodyValues);
  assert.deepEqual(routed, ['Notiz'], 'fremde Absender erzeugen weder Notiz noch Aufgabe');
  assert.deepEqual(store.list().map((d) => d.title).sort(), ['!Hack', 'Wochenblatt', 'Wochenpost']);
  assert.deepEqual(moved, ['m1', 'm2', 'm3', 'm4']);
});
