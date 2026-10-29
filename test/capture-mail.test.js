import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMailCapture, senderFilter, toCapture } from '../src/capture/mail.js';

const quiet = { info() {}, warn() {}, error() {} };

/** JMAP-Attrappe mit einem Ordner „Vault“ und „Archive“. */
function fakeJmap(emails) {
  const moved = [];
  const fetch = async (url, init) => {
    if (url.endsWith('/session')) {
      return Response.json({ apiUrl: 'https://jmap.test/api', primaryAccounts: { 'urn:ietf:params:jmap:mail': 'acc1' } });
    }
    const { methodCalls } = JSON.parse(init.body);
    const responses = methodCalls.flatMap(([name, args, tag]) => {
      if (name === 'Mailbox/get') {
        return [[name, { list: [{ id: 'mb-vault', name: 'Vault' }, { id: 'mb-arch', name: 'Archiv', role: 'archive' }] }, tag]];
      }
      if (name === 'Email/query') return [[name, { ids: emails.map((e) => e.id) }, tag]];
      if (name === 'Email/get') return [[name, { list: emails }, tag]];
      if (name === 'Email/set') {
        moved.push(...Object.keys(args.update));
        return [[name, { updated: args.update }, tag]];
      }
      return [['error', { type: 'unknownMethod' }, tag]];
    });
    return Response.json({ methodResponses: responses });
  };
  return { fetch, moved };
}

const mail = (id, from, subject, text) => ({
  id,
  messageId: [`<${id}@mail.test>`],
  from: [{ email: from }],
  subject,
  receivedAt: '2026-10-13T08:00:00Z',
  textBody: [{ partId: '1' }],
  bodyValues: { 1: { value: text } },
});

test('Mail wird Notiz mit Betreff als Titel, ! im Betreff wird Aufgabe', () => {
  const note = toCapture(mail('a', 'r@x.test', 'Buchidee', 'Inhalt'));
  assert.equal(note.title, 'Buchidee');
  assert.equal(note.text, 'Inhalt');
  assert.equal(note.source, 'mail');
  assert.match(note.captureId, /^mail-[0-9a-f]{32}$/);
  assert.equal(toCapture(mail('a', 'r@x.test', 'Anders', 'x')).captureId, note.captureId, 'gleiche Message-ID, gleiche ID');
  const task = toCapture(mail('b', 'r@x.test', '! Rechnung zahlen', 'Bis Freitag'));
  assert.equal(task.text, '! Rechnung zahlen\nBis Freitag');
  assert.equal(task.title, undefined);
});

test('Abruf verarbeitet freigegebene Absender und verschiebt die Mails', async () => {
  const jmap = fakeJmap([mail('m1', 'R@X.test', 'Notiz', 'Text'), mail('m2', 'fremd@spam.test', '!Hack', 'x')]);
  const routed = [];
  const capture = createMailCapture({
    token: 't',
    sessionUrl: 'https://jmap.test/session',
    doneMailbox: 'Archive',
    allowedSenders: ['r@x.test'],
    router: { route: async (input) => routed.push(input) },
    fetch: jmap.fetch,
    logger: quiet,
  });
  assert.equal(await capture.runOnce(), 1);
  assert.deepEqual(routed.map((r) => r.title), ['Notiz']);
  assert.deepEqual(jmap.moved, ['m1', 'm2'], 'fremde Mail wird nur weggeräumt');
  assert.equal(capture.status().lastError, null);
});

test('scheitert die Weiterleitung, bleibt die Mail liegen', async () => {
  const jmap = fakeJmap([mail('m1', 'r@x.test', '!Aufgabe', '')]);
  const capture = createMailCapture({
    token: 't',
    sessionUrl: 'https://jmap.test/session',
    allowedSenders: ['r@x.test'],
    router: {
      route: async () => {
        throw new Error('Zunder nicht erreichbar');
      },
    },
    fetch: jmap.fetch,
    logger: quiet,
  });
  assert.equal(await capture.runOnce(), 0);
  assert.deepEqual(jmap.moved, []);
});

test('ohne freigegebene Absender startet der Mail-Abruf nicht', () => {
  assert.throws(() => createMailCapture({ token: 't', allowedSenders: [' '], router: {} }), /MAIL_ALLOWED_SENDERS/);
});

test('Einträge mit @ geben eine ganze Domain frei, aber keine Subdomain', () => {
  const allowed = senderFilter(['@rubeen.dev', ' @Rubeen.Email ', 'a@x.test']);
  assert.equal(allowed('x@rubeen.dev'), true);
  assert.equal(allowed('ruben@rubeen.email'), true);
  assert.equal(allowed('a@x.test'), true);
  assert.equal(allowed('b@x.test'), false, 'Adresse bleibt exakt');
  assert.equal(allowed('x@evil-rubeen.dev'), false);
  assert.equal(allowed('x@sub.rubeen.dev'), false);
  assert.equal(allowed('rubeen.dev'), false);
  assert.equal(allowed('@rubeen.dev'), false);
  assert.equal(allowed(''), false);
});

test('Abruf nimmt Absender einer freigegebenen Domain an', async () => {
  const jmap = fakeJmap([mail('m1', 'X@Rubeen.dev', 'Notiz', 'Text'), mail('m2', 'x@sub.rubeen.dev', 'Fremd', 'x')]);
  const routed = [];
  const capture = createMailCapture({
    token: 't',
    sessionUrl: 'https://jmap.test/session',
    allowedSenders: '@rubeen.dev,@rubeen.email'.split(','),
    router: { route: async (input) => routed.push(input) },
    fetch: jmap.fetch,
    logger: quiet,
  });
  assert.equal(await capture.runOnce(), 1);
  assert.deepEqual(routed.map((r) => r.title), ['Notiz']);
  assert.deepEqual(jmap.moved, ['m1', 'm2']);
});

