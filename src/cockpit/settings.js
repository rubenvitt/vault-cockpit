import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';

/**
 * Einstellungen des Web-Cockpits, gepflegt auf der Seite `/einstellungen` und
 * als JSON unter `/data` abgelegt (Datei nur für den Dienst lesbar, weil sie
 * Kalender-Passwörter und den Zunder-Token enthält).
 *
 * Leere Felder bedeuten „Standard“: Zeitzone, Vault-Name, Inbox-Ordner und
 * Zunder-Zugang fallen dann auf die Umgebungsvariablen zurück, die der Dienst
 * ohnehin kennt (`COCKPIT_TZ`, `OBSIDIAN_VAULT_NAME`, `CAPTURE_FOLDER`,
 * `ZUNDER_URL`/`ZUNDER_TOKEN`). Im Deployment muss dafür nichts stehen.
 */

export class SettingsError extends Error {}

export const MAX_CALENDARS = 20;
const KINDS = ['ical', 'caldav'];

const EMPTY = { tz: null, vaultName: null, inboxFolder: null, zunder: { url: null, token: null }, calendars: [] };

function validZone(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const text = (v, max, what) => {
  const s = String(v ?? '').trim();
  if (s.length > max) throw new SettingsError(`${what} ist zu lang (höchstens ${max} Zeichen)`);
  return s || null;
};

function httpUrl(v, what, { webcal = false } = {}) {
  const s = text(v, 2000, what);
  if (!s) return null;
  let u;
  try {
    u = new URL(webcal ? s.replace(/^webcal:/i, 'https:') : s);
  } catch {
    throw new SettingsError(`${what} ist keine gültige Adresse`);
  }
  if (!['https:', 'http:'].includes(u.protocol)) throw new SettingsError(`${what} muss mit https:// beginnen`);
  return u.href;
}

/** Prüft und normalisiert einen vollständigen Einstellungsstand. */
export function validateSettings(input) {
  const tz = text(input.tz, 100, 'Zeitzone');
  if (tz && !validZone(tz)) throw new SettingsError(`Unbekannte Zeitzone „${tz}“ (z. B. Europe/Berlin)`);

  const inboxFolder = text(input.inboxFolder, 200, 'Inbox-Ordner')?.replace(/^\/+|\/+$/g, '') || null;
  if (inboxFolder && inboxFolder.split('/').some((p) => p === '..' || p === '.')) {
    throw new SettingsError('Inbox-Ordner muss ein Pfad im Vault sein');
  }

  const zunderUrl = httpUrl(input.zunder?.url, 'Zunder-Adresse');
  const zunderToken = text(input.zunder?.token, 500, 'Zunder-Token');

  const calendars = (input.calendars ?? []).map((c, i) => {
    const label = `Kalender ${i + 1}`;
    const name = text(c.name, 80, `Name von ${label}`);
    if (!name) throw new SettingsError(`${label} braucht einen Namen`);
    if (!KINDS.includes(c.kind)) throw new SettingsError(`${name}: Art muss iCal oder CalDAV sein`);
    const url = httpUrl(c.url, `Adresse von „${name}“`, { webcal: true });
    if (!url) throw new SettingsError(`„${name}“ braucht eine Adresse`);
    const username = text(c.username, 200, `Benutzer von „${name}“`);
    const password = text(c.password, 500, `Passwort von „${name}“`);
    if (password && !username) throw new SettingsError(`„${name}“: zum Passwort fehlt der Benutzer`);
    const filter = c.kind === 'caldav' ? (c.filter ?? []).map((f) => String(f).trim()).filter(Boolean).slice(0, 50) : [];
    return { id: typeof c.id === 'string' && /^[\w-]{1,64}$/.test(c.id) ? c.id : randomUUID(), name, kind: c.kind, url, username, password, filter };
  });
  if (calendars.length > MAX_CALENDARS) throw new SettingsError(`Höchstens ${MAX_CALENDARS} Kalender`);
  const names = new Set();
  for (const c of calendars) {
    if (names.has(c.name.toLowerCase())) throw new SettingsError(`Der Name „${c.name}“ ist doppelt`);
    names.add(c.name.toLowerCase());
  }

  return { tz, vaultName: text(input.vaultName, 200, 'Vault-Name'), inboxFolder, zunder: { url: zunderUrl, token: zunderToken }, calendars };
}

export function writePrivate(file, content) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, content, { mode: 0o600 });
  renameSync(tmp, file);
}

/**
 * `defaults`: Werte aus der Umgebung, die gelten, solange ein Feld leer ist.
 * Ohne `file` lebt der Stand nur im Speicher (Tests).
 */
export function createSettingsStore({ file = null, defaults = {}, logger = console }) {
  let stored = { ...EMPTY };
  if (file && existsSync(file)) {
    try {
      stored = validateSettings(JSON.parse(readFileSync(file, 'utf8')));
    } catch (err) {
      logger.warn?.(`Einstellungen in ${file} nicht lesbar, starte mit leeren: ${err.message}`);
    }
  }
  let version = 0;

  const d = { tz: 'Europe/Berlin', vaultName: null, inboxFolder: 'inbox', zunderUrl: null, zunderToken: null, ...defaults };

  return {
    /** Gespeicherter Stand, wie die Einstellungsseite ihn bearbeitet. */
    stored: () => stored,

    /** Die Umgebungswerte, die für leere Felder gelten. */
    defaults: () => d,

    /** Wirksame Einstellungen: gespeichert, sonst Standard. */
    get() {
      const ownZunder = stored.zunder.url && stored.zunder.token;
      return {
        tz: stored.tz ?? d.tz,
        vaultName: stored.vaultName ?? d.vaultName,
        inboxFolder: stored.inboxFolder ?? d.inboxFolder,
        zunder: ownZunder ? { ...stored.zunder, source: 'einstellungen' } : d.zunderUrl && d.zunderToken ? { url: d.zunderUrl, token: d.zunderToken, source: 'umgebung' } : null,
        calendars: stored.calendars,
        version,
      };
    },

    save(input) {
      const next = validateSettings(input);
      if (file) writePrivate(file, `${JSON.stringify(next, null, 2)}\n`);
      stored = next;
      version += 1;
      return next;
    },
  };
}

/**
 * Secret für das Sitzungs-Cookie: aus `SESSION_SECRET`, sonst einmal zufällig
 * erzeugt und unter `/data` abgelegt, damit Sitzungen einen Neustart überleben.
 */
export function loadOrCreateSecret(file, fromEnv = null) {
  if (fromEnv) return fromEnv;
  try {
    const existing = readFileSync(file, 'utf8').trim();
    if (existing.length >= 32) return existing;
  } catch {
    /* noch keins da */
  }
  const secret = randomBytes(48).toString('base64url');
  writePrivate(file, `${secret}\n`);
  return secret;
}
