import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { safeFetch, isPublicAddress, normalizeUrl, splitCredentials, sameHost, decode, FetchError } from '../src/lesen/fetch.js';
import { createSecretBox } from '../src/cockpit/secret-box.js';

test('SSRF: private, lokale und reservierte Adressen gelten nicht als öffentlich', () => {
  const blocked = [
    '127.0.0.1', '127.8.8.8', '10.0.0.1', '10.255.255.255', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '169.254.0.1',
    '100.64.0.1', '100.127.255.255', '0.0.0.0', '0.1.2.3', '224.0.0.1', '239.255.255.250', '240.0.0.1', '255.255.255.255', '198.18.0.1',
    '::', '::1', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', '::ffff:c0a8:101', '64:ff9b::7f00:1',
    '::7f00:1', '::127.0.0.1', '2002:7f00:1::', '2001:0:7f00:1::1', '64:ff9b:1::a00:1',
    'localhost', 'kein-ip', '',
  ];
  for (const ip of blocked) assert.equal(isPublicAddress(ip), false, ip);
  for (const ip of ['93.184.215.14', '1.1.1.1', '172.32.0.1', '100.128.0.1', '2606:4700:4700::1111', '2a00:1450:4001::200e']) assert.equal(isPublicAddress(ip), true, ip);
});

/** Kein Testserver nötig: der Abruf muss vor dem Verbinden scheitern. */
const never = async () => {
  throw new Error('darf nicht auflösen');
};

test('SSRF: Schema, Zugangsdaten und IP-Literale werden vor dem Verbinden abgewiesen', async () => {
  for (const url of ['file:///etc/passwd', 'ftp://a.test/x', 'javascript:alert(1)', 'gopher://a.test', 'kein url']) {
    await assert.rejects(safeFetch(url, { resolve: never }), (err) => err instanceof FetchError && err.status === 400, url);
  }
  await assert.rejects(safeFetch('https://user:pw@a.test/', { resolve: never }), /Zugangsdaten/);
  for (const url of ['http://127.0.0.1/', 'http://localhost./x', 'http://10.0.0.5:8080/', 'http://192.168.0.1/', 'http://169.254.169.254/latest/meta-data/', 'http://[::1]/', 'http://[fc00::1]/', 'http://[::ffff:127.0.0.1]/', 'http://0x7f000001/', 'http://2130706433/', 'http://0/']) {
    const resolve = async (host) => (host === 'localhost.' ? [{ address: '127.0.0.1', family: 4 }] : never());
    await assert.rejects(safeFetch(url, { resolve }), /lokalen oder privaten Netz/, url);
  }
  assert.equal(normalizeUrl(' https://a.test/x#abschnitt '), 'https://a.test/x');
});

test('SSRF: Hostname, der auf eine private Adresse auflöst, wird abgewiesen (auch nur eine von mehreren)', async () => {
  const resolve = async (host) =>
    ({
      'intern.test': [{ address: '10.1.2.3', family: 4 }],
      'gemischt.test': [{ address: '93.184.215.14', family: 4 }, { address: '192.168.1.10', family: 4 }],
      'v6.test': [{ address: 'fd00::1', family: 6 }],
      'mapped.test': [{ address: '::ffff:127.0.0.1', family: 6 }],
    })[host] ?? [];
  for (const host of ['intern.test', 'gemischt.test', 'v6.test', 'mapped.test']) {
    await assert.rejects(safeFetch(`http://${host}/`, { resolve }), /lokalen oder privaten Netz/, host);
  }
  await assert.rejects(safeFetch('http://leer.test/', { resolve }), /nicht erreichbar/);
});

/** Testserver auf 127.0.0.1; `isAllowed` lässt nur ihn zu, alles andere Private bleibt gesperrt. */
async function withServer(handler, run) {
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const opts = {
    resolve: async (host) => ({ 'artikel.test': [{ address: '127.0.0.1', family: 4 }], 'intern.test': [{ address: '10.0.0.1', family: 4 }] })[host] ?? [],
    isAllowed: (ip) => ip === '127.0.0.1' || isPublicAddress(ip),
  };
  try {
    await run(`http://artikel.test:${port}`, opts);
  } finally {
    server.closeAllConnections();
    server.close();
  }
}

test('Abruf: verbindet mit der geprüften Adresse, folgt Weiterleitungen und liefert Text samt Endadresse', async () => {
  await withServer(
    (req, res) => {
      if (req.url === '/kurz') return res.writeHead(301, { location: '/artikel' }).end();
      assert.equal(req.headers['accept-encoding'], undefined, 'nichts Gepacktes anfordern');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end('<p>Grüße</p>');
    },
    async (base, opts) => {
      const r = await safeFetch(`${base}/kurz`, opts);
      assert.equal(r.url, `${base}/artikel`);
      assert.equal(r.body, '<p>Grüße</p>');
    },
  );
});

