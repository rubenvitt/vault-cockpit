import { createHmac, timingSafeEqual, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { deflateRawSync, inflateRawSync } from 'node:zlib';

/**
 * Signierte Cookies für das Web-Cockpit.
 *
 * Der Inhalt (JSON) steht lesbar im Cookie, eine HMAC-SHA256-Signatur mit
 * `SESSION_SECRET` schützt ihn vor Änderungen. Es gibt keinen Session-Speicher
 * auf dem Server: Ein Neustart meldet niemanden ab, ein neues Secret alle.
 * Was nicht lesbar sein soll (der Entwurf über den Login), wird mit
 * AES-256-GCM verschlüsselt, Schlüssel aus demselben Secret abgeleitet.
 */
export function createCookieSigner(secret) {
  if (!secret || String(secret).length < 32) throw new Error('SESSION_SECRET muss mindestens 32 Zeichen lang sein');
  const sign = (data) => createHmac('sha256', secret).update(data).digest('base64url');
  const key = createHmac('sha256', secret).update('vc-cookie-encryption').digest();

  return {
    /** HMAC über beliebigen Text, z. B. für das CSRF-Token einer Sitzung. */
    mac: (data) => sign(`mac\n${data}`),

    seal(payload) {
      const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
      return `${data}.${sign(data)}`;
    },

    /** Inhalt eines gültigen, nicht abgelaufenen Cookies, sonst null. `exp` in Sekunden. */
    open(value, now = Date.now()) {
      const [data, sig, extra] = String(value ?? '').split('.');
      if (!data || !sig || extra !== undefined) return null;
      const expected = Buffer.from(sign(data));
      const given = Buffer.from(sig);
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
      let payload;
      try {
        payload = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
      } catch {
        return null;
      }
      if (typeof payload?.exp !== 'number' || payload.exp * 1000 <= now) return null;
      return payload;
    },

    /** Wie `seal`, aber verschlüsselt (und vorher komprimiert): Der Inhalt steht nicht im Cookie. */
    encrypt(payload) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const body = Buffer.concat([cipher.update(deflateRawSync(JSON.stringify(payload))), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url');
    },

    /** Inhalt eines mit `encrypt` erzeugten, unveränderten und nicht abgelaufenen Werts, sonst null. */
    decrypt(value, now = Date.now()) {
      const buf = Buffer.from(String(value ?? ''), 'base64url');
      if (buf.length < 29) return null;
      let payload;
      try {
        const decipher = createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
        decipher.setAuthTag(buf.subarray(12, 28));
        const plain = Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]);
        payload = JSON.parse(inflateRawSync(plain, { maxOutputLength: 1 << 20 }).toString('utf8'));
      } catch {
        return null;
      }
      if (typeof payload?.exp !== 'number' || payload.exp * 1000 <= now) return null;
      return payload;
    },
  };
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

export function cookie(name, value, { maxAge, secure = true, path = '/' } = {}) {
  const parts = [`${name}=${value}`, `Path=${path}`, 'HttpOnly', 'SameSite=Lax'];
  if (secure) parts.push('Secure');
  if (maxAge !== undefined) parts.push(`Max-Age=${maxAge}`);
  return parts.join('; ');
}
