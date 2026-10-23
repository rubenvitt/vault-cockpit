import { readFileSync, existsSync } from 'node:fs';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { SettingsError, writePrivate } from './settings.js';

/**
 * API-Tokens, erzeugt auf der Seite `/einstellungen`. Jeder Token hat genau ein
 * Recht (`scope`): `search` für `GET /api/search`, `capture` für `/capture` und
 * `/funke` (iOS-Kurzbefehle, Funke), `lesestapel` für `/lesestapel/speichern`
 * (Artikel und PDFs in den Lesestapel), `app` für `/api/app/…` (Geräte-Token
 * der iOS-App, src/web/app-access.js). Ein `app`-Token darf zusätzlich alles,
 * was `lesestapel` darf, weil die Share Extension der App darüber speichert.
 * Tokens aus der Zeit vor den Rechten gelten als `search`; ein Token bekommt
 * nie nachträglich ein weiteres Recht.
 *
 * Gespeichert wird nur der SHA-256 eines Tokens, nie der Klartext; den sieht
 * man genau einmal direkt nach dem Anlegen. Eigene Datei neben den
 * Einstellungen, damit das Einstellungsformular die Tokens nicht überschreibt.
 */

export const MAX_TOKENS = 20;
export const SCOPES = ['search', 'capture', 'lesestapel', 'app'];
/** Rechte, die ein Recht mit einschließt. */
const INCLUDES = { app: ['lesestapel'] };
const PREFIX = 'vct_';

/** Alle Rechte eines Tokens mit diesem `scope`. */
export const grantsOf = (scope) => [scope, ...(INCLUDES[scope] ?? [])];

const sha256 = (s) => createHash('sha256').update(s).digest();

/** Ohne `file` lebt der Stand nur im Speicher (Tests). */
export function createTokenStore({ file = null, logger = console, now = () => Date.now() }) {
  let tokens = [];
  if (file && existsSync(file)) {
    try {
      tokens = JSON.parse(readFileSync(file, 'utf8'))
        .filter((t) => t && typeof t.id === 'string' && /^[0-9a-f]{64}$/.test(t.hash))
        .map((t) => ({ ...t, scope: SCOPES.includes(t.scope) ? t.scope : 'search' }));
    } catch (err) {
      logger.warn?.(`API-Tokens in ${file} nicht lesbar, starte ohne: ${err.message}`);
    }
  }
  const persist = (next) => {
    if (file) writePrivate(file, `${JSON.stringify(next, null, 2)}\n`);
    tokens = next;
  };

  /** Der gespeicherte Token zum vorgelegten (ohne Hash) oder null; prüft alle Hashes, ohne früh abzubrechen. */
  function find(presented) {
    if (typeof presented !== 'string' || !presented.startsWith(PREFIX)) return null;
    const h = sha256(presented);
    let found = null;
    for (const t of tokens) if (timingSafeEqual(h, Buffer.from(t.hash, 'hex'))) found = t;
    return found && { id: found.id, name: found.name, scope: found.scope, createdAt: found.createdAt };
  }

  return {
    /** Gespeicherte Tokens ohne Hash, für die Einstellungsseite. */
    list: () => tokens.map(({ id, name, scope, createdAt }) => ({ id, name, scope, createdAt })),

    /** Ob es mindestens einen Token mit diesem Recht gibt. */
    has: (scope) => tokens.some((t) => t.scope === scope),

    /** Legt einen Token an und gibt den Klartext zurück — das einzige Mal. */
    create(name, scope = 'search') {
      const n = String(name ?? '').trim();
      if (!n) throw new SettingsError('Der Token braucht einen Namen');
      if (n.length > 80) throw new SettingsError('Name ist zu lang (höchstens 80 Zeichen)');
      if (!SCOPES.includes(scope)) throw new SettingsError(`Unbekanntes Recht „${scope}“`);
      if (tokens.length >= MAX_TOKENS) throw new SettingsError(`Höchstens ${MAX_TOKENS} Tokens`);
      const token = PREFIX + randomBytes(32).toString('base64url');
      const entry = { id: randomUUID(), name: n, scope, hash: sha256(token).toString('hex'), createdAt: new Date(now()).toISOString() };
      persist([...tokens, entry]);
      return { token, id: entry.id, name: n, scope };
    },

    /** `true`, wenn es den Token gab. */
    revoke(id) {
      const next = tokens.filter((t) => t.id !== id);
      if (next.length === tokens.length) return false;
      persist(next);
      return true;
    },

    find,

    /** Ob der vorgelegte Token dieses Recht hat. */
    verify(presented, scope = 'search') {
      const t = find(presented);
      return Boolean(t && grantsOf(t.scope).includes(scope));
    },
  };
}
