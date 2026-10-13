import { createPublicKey, createVerify } from 'node:crypto';

/**
 * Prüft Access Tokens, die Pocket ID ausgestellt hat.
 *
 * Pocket ID liefert RFC-9068-JWTs (`typ: at+jwt`, RS256). Die Audience-Bindung
 * entsteht dort über das API-Feature (RFC 8707): nur wenn Claude
 * `resource=<PUBLIC_URL>/mcp` sendet und diese API registriert ist,
 * trägt das Token unsere Resource in `aud`. Ein reines Login-Token hat statt
 * dessen die client_id bzw. den Issuer als Audience — und wird hier abgelehnt.
 * Das ist der Schutz gegen Token-Passthrough, den die MCP-Spec verlangt.
 */
export function createTokenVerifier({ issuer, resource, loadJwks, allowedSubjects = [] }) {
  let cached = null;

  async function keyFor(kid) {
    if (!cached) cached = await loadJwks();
    let jwk = cached.keys?.find((k) => k.kid === kid);
    if (!jwk) {
      // Unbekannte kid heißt in aller Regel: der Schlüssel wurde rotiert.
      cached = await loadJwks();
      jwk = cached.keys?.find((k) => k.kid === kid);
    }
    if (!jwk) throw new Error(`kein passender Schlüssel im JWKS für kid ${kid}`);
    return createPublicKey({ key: jwk, format: 'jwk' });
  }

  return {
    async verify(token) {
      const parts = String(token ?? '').split('.');
      if (parts.length !== 3 || !parts[0] || !parts[1]) {
        throw new Error('Token hat kein gültiges JWT-Format');
      }
      const [headB64, bodyB64, sigB64] = parts;

      let header;
      try {
        header = JSON.parse(Buffer.from(headB64, 'base64url').toString('utf8'));
      } catch {
        throw new Error('Token hat kein gültiges JWT-Format');
      }
      // Vor allem anderen: ein Token ohne echten Algorithmus wird nie geprüft,
      // sondern sofort verworfen (alg=none-Angriff).
      if (header.alg !== 'RS256') throw new Error(`unerlaubter Algorithmus: ${header.alg}`);
      if (!sigB64) throw new Error('Token hat kein gültiges JWT-Format');

      const key = await keyFor(header.kid);
      const verifier = createVerify('RSA-SHA256');
      verifier.update(`${headB64}.${bodyB64}`);
      if (!verifier.verify(key, Buffer.from(sigB64, 'base64url'))) {
        throw new Error('Signatur ist ungültig');
      }

      let claims;
      try {
        claims = JSON.parse(Buffer.from(bodyB64, 'base64url').toString('utf8'));
      } catch {
        throw new Error('Token hat kein gültiges JWT-Format');
      }

      if (claims.iss !== issuer) throw new Error(`iss stimmt nicht: ${claims.iss}`);

      const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
      if (!aud.includes(resource)) {
        throw new Error(`aud enthält unsere Resource nicht (${JSON.stringify(claims.aud)})`);
      }

      if (!claims.sub) throw new Error('sub fehlt im Token');

      // Keine Uhren-Toleranz auf exp: der Authorization Server läuft hier auf demselben Host, und
      // eine Toleranz würde die Gültigkeit abgelaufener Tokens verlängern.
      const now = Math.floor(Date.now() / 1000);
      if (typeof claims.exp !== 'number' || claims.exp <= now) {
        throw new Error('Token ist abgelaufen');
      }

      if (allowedSubjects.length && !allowedSubjects.includes(claims.sub)) {
        throw new Error(`Subject ${claims.sub} ist nicht freigegeben`);
      }

      // Pocket ID schreibt beides: `scope` als String, `scp` als Array.
      const scopes = Array.isArray(claims.scp)
        ? claims.scp
        : String(claims.scope ?? '').trim().split(/\s+/).filter(Boolean);

      return {
        subject: claims.sub,
        clientId: claims.client_id ?? null,
        scopes,
        aud: resource,
        expiresAt: claims.exp,
        token,
      };
    },
  };
}
