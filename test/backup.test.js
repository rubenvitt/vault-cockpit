import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, statSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { createBackup, seal, open, BackupError, DATA_FILES } from '../src/cockpit/backup.js';
import { parseMultipart, readMultipart, FormError } from '../src/web/multipart.js';
import { createApp } from '../src/http/app.js';
import { createWebHttp } from '../src/web/http.js';
import { createCookieSigner } from '../src/web/session.js';
import { createSettingsStore } from '../src/cockpit/settings.js';
import { createTokenStore } from '../src/cockpit/tokens.js';

const quiet = { info() {}, warn() {}, error() {} };
// Kleine scrypt-Kosten, damit die Tests schnell bleiben; der Standard ist 2^17.
const cost = { N: 2 ** 10, r: 8, p: 1 };
const PASS = 'korrekt pferd batterie';
const SECRET = 'x'.repeat(40);

const tmp = () => mkdtempSync(join(tmpdir(), 'vc-backup-'));

const SETTINGS = JSON.stringify({ zunder: { url: 'https://zunder.test', token: 'zt_geheim_1234' }, mail: { token: 'fm_geheim_5678' }, calendars: [{ url: 'https://cal.test/geheim.ics', password: 'pw_geheim' }] });

test('Sicherung: verschlüsselt und wieder geöffnet, ohne Geheimnisse im Klartext', async () => {
  const files = { 'cockpit-settings.json': Buffer.from(SETTINGS), 'session-secret': Buffer.from('s'.repeat(64)) };
  const text = await seal(files, PASS, { cost, now: () => Date.parse('2026-10-18T10:00:00Z') });
  const doc = JSON.parse(text);
  assert.equal(doc.format, 'vault-cockpit-sicherung');
  assert.equal(doc.version, 1);
  assert.equal(doc.createdAt, '2026-10-18T10:00:00.000Z');
  assert.deepEqual(Object.keys(doc.kdf), ['name', 'N', 'r', 'p', 'salt']);
  assert.equal(doc.cipher.name, 'aes-256-gcm');
  for (const secret of ['zt_geheim_1234', 'fm_geheim_5678', 'pw_geheim', 'geheim.ics', 'sss', PASS, 'cockpit-settings']) {
    assert.ok(!text.includes(secret), secret);
    assert.ok(!text.includes(Buffer.from(secret).toString('base64').slice(0, 12)), `${secret} (base64)`);
  }

  const back = await open(text, PASS);
  assert.equal(back.createdAt, '2026-10-18T10:00:00.000Z');
  assert.equal(back.files['cockpit-settings.json'].toString(), SETTINGS);
  assert.equal(back.files['session-secret'].toString(), 's'.repeat(64));

  // Zwei Sicherungen desselben Stands haben eigenes Salt und eigenen IV.
  const again = JSON.parse(await seal(files, PASS, { cost }));
  assert.notEqual(again.kdf.salt, doc.kdf.salt);
  assert.notEqual(again.cipher.iv, doc.cipher.iv);
});

test('Sicherung: falsche Passphrase, geänderter Kopf und Inhalt fallen auf', async () => {
  const text = await seal({ 'session-secret': Buffer.from('s'.repeat(64)) }, PASS, { cost });
  await assert.rejects(open(text, 'falsche passphrase'), /Passphrase falsch oder Datei beschädigt/);
  await assert.rejects(open(text, 'kurz'), /mindestens 12 Zeichen/);

  const doc = JSON.parse(text);
  await assert.rejects(open(JSON.stringify({ ...doc, createdAt: '2020-01-01T00:00:00.000Z' }), PASS), /Passphrase falsch oder Datei beschädigt/);
  const data = Buffer.from(doc.data, 'base64');
  data[0] ^= 1;
  await assert.rejects(open(JSON.stringify({ ...doc, data: data.toString('base64') }), PASS), /Passphrase falsch oder Datei beschädigt/);

  await assert.rejects(open('{"format":"etwas anderes"}', PASS), /Keine Sicherung des Cockpits/);
  await assert.rejects(open('kein json', PASS), /kein JSON/);
  await assert.rejects(open(JSON.stringify({ ...doc, version: 2 }), PASS), /Format 2/);
  // Parameter aus der Datei dürfen den Dienst nicht lahmlegen.
  await assert.rejects(open(JSON.stringify({ ...doc, kdf: { ...doc.kdf, N: 2 ** 24 } }), PASS), /zu großen Schlüsselparametern/);
  await assert.rejects(open(JSON.stringify({ ...doc, kdf: { ...doc.kdf, N: 1000 } }), PASS), /Schlüsselparametern/);
  await assert.rejects(seal({}, 'zu kurz', { cost }), BackupError);
});

