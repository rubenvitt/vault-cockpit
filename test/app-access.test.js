import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createSign, createHash, randomBytes } from 'node:crypto';
import { createApp } from '../src/http/app.js';
import { createWebHttp } from '../src/web/http.js';
import { createOidcLogin } from '../src/web/oidc.js';
import { createSettingsStore } from '../src/cockpit/settings.js';
import { createTokenStore } from '../src/cockpit/tokens.js';
import { createReadingStore } from '../src/lesen/store.js';
import { readingRoutes } from '../src/lesen/http.js';
import { createReadingApi } from '../src/lesen/api.js';

const ISSUER = 'https://id.test';
const CLIENT = 'cockpit-web';
const quiet = { info() {}, warn() {}, error() {} };

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwks = { keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'K1', alg: 'RS256', use: 'sig' }] };

function signJwt(payload) {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = enc({ alg: 'RS256', typ: 'JWT', kid: 'K1' });
  const body = enc(payload);
  const s = createSign('RSA-SHA256');
  s.update(`${head}.${body}`);
  return `${head}.${body}.${s.sign(privateKey).toString('base64url')}`;
}

/** Pocket-ID-Attrappe wie in web.test.js: Discovery, JWKS, Token-Endpunkt mit PKCE. */
function fakeIdp({ sub = 'ruben' } = {}) {
  const grants = new Map();
  const fetch = async (url, init = {}) => {
    const u = String(url);
    if (u === `${ISSUER}/.well-known/openid-configuration`) {
      return Response.json({ authorization_endpoint: `${ISSUER}/authorize`, token_endpoint: `${ISSUER}/api/oidc/token`, jwks_uri: `${ISSUER}/.well-known/jwks.json` });
    }
    if (u === `${ISSUER}/.well-known/jwks.json`) return Response.json(jwks);
    if (u === `${ISSUER}/api/oidc/token`) {
      const form = new URLSearchParams(init.body);
      const g = grants.get(form.get('code'));
      const challenge = createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url');
      if (!g || g.challenge !== challenge) return Response.json({ error: 'invalid_grant' }, { status: 400 });
      const now = Math.floor(Date.now() / 1000);
      return Response.json({ id_token: signJwt({ iss: ISSUER, aud: CLIENT, sub, name: 'Ruben', nonce: g.nonce, exp: now + 300, iat: now }) });
    }
    throw new Error(`unerwarteter Abruf: ${u}`);
  };
  const authorize = (location) => {
    const u = new URL(location);
    const code = `code-${grants.size + 1}`;
    grants.set(code, { challenge: u.searchParams.get('code_challenge'), nonce: u.searchParams.get('nonce') });
    return { code, state: u.searchParams.get('state') };
  };
  return { fetch, authorize };
}

const pkce = () => {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
};