test('Abruf: Weiterleitung auf eine private Adresse oder in Schleife wird abgewiesen', async () => {
  let port;
  await withServer(
    (req, res) => {
      if (req.url === '/intern') return res.writeHead(302, { location: 'http://intern.test/admin' }).end();
      if (req.url === '/meta') return res.writeHead(302, { location: 'http://169.254.169.254/latest' }).end();
      if (req.url === '/v6') return res.writeHead(302, { location: 'http://[::1]/' }).end();
      if (req.url === '/datei') return res.writeHead(302, { location: 'file:///etc/passwd' }).end();
      if (req.url === '/kaputt') return res.writeHead(302, { location: 'http://[' }).end();
      if (req.url === '/schleife') return res.writeHead(302, { location: `http://artikel.test:${port}/schleife` }).end();
      res.writeHead(200, { 'content-type': 'application/pdf' }).end('%PDF');
    },
    async (base, opts) => {
      port = new URL(base).port;
      for (const p of ['/intern', '/meta', '/v6']) await assert.rejects(safeFetch(`${base}${p}`, opts), /lokalen oder privaten Netz/, p);
      await assert.rejects(safeFetch(`${base}/datei`, opts), /Nur http/);
      await assert.rejects(safeFetch(`${base}/kaputt`, opts), (err) => err instanceof FetchError && err.status === 400);
      await assert.rejects(safeFetch(`${base}/schleife`, opts), /Zu viele Weiterleitungen/);
      await assert.rejects(safeFetch(`${base}/pdf`, opts), (err) => err.status === 415);
    },
  );
});

test('Abruf: zu groß (mit und ohne Content-Length) und zu langsam bricht ab', async () => {
  await withServer(
    (req, res) => {
      if (req.url === '/gross') return res.writeHead(200, { 'content-type': 'text/html', 'content-length': 2048 }).end('x'.repeat(2048));
      if (req.url === '/strom') {
        res.writeHead(200, { 'content-type': 'text/html' });
        const t = setInterval(() => res.write('x'.repeat(512)), 5);
        return res.on('close', () => clearInterval(t));
      }
      if (req.url === '/langsam') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.write('<p>');
        return; // schickt nie den Rest
      }
      res.writeHead(200, { 'content-type': 'text/html' }).end('ok');
    },
    async (base, opts) => {
      await assert.rejects(safeFetch(`${base}/gross`, { ...opts, maxBytes: 1024 }), (err) => err.status === 413);
      await assert.rejects(safeFetch(`${base}/strom`, { ...opts, maxBytes: 4096 }), (err) => err.status === 413);
      const started = Date.now();
      await assert.rejects(safeFetch(`${base}/langsam`, { ...opts, timeoutMs: 150 }), (err) => err.status === 504);
      assert.ok(Date.now() - started < 1500);
    },
  );
});

