import { readFileSync, existsSync } from 'node:fs';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { SettingsError, writePrivate } from './settings.js';

/**
 * API-Tokens für `GET /api/search`, erzeugt auf der Seite `/einstellungen`.
 *
 * Gespeichert wird nur der SHA-256 eines Tokens, nie der Klartext; den sieht
 * man genau einmal direkt nach dem Anlegen. Eigene Datei neben den
 * Einstellungen, damit das Einstellungsformular die Tokens nicht überschreibt.
 */

export const MAX_TOKENS = 20;
const PREFIX = 'vct_';

const sha256 = (s) => createHash('sha256').update(s).digest();

/** Ohne `file` lebt der Stand nur im Speicher (Tests). */
export function createTokenStore({ file = null, logger = console, now = () => Date.now() }) {
  let tokens = [];
  if (file && existsSync(file)) {
    try {
      tokens = JSON.parse(readFileSync(file, 'utf8')).filter((t) => t && typeof t.id === 'string' && /^[0-9a-f]{64}$/.test(t.hash));
    } catch (err) {
      logger.warn?.(`API-Tokens in ${file} nicht lesbar, starte ohne: ${err.message}`);
    }
  }
  const persist = (next) => {
    if (file) writePrivate(file, `${JSON.stringify(next, null, 2)}\n`);
    tokens = next;
  };

  return {
    /** Gespeicherte Tokens ohne Hash, für die Einstellungsseite. */
    list: () => tokens.map(({ id, name, createdAt }) => ({ id, name, createdAt })),

    /** Legt einen Token an und gibt den Klartext zurück — das einzige Mal. */
    create(name) {
      const n = String(name ?? '').trim();
      if (!n) throw new SettingsError('Der Token braucht einen Namen');
      if (n.length > 80) throw new SettingsError('Name ist zu lang (höchstens 80 Zeichen)');
      if (tokens.length >= MAX_TOKENS) throw new SettingsError(`Höchstens ${MAX_TOKENS} Tokens`);
      const token = PREFIX + randomBytes(32).toString('base64url');
      const entry = { id: randomUUID(), name: n, hash: sha256(token).toString('hex'), createdAt: new Date(now()).toISOString() };
      persist([...tokens, entry]);
      return { token, id: entry.id, name: n };
    },

    /** `true`, wenn es den Token gab. */
    revoke(id) {
      const next = tokens.filter((t) => t.id !== id);
      if (next.length === tokens.length) return false;
      persist(next);
      return true;
    },

    /** Prüft einen vorgelegten Token gegen alle Hashes, ohne früh abzubrechen. */
    verify(presented) {
      if (typeof presented !== 'string' || !presented.startsWith(PREFIX)) return false;
      const h = sha256(presented);
      let ok = false;
      for (const t of tokens) ok = timingSafeEqual(h, Buffer.from(t.hash, 'hex')) || ok;
      return ok;
    },
  };
}