async function withServer(run, { sub = 'ruben', publicUrl = 'https://vault.test', allowDevScheme = false } = {}) {
  const idp = fakeIdp({ sub });
  const clock = { t: Date.now() };
  const tokens = createTokenStore({ logger: quiet });
  const store = createReadingStore({ path: ':memory:' });
  const changed = [];
  const reading = readingRoutes({ store, logger: quiet, onChange: (id) => changed.push(id) });
  const logs = [];
  const logger = { info: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m) };
  const webHttp = createWebHttp({
    cockpit: { week: async () => null },
    settings: createSettingsStore({ defaults: { tz: 'Europe/Berlin' }, logger: quiet }),
    tokens,
    reading,
    oidc: createOidcLogin({ issuer: ISSUER, clientId: CLIENT, redirectUri: 'https://vault.test/auth/callback', allowedSubjects: ['ruben'], fetch: idp.fetch }),
    sessionSecret: 'x'.repeat(40),
    publicUrl,
    appId: 'TEAM123.dev.example.cockpit',
    allowDevScheme,
    allowedSubjects: ['ruben'],
    logger,
    now: () => clock.t,
  });
  const app = createApp({
    config: { publicUrl: 'https://vault.test', resource: 'https://vault.test/mcp', issuer: ISSUER, supportedScopes: [], allowedHosts: ['vault.test'], trustProxy: true },
    verifyToken: async () => {
      throw new Error('nicht benutzt');
    },
    mcpHandler: async () => {},
    readingApi: createReadingApi({ tokens, store, logger: quiet }),
    webHttp,
    logger: quiet,
  });
  app.listen(0, '127.0.0.1');
  await new Promise((res) => app.once('listening', res));
  const base = `http://127.0.0.1:${app.address().port}`;
  // Ein Keksglas für das Login-Blatt (ASWebAuthenticationSession), eins für den WKWebView.
  const sheet = {};
  const call = async (path, { method = 'GET', jar = sheet, body = undefined, bearer = null } = {}) => {
    const cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
    const headers = { 'x-forwarded-host': 'vault.test', ...(cookie ? { cookie } : {}), ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(base + path, { method, redirect: 'manual', headers, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const c of res.headers.getSetCookie()) {
      const [pair, ...attrs] = c.split('; ');
      const [k, v] = pair.split('=');
      if (attrs.includes('Max-Age=0')) delete jar[k];
      else jar[k] = v;
    }
    return res;
  };
  /** App-Login bis zum Redirect auf den Universal Link; liefert dessen Parameter. */
  const appLogin = async ({ challenge, state = 'zustand-123', extra = '' }) => {
    const start = await call(`/login?app=1&state=${state}&challenge=${challenge}${extra}`);
    assert.equal(start.status, 303);
    const { code, state: s } = idp.authorize(start.headers.get('location'));
    const back = await call(`/auth/callback?code=${code}&state=${s}`);
    assert.equal(back.status, 303);
    return new URL(back.headers.get('location'));
  };
  const redeem = (body) => call('/api/app/einloesen', { method: 'POST', body });
  try {
    await run({ base, call, appLogin, redeem, clock, tokens, store, changed, logs, sheet });
  } finally {
    app.close();
  }
}

test('App-Login: Universal Link, Einlösen, Cookie öffnet /lesen/eingang, Token die App-API', async () => {
  await withServer(async ({ base, call, appLogin, redeem, clock, tokens, store, changed, logs, sheet }) => {
    const { verifier, challenge } = pkce();
    const back = await appLogin({ challenge });
    assert.equal(`${back.origin}${back.pathname}`, 'https://vault.test/app/angemeldet');
    assert.equal(back.searchParams.get('state'), 'zustand-123');
    const code = back.searchParams.get('code');
    assert.match(code, /^[\w-]{43}$/);
    // Im Login-Blatt entsteht keine Sitzung, das Login-Cookie ist weg.
    assert.deepEqual(sheet, {});

    const res = await redeem({ code, verifier, device: 'Rubens iPhone' });
    assert.equal(res.status, 200);
    const out = await res.json();
    assert.deepEqual(Object.keys(out.cookie).sort(), ['domain', 'expires', 'httpOnly', 'name', 'path', 'sameSite', 'secure', 'value']);
    assert.equal(out.cookie.name, 'vc_session');
    assert.equal(out.cookie.domain, 'vault.test');
    assert.equal(out.cookie.path, '/');
    assert.equal(out.cookie.secure, true);
    assert.equal(out.cookie.httpOnly, true);
    // Standard der Einstellungen: 30 Tage ohne Nutzung, verlängert bei Nutzung.
    assert.ok(Math.abs(Date.parse(out.cookie.expires) - (Date.now() + 30 * 86_400_000)) < 5000);
    assert.match(out.token.token, /^vct_/);
    assert.deepEqual(out.token.scopes, ['app', 'lesestapel']);
    assert.deepEqual(tokens.list().map((t) => [t.name, t.scope]), [['Rubens iPhone', 'app']]);
    assert.ok(!logs.some((l) => l.includes(out.token.token) || l.includes(code) || l.includes(out.cookie.value)), 'keine Geheimnisse im Log');

    // Mit dem Cookie (WKWebView) ist das Cockpit offen.
    const web = { [out.cookie.name]: out.cookie.value };
    assert.equal((await call('/lesen/eingang', { jar: web })).status, 200);
    assert.equal((await call('/lesen/eingang', { jar: {} })).status, 303);
    // Bei Nutzung verlängert wie im Web: nach über einer Stunde ein frisches Cookie, das der WKWebView übernimmt.
    clock.t += 2 * 3600_000;
    const before = web.vc_session;
    assert.equal((await call('/lesen/eingang', { jar: web })).status, 200);
    assert.notEqual(web.vc_session, before);

    // Mit dem Token die App-API.
    const bearer = out.token.token;
    const me = await (await call('/api/app/ich', { bearer })).json();
    assert.equal(me.name, 'Rubens iPhone');
    assert.deepEqual(me.scopes, ['app', 'lesestapel']);
    assert.match(me.version, /^\d+\.\d+\.\d+/);

    const html = '<p>Erster Satz hier. Zweiter Satz dort.</p>';
    const { doc } = store.addDocument({ url: 'https://blatt.test/a', title: 'Vom Lesen', status: 'stapel', reading_minutes: 5, content_html: html });
    store.addDocument({ url: 'https://blatt.test/lang', title: 'Zu lang', status: 'stapel', reading_minutes: 40 });
    const stapel = await (await call('/api/app/stapel?zeit=15', { bearer })).json();
    assert.equal(stapel.zeit, 15);
    assert.deepEqual(stapel.items.map((d) => [d.id, d.title, d.remaining]), [[doc.id, 'Vom Lesen', 5]]);

    const text = await (await call(`/api/app/text?id=${doc.id}`, { bearer })).json();
    assert.equal(text.text, 'Erster Satz hier. Zweiter Satz dort.');
    assert.deepEqual(text.sentences, [[0, 17], [18, 36]]);
    assert.equal((await call('/api/app/text?id=gibtsnicht', { bearer })).status, 404);

    const p = await call('/api/app/fortschritt', { method: 'POST', bearer, body: { id: doc.id, fortschritt: 0.5, anker: 18 } });
    assert.equal(p.status, 200);
    assert.equal((await p.json()).progress, 0.5);
    assert.equal(store.get(doc.id).scroll_anchor, '18');
    assert.equal((await call('/api/app/fortschritt', { method: 'POST', bearer, body: { id: doc.id } })).status, 400);
    assert.equal((await call('/api/app/fortschritt', { method: 'POST', bearer, body: { id: 'gibtsnicht', fortschritt: 0.5 } })).status, 400);

    const mark = { id: doc.id, quote: 'Zweiter Satz dort.', prefix: 'Erster Satz hier. ', suffix: '', start: 18, cid: 'app-1' };
    const m1 = await call('/api/app/markierung', { method: 'POST', bearer, body: mark });
    assert.equal(m1.status, 201);
    assert.equal((await m1.json()).id, 'app-1');
    const m2 = await call('/api/app/markierung', { method: 'POST', bearer, body: mark });
    assert.equal(m2.status, 200);
    assert.equal((await m2.json()).duplicate, true);
    assert.equal(store.listHighlights({ docId: doc.id }).length, 1);
    assert.deepEqual(changed, [doc.id]);
    assert.equal((await call('/api/app/markierung', { method: 'POST', bearer, body: { id: doc.id, quote: 'x', start: { a: 1 } } })).status, 400);
    assert.equal((await call('/api/app/stapel', { method: 'POST', bearer, body: {} })).status, 405);

    // Die Share Extension speichert mit demselben Token in den Lesestapel (Recht „Lesestapel“ inklusive).
    const share = await fetch(`${base}/lesestapel/speichern`, { method: 'POST', headers: { 'x-forwarded-host': 'vault.test', authorization: `Bearer ${bearer}`, 'content-type': 'application/json' }, body: '{"url":"ftp://kein.test"}' });
    assert.equal(share.status, 400, 'Token angenommen, nur die Adresse taugt nicht');

    // Zweites Einlösen: 400.
    assert.equal((await redeem({ code, verifier, device: 'Rubens iPhone' })).status, 400);
  });
});

test('App-Login: falscher Verifier verbraucht den Code, abgelaufener gilt nicht', async () => {
  await withServer(async ({ appLogin, redeem, clock, tokens }) => {
    const { verifier, challenge } = pkce();
    const code = (await appLogin({ challenge })).searchParams.get('code');
    const wrong = await redeem({ code, verifier: pkce().verifier, device: 'iPhone' });
    assert.equal(wrong.status, 400);
    assert.equal((await wrong.json()).error, 'invalid_code');
    // Nach einem Fehlversuch ist der Code verbraucht, auch für den richtigen Verifier.
    assert.equal((await redeem({ code, verifier, device: 'iPhone' })).status, 400);

    const late = pkce();
    const code2 = (await appLogin({ challenge: late.challenge })).searchParams.get('code');
    clock.t += 61_000;
    assert.equal((await redeem({ code: code2, verifier: late.verifier, device: 'iPhone' })).status, 400);
    assert.equal((await redeem({ code: 'ausgedacht', verifier: late.verifier, device: 'iPhone' })).status, 400);
    assert.equal((await redeem({})).status, 400);
    assert.equal(tokens.list().length, 0);
  });
});

test('App-Login: Redirect immer auf /app/angemeldet, nie auf cockpit://, ungültige Challenge 400', async () => {
  await withServer(async ({ call, appLogin }) => {
    const { challenge } = pkce();
    const back = await appLogin({ challenge, extra: `&next=${encodeURIComponent('https://evil.test/')}&redirect_uri=${encodeURIComponent('evil://login')}` });
    assert.match(back.href, /^https:\/\/vault\.test\/app\/angemeldet\?code=/);
    assert.equal((await call(`/login?app=1&state=zustand-123&challenge=zu-kurz`)).status, 400);
    assert.equal((await call(`/login?app=1&challenge=${challenge}`)).status, 400);
    // Abbruch bei Pocket ID geht zurück an die App, ohne Code.
    const start = await call(`/login?app=1&state=zustand-123&challenge=${challenge}`);
    const state = new URL(start.headers.get('location')).searchParams.get('state');
    const cancel = await call(`/auth/callback?error=access_denied&state=${state}`);
    assert.equal(cancel.headers.get('location'), 'https://vault.test/app/angemeldet?error=access_denied&state=zustand-123');
  });
});

test('App-Login: cockpit://login nur bei PUBLIC_URL ohne https und außerhalb der Produktion', async () => {
  await withServer(
    async ({ appLogin, redeem }) => {
      const { verifier, challenge } = pkce();
      const back = await appLogin({ challenge });
      assert.equal(`${back.protocol}//${back.host}${back.pathname}`, 'cockpit://login');
      assert.equal(back.searchParams.get('state'), 'zustand-123');
      const res = await redeem({ code: back.searchParams.get('code'), verifier, device: 'Simulator' });
      assert.equal(res.status, 200);
      assert.equal((await res.json()).cookie.secure, false);
    },
    { publicUrl: 'http://vault.test', allowDevScheme: true },
  );
  // Mit https nie, auch wenn erlaubt; ohne Erlaubnis (NODE_ENV=production) auch nicht bei http.
  for (const options of [{ publicUrl: 'https://vault.test', allowDevScheme: true }, { publicUrl: 'http://vault.test', allowDevScheme: false }]) {
    await withServer(async ({ appLogin }) => {
      const back = await appLogin({ challenge: pkce().challenge });
      assert.equal(`${back.origin}${back.pathname}`, `${options.publicUrl}/app/angemeldet`);
    }, options);
  }
});

test('Universal Link: apple-app-site-association und /app/angemeldet ohne Anmeldung', async () => {
  await withServer(async ({ call }) => {
    const aasa = await call('/.well-known/apple-app-site-association', { jar: {} });
    assert.equal(aasa.status, 200);
    assert.equal(aasa.headers.get('content-type'), 'application/json');
    assert.deepEqual(await aasa.json(), {
      applinks: { details: [{ appIDs: ['TEAM123.dev.example.cockpit'], components: [{ '/': '/app/angemeldet*' }] }] },
      webcredentials: { apps: ['TEAM123.dev.example.cockpit'] },
    });
    const page = await call('/app/angemeldet?code=abc&state=zustand-123', { jar: {} });
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /^text\/html/);
    assert.equal(page.headers.get('cache-control'), 'no-store');
    const html = await page.text();
    assert.match(html, /Zurück zur App/);
    assert.doesNotMatch(html, /abc/, 'der Code bleibt unbenutzt');
  });
});

