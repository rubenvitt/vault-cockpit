import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMailCapture, toCapture } from '../src/capture/mail.js';

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
