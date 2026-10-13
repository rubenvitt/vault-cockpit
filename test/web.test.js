import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createSign, createHash } from 'node:crypto';
import { createApp } from '../src/http/app.js';
import { createWebHttp } from '../src/web/http.js';
import { createOidcLogin } from '../src/web/oidc.js';
import { createCookieSigner, parseCookies } from '../src/web/session.js';

const ISSUER = 'https://id.test';
const CLIENT = 'cockpit-web';
const SECRET = 'x'.repeat(40);
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

/**
 * Pocket-ID-Attrappe: Discovery, JWKS und Token-Endpunkt. Der Token-Endpunkt
 * prüft PKCE und gibt ein ID-Token mit der beim Authorize gesendeten nonce aus.
 */
function fakeIdp({ sub = 'ruben', aud = CLIENT, nonceOverride = null } = {}) {
  const grants = new Map();
  const tokenRequests = [];
  const fetch = async (url, init = {}) => {
    const u = String(url);
    if (u === `${ISSUER}/.well-known/openid-configuration`) {
      return Response.json({ authorization_endpoint: `${ISSUER}/authorize`, token_endpoint: `${ISSUER}/api/oidc/token`, jwks_uri: `${ISSUER}/.well-known/jwks.json` });
    }
    if (u === `${ISSUER}/.well-known/jwks.json`) return Response.json(jwks);
    if (u === `${ISSUER}/api/oidc/token`) {
      const form = new URLSearchParams(init.body);
      tokenRequests.push({ form, headers: init.headers });
      const g = grants.get(form.get('code'));
      const challenge = createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url');
      if (!g || g.challenge !== challenge) return Response.json({ error: 'invalid_grant' }, { status: 400 });
      const now = Math.floor(Date.now() / 1000);
      return Response.json({
        id_token: signJwt({ iss: ISSUER, aud, sub, name: 'Ruben', nonce: nonceOverride ?? g.nonce, exp: now + 300, iat: now }),
      });
    }
    throw new Error(`unerwarteter Abruf: ${u}`);
  };
  /** Was der Browser bei Pocket ID tun würde: Code ausstellen und zurückleiten. */
  const authorize = (location) => {
    const u = new URL(location);
    const code = `code-${grants.size + 1}`;
    grants.set(code, { challenge: u.searchParams.get('code_challenge'), nonce: u.searchParams.get('nonce') });
    return { code, state: u.searchParams.get('state'), params: u.searchParams };
  };
  return { fetch, authorize, tokenRequests };
}

const cockpit = {
  async week(id) {
    if (id === 'kaputt') return null;
    return {
      week: { id: '2026-W42', year: 2026, week: 42, monday: '2026-10-12', sunday: '2026-10-18', prev: '2026-W41', next: '2026-W43', current: true },
      today: '2026-10-14',
      feuer: { ok: true, data: null },
      flames: { ok: true, data: [] },
      rocks: { ok: true, data: [] },
      calendar: { ok: true, data: [] },
      tasks: { ok: true, data: [] },
      inbox: { vault: { ok: true, data: [] }, zunder: { ok: true, data: [] }, folder: 'inbox' },
    };
  },
};

