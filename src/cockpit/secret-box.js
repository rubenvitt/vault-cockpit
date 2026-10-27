import { createHmac, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';

/**
 * Verschlüsselt Geheimnisse, die in einer Datenbank liegen (Zugangsdaten
 * privater Feeds), mit AES-256-GCM. Der Schlüssel kommt aus einem eigenen
 * Secret unter `/data` (`credentials-key`, erzeugt `loadOrCreateSecret` beim
 * ersten Start), nicht aus dem Sitzungs-Secret: Das darf wechseln, ohne dass
 * gespeicherte Zugangsdaten verloren gehen. Die Sicherung nimmt beides mit.
 *
 * `context` (etwa `feed:<id>`) geht als zusätzliche Daten in GCM ein: Ein
 * Wert, der in eine andere Zeile kopiert wird, lässt sich dort nicht öffnen.
 */

const VERSION = 'v1';

export function createSecretBox(secret) {
  if (!secret || String(secret).length < 32) throw new Error('Das Secret für Zugangsdaten muss mindestens 32 Zeichen lang sein');
  const key = createHmac('sha256', secret).update('vc-credentials').digest();

  return {
    /** Wert (JSON) → Text `v1.<iv><tag><daten>` (base64url). */
    seal(value, context = '') {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(Buffer.from(String(context)));
      const body = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
      return `${VERSION}.${Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url')}`;
    },

    /** Inhalt eines mit `seal` und demselben `context` erzeugten Werts, sonst `null` (anderer Schlüssel, verändert). */
    open(sealed, context = '') {
      const [version, data] = String(sealed ?? '').split('.');
      if (version !== VERSION || !data) return null;
      const buf = Buffer.from(data, 'base64url');
      if (buf.length < 29) return null;
      try {
        const decipher = createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
        decipher.setAAD(Buffer.from(String(context)));
        decipher.setAuthTag(buf.subarray(12, 28));
        return JSON.parse(Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8'));
      } catch {
        return null;
      }
    },
  };
}