test('Sicherung: erfasst die bekannten Dateien unter /data, leer heißt ohne Einstellungen und Tokens', async () => {
  const dir = tmp();
  const elsewhere = join(tmp(), 'state.json');
  try {
    const backup = createBackup({ dir, paths: { 'capture-state.json': elsewhere }, cost });
    assert.equal(backup.isEmpty(), true);
    await assert.rejects(backup.create(PASS), /noch nichts/);

    writeFileSync(join(dir, 'api-tokens.json'), '[]\n');
    writeFileSync(join(dir, 'session-secret'), 'alt'.repeat(20));
    writeFileSync(elsewhere, '{"bridge:a":1}');
    assert.equal(backup.isEmpty(), true, 'keine Tokens und kein Merkzettel zählen nicht');
    const status = backup.status();
    assert.deepEqual(status.files.map((f) => f.name), DATA_FILES.map((f) => f.name));
    assert.deepEqual(status.files.map((f) => f.present), [false, true, true, true]);

    writeFileSync(join(dir, 'cockpit-settings.json'), SETTINGS);
    assert.equal(backup.isEmpty(), false);

    await assert.rejects(backup.create(PASS, { repeat: 'etwas anderes!!' }), /stimmen nicht überein/);
    await assert.rejects(backup.create('kurz', { repeat: 'kurz' }), /mindestens 12/);
    const file = await backup.create(PASS, { repeat: PASS });
    assert.match(file.filename, /^cockpit-sicherung-\d{4}-\d{2}-\d{2}\.json$/);
    assert.deepEqual(file.files.sort(), ['api-tokens.json', 'capture-state.json', 'cockpit-settings.json', 'session-secret']);
    const inner = await open(file.body, PASS);
    assert.equal(inner.files['capture-state.json'].toString(), '{"bridge:a":1}');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Wiederherstellen: nur ins leere Cockpit oder mit Ersetzen, atomar und nur für den Dienst lesbar', async () => {
  const source = tmp();
  const target = tmp();
  try {
    writeFileSync(join(source, 'cockpit-settings.json'), SETTINGS);
    writeFileSync(join(source, 'api-tokens.json'), '[{"id":"t1"}]');
    writeFileSync(join(source, 'session-secret'), 'n'.repeat(64));
    const { body } = await createBackup({ dir: source, cost }).create(PASS);

    // Ein frisch gestartetes Cockpit hat schon ein eigenes Sitzungs-Secret.
    writeFileSync(join(target, 'session-secret'), 'f'.repeat(64));
    const backup = createBackup({ dir: target, cost });
    await assert.rejects(backup.restore(body, 'falsche passphrase'), /Passphrase falsch/);
    await assert.rejects(backup.restore(null, PASS), /Sicherungsdatei wählen/);
    assert.ok(!existsSync(join(target, 'cockpit-settings.json')));

    const r = await backup.restore(Buffer.from(body), PASS);
    assert.deepEqual(r.files.sort(), ['api-tokens.json', 'cockpit-settings.json', 'session-secret']);
    assert.deepEqual(r.skipped, []);
    assert.equal(readFileSync(join(target, 'cockpit-settings.json'), 'utf8'), SETTINGS);
    assert.equal(readFileSync(join(target, 'session-secret'), 'utf8'), 'n'.repeat(64));
    assert.equal(statSync(join(target, 'cockpit-settings.json')).mode & 0o777, 0o600);
    // Was die Sicherung nicht kennt (hier der Merkzettel), bleibt unberührt.
    assert.ok(!existsSync(join(target, 'capture-state.json')));

    // Jetzt ist es eingerichtet: Überschreiben nur ausdrücklich.
    assert.equal(backup.isEmpty(), false);
    await assert.rejects(backup.restore(body, PASS), /schon eingerichtet/);
    writeFileSync(join(target, 'cockpit-settings.json'), '{"tz":"UTC"}');
    await backup.restore(body, PASS, { replace: true });
    assert.equal(readFileSync(join(target, 'cockpit-settings.json'), 'utf8'), SETTINGS);
  } finally {
    rmSync(source, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});

test('Wiederherstellen: unbekannte Dateien übergangen, kaputtes JSON schreibt nichts', async () => {
  const target = tmp();
  try {
    const backup = createBackup({ dir: target, cost });
    const strange = await seal({ 'cockpit-settings.json': Buffer.from(SETTINGS), '../../etc/passwd': Buffer.from('x') }, PASS, { cost });
    const r = await backup.restore(strange, PASS);
    assert.deepEqual(r.files, ['cockpit-settings.json']);
    assert.deepEqual(r.skipped, ['../../etc/passwd']);

    const other = tmp();
    const broken = await seal({ 'session-secret': Buffer.from('b'.repeat(64)), 'api-tokens.json': Buffer.from('{kaputt') }, PASS, { cost });
    const fresh = createBackup({ dir: other, cost });
    await assert.rejects(fresh.restore(broken, PASS), /api-tokens.json in der Sicherung ist kein gültiges JSON/);
    assert.ok(!existsSync(join(other, 'session-secret')), 'erst prüfen, dann schreiben');
    await assert.rejects(fresh.restore(await seal({ 'fremd.txt': Buffer.from('x') }, PASS, { cost }), PASS), /keine bekannte Datei/);
    rmSync(other, { recursive: true, force: true });
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

const multipart = (boundary, parts) =>
  Buffer.concat([
    ...parts.flatMap(([head, body]) => [Buffer.from(`--${boundary}\r\n${head}\r\n\r\n`), Buffer.isBuffer(body) ? body : Buffer.from(body), Buffer.from('\r\n')]),
    Buffer.from(`--${boundary}--\r\n`),
  ]);

test('Multipart: Textfelder und eine Datei, binär unverändert, Fehler mit Status', async () => {
  const binary = Buffer.from([0, 13, 10, 45, 45, 255, 1]);
  const body = multipart('XyZ', [
    ['Content-Disposition: form-data; name="csrf"', 'abc'],
    ['Content-Disposition: form-data; name="passphrase"', 'mit ümlaut'],
    ['Content-Disposition: form-data; name="datei"; filename="s.json"\r\nContent-Type: application/json', binary],
    ['Content-Disposition: form-data; name="leer"; filename=""', ''],
  ]);
  const { fields, files } = parseMultipart(body, 'XyZ');
  assert.equal(fields.get('csrf'), 'abc');
  assert.equal(fields.get('passphrase'), 'mit ümlaut');
  assert.equal(files.get('datei').filename, 's.json');
  assert.equal(files.get('datei').type, 'application/json');
  assert.deepEqual(files.get('datei').data, binary);
  assert.equal(files.get('leer').data.length, 0);

  assert.throws(() => parseMultipart(Buffer.from('nichts'), 'XyZ'), FormError);
  assert.throws(() => parseMultipart(body.subarray(0, 80), 'XyZ'), /unvollständig/);
  assert.throws(() => parseMultipart(body, 'XyZ', { maxParts: 2 }), /zu vielen Teilen/);
  assert.throws(() => parseMultipart(multipart('b', [['Content-Type: text/plain', 'x']]), 'b'), /ohne Namen/);

  const req = (buf, type = 'multipart/form-data; boundary=XyZ') => Object.assign(Readable.from([buf]), { headers: { 'content-type': type } });
  assert.equal((await readMultipart(req(body), { limit: 10_000 })).fields.get('csrf'), 'abc');
  await assert.rejects(readMultipart(req(body), { limit: 100 }), (err) => err.status === 413);
  await assert.rejects(readMultipart(req(body, 'application/x-www-form-urlencoded'), { limit: 10_000 }), (err) => err.status === 415);
});

/** Cockpit mit echten Dateien unter `dir`, angemeldet über ein selbst signiertes Sitzungs-Cookie. */
async function withCockpit(dir, run) {
  const settings = createSettingsStore({ file: join(dir, 'cockpit-settings.json'), logger: quiet });
  const tokens = createTokenStore({ file: join(dir, 'api-tokens.json'), logger: quiet });
  const restarts = [];
  const webHttp = createWebHttp({
    cockpit: { week: async () => null },
    settings,
    tokens,
    backup: createBackup({ dir, cost }),
    restart: () => restarts.push(Date.now()),
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
  const session = createCookieSigner(SECRET).seal({ sub: 'ruben', sid: 's1', exp: Math.floor(Date.now() / 1000) + 3600 });
  const call = (path, { method = 'GET', form = null, body = undefined, cookie = true, origin = null } = {}) => {
    const headers = { 'x-forwarded-host': 'vault.test', ...(cookie ? { cookie: `vc_session=${session}` } : {}), ...(origin ? { origin } : {}) };
    if (form) headers['content-type'] = 'application/x-www-form-urlencoded';
    return fetch(base + path, { method, redirect: 'manual', headers, body: form ? new URLSearchParams(form).toString() : body });
  };
  const csrf = async () => (await (await call('/einstellungen')).text()).match(/name="csrf" value="([^"]+)"/)[1];
  try {
    await run({ call, csrf, settings, tokens, restarts });
  } finally {
    app.close();
  }
}

const upload = (fields, file) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  if (file !== undefined) fd.append('datei', new Blob([file], { type: 'application/json' }), 'cockpit-sicherung.json');
  return fd;
};

test('Einstellungen → Sicherung: herunterladen nur angemeldet mit CSRF, Datei nicht im Cache', async () => {
  const dir = tmp();
  try {
    await withCockpit(dir, async ({ call, csrf, settings, tokens }) => {
      const anon = await call('/einstellungen/sicherung', { method: 'POST', form: { passphrase: PASS, passphrase2: PASS }, cookie: false });
      assert.equal(anon.status, 303);
      assert.equal(anon.headers.get('location'), '/login?next=%2Feinstellungen');

      const page = await (await call('/einstellungen')).text();
      assert.match(page, /<section id="sicherung">/);
      assert.match(page, /href="#sicherung"/);
      assert.match(page, /Neu eingerichtet\? Eine Sicherung lässt sich/);
      assert.ok(!page.includes('name="ersetzen"'), 'leer: ohne Haken zum Ersetzen');
      assert.match(page, /enctype="multipart\/form-data"/);

      const token = await csrf();
      settings.save({ zunder: { url: 'https://zunder.test', token: 'zt_geheim_1234' } });
      tokens.create('iPhone', 'capture');
      assert.equal((await call('/einstellungen/sicherung', { method: 'POST', form: { passphrase: PASS, passphrase2: PASS } })).status, 403);
      assert.equal((await call('/einstellungen/sicherung', { method: 'POST', form: { passphrase: PASS, passphrase2: PASS, csrf: token }, origin: 'https://evil.test' })).status, 403);
      const mismatch = await call('/einstellungen/sicherung', { method: 'POST', form: { passphrase: PASS, passphrase2: 'etwas anderes!', csrf: token } });
      assert.equal(mismatch.status, 400);
      assert.match(await mismatch.text(), /stimmen nicht überein/);
      const short = await call('/einstellungen/sicherung', { method: 'POST', form: { passphrase: 'kurz', passphrase2: 'kurz', csrf: token } });
      assert.equal(short.status, 400);

      const res = await call('/einstellungen/sicherung', { method: 'POST', form: { passphrase: PASS, passphrase2: PASS, csrf: token } });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('cache-control'), 'no-store');
      assert.match(res.headers.get('content-disposition'), /^attachment; filename="cockpit-sicherung-\d{4}-\d{2}-\d{2}\.json"$/);
      const text = await res.text();
      assert.ok(!text.includes('zt_geheim_1234'));
      const inner = await open(text, PASS);
      assert.deepEqual(Object.keys(inner.files).sort(), ['api-tokens.json', 'cockpit-settings.json']);

      const later = await (await call('/einstellungen')).text();
      assert.ok(!later.includes('Neu eingerichtet?'));
      assert.match(later, /name="ersetzen" value="1" required/);
      assert.equal((await call('/einstellungen/sicherung')).headers.get('location'), '/einstellungen#sicherung');
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Einstellungen → Wiederherstellen: per Datei-Upload ins leere Cockpit, danach Neustart und neue Anmeldung', async () => {
  const source = tmp();
  const target = tmp();
  try {
    writeFileSync(join(source, 'cockpit-settings.json'), JSON.stringify({ tz: 'UTC', zunder: { url: 'https://zunder.test', token: 'zt_geheim_1234' } }));
    writeFileSync(join(source, 'session-secret'), 'n'.repeat(64));
    const { body } = await createBackup({ dir: source, cost }).create(PASS);

    await withCockpit(target, async ({ call, csrf, restarts }) => {
      const token = await csrf();
      const route = '/einstellungen/sicherung/wiederherstellen';
      assert.equal((await call(route, { method: 'POST', body: upload({ passphrase: PASS, csrf: token }, body), cookie: false })).status, 303);
      assert.equal((await call(route, { method: 'POST', body: upload({ passphrase: PASS }, body) })).status, 403);
      assert.equal((await call(route, { method: 'POST', body: upload({ passphrase: PASS, csrf: token }, body), origin: 'https://evil.test' })).status, 403);
      const wrong = await call(route, { method: 'POST', body: upload({ passphrase: 'falsche passphrase', csrf: token }, body) });
      assert.equal(wrong.status, 400);
      assert.match(await wrong.text(), /Passphrase falsch/);
      const none = await call(route, { method: 'POST', body: upload({ passphrase: PASS, csrf: token }) });
      assert.equal(none.status, 400);
      assert.match(await none.text(), /Sicherungsdatei wählen/);
      const urlencoded = await call(route, { method: 'POST', form: { passphrase: PASS, csrf: token } });
      assert.equal(urlencoded.status, 415);
      assert.equal(restarts.length, 0);
      assert.ok(!existsSync(join(target, 'cockpit-settings.json')));

      const ok = await call(route, { method: 'POST', body: upload({ passphrase: PASS, csrf: token }, body) });
      assert.equal(ok.status, 200);
      const html = await ok.text();
      assert.match(html, /Sicherung wiederhergestellt/);
      assert.match(html, /cockpit-settings\.json, session-secret/);
      assert.match(html, /neu anmelden/);
      assert.ok(ok.headers.getSetCookie().some((c) => c.startsWith('vc_session=;') && c.includes('Max-Age=0')));
      assert.equal(readFileSync(join(target, 'session-secret'), 'utf8'), 'n'.repeat(64));
      assert.match(readFileSync(join(target, 'cockpit-settings.json'), 'utf8'), /zt_geheim_1234/);
      assert.equal(restarts.length, 1);

      // Nun nicht mehr leer: ohne Haken kein Überschreiben.
      const again = await call(route, { method: 'POST', body: upload({ passphrase: PASS, csrf: token }, body) });
      assert.equal(again.status, 400);
      assert.match(await again.text(), /schon eingerichtet/);
      assert.equal((await call(route, { method: 'POST', body: upload({ passphrase: PASS, csrf: token, ersetzen: '1' }, body) })).status, 200);
      assert.equal(restarts.length, 2);
    });
  } finally {
    rmSync(source, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});

test('Einstellungen → Wiederherstellen: zu große Datei bekommt eine Meldung statt eines Abbruchs', async () => {
  const dir = tmp();
  try {
    await withCockpit(dir, async ({ call, csrf, restarts }) => {
      const token = await csrf();
      const res = await call('/einstellungen/sicherung/wiederherstellen', { method: 'POST', body: upload({ passphrase: PASS, csrf: token }, Buffer.alloc(9 * 1024 * 1024, 97)) });
      assert.equal(res.status, 413);
      assert.match(await res.text(), /zu groß/);
      assert.equal(restarts.length, 0);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