test('fehlender Ordner wird als Fehler gemeldet', async () => {
  const jmap = fakeJmap([]);
  const capture = createMailCapture({
    token: 't',
    sessionUrl: 'https://jmap.test/session',
    mailbox: 'Gibtsnicht',
    allowedSenders: ['r@x.test'],
    router: { route: async () => {} },
    fetch: jmap.fetch,
    logger: quiet,
  });
  await capture.runOnce();
  assert.match(capture.status().lastError, /Gibtsnicht/);
});

test('Lesestapel: abgeschnittener Newsletter wird als Blob ganz nachgeholt, im Zeichensatz des Teils', async () => {
  const long = '<p>Anfang</p>' + '<p>Mitte</p>'.repeat(10) + '<p>Schluss mit Größe</p>';
  const email = {
    ...mail('n1', 'news@fremd.test', 'Langer Newsletter', ''),
    textBody: [],
    htmlBody: [{ partId: '2', blobId: 'blob-2', type: 'text/html', charset: 'iso-8859-1' }],
    bodyValues: { 2: { value: '<p>Anfang</p><p>Mi', isTruncated: true } },
  };
  const jmap = fakeJmap([email]);
  const downloads = [];
  const fetch = async (url, init) => {
    if (url.endsWith('/session')) return Response.json({ apiUrl: 'https://jmap.test/api', downloadUrl: 'https://jmap.test/download/{accountId}/{blobId}/{name}?type={type}', primaryAccounts: { 'urn:ietf:params:jmap:mail': 'acc1' } });
    if (url.startsWith('https://jmap.test/download/')) {
      downloads.push({ url, auth: init.headers.authorization, redirect: init.redirect });
      return new Response(Buffer.from(long, 'latin1'));
    }
    return jmap.fetch(url, init);
  };
  const saved = [];
  const capture = createMailCapture({
    token: 't',
    sessionUrl: 'https://jmap.test/session',
    allowedSenders: ['r@x.test'],
    router: { route: async () => {} },
    readingMail: { matches: () => true, save: async (e) => saved.push(e) },
    fetch,
    logger: quiet,
  });
  assert.equal(await capture.runOnce(), 1);
  assert.deepEqual(downloads, [{ url: 'https://jmap.test/download/acc1/blob-2/teil?type=text%2Fhtml', auth: 'Bearer t', redirect: 'error' }]);
  assert.equal(saved[0].bodyValues[2].value, long);
  assert.equal(saved[0].bodyValues[2].isTruncated, false);
});

test('Lesestapel: scheitert das Nachholen, bleibt der gekürzte Text', async () => {
  const email = { ...mail('n2', 'r@x.test', '[lesen] Kurz', ''), bodyValues: { 1: { value: 'gekürzt', isTruncated: true } }, textBody: [{ partId: '1', blobId: 'b1', type: 'text/plain' }] };
  const jmap = fakeJmap([email]);
  const fetch = async (url, init) => {
    if (url.endsWith('/session')) return Response.json({ apiUrl: 'https://jmap.test/api', downloadUrl: 'https://jmap.test/dl/{blobId}', primaryAccounts: { 'urn:ietf:params:jmap:mail': 'acc1' } });
    if (url.startsWith('https://jmap.test/dl/')) return new Response('nein', { status: 500 });
    return jmap.fetch(url, init);
  };
  const saved = [];
  const capture = createMailCapture({ token: 't', sessionUrl: 'https://jmap.test/session', allowedSenders: ['r@x.test'], router: { route: async () => {} }, readingMail: { matches: () => true, save: async (e) => saved.push(e) }, fetch, logger: quiet });
  assert.equal(await capture.runOnce(), 1);
  assert.equal(saved[0].bodyValues[1].value, 'gekürzt');
});

test('Lesestapel: Blob nur über https und höchstens 5 MB, auch ohne Content-Length', async () => {
  const run = async (downloadUrl, body) => {
    const email = { ...mail('n3', 'r@x.test', '[lesen] Lang', ''), bodyValues: { 1: { value: 'gekürzt', isTruncated: true } }, textBody: [{ partId: '1', blobId: 'b1', type: 'text/plain' }] };
    const jmap = fakeJmap([email]);
    const asked = [];
    const fetch = async (url, init) => {
      if (url.endsWith('/session')) return Response.json({ apiUrl: 'https://jmap.test/api', downloadUrl, primaryAccounts: { 'urn:ietf:params:jmap:mail': 'acc1' } });
      if (url.includes('/dl/')) {
        asked.push(url);
        return new Response(body());
      }
      return jmap.fetch(url, init);
    };
    const saved = [];
    await createMailCapture({ token: 't', sessionUrl: 'https://jmap.test/session', allowedSenders: ['r@x.test'], router: { route: async () => {} }, readingMail: { matches: () => true, save: async (e) => saved.push(e) }, fetch, logger: quiet }).runOnce();
    return { asked, value: saved[0].bodyValues[1].value };
  };
  const plain = await run('http://jmap.test/dl/{blobId}', () => 'ganz');
  assert.deepEqual(plain, { asked: [], value: 'gekürzt' }, 'kein Token über http');
  // Gestreamt ohne Content-Length, über der Grenze: bleibt gekürzt.
  const huge = () => new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(1024 * 1024)); } });
  assert.equal((await run('https://jmap.test/dl/{blobId}', huge)).value, 'gekürzt');
});