test('App-Login: nur ALLOWED_SUBJECTS', async () => {
  await withServer(
    async ({ appLogin }) => {
      const back = await appLogin({ challenge: pkce().challenge });
      assert.equal(back.href, 'https://vault.test/app/angemeldet?error=access_denied&state=zustand-123');
    },
    { sub: 'fremd' },
  );
});

test('App-Login: Einlösen ist begrenzt', async () => {
  await withServer(async ({ redeem, clock }) => {
    for (let i = 0; i < 10; i++) assert.equal((await redeem({ code: `x${i}`, verifier: 'y' })).status, 400);
    assert.equal((await redeem({ code: 'x', verifier: 'y' })).status, 429);
    clock.t += 61_000;
    assert.equal((await redeem({ code: 'x', verifier: 'y' })).status, 400);
  });
});

test('App-API: ohne, mit fremdem Recht und mit widerrufenem Token', async () => {
  await withServer(async ({ call, tokens }) => {
    const reads = ['/api/app/ich', '/api/app/stapel', '/api/app/text?id=a'];
    const writes = ['/api/app/fortschritt', '/api/app/markierung'];
    const all = async (bearer, status) => {
      for (const p of reads) assert.equal((await call(p, { bearer })).status, status, p);
      for (const p of writes) assert.equal((await call(p, { method: 'POST', bearer, body: { id: 'a' } })).status, status, p);
    };
    await all(null, 401);
    await all('vct_ausgedacht', 401);
    await all(tokens.create('Kurzbefehl', 'lesestapel').token, 403);
    const device = tokens.create('iPhone', 'app');
    assert.equal((await call('/api/app/ich', { bearer: device.token })).status, 200);
    tokens.revoke(device.id);
    await all(device.token, 401);
    // Abmelden in der App widerruft genau diesen Token.
    const phone = tokens.create('iPhone', 'app');
    const other = tokens.create('iPad', 'app');
    assert.equal((await call('/api/app/abmelden', { bearer: phone.token })).status, 405);
    assert.equal((await call('/api/app/abmelden', { method: 'POST', body: {} })).status, 401);
    const out = await call('/api/app/abmelden', { method: 'POST', bearer: phone.token, body: {} });
    assert.equal(out.status, 200);
    assert.deepEqual(await out.json(), { ok: true });
    await all(phone.token, 401);
    assert.equal((await call('/api/app/abmelden', { method: 'POST', bearer: phone.token, body: {} })).status, 401);
    assert.equal((await call('/api/app/ich', { bearer: other.token })).status, 200);
    // Eine Sitzung ersetzt den Token nicht.
    assert.equal((await call('/api/app/ich')).status, 401);
  });
});
