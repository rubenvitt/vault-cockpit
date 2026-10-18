import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createSign, createHash } from 'node:crypto';
import { createApp } from '../src/http/app.js';
import { createWebHttp } from '../src/web/http.js';
import { loadShortcuts } from '../src/web/shortcuts.js';
import { createOidcLogin } from '../src/web/oidc.js';
import { createCookieSigner, parseCookies } from '../src/web/session.js';
import { createSettingsStore } from '../src/cockpit/settings.js';
import { createTokenStore } from '../src/cockpit/tokens.js';
import { ActionError } from '../src/cockpit/actions.js';

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
    if (id === 'kaputt' || id === 'unbekannt') return null;
    return {
      tz: 'Europe/Berlin',
      vaultName: null,
      week: { id: '2026-W42', year: 2026, week: 42, monday: '2026-10-12', sunday: '2026-10-18', prev: '2026-W41', next: '2026-W43', current: id !== 'vorbei', past: id === 'vorbei' },
      today: '2026-10-14',
      feuer: { ok: true, data: id === 'feuer' ? { path: 'feuer/KW42.md', title: 'KW42', goal: 'Ziel <b>', firstMove: null, alignment: null } : null },
      burning: id === 'brennt' ? { id: 'f9', ref: null, title: 'Deep Work', startedAt: '2026-10-14T07:00:00Z', url: 'https://zunder.test/#/aufgabe/f9' } : null,
      flames: { ok: true, data: [] },
      rocks: {
        ok: true,
        data: [{ area: 'Finanzen', done: 0, tasks: [{ id: 't1', ref: 'VCP-1', title: 'Steuer <abgeben>', status: 'open', due: null, url: 'https://zunder.test/#/aufgabe/t1' }] }],
      },
      calendar: { ok: true, data: [] },
      tasks: { ok: true, data: [] },
      inbox: {
        vault: { ok: true, data: [] },
        zunder: { ok: true, data: [{ id: 'z1', ref: null, title: 'Zahnarzt anrufen', status: 'open', due: null, phoenix: null, url: 'https://zunder.test/#/aufgabe/z1' }] },
        targets: [{ id: 'a1', name: 'Gesundheit', projects: [{ id: 'p1', name: 'Zähne & Co' }] }],
        folder: 'inbox',
      },
    };
  },
};

cockpit.review = async (id) =>
  id === 'kaputt'
    ? null
    : {
        tz: 'Europe/Berlin',
        week: { id: '2026-W42', week: 42, monday: '2026-10-12', sunday: '2026-10-18', prev: '2026-W41', next: '2026-W43' },
        ok: true,
        areas: [{ area: 'Finanzen <A>', planned: 4, done: 3, extra: 1, minutes: 95, open: [{ id: 't1', title: 'Steuer', due: '2026-10-16', url: 'https://zunder.test/#/aufgabe/t1' }] }],
        totals: { planned: 4, done: 3, extra: 1, minutes: 95 },
        flames: [],
      };

const graph = {
  async around(path) {
    if (path !== 'wiki/a.md') return null;
    return {
      center: 'note:wiki/a.md',
      nodes: [
        { id: 'note:wiki/a.md', kind: 'note', path: 'wiki/a.md', level: 0, label: 'A' },
        { id: 'note:wiki/b.md', kind: 'note', path: 'wiki/b.md', level: 1, label: 'B' },
      ],
      edges: [{ from: 'note:wiki/a.md', to: 'note:wiki/b.md', kind: 'semantic', score: 0.71 }],
      problems: [],
    };
  },
};
const search = async (q) => ({ results: [{ path: 'wiki/a.md', title: 'A', snippet: `zu ${q}`, streams: ['text', 'semantic'] }], total: 1, degraded: null });