test('Abruf: der Body einer Weiterleitung wird nicht gelesen, die Verbindung schließt', async () => {
  let closed = false;
  await withServer(
    (req, res) => {
      if (req.url === '/endlos') {
        res.writeHead(302, { location: '/artikel' });
        const t = setInterval(() => res.write('x'.repeat(512)), 5);
        res.on('close', () => {
          clearInterval(t);
          closed = true;
        });
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html' }).end('<p>ok</p>');
    },
    async (base, opts) => {
      assert.equal((await safeFetch(`${base}/endlos`, opts)).body, '<p>ok</p>');
      for (let i = 0; i < 50 && !closed; i++) await new Promise((r) => setTimeout(r, 10));
      assert.ok(closed, 'Redirect-Verbindung bleibt nicht offen');
    },
  );
});

test('Zugangsdaten: aus der Adresse gelöst und dekodiert, nur an denselben Host und nie zurück auf http', async () => {
  assert.deepEqual(splitCredentials(' https://ru%20ben:p%40ss@a.test/feed#x '), { url: 'https://a.test/feed', auth: { user: 'ru ben', password: 'p@ss' } });
  assert.deepEqual(splitCredentials('https://a.test/feed'), { url: 'https://a.test/feed', auth: null });
  assert.deepEqual(splitCredentials('https://token@a.test/feed'), { url: 'https://a.test/feed', auth: { user: 'token', password: '' } });
  assert.throws(() => splitCredentials('ftp://u:p@a.test/'), /Nur http/);
  assert.equal(sameHost('https://a.test/x', 'http://a.test/feed'), true, 'Wechsel auf https darf');
  assert.equal(sameHost('http://a.test/x', 'https://a.test/feed'), false, 'zurück auf http nicht');
  assert.equal(sameHost('https://b.test/x', 'https://a.test/feed'), false);
  assert.equal(sameHost('https://a.test:8443/x', 'https://a.test/feed'), false);

  const seen = [];
  await withServer(
    (req, res) => {
      seen.push([req.headers.host.split(':')[0], req.url, req.headers.authorization ?? null]);
      if (req.url === '/weiter') return res.writeHead(302, { location: '/feed' }).end();
      if (req.url === '/weg') return res.writeHead(302, { location: `http://anders.test:${req.socket.localPort}/feed` }).end();
      if (req.headers.authorization !== `Basic ${Buffer.from('ruben:p@ss').toString('base64')}`) return res.writeHead(401).end();
      res.writeHead(200, { 'content-type': 'application/rss+xml' }).end('<rss/>');
    },
    async (base, opts) => {
      const o = { ...opts, accept: null, resolve: async (host) => (['artikel.test', 'anders.test'].includes(host) ? [{ address: '127.0.0.1', family: 4 }] : []) };
      const auth = { user: 'ruben', password: 'p@ss' };
      assert.equal((await safeFetch(`${base}/weiter`, { ...o, auth })).body, '<rss/>');
      await assert.rejects(safeFetch(`${base}/weg`, { ...o, auth }), /Zugang verweigert \(HTTP 401\)/);
      await assert.rejects(safeFetch(`${base}/feed`, { ...o, auth: { user: 'ruben', password: 'falsch' } }), /Zugang verweigert \(HTTP 401\), bitte die Zugangsdaten prüfen/);
    },
  );
  const basic = `Basic ${Buffer.from('ruben:p@ss').toString('base64')}`;
  assert.deepEqual(seen.slice(0, 4), [['artikel.test', '/weiter', basic], ['artikel.test', '/feed', basic], ['artikel.test', '/weg', basic], ['anders.test', '/feed', null]]);
});

test('Secret-Box: nur mit demselben Schlüssel und Kontext zu öffnen', () => {
  const box = createSecretBox('k'.repeat(40));
  const sealed = box.seal({ user: 'a', password: 'geheim' }, 'feed:1');
  assert.match(sealed, /^v1\./);
  assert.ok(!sealed.includes('geheim'));
  assert.notEqual(box.seal({ user: 'a' }, 'feed:1'), box.seal({ user: 'a' }, 'feed:1'), 'zufälliger IV');
  assert.deepEqual(box.open(sealed, 'feed:1'), { user: 'a', password: 'geheim' });
  assert.equal(box.open(sealed, 'feed:2'), null, 'in eine andere Zeile kopiert');
  assert.equal(createSecretBox('j'.repeat(40)).open(sealed, 'feed:1'), null);
  assert.equal(box.open(`${sealed.slice(0, -2)}AA`, 'feed:1'), null);
  assert.equal(box.open('kaputt', 'feed:1'), null);
  assert.throws(() => createSecretBox('kurz'), /32 Zeichen/);
});

test('Zeichensatz: Header vor <meta charset> und <?xml encoding?>, BOM vor allem, sonst UTF-8', () => {
  const latin = (s) => Buffer.from(s, 'latin1');
  assert.equal(decode(latin('<html><head><meta charset="iso-8859-1"></head><p>Grüße</p>'), 'text/html'), '<html><head><meta charset="iso-8859-1"></head><p>Grüße</p>');
  assert.match(decode(latin('<meta http-equiv="Content-Type" content="text/html; charset=windows-1252"><p>Straße</p>'), 'text/html'), /Straße/);
  assert.match(decode(latin('<?xml version="1.0" encoding="ISO-8859-1"?><rss><title>Bär</title></rss>'), 'application/xml'), /Bär/);
  // Der Header gewinnt gegen die Angabe im Dokument.
  assert.match(decode(Buffer.from('<meta charset="iso-8859-1"><p>Grüße</p>'), 'text/html; charset=utf-8'), /Grüße/);
  assert.match(decode(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('<p>Öl</p>')]), 'text/html; charset=iso-8859-1'), /Öl/);
  assert.equal(decode(Buffer.from('<p>Kühn</p>'), null), '<p>Kühn</p>');
  assert.equal(decode(Buffer.from('<p>Kühn</p>'), 'text/html; charset=quatsch'), '<p>Kühn</p>');
});
