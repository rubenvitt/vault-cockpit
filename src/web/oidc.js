import { createHash, randomBytes } from 'node:crypto';
import { createTokenVerifier } from '../oauth/verifier.js';

const b64url = (buf) => Buffer.from(buf).toString('base64url');

/**
 * Browser-Login für das Web-Cockpit: OpenID Connect, Authorization Code mit
 * PKCE, gegen denselben Pocket-ID-Server wie die MCP-Schnittstelle.
 *
 * Dafür braucht es in Pocket ID einen eigenen OIDC-Client (Callback
 * `<PUBLIC_URL>/auth/callback`), getrennt vom CIMD-Client für Claude. Ein
 * öffentlicher Client mit PKCE reicht; ein Client Secret wird mitgeschickt,
 * wenn es gesetzt ist. Geprüft wird das ID-Token: Signatur, `iss`,
 * `aud` = Client-ID, `exp`, `nonce` und das Subject gegen `ALLOWED_SUBJECTS`.
 */
export function createOidcLogin({ issuer, clientId, clientSecret = null, redirectUri, allowedSubjects, fetch = globalThis.fetch }) {
  let discovery = null;

  async function config() {
    if (discovery) return discovery;
    const res = await fetch(`${issuer}/.well-known/openid-configuration`);
    if (!res.ok) throw new Error(`OIDC-Discovery fehlgeschlagen: HTTP ${res.status}`);
    discovery = await res.json();
    return discovery;
  }

  const verifier = createTokenVerifier({
    issuer,
    resource: clientId,
    allowedSubjects,
    async loadJwks() {
      const res = await fetch((await config()).jwks_uri);
      if (!res.ok) throw new Error(`JWKS-Abruf fehlgeschlagen: HTTP ${res.status}`);
      return res.json();
    },
  });

  return {
    /** Ziel der Weiterleitung zum Login und der Zustand, der bis zum Callback im Cookie liegt. */
    async start() {
      const pending = { state: b64url(randomBytes(24)), nonce: b64url(randomBytes(24)), verifier: b64url(randomBytes(32)) };
      const url = new URL((await config()).authorization_endpoint);
      url.search = new URLSearchParams({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: redirectUri,
        scope: 'openid profile',
        state: pending.state,
        nonce: pending.nonce,
        code_challenge: b64url(createHash('sha256').update(pending.verifier).digest()),
        code_challenge_method: 'S256',
      }).toString();
      return { url: url.href, pending };
    },

    /** Code gegen ID-Token tauschen und prüfen; liefert `{ subject, name }`. */
    async finish({ code, state, pending }) {
      if (!pending || !state || state !== pending.state) throw new Error('state passt nicht zum Login');
      if (!code) throw new Error('code fehlt');
      const headers = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
      const form = new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        code_verifier: pending.verifier,
        client_id: clientId,
      });
      if (clientSecret) {
        headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`).toString('base64')}`;
      }
      const res = await fetch((await config()).token_endpoint, { method: 'POST', headers, body: form.toString() });
      if (!res.ok) throw new Error(`Token-Tausch fehlgeschlagen: HTTP ${res.status}`);
      const { id_token: idToken } = await res.json();
      if (!idToken) throw new Error('Antwort enthält kein ID-Token');
      const principal = await verifier.verify(idToken);
      if (principal.claims.nonce !== pending.nonce) throw new Error('nonce passt nicht zum Login');
      const c = principal.claims;
      return { subject: principal.subject, name: c.name ?? c.preferred_username ?? c.email ?? null };
    },
  };
}