async function withServer(run, idpOptions = {}, { clientSecret = null, allowedSubjects = ['ruben'] } = {}) {
  const idp = fakeIdp(idpOptions);
  const webHttp = createWebHttp({
    cockpit,
    oidc: createOidcLogin({ issuer: ISSUER, clientId: CLIENT, clientSecret, redirectUri: 'https://vault.test/auth/callback', allowedSubjects, fetch: idp.fetch }),
    sessionSecret: SECRET,
    publicUrl: 'https://vault.test',
    allowedSubjects,
    logger: quiet,
  });
  const app = createApp({
    config: { publicUrl: 'https://vault.test', resource: 'https://vault.test/mcp', issuer: ISSUER, supportedScopes: [], allowedHosts: ['vault.test'], trustProxy: true },
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
  const jar = {};
  const call = async (path, { method = 'GET', cookies = true } = {}) => {
    const cookie = cookies ? Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ') : '';
    const res = await fetch(base + path, { method, redirect: 'manual', headers: { 'x-forwarded-host': 'vault.test', ...(cookie ? { cookie } : {}) } });
    for (const c of res.headers.getSetCookie()) {
      const [pair, ...attrs] = c.split('; ');
      const [k, v] = pair.split('=');
      if (attrs.includes('Max-Age=0')) delete jar[k];
      else jar[k] = v;
    }
    return res;
  };
  /** Kompletter Login bis zur Rückkehr auf die Seite. */
  const login = async (next = '/') => {
    const start = await call(`/login?next=${encodeURIComponent(next)}`);
    assert.equal(start.status, 303);
    const { code, state } = idp.authorize(start.headers.get('location'));
    return call(`/auth/callback?code=${code}&state=${state}`);
  };
  try {
    await run({ call, login, idp, jar });
  } finally {
    app.close();
  }
}

test('ohne Sitzung: Seite leitet zum Login, API antwortet 401', async () => {
  await withServer(async ({ call }) => {
    const page = await call('/?woche=2026-W42');
    assert.equal(page.status, 303);
    assert.equal(page.headers.get('location'), '/login?next=%2F%3Fwoche%3D2026-W42');
    assert.equal((await call('/api/woche')).status, 401);
  });
});

test('Login: PKCE, nonce, Sitzungs-Cookie, Rücksprung und Wochenseite', async () => {
  await withServer(async ({ call, login, idp, jar }) => {
    const start = await call('/login?next=%2F%3Fwoche%3D2026-W42');
    const loc = new URL(start.headers.get('location'));
    assert.equal(loc.origin + loc.pathname, `${ISSUER}/authorize`);
    assert.equal(loc.searchParams.get('client_id'), CLIENT);
    assert.equal(loc.searchParams.get('redirect_uri'), 'https://vault.test/auth/callback');
    assert.equal(loc.searchParams.get('code_challenge_method'), 'S256');
    assert.ok(loc.searchParams.get('nonce'));
    const setCookie = start.headers.getSetCookie()[0];
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /Secure/);
    assert.match(setCookie, /SameSite=Lax/);

    const { code, state } = idp.authorize(loc.href);
    const back = await call(`/auth/callback?code=${code}&state=${state}`);
    assert.equal(back.status, 303);
    assert.equal(back.headers.get('location'), '/?woche=2026-W42');
    assert.ok(jar.vc_session);
    assert.equal(jar.vc_login, undefined);
    assert.equal(idp.tokenRequests[0].headers.authorization, undefined);

    const page = await call('/');
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy'), /default-src 'none'/);
    assert.match(await page.text(), /<h1>KW 42/);

    const api = await call('/api/woche');
    assert.equal(api.status, 200);
    assert.equal((await api.json()).week.id, '2026-W42');
    assert.equal((await call('/api/woche?woche=kaputt')).status, 400);
    assert.equal((await call('/?woche=kaputt')).status, 400);

    await login();
    const out = await call('/logout', { method: 'POST' });
    assert.equal(out.status, 303);
    assert.equal(jar.vc_session, undefined);
    assert.equal((await call('/')).status, 303);
  });
});

test('Login: Client Secret geht per Basic-Auth an den Token-Endpunkt', async () => {
  await withServer(
    async ({ login, idp }) => {
      assert.equal((await login()).status, 303);
      assert.equal(idp.tokenRequests[0].headers.authorization, `Basic ${Buffer.from(`${CLIENT}:geheim`).toString('base64')}`);
    },
    {},
    { clientSecret: 'geheim' },
  );
});

test('Login: falscher state, falsche nonce, fremde Audience und fremdes Subject werden abgewiesen', async () => {
  await withServer(async ({ call, idp, jar }) => {
    const start = await call('/login');
    const { code } = idp.authorize(start.headers.get('location'));
    assert.equal((await call(`/auth/callback?code=${code}&state=falsch`)).status, 403);
    assert.equal(jar.vc_session, undefined);
  });
  for (const opts of [{ nonceOverride: 'andere' }, { aud: 'anderer-client' }, { sub: 'fremd' }]) {
    await withServer(async ({ login, jar }) => {
      assert.equal((await login()).status, 403);
      assert.equal(jar.vc_session, undefined);
    }, opts);
  }
});

test('Login: kein offener Redirect über next', async () => {
  for (const next of ['//evil.test/x', 'https://evil.test', '/\\evil.test']) {
    await withServer(async ({ login }) => {
      assert.equal((await login(next)).headers.get('location'), '/');
    });
  }
});

test('Login: Abbruch bei Pocket ID zeigt eine Meldung', async () => {
  await withServer(async ({ call }) => {
    await call('/login');
    const res = await call('/auth/callback?error=access_denied&error_description=%3Cb%3Enein%3C%2Fb%3E');
    assert.equal(res.status, 401);
    const html = await res.text();
    assert.match(html, /&lt;b&gt;nein/);
  });
});

test('Sitzung: gefälschte, abgelaufene und gestrichene Cookies gelten nicht', async () => {
  const signer = createCookieSigner(SECRET);
  const exp = Math.floor(Date.now() / 1000) + 600;
  const good = signer.seal({ sub: 'ruben', exp });
  assert.equal(signer.open(good).sub, 'ruben');
  assert.equal(signer.open(`${good}x`), null);
  assert.equal(signer.open(good.replace(/^[^.]+/, Buffer.from(JSON.stringify({ sub: 'admin', exp })).toString('base64url'))), null);
  assert.equal(signer.open(signer.seal({ sub: 'ruben', exp: exp - 1200 })), null);
  assert.equal(createCookieSigner('y'.repeat(40)).open(good), null);
  assert.throws(() => createCookieSigner('kurz'), /32 Zeichen/);
  assert.deepEqual(parseCookies('a=1; b=2=3'), { a: '1', b: '2=3' });

  await withServer(async ({ call, jar }) => {
    jar.vc_session = signer.seal({ sub: 'fremd', exp });
    assert.equal((await call('/')).status, 303);
    jar.vc_session = signer.seal({ sub: 'ruben', exp });
    assert.equal((await call('/')).status, 200);
  });
});

test('Stylesheet ist ohne Sitzung abrufbar, MCP-Routen bleiben unberührt', async () => {
  await withServer(async ({ call }) => {
    const css = await call('/static/cockpit.css', { cookies: false });
    assert.equal(css.status, 200);
    assert.match(css.headers.get('content-type'), /text\/css/);
    assert.equal((await call('/mcp', { method: 'POST' })).status, 401);
    assert.equal((await call('/nicht-da')).status, 404);
  });
});