async function withServer(run, idpOptions = {}, { clientSecret = null, allowedSubjects = ['ruben'], calendars = null, actions = null, notes = null, shortcuts = [] } = {}) {
  const idp = fakeIdp(idpOptions);
  const settings = createSettingsStore({ defaults: { tz: 'Europe/Berlin', inboxFolder: 'inbox', zunderUrl: 'https://zunder.env', zunderToken: 'zt_env' }, logger: quiet });
  const tokens = createTokenStore({ logger: quiet });
  const webHttp = createWebHttp({
    cockpit,
    settings,
    actions,
    notes,
    tokens,
    shortcuts,
    calendars,
    graph,
    search,
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
  const call = async (path, { method = 'GET', cookies = true, form = null, origin = null, accept = null } = {}) => {
    const cookie = cookies ? Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ') : '';
    const headers = { 'x-forwarded-host': 'vault.test', ...(cookie ? { cookie } : {}), ...(origin ? { origin } : {}), ...(accept ? { accept } : {}) };
    if (form) headers['content-type'] = 'application/x-www-form-urlencoded';
    const res = await fetch(base + path, { method, redirect: 'manual', headers, body: form ? new URLSearchParams(form).toString() : undefined });
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
    await run({ call, login, idp, jar, settings, tokens });
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

test('PWA: Manifest und Icons ohne Sitzung, Stylesheet mit Versions-Parameter', async () => {
  await withServer(async ({ call, login }) => {
    const manifest = await call('/manifest.webmanifest', { cookies: false });
    assert.equal(manifest.status, 200);
    assert.match(manifest.headers.get('content-type'), /application\/manifest\+json/);
    const m = await manifest.json();
    assert.equal(m.display, 'standalone');
    assert.equal(m.start_url, '/');
    for (const icon of m.icons) {
      const res = await call(icon.src, { cookies: false });
      assert.equal(res.status, 200, icon.src);
      assert.equal(res.headers.get('content-type'), icon.type);
    }
    assert.ok(m.icons.some((i) => i.purpose === 'maskable'));
    assert.equal((await call('/static/icons/apple-touch-icon.png', { cookies: false })).status, 200);

    await login();
    const html = await (await call('/')).text();
    assert.match(html, /<link rel="manifest" href="\/manifest\.webmanifest">/);
    assert.match(html, /<link rel="apple-touch-icon" href="\/static\/icons\/apple-touch-icon\.png">/);
    assert.match(html, /viewport-fit=cover/);
    const href = html.match(/<link rel="stylesheet" href="(\/static\/cockpit\.css\?v=[\w-]{10})">/)[1];
    const pinned = await call(href, { cookies: false });
    assert.match(pinned.headers.get('cache-control'), /immutable/);
    // Ohne oder mit alter Version fragt der Browser jedes Mal nach.
    assert.equal((await call('/static/cockpit.css?v=alt', { cookies: false })).headers.get('cache-control'), 'no-cache');
    assert.match(await (await call('/einstellungen')).text(), new RegExp(href.replace(/[.?]/g, '\\$&')));
  });
});

test('Einstellungen: nur angemeldet, Kalender anlegen, Geheimnisse bleiben verborgen', async () => {
  const calendars = { check: async () => ({}) };
  await withServer(
    async ({ call, login, settings }) => {
      const anon = await call('/einstellungen');
      assert.equal(anon.status, 303);
      assert.equal(anon.headers.get('location'), '/login?next=%2Feinstellungen');
      assert.equal((await call('/einstellungen', { method: 'POST', form: { tz: 'UTC' } })).status, 303);
      assert.equal(settings.stored().tz, null);

      await login();
      const page = await call('/einstellungen');
      assert.equal(page.status, 200);
      const html = await page.text();
      const csrf = csrfFrom(html);
      assert.match(html, /aus der Umgebung \(https:\/\/zunder\.env\)/);
      assert.match(html, /Neuer Kalender/);
      assert.match(html, /name="hiddenEvents" value="Blockiert"/);

      const saved = await call('/einstellungen', {
        method: 'POST',
        form: {
          'cal.0.name': 'Privat', 'cal.0.kind': 'ical', 'cal.0.url': 'webcal://cal.example/geheim-123.ics',
          'cal.1.name': '', 'cal.1.url': '',
          'zunder.url': '', 'zunder.token': '', tz: '', vaultName: 'RNotes', inboxFolder: '00-inbox', hiddenEvents: 'Blockiert, Fokus', csrf,
        },
      });
      assert.equal(saved.status, 303);
      assert.equal(saved.headers.get('location'), '/einstellungen?gespeichert=1');
      const [privat] = settings.stored().calendars;
      assert.equal(privat.url, 'https://cal.example/geheim-123.ics');
      assert.equal(settings.get().inboxFolder, '00-inbox');
      assert.deepEqual(settings.get().hiddenEvents, ['Blockiert', 'Fokus']);

      // Zweiter Kalender mit Passwort, erster unverändert (Adresse leer gelassen).
      await call('/einstellungen', {
        method: 'POST',
        form: {
          'cal.0.id': privat.id, 'cal.0.name': 'Privat', 'cal.0.kind': 'ical', 'cal.0.url': '',
          'cal.1.name': 'Arbeit', 'cal.1.kind': 'caldav', 'cal.1.url': 'https://dav.example/', 'cal.1.username': 'r', 'cal.1.password': 'pw-geheim', 'cal.1.filter': 'Team, Urlaub', csrf,
        },
      });
      const [p2, arbeit] = settings.stored().calendars;
      assert.equal(p2.url, 'https://cal.example/geheim-123.ics');
      assert.deepEqual([arbeit.kind, arbeit.password, arbeit.filter], ['caldav', 'pw-geheim', ['Team', 'Urlaub']]);

      const again = await (await call('/einstellungen?gespeichert=1')).text();
      assert.match(again, /Gespeichert\./);
      assert.ok(!again.includes('geheim-123'));
      assert.ok(!again.includes('pw-geheim'));
      assert.match(again, /https:\/\/cal\.example\/…/);

      // Passwort leer lassen behält es; entfernen löscht den Kalender.
      await call('/einstellungen', {
        method: 'POST',
        form: {
          'cal.0.id': p2.id, 'cal.0.name': 'Privat', 'cal.0.kind': 'ical', 'cal.0.remove': '1',
          'cal.1.id': arbeit.id, 'cal.1.name': 'Arbeit', 'cal.1.kind': 'caldav', 'cal.1.username': 'r', 'cal.1.password': '', csrf,
        },
      });
      assert.deepEqual(settings.stored().calendars.map((c) => [c.name, c.password]), [['Arbeit', 'pw-geheim']]);
    },
    {},
    { calendars },
  );
});

test('Einstellungen: Kalender als kompakte Liste, Felder je Art, Entfernen als Knopf', async () => {
  const calendars = { check: async () => ({}) };
  await withServer(
    async ({ call, login, settings }) => {
      await login();
      const csrf = csrfFrom(await (await call('/einstellungen')).text());
      await call('/einstellungen', {
        method: 'POST',
        form: {
          'cal.0.name': 'Abo', 'cal.0.kind': 'ical', 'cal.0.url': 'https://cal.example/a.ics', 'cal.0.auth': '1', 'cal.0.username': 'u', 'cal.0.password': 'pw',
          'cal.1.name': 'Dav', 'cal.1.kind': 'caldav', 'cal.1.url': 'https://dav.example/', 'cal.1.username': 'r', 'cal.1.password': 'pw2',
          'cal.auth': '1', csrf,
        },
      });
      const [abo, dav] = settings.stored().calendars;
      assert.equal(abo.username, 'u');

      const html = await (await call('/einstellungen')).text();
      // Jeder Kalender ist eine zugeklappte Zeile mit Art und Host, die Felder liegen darunter.
      assert.match(html, /<details class="cal">\s*<summary class="cal-row">\s*<span class="cal-name">Abo<\/span>\s*<span class="cal-meta">iCal-Abo · cal\.example<\/span>/);
      assert.match(html, /<input type="checkbox" name="cal\.0\.auth" value="1" checked>/);
      assert.match(html, /<button type="submit" name="cal\.1\.remove" value="1" class="btn quiet danger">Kalender entfernen<\/button>/);
      // Enter in einem Feld speichert, statt den ersten Entfernen-Knopf auszulösen.
      assert.ok(html.indexOf('class="sr-only" tabindex="-1" aria-hidden="true">Speichern</button>') < html.indexOf('Kalender entfernen'));
      assert.match(html, /<nav class="settings-nav"/);

      // iCal ohne Haken bei „Mit Anmeldung“ verliert Benutzer und Passwort; CalDAV behält sie.
      await call('/einstellungen', {
        method: 'POST',
        form: {
          'cal.0.id': abo.id, 'cal.0.name': 'Abo', 'cal.0.kind': 'ical', 'cal.0.username': 'u',
          'cal.1.id': dav.id, 'cal.1.name': 'Dav', 'cal.1.kind': 'caldav', 'cal.1.username': 'r',
          'cal.auth': '1', csrf,
        },
      });
      assert.deepEqual(settings.stored().calendars.map((c) => [c.name, c.username, c.password]), [['Abo', null, null], ['Dav', 'r', 'pw2']]);

      // „Kalender entfernen“ schickt das Formular mit dem Namen des Knopfs.
      await call('/einstellungen', {
        method: 'POST',
        form: { 'cal.0.id': abo.id, 'cal.0.name': 'Abo', 'cal.0.kind': 'ical', 'cal.0.remove': '1', 'cal.1.id': dav.id, 'cal.1.name': 'Dav', 'cal.1.kind': 'caldav', 'cal.1.username': 'r', 'cal.auth': '1', csrf },
      });
      assert.deepEqual(settings.stored().calendars.map((c) => c.name), ['Dav']);
    },
    {},
    { calendars },
  );
});

test('Einstellungen: Brücke, Mail und Embeddings speichern, Mail-Token bleibt verborgen', async () => {
  await withServer(async ({ call, login, settings, tokens }) => {
    await login();
    const page = await (await call('/einstellungen')).text();
    const csrf = csrfFrom(page);
    for (const name of ['bridge.enabled', 'bridge.tag', 'mail.token', 'mail.senders', 'mail.mailbox', 'mail.doneMailbox', 'mail.pollMinutes', 'embed.url', 'embed.model']) {
      assert.match(page, new RegExp(`name="${name.replace('.', '\\.')}"`), name);
    }
    const form = {
      'bridge.enabled': 'aus', 'bridge.tag': '#todo',
      'mail.token': 'fm-geheim-42', 'mail.senders': 'r@rubeen.dev, @rubeen.email', 'mail.mailbox': '', 'mail.doneMailbox': '', 'mail.pollMinutes': '15',
      'embed.url': 'http://ollama:11434', 'embed.model': '', csrf,
    };
    assert.equal((await call('/einstellungen', { method: 'POST', form })).status, 303);
    const g = settings.get();
    assert.deepEqual(g.bridge, { enabled: false, tag: 'todo' });
    assert.deepEqual([g.mail.token, g.mail.senders, g.mail.mailbox, g.mail.pollMinutes], ['fm-geheim-42', ['r@rubeen.dev', '@rubeen.email'], 'Vault', 15]);
    assert.equal(g.embed.model, 'bge-m3');

    const again = await (await call('/einstellungen')).text();
    assert.ok(!again.includes('fm-geheim-42'));
    assert.match(again, /<option value="aus" selected>/);

    // Token leer lassen behält ihn, „löschen“ entfernt ihn.
    await call('/einstellungen', { method: 'POST', form: { ...form, 'mail.token': '' } });
    assert.equal(settings.stored().mail.token, 'fm-geheim-42');
    await call('/einstellungen', { method: 'POST', form: { ...form, 'mail.token': '', 'mail.clear': '1' } });
    assert.equal(settings.stored().mail.token, null);

    // Capture-Token anlegen.
    const created = await call('/einstellungen/tokens', { method: 'POST', form: { name: 'iPhone', scope: 'capture', csrf } });
    assert.match(await created.text(), /Capture-Token „iPhone“ angelegt/);
    assert.deepEqual(tokens.list().map((t) => t.scope), ['capture']);
    assert.equal((await call('/einstellungen/tokens', { method: 'POST', form: { name: 'x', scope: 'admin', csrf } })).status, 400);
  });
});

test('Einstellungen: Fehler zeigt die Meldung, fremde Herkunft wird abgewiesen', async () => {
  await withServer(async ({ call, login, settings }) => {
    await login();
    const csrf = csrfFrom(await (await call('/einstellungen')).text());
    const bad = await call('/einstellungen', { method: 'POST', form: { tz: 'Mars/Olympus', csrf } });
    assert.equal(bad.status, 400);
    assert.match(await bad.text(), /Unbekannte Zeitzone/);
    const foreign = await call('/einstellungen', { method: 'POST', form: { tz: 'UTC', csrf }, origin: 'https://evil.test' });
    assert.equal(foreign.status, 403);
    // Ohne oder mit falschem CSRF-Token wird nichts gespeichert.
    const noToken = await call('/einstellungen', { method: 'POST', form: { tz: 'UTC' } });
    assert.equal(noToken.status, 403);
    assert.match(await noToken.text(), /veraltet/);
    assert.equal((await call('/einstellungen', { method: 'POST', form: { tz: 'UTC', csrf: `${csrf.slice(0, -1)}x` } })).status, 403);
    assert.equal(settings.stored().tz, null);
    const same = await call('/einstellungen', { method: 'POST', form: { tz: 'UTC', csrf }, origin: 'https://vault.test' });
    assert.equal(same.status, 303);
    assert.equal(settings.get().tz, 'UTC');
  });
});

test('API-Tokens: anlegen zeigt den Klartext einmal, widerrufen, nur angemeldet und von dieser Seite', async () => {
  await withServer(async ({ call, login, settings, tokens }) => {
    const anon = await call('/einstellungen/tokens', { method: 'POST', form: { name: 'Raycast' } });
    assert.equal(anon.status, 303);
    assert.equal(anon.headers.get('location'), '/login?next=%2Feinstellungen');
    assert.equal(tokens.list().length, 0);

    await login();
    const first = await (await call('/einstellungen')).text();
    assert.match(first, /Noch keine Tokens/);
    const csrf = csrfFrom(first);
    const foreign = await call('/einstellungen/tokens', { method: 'POST', form: { name: 'Raycast', csrf }, origin: 'https://evil.test' });
    assert.equal(foreign.status, 403);
    assert.equal((await call('/einstellungen/tokens', { method: 'POST', form: { name: 'Raycast' } })).status, 403);
    assert.equal((await call('/einstellungen/tokens', { method: 'POST', form: { name: '', csrf } })).status, 400);
    assert.equal(tokens.list().length, 0);

    const created = await call('/einstellungen/tokens', { method: 'POST', form: { name: 'Raycast', csrf }, origin: 'https://vault.test' });
    assert.equal(created.status, 200);
    const html = await created.text();
    const plain = html.match(/<code>(vct_[\w-]+)<\/code>/)[1];
    assert.match(html, /nicht noch einmal angezeigt/);
    assert.ok(tokens.verify(plain));

    // Speichern der übrigen Einstellungen lässt die Tokens stehen.
    await call('/einstellungen', { method: 'POST', form: { tz: 'UTC', csrf } });
    assert.equal(settings.get().tz, 'UTC');
    const page = await (await call('/einstellungen')).text();
    assert.ok(!page.includes(plain));
    assert.match(page, /Raycast/);

    const [{ id }] = tokens.list();
    assert.equal((await call('/einstellungen/tokens/widerrufen', { method: 'POST', form: { id } })).status, 403);
    assert.equal(tokens.list().length, 1);
    const revoked = await call('/einstellungen/tokens/widerrufen', { method: 'POST', form: { id, csrf } });
    assert.equal(revoked.headers.get('location'), '/einstellungen?widerrufen=1');
    assert.equal(tokens.list().length, 0);
    assert.ok(!tokens.verify(plain));
    assert.equal((await call('/einstellungen/tokens')).headers.get('location'), '/einstellungen');
  });
});

test('Suche und Graph: nur mit Sitzung, Treffer verlinken auf den Graphen, JSON unter /api/graph', async () => {
  await withServer(async ({ call, login }) => {
    assert.equal((await call('/graph?q=hund')).status, 303);
    assert.equal((await call('/api/graph?pfad=wiki/a.md')).status, 401);
    await login('/graph');

    const found = await call('/graph?q=hund');
    assert.equal(found.status, 200);
    const html = await found.text();
    assert.match(html, /href="\/graph\?pfad=wiki%2Fa\.md"/);
    assert.match(html, /Volltext \+ Bedeutung/);

    const g = await call('/graph?pfad=wiki%2Fa.md');
    assert.equal(g.status, 200);
    assert.match(await g.text(), /class="edge semantic"/);
    assert.equal((await call('/graph?pfad=nix.md')).status, 404);

    const api = await call('/api/graph?pfad=wiki%2Fa.md');
    assert.equal((await api.json()).edges[0].kind, 'semantic');
    assert.equal((await call('/api/graph?pfad=nix.md')).status, 404);

    const css = await (await call('/static/cockpit.css')).text();
    assert.match(css, /\.graph \.edge\.semantic/);
  });
});

/** Aktions-Attrappe: merkt sich Aufrufe, `fail` lässt den nächsten scheitern. */
function fakeActions() {
  const calls = [];
  let fail = null;
  return {
    calls,
    failNext: (err) => (fail = err),
    async setStatus(id, status) {
      calls.push(['status', id, status]);
      if (fail) {
        const e = fail;
        fail = null;
        throw e;
      }
      return { id, ref: 'VCP-1', title: 'Steuer', status };
    },
    async setDue(id, due) {
      calls.push(['due', id, due]);
      if (fail) {
        const e = fail;
        fail = null;
        throw e;
      }
      return { id, ref: 'VCP-1', title: 'Steuer', status: 'open', due: due === 'keine' ? null : due === 'morgen' ? '2026-10-15' : due };
    },
    async move(id, ziel) {
      calls.push(['move', id, ziel]);
      const location = ziel === 'inbox' ? { kind: 'inbox' } : { kind: 'project', id: 'p1', name: 'Vault Cockpit', area_name: 'Programmieren' };
      return { id, ref: null, title: 'Zahnarzt', status: 'open', location };
    },
    async setPhoenix(id, fire) {
      calls.push(['phoenix', id, fire]);
      return { id, ref: null, title: 'Zahnarzt', status: 'open', phoenix: fire ? { role: 'feuer_schritt', fire } : null };
    },
    async flame(id, on) {
      calls.push(['flame', id, on]);
      return on
        ? { id, ref: 'VCP-1', title: 'Steuer', status: 'in_progress', running: true, startedAt: '2026-10-14T07:00:00Z', endedAt: null, timing: true }
        : { id, ref: 'VCP-1', title: 'Steuer', status: 'in_progress', running: false, startedAt: '2026-10-14T07:00:00Z', endedAt: '2026-10-14T07:42:00Z', timing: false };
    },
    async capture({ text, captureId }) {
      calls.push(['capture', text, captureId]);
      if (fail) {
        const e = fail;
        fail = null;
        throw e;
      }
      return text.startsWith('!') ? { kind: 'task', id: 'z9', ref: 'ZUN-9', url: 'https://zunder.test/#/aufgabe/z9' } : { kind: 'note', path: 'inbox/2026-10-14 0900 - Idee.md' };
    },
  };
}

const csrfFrom = (html) => html.match(/name="csrf" value="([^"]+)"/)[1];

test('Wochenseite: Abhaken-Formulare, Schnelleingabe und Script nur mit Aktionen', async () => {
  await withServer(async ({ call, login }) => {
    await login();
    const html = await (await call('/')).text();
    assert.ok(!html.includes('/static/cockpit.js'));
    assert.ok(!html.includes('/aktion/'));
  });
  await withServer(
    async ({ call, login }) => {
      await login();
      const res = await call('/?woche=2026-W42');
      assert.match(res.headers.get('content-security-policy'), /script-src 'self'; style-src 'self'; connect-src 'self'/);
      const html = await res.text();
      assert.match(html, /<script src="\/static\/cockpit\.js\?v=[\w-]{10}" defer><\/script>/);
      assert.match(html, /action="\/aktion\/status" class="tick"/);
      assert.match(html, /aria-label="Abhaken: Steuer &lt;abgeben&gt;"/);
      assert.match(html, /name="back" value="\/\?woche=2026-W42"/);
      assert.match(html, /action="\/aktion\/erfassen" class="capture"/);
      assert.match(html, /name="cid" value="[0-9a-f-]{36}"/);
      assert.match(html, /data-list="vault-inbox" hidden/);

      const js = await call('/static/cockpit.js', { cookies: false });
      assert.equal(js.status, 200);
      assert.match(js.headers.get('content-type'), /text\/javascript/);
      assert.match(await js.text(), /Rückgängig/);
    },
    {},
    { actions: fakeActions() },
  );
});

test('Aktionen: nur angemeldet, mit CSRF-Token und von dieser Seite', async () => {
  const actions = fakeActions();
  await withServer(
    async ({ call, login }) => {
      const anon = await call('/aktion/status', { method: 'POST', form: { id: 't1', status: 'done' } });
      assert.equal(anon.status, 303);
      assert.equal(anon.headers.get('location'), '/login');
      const anonJson = await call('/aktion/erfassen', { method: 'POST', form: { text: 'x' }, accept: 'application/json' });
      assert.equal(anonJson.status, 401);
      assert.equal((await call('/aktion/status')).status, 405);

      await login();
      const csrf = csrfFrom(await (await call('/')).text());
      const noToken = await call('/aktion/status', { method: 'POST', form: { id: 't1', status: 'done' }, accept: 'application/json' });
      assert.equal(noToken.status, 403);
      assert.equal((await noToken.json()).error, 'csrf');
      const wrong = await call('/aktion/status', { method: 'POST', form: { id: 't1', status: 'done', csrf: `${csrf.slice(0, -1)}x` } });
      assert.equal(wrong.status, 403);
      const foreign = await call('/aktion/status', { method: 'POST', form: { id: 't1', status: 'done', csrf }, origin: 'https://evil.test' });
      assert.equal(foreign.status, 403);
      assert.equal(actions.calls.length, 0);

      // Neue Sitzung, neues Token: das alte gilt nicht mehr.
      await login();
      assert.equal((await call('/aktion/status', { method: 'POST', form: { id: 't1', status: 'done', csrf } })).status, 403);
      assert.equal(actions.calls.length, 0);
    },
    {},
    { actions },
  );
});

test('Abhaken mit JavaScript: JSON mit Meldung und Rückgängig', async () => {
  const actions = fakeActions();
  await withServer(
    async ({ call, login }) => {
      await login();
      const csrf = csrfFrom(await (await call('/')).text());
      const res = await call('/aktion/status', { method: 'POST', form: { id: 't1', status: 'done', prev: 'in_progress', csrf }, accept: 'application/json', origin: 'https://vault.test' });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.message, 'Erledigt: VCP-1 Steuer');
      assert.deepEqual(body.undo, { action: '/aktion/status', fields: { id: 't1', status: 'in_progress' } });
      assert.deepEqual(actions.calls, [['status', 't1', 'done']]);

      actions.failNext(new ActionError('Zunder antwortet mit HTTP 500', 502));
      const failed = await call('/aktion/status', { method: 'POST', form: { id: 't1', status: 'done', csrf }, accept: 'application/json' });
      assert.equal(failed.status, 502);
      assert.equal((await failed.json()).message, 'Zunder antwortet mit HTTP 500');
    },
    {},
    { actions },
  );
});

test('Abhaken ohne JavaScript: Weiterleitung zurück, Meldung mit Rückgängig erscheint einmal', async () => {
  const actions = fakeActions();
  await withServer(
    async ({ call, login }) => {
      await login();
      const csrf = csrfFrom(await (await call('/')).text());
      const res = await call('/aktion/status', { method: 'POST', form: { id: 't1', status: 'done', prev: 'open', csrf, back: '/?woche=2026-W42' } });
      assert.equal(res.status, 303);
      assert.equal(res.headers.get('location'), '/?woche=2026-W42');
      const html = await (await call('/?woche=2026-W42')).text();
      assert.match(html, /class="toast ok"[^>]*><span class="toast-text">Erledigt: VCP-1 Steuer/);
      assert.match(html, /<form method="post" action="\/aktion\/status" class="act">[^]*?name="status" value="open"><button type="submit" class="toast-action">Rückgängig/);
      assert.ok(!(await (await call('/')).text()).includes('toast-text'));

      // Kein offener Redirect über back.
      const evil = await call('/aktion/status', { method: 'POST', form: { id: 't1', status: 'done', csrf, back: '//evil.test' } });
      assert.equal(evil.headers.get('location'), '/');
    },
    {},
    { actions },
  );
});

test('Schnelleingabe: Notiz und Aufgabe; ohne JavaScript bleibt der Text bei Fehlern erhalten', async () => {
  const actions = fakeActions();
  await withServer(
    async ({ call, login }) => {
      await login();
      const html = await (await call('/')).text();
      const csrf = csrfFrom(html);
      const cid = html.match(/name="cid" value="([^"]+)"/)[1];

      const note = await call('/aktion/erfassen', { method: 'POST', form: { text: 'Idee', cid, csrf }, accept: 'application/json' });
      assert.equal((await note.json()).message, 'Notiz angelegt: inbox/2026-10-14 0900 - Idee.md');
      assert.deepEqual(actions.calls[0], ['capture', 'Idee', cid]);
      const task = await call('/aktion/erfassen', { method: 'POST', form: { text: '! Steuer', csrf }, accept: 'application/json' });
      const body = await task.json();
      assert.equal(body.message, 'Aufgabe angelegt: ZUN-9 liegt in der Zunder-Inbox');
      assert.equal(body.result.url, 'https://zunder.test/#/aufgabe/z9');

      actions.failNext(new ActionError('Für Aufgaben mit ! fehlt der Zunder-Zugang (Einstellungen → Zunder)', 503));
      const failed = await call('/aktion/erfassen', { method: 'POST', form: { text: '! Wichtig <b>', csrf, back: '/' } });
      assert.equal(failed.status, 503);
      const page = await failed.text();
      assert.match(page, /class="toast error"/);
      assert.match(page, /fehlt der Zunder-Zugang/);
      assert.match(page, /<textarea[^>]*>! Wichtig &lt;b&gt;<\/textarea>/);
      assert.match(page, /data-mode="task"/);
    },
    {},
    { actions },
  );
});

test('Menü an Aufgaben: Status und Fälligkeit als Formulare', async () => {
  await withServer(
    async ({ call, login }) => {
      await login();
      const html = await (await call('/')).text();
      assert.match(html, /<details class="menu">\s*<summary class="menu-button" aria-label="Mehr zu: Steuer &lt;abgeben&gt;"/);
      assert.match(html, /action="\/aktion\/status" class="act">[^]*?name="prev" value="open"[^]*?value="in_progress" class="chip">In Arbeit[^]*?value="open" class="chip" aria-current="true" disabled>Offen/);
      assert.match(html, /action="\/aktion\/faellig" class="act">[^]*?name="id" value="t1"[^]*?name="prev" value=""[^]*?type="date" name="date"[^]*?value="naechste-woche" class="chip">Nächste Woche/);
    },
    {},
    { actions: fakeActions() },
  );
});

test('Fälligkeit verschieben: JSON mit Rückgängig, ohne JavaScript per Weiterleitung', async () => {
  const actions = fakeActions();
  await withServer(
    async ({ call, login }) => {
      await login();
      const csrf = csrfFrom(await (await call('/')).text());
      const res = await call('/aktion/faellig', { method: 'POST', form: { id: 't1', due: 'morgen', prev: '2026-10-01', csrf }, accept: 'application/json' });
      const body = await res.json();
      assert.equal(body.message, 'Fällig Do 15.10.: VCP-1 Steuer');
      assert.deepEqual(body.undo, { action: '/aktion/faellig', fields: { id: 't1', due: '2026-10-01' } });

      // Datum aus dem Feld; vorher ohne Fälligkeit → Rückgängig entfernt sie wieder.
      const picked = await (await call('/aktion/faellig', { method: 'POST', form: { id: 't1', due: 'datum', date: '2026-11-03', prev: '', csrf }, accept: 'application/json' })).json();
      assert.deepEqual(picked.undo, { action: '/aktion/faellig', fields: { id: 't1', due: 'keine' } });
      const cleared = await (await call('/aktion/faellig', { method: 'POST', form: { id: 't1', due: 'keine', prev: '2026-11-03', csrf }, accept: 'application/json' })).json();
      assert.equal(cleared.message, 'Ohne Fälligkeit: VCP-1 Steuer');
      assert.deepEqual(actions.calls, [['due', 't1', 'morgen'], ['due', 't1', '2026-11-03'], ['due', 't1', 'keine']]);

      const plain = await call('/aktion/faellig', { method: 'POST', form: { id: 't1', due: 'morgen', prev: '', csrf, back: '/' } });
      assert.equal(plain.status, 303);
      const page = await (await call('/')).text();
      assert.match(page, /Fällig Do 15\.10\.: VCP-1 Steuer/);
      assert.match(page, /action="\/aktion\/faellig" class="act">[^]*?name="due" value="keine"><button type="submit" class="toast-action">Rückgängig/);

      actions.failNext(new ActionError('„x“ ist kein Datum', 400));
      const bad = await call('/aktion/faellig', { method: 'POST', form: { id: 't1', due: 'x', csrf }, accept: 'application/json' });
      assert.equal(bad.status, 400);
      assert.equal((await bad.json()).message, '„x“ ist kein Datum');

      const noCsrf = await call('/aktion/faellig', { method: 'POST', form: { id: 't1', due: 'morgen' }, accept: 'application/json' });
      assert.equal(noCsrf.status, 403);
    },
    {},
    { actions },
  );
});

test('Zunder-Inbox: Zuordnen, Phönix-Schritt und Verwerfen im Menü', async () => {
  await withServer(
    async ({ call, login }) => {
      await login();
      const html = await (await call('/')).text();
      const inbox = html.slice(html.indexOf('data-list="zunder-inbox"'));
      assert.match(inbox, /action="\/aktion\/zuordnen" class="act">[^]*?name="id" value="z1"[^]*?name="prev" value="inbox"/);
      assert.match(inbox, /<optgroup label="Gesundheit"><option value="area:a1">Gesundheit<\/option><option value="project:p1">Gesundheit \/ Zähne &amp; Co<\/option>/);
      assert.match(inbox, /<option value="loose">/);
      assert.match(inbox, /name="status" value="dropped" class="chip danger">Verwerfen/);
      assert.match(inbox, /action="\/aktion\/phoenix" class="act">[^]*?name="fire" value="2026-W42" class="chip">Schritt für KW 42/);
      // Big Rocks (nicht Inbox) haben kein Zuordnen und kein Verwerfen.
      const rocks = html.slice(0, html.indexOf('data-list="zunder-inbox"'));
      assert.ok(!rocks.includes('/aktion/zuordnen'));
      assert.ok(!rocks.includes('Verwerfen'));
    },
    {},
    { actions: fakeActions() },
  );
});

test('Zuordnen und Phönix: Meldung mit Rückgängig', async () => {
  const actions = fakeActions();
  await withServer(
    async ({ call, login }) => {
      await login();
      const csrf = csrfFrom(await (await call('/')).text());
      const moved = await (await call('/aktion/zuordnen', { method: 'POST', form: { id: 'z1', ziel: 'project:p1', prev: 'inbox', csrf }, accept: 'application/json' })).json();
      assert.equal(moved.message, 'Programmieren / Vault Cockpit: Zahnarzt');
      assert.deepEqual(moved.undo, { action: '/aktion/zuordnen', fields: { id: 'z1', ziel: 'inbox' } });
      const back = await (await call('/aktion/zuordnen', { method: 'POST', form: { id: 'z1', ziel: 'inbox', csrf }, accept: 'application/json' })).json();
      assert.equal(back.message, 'Inbox: Zahnarzt');
      assert.equal(back.undo, null);

      const step = await (await call('/aktion/phoenix', { method: 'POST', form: { id: 'z1', fire: '2026-W42', prev: '', csrf }, accept: 'application/json' })).json();
      assert.equal(step.message, 'Phönix-Schritt KW 42: Zahnarzt');
      assert.deepEqual(step.undo, { action: '/aktion/phoenix', fields: { id: 'z1', fire: '' } });
      const none = await (await call('/aktion/phoenix', { method: 'POST', form: { id: 'z1', fire: '', prev: '2026-W42', csrf }, accept: 'application/json' })).json();
      assert.equal(none.message, 'Kein Phönix-Schritt mehr: Zahnarzt');

      const dropped = await (await call('/aktion/status', { method: 'POST', form: { id: 'z1', status: 'dropped', prev: 'open', csrf }, accept: 'application/json' })).json();
      assert.equal(dropped.message, 'Verworfen: VCP-1 Steuer');
      assert.deepEqual(dropped.undo, { action: '/aktion/status', fields: { id: 'z1', status: 'open' } });
    },
    {},
    { actions },
  );
});

test('Flammen: Knopf an Big Rocks, Leiste mit Timer und Stopp, Meldungen', async () => {
  const actions = fakeActions();
  await withServer(
    async ({ call, login }) => {
      await login();
      const html = await (await call('/')).text();
      assert.match(html, /action="\/aktion\/flamme" class="act flame-form">[^]*?name="id" value="t1"[^]*?name="an" value="1"[^]*?aria-label="Flamme starten: Steuer &lt;abgeben&gt;"/);
      assert.ok(!html.includes('class="burning"'));
      const burning = await (await call('/?woche=brennt')).text();
      assert.match(burning, /<div class="burning" role="status">[^]*?Flamme läuft: <a href="https:\/\/zunder\.test\/#\/aufgabe\/f9">Deep Work<\/a>[^]*?data-since="2026-10-14T07:00:00Z">seit 09:00<[^]*?name="an" value="0"/);

      const csrf = csrfFrom(html);
      const on = await (await call('/aktion/flamme', { method: 'POST', form: { id: 't1', an: '1', csrf }, accept: 'application/json' })).json();
      assert.equal(on.message, 'Flamme läuft: VCP-1 Steuer · Timing misst mit');
      const off = await (await call('/aktion/flamme', { method: 'POST', form: { id: 't1', an: '0', csrf }, accept: 'application/json' })).json();
      assert.equal(off.message, 'Flamme gestoppt: VCP-1 Steuer · 42 min');
      assert.deepEqual(actions.calls, [['flame', 't1', true], ['flame', 't1', false]]);
    },
    {},
    { actions },
  );
});

/** Notiz-Attrappe für die Notizseite. */
function fakeNotes() {
  const calls = [];
  const note = { path: '00-inbox/Idee.md', folder: '00-inbox', title: 'Idee <Hund>', frontmatter: { source: 'cockpit' }, tags: ['alt'], body: '- [ ] Preise\n- [x] Termin\n', inInbox: true };
  return {
    calls,
    get: (p) => (p === note.path ? note : null),
    targets: () => ['10-projekte/Hund', '40-archiv'],
    archiveFolder: () => '40-archiv',
    move(p, folder) {
      calls.push(['move', p, folder]);
      if (folder === 'privat') throw new ActionError('„privat“ ist vertraulich oder ausgeschlossen; dorthin legt das Cockpit nichts ab', 403);
      return { path: `${folder}/Idee.md`, from: p, changed: true };
    },
    setTags(p, raw) {
      calls.push(['tags', p, raw]);
      return { path: p, tags: raw.split(',').map((t) => t.trim()).filter(Boolean) };
    },
    append(p, text) {
      calls.push(['append', p, text]);
      if (text === 'kaputt') throw new ActionError('„00-inbox/Idee.md“ wurde gerade anderweitig geändert.', 400);
      return { path: p };
    },
    setFeuer(p, field, text) {
      calls.push(['feuer', p, field, text]);
      return { path: p, changed: true, previous: 'Altes Ziel', heading: field === 'ziel' ? 'Feuer-Ziel' : 'Erster Zug' };
    },
    link(p, target) {
      calls.push(['link', p, target]);
      if (target === 'privat/geheim.md') throw new ActionError('Das Ziel gibt es nicht oder das Cockpit darf es nicht verlinken', 404);
      return { path: p, target, title: 'B', changed: target !== 'wiki/c.md' };
    },
    createFeuer(week, goal, firstMove) {
      calls.push(['feuer-anlegen', week, goal, firstMove]);
      if (week === '2026-W42' && goal === 'doppelt') throw new ActionError('Für diese Woche gibt es schon „Feuer W3 - 2026-Q4“', 409);
      return { path: 'feuer/Feuer W3 - 2026-Q4.md', title: 'Feuer W3 - 2026-Q4', week };
    },
    toggle(p, n, line, done) {
      calls.push(['toggle', p, n, line, done]);
      return { path: p, line: done ? '- [x] Preise' : '- [ ] Preise' };
    },
  };
}

test('Notizseite: Vorschau mit Checkbox-Knöpfen und Verarbeiten; unbekannte Notiz 404', async () => {
  const notes = fakeNotes();
  await withServer(
    async ({ call, login }) => {
      assert.equal((await call('/notiz?pfad=00-inbox%2FIdee.md')).status, 303);
      await login();
      const res = await call('/notiz?pfad=00-inbox%2FIdee.md');
      assert.equal(res.status, 200);
      const html = await res.text();
      assert.match(html, /<h1>Idee &lt;Hund&gt;<\/h1>/);
      assert.match(html, /action="\/aktion\/notiz\/checkbox" class="act box-form">[^]*?name="n" value="0"[^]*?name="line" value="- \[ \] Preise"[^]*?name="erledigt" value="1"/);
      assert.match(html, /<option value="10-projekte\/Hund">/);
      assert.match(html, /name="ordner" value="40-archiv"[^]*?Ins Archiv/);
      assert.match(html, /name="tags" value="alt"/);
      assert.equal((await call('/notiz?pfad=privat%2Fgeheim.md')).status, 404);

      // Die Wochenansicht verlinkt Inbox-Notizen auf die Vorschau.
      assert.ok((await (await call('/')).text()).includes('/static/cockpit.js'));
    },
    {},
    { actions: fakeActions(), notes },
  );
});

test('Notiz ablegen: JSON führt zur neuen Adresse, Meldung kommt per Cookie mit; Fehler bleiben auf der Seite', async () => {
  const notes = fakeNotes();
  await withServer(
    async ({ call, login }) => {
      await login();
      const csrf = csrfFrom(await (await call('/notiz?pfad=00-inbox%2FIdee.md')).text());
      const back = '/notiz?pfad=00-inbox%2FIdee.md';
      const res = await call('/aktion/notiz/ablegen', { method: 'POST', form: { pfad: '00-inbox/Idee.md', ordner: '40-archiv', back, csrf }, accept: 'application/json' });
      const body = await res.json();
      assert.equal(body.message, 'Abgelegt in 40-archiv/');
      assert.equal(body.redirect, '/notiz?pfad=40-archiv%2FIdee.md');
      assert.deepEqual(body.undo, { action: '/aktion/notiz/ablegen', fields: { pfad: '40-archiv/Idee.md', ordner: '00-inbox', back } });
      assert.match(res.headers.get('set-cookie'), /vc_flash=/);

      // Ohne JavaScript: Weiterleitung zur neuen Adresse.
      const plain = await call('/aktion/notiz/ablegen', { method: 'POST', form: { pfad: '00-inbox/Idee.md', ordner: '10-projekte/Hund', back, csrf } });
      assert.equal(plain.headers.get('location'), '/notiz?pfad=10-projekte%2FHund%2FIdee.md');
      // Aus der Woche abgelegt: zurück zur Woche.
      const fromWeek = await call('/aktion/notiz/ablegen', { method: 'POST', form: { pfad: '00-inbox/Idee.md', ordner: '40-archiv', back: '/', csrf } });
      assert.equal(fromWeek.headers.get('location'), '/');

      const denied = await call('/aktion/notiz/ablegen', { method: 'POST', form: { pfad: '00-inbox/Idee.md', ordner: 'privat', csrf }, accept: 'application/json' });
      assert.equal(denied.status, 403);

      const tags = await (await call('/aktion/notiz/tags', { method: 'POST', form: { pfad: '00-inbox/Idee.md', tags: 'hund, idee', csrf }, accept: 'application/json' })).json();
      assert.equal(tags.message, 'Tags: #hund #idee');
      const box = await (await call('/aktion/notiz/checkbox', { method: 'POST', form: { pfad: '00-inbox/Idee.md', n: '0', line: '- [ ] Preise', erledigt: '1', csrf }, accept: 'application/json' })).json();
      assert.equal(box.message, 'Abgehakt');
      assert.deepEqual(box.undo.fields, { pfad: '00-inbox/Idee.md', n: '0', line: '- [x] Preise', erledigt: '0' });

      // Anhängen scheitert ohne JavaScript: Notizseite mit Fehler, Text bleibt im Feld.
      const failed = await call('/aktion/notiz/anhaengen', { method: 'POST', form: { pfad: '00-inbox/Idee.md', text: 'kaputt', back, csrf } });
      assert.equal(failed.status, 400);
      const page = await failed.text();
      assert.match(page, /<h1>Idee &lt;Hund&gt;<\/h1>/);
      assert.match(page, /anderweitig geändert/);
      assert.match(page, /<textarea name="text"[^>]*>kaputt<\/textarea>/);
    },
    {},
    { actions: fakeActions(), notes },
  );
});

test('Feuer-Ziel bearbeiten: Formular an der Feuer-Notiz, Speichern mit Rückgängig', async () => {
  const notes = fakeNotes();
  await withServer(
    async ({ call, login }) => {
      await login();
      const html = await (await call('/?woche=feuer')).text();
      assert.match(html, /<details class="inline-edit">[^]*?action="\/aktion\/feuer" class="act">[^]*?name="pfad" value="feuer\/KW42\.md"[^]*?name="feld" value="ziel"[^]*?<textarea name="text"[^>]*>Ziel &lt;b&gt;<\/textarea>/);
      assert.match(html, /name="feld" value="zug"/);
      const csrf = csrfFrom(html);
      const r = await (await call('/aktion/feuer', { method: 'POST', form: { pfad: 'feuer/KW42.md', feld: 'ziel', text: 'Neu', csrf }, accept: 'application/json' })).json();
      assert.equal(r.message, 'Feuer-Ziel gespeichert');
      assert.deepEqual(r.undo, { action: '/aktion/feuer', fields: { pfad: 'feuer/KW42.md', feld: 'ziel', text: 'Altes Ziel' } });
      assert.deepEqual(notes.calls, [['feuer', 'feuer/KW42.md', 'ziel', 'Neu']]);
    },
    {},
    { actions: fakeActions(), notes },
  );
  // Ohne Notiz-Schreibtisch kein Bearbeiten.
  await withServer(
    async ({ call, login }) => {
      await login();
      assert.ok(!(await (await call('/?woche=feuer')).text()).includes('/aktion/feuer'));
    },
    {},
    { actions: fakeActions() },
  );
});

test('Interaktiver Graph: Skripte ausgeliefert, Live-Suche als JSON, Verlinken mit und ohne JavaScript', async () => {
  const notes = fakeNotes();
  await withServer(
    async ({ call, login }) => {
      assert.equal((await call('/api/suche?q=hund')).status, 401);
      await login('/graph');

      const lib = await call('/static/vendor/graph-lib.js');
      assert.equal(lib.status, 200);
      assert.match(lib.headers.get('content-type'), /text\/javascript/);
      assert.match(await lib.text(), /var GraphLib=/);
      const js = await call('/static/graph.js');
      assert.equal(js.status, 200);
      assert.match(await js.text(), /\/api\/suche/);

      const found = await (await call('/api/suche?q=hund')).json();
      assert.deepEqual(found.results, [{ path: 'wiki/a.md', title: 'A', snippet: 'zu hund', streams: ['text', 'semantic'] }]);
      assert.deepEqual((await (await call('/api/suche?q=')).json()).results, []);

      const page = await call('/graph?pfad=wiki%2Fa.md');
      assert.match(page.headers.get('content-security-policy'), /script-src 'self';/);
      const html = await page.text();
      // Mit Versions-Parameter, damit nach einem Deploy keine alte Fassung aus dem Cache kommt.
      const libSrc = html.match(/<script src="(\/static\/vendor\/graph-lib\.js\?v=[\w-]+)" defer><\/script>/)?.[1];
      assert.ok(libSrc, 'graph-lib.js mit Version');
      assert.match((await call(libSrc)).headers.get('cache-control'), /immutable/);
      assert.match(html, /data-center="wiki\/a\.md" data-notes="1" data-csrf="/);
      assert.match(html, /action="\/aktion\/verlinken" class="link-similar">[^]*?name="pfad" value="wiki\/a\.md"[^]*?name="ziel" value="wiki\/b\.md"/);
      const csrf = csrfFrom(html);
      const back = '/graph?pfad=wiki%2Fa.md';

      const linked = await (await call('/aktion/verlinken', { method: 'POST', form: { pfad: 'wiki/a.md', ziel: 'wiki/b.md', csrf, back }, accept: 'application/json' })).json();
      assert.equal(linked.message, 'Verlinkt: B');
      assert.equal(linked.target, 'wiki/b.md');
      const again = await (await call('/aktion/verlinken', { method: 'POST', form: { pfad: 'wiki/a.md', ziel: 'wiki/c.md', csrf }, accept: 'application/json' })).json();
      assert.equal(again.message, 'Schon verlinkt: B');

      // Ohne JavaScript: zurück zum Graphen, Meldung per Cookie; auch bei Fehlern.
      const plain = await call('/aktion/verlinken', { method: 'POST', form: { pfad: 'wiki/a.md', ziel: 'wiki/b.md', csrf, back } });
      assert.equal(plain.status, 303);
      assert.equal(plain.headers.get('location'), back);
      const denied = await call('/aktion/verlinken', { method: 'POST', form: { pfad: 'wiki/a.md', ziel: 'privat/geheim.md', csrf, back } });
      assert.equal(denied.status, 303);
      assert.equal(denied.headers.get('location'), back);
      assert.match(denied.headers.get('set-cookie'), /vc_flash=/);

      assert.equal((await call('/aktion/verlinken', { method: 'POST', form: { pfad: 'wiki/a.md', ziel: 'wiki/b.md', csrf: 'falsch' }, accept: 'application/json' })).status, 403);
      assert.deepEqual(notes.calls.map((c) => c[2]), ['wiki/b.md', 'wiki/c.md', 'wiki/b.md', 'privat/geheim.md']);
    },
    {},
    { actions: fakeActions(), notes },
  );
  // Ohne Notiz-Schreibtisch keine Verlinken-Knöpfe, der Graph bleibt interaktiv.
  await withServer(async ({ call, login }) => {
    await login('/graph');
    const html = await (await call('/graph?pfad=wiki%2Fa.md')).text();
    assert.ok(!html.includes('/aktion/verlinken'));
    assert.match(html, /<script src="\/static\/graph\.js\?v=[\w-]+" defer>/);
  });
});

test('Feuer anlegen: Formular nur ohne Feuer-Notiz und nicht für vergangene Wochen', async () => {
  const notes = fakeNotes();
  await withServer(
    async ({ call, login }) => {
      await login();
      const html = await (await call('/')).text();
      assert.match(html, /<details class="inline-edit feuer-create">[^]*?action="\/aktion\/feuer\/anlegen" class="act">[^]*?name="woche" value="2026-W42"[^]*?<textarea name="ziel"[^>]*required[^]*?<textarea name="zug"/);
      assert.ok(!(await (await call('/?woche=feuer')).text()).includes('/aktion/feuer/anlegen'), 'Notiz da: kein Anlegen');
      assert.ok(!(await (await call('/?woche=vorbei')).text()).includes('/aktion/feuer/anlegen'), 'vergangene Woche: kein Anlegen');

      const csrf = csrfFrom(html);
      const r = await (await call('/aktion/feuer/anlegen', { method: 'POST', form: { woche: '2026-W42', ziel: 'Cockpit fertig', zug: 'Menü zuerst', csrf }, accept: 'application/json' })).json();
      assert.equal(r.message, 'Feuer W3 - 2026-Q4 angelegt');
      assert.equal(r.undo, undefined);
      const twice = await call('/aktion/feuer/anlegen', { method: 'POST', form: { woche: '2026-W42', ziel: 'doppelt', csrf }, accept: 'application/json' });
      assert.equal(twice.status, 409);
      assert.deepEqual(notes.calls, [['feuer-anlegen', '2026-W42', 'Cockpit fertig', 'Menü zuerst'], ['feuer-anlegen', '2026-W42', 'doppelt', null]]);
      const noCsrf = await call('/aktion/feuer/anlegen', { method: 'POST', form: { woche: '2026-W42', ziel: 'x' }, accept: 'application/json' });
      assert.equal(noCsrf.status, 403);
    },
    {},
    { actions: fakeActions(), notes },
  );
});

test('Rückblick: Kennzahlen, Balken als SVG ohne Inline-Styles, Navigation', async () => {
  await withServer(async ({ call, login }) => {
    assert.equal((await call('/rueckblick')).status, 303);
    await login();
    const html = await (await call('/rueckblick?woche=2026-W42')).text();
    assert.match(html, /<span class="stat-value">3<span class="stat-of">\/4<\/span>/);
    assert.match(html, /geplant erledigt · 75 %/);
    assert.match(html, /1 h 35 min/);
    assert.match(html, /Finanzen &lt;A&gt;/);
    assert.match(html, /<rect class="fill" width="75" height="8"\/>/);
    assert.ok(!html.includes('style='));
    assert.match(html, /href="\/rueckblick\?woche=2026-W43"/);
    assert.match(html, /1 offen geblieben/);
    assert.equal((await call('/rueckblick?woche=kaputt')).status, 400);
    assert.match(await (await call('/')).text(), /href="\/rueckblick\?woche=2026-W42" class="nav-link"/);
  });
});

test('Kurzbefehle: in den Einstellungen verlinkt, nur angemeldet zu laden', async () => {
  const shortcuts = loadShortcuts();
  assert.deepEqual(shortcuts.map((s) => s.slug), ['notiz', 'sprachmemo'], 'beide signierten Dateien liegen im Repo');
  await withServer(
    async ({ call, login }) => {
      const anon = await call('/kurzbefehle/notiz.shortcut');
      assert.equal(anon.status, 303);
      await login();
      const page = await (await call('/einstellungen')).text();
      assert.match(page, /href="\/kurzbefehle\/notiz\.shortcut"/);
      assert.match(page, /href="\/kurzbefehle\/sprachmemo\.shortcut"/);
      const file = await call('/kurzbefehle/sprachmemo.shortcut');
      assert.equal(file.status, 200);
      assert.match(file.headers.get('content-disposition'), /attachment;.*Sprachmemo%20ins%20Cockpit\.shortcut/);
      assert.deepEqual(Buffer.from(await file.arrayBuffer()), shortcuts[1].data);
    },
    {},
    { shortcuts },
  );
});

test('Einstellungen: Flammen in der Feuer-Notiz abschalten (VCP-52)', async () => {
  await withServer(async ({ call, login, settings }) => {
    await login();
    const html = await (await call('/einstellungen')).text();
    assert.match(html, /<section id="feuer-notiz">[^]*<select name="flameNote\.enabled">[^]*Standard \(an\)/);
    assert.equal(settings.get().flameNote.enabled, true);
    await call('/einstellungen', { method: 'POST', form: { 'flameNote.enabled': 'aus', csrf: csrfFrom(html) } });
    assert.equal(settings.stored().flameNote.enabled, false);
    assert.equal(settings.get().flameNote.enabled, false);
    assert.match(await (await call('/einstellungen')).text(), /<option value="aus" selected>aus<\/option>\s*<\/select><\/label>\s*<\/div>\s*<\/section>\s*<section id="mail">/);
  });
});
