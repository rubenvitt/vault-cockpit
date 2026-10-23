import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';

/**
 * Einstellungen des Web-Cockpits, gepflegt auf der Seite `/einstellungen` und
 * als JSON unter `/data` abgelegt (Datei nur für den Dienst lesbar, weil sie
 * Kalender-Passwörter und den Zunder-Token enthält).
 *
 * Leere Felder bedeuten „Standard“: Sie fallen auf die Umgebungsvariablen
 * zurück, mit denen ältere Deployments eingerichtet wurden (`COCKPIT_TZ`,
 * `OBSIDIAN_VAULT_NAME`, `CAPTURE_FOLDER`, `ZUNDER_*`, `MAIL_*`, `EMBED_*`),
 * sonst auf feste Standardwerte. Im Deployment muss dafür nichts stehen.
 * Alles hier wirkt ohne Neustart: Wochenansicht, `!`-Capture, Brücke, Mail,
 * Embeddings und Graph lesen den Stand bei jedem Aufruf bzw. bauen sich nach
 * dem Speichern neu auf (`onChange`). Auch die Dauer der Web-Sitzung und ihre
 * Generation („Überall abmelden“) stehen hier, siehe `src/web/sessions.js`.
 */

export class SettingsError extends Error {}

export const MAX_CALENDARS = 20;
const KINDS = ['ical', 'caldav'];

/** Termine mit diesen Titeln blendet das Cockpit aus, solange nichts anderes eingestellt ist. */
export const DEFAULT_HIDDEN_EVENTS = ['Blockiert'];

const EMPTY = {
  tz: null,
  vaultName: null,
  inboxFolder: null,
  zunder: { url: null, token: null },
  bridge: { enabled: null, tag: null },
  flameNote: { enabled: null },
  readingNotes: { folder: null },
  mail: { token: null, senders: [], mailbox: null, doneMailbox: null, pollMinutes: null },
  embed: { url: null, model: null },
  calendars: [],
  hiddenEvents: null,
  session: { idleDays: null, maxDays: null, generation: 0 },
};

const SENDER = /^(?:[^@\s]+@|@)[^@\s]+\.[^@\s]+$/;
const TAG = /^[\p{L}\p{N}_/-]{1,50}$/u;

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

  // Ordner der Lesestapel-Notizen (VCP-75); vertraulich oder Readwise prüft der Export.
  const readingFolder = text(input.readingNotes?.folder, 200, 'Lesestapel-Ordner')?.replace(/^\/+|\/+$/g, '') || null;
  if (readingFolder && readingFolder.split('/').some((p) => p.startsWith('.') || !p.trim())) {
    throw new SettingsError('Lesestapel-Ordner muss ein Pfad im Vault sein');
  }

  const zunderUrl = httpUrl(input.zunder?.url, 'Zunder-Adresse');
  const zunderToken = text(input.zunder?.token, 500, 'Zunder-Token');

  // `null` heißt jeweils „Standard“ (Umgebung oder fester Wert).
  const enabled = input.bridge?.enabled;
  const bridgeTag = text(input.bridge?.tag, 60, 'Brücken-Tag')?.replace(/^#/, '') || null;
  if (bridgeTag && !TAG.test(bridgeTag)) throw new SettingsError(`Brücken-Tag „${bridgeTag}“: nur Buchstaben, Ziffern, _, - und /`);
  const bridge = { enabled: typeof enabled === 'boolean' ? enabled : null, tag: bridgeTag };
  // Flammen in der Feuer-Notiz (VCP-52); `null` = Standard (an).
  const flameNote = { enabled: typeof input.flameNote?.enabled === 'boolean' ? input.flameNote.enabled : null };

  const senders = [...new Set((input.mail?.senders ?? []).map((s) => text(s, 200, 'Absender')?.toLowerCase()).filter(Boolean))].slice(0, 50);
  for (const s of senders) {
    if (!SENDER.test(s)) throw new SettingsError(`Absender „${s}“: Adresse oder @domain erwartet`);
  }
  const poll = input.mail?.pollMinutes;
  const pollMinutes = poll === null || poll === undefined || poll === '' ? null : Number(poll);
  if (pollMinutes !== null && !(Number.isInteger(pollMinutes) && pollMinutes >= 1 && pollMinutes <= 1440)) {
    throw new SettingsError('Mail-Abruf: Abstand in ganzen Minuten zwischen 1 und 1440');
  }
  const mail = {
    token: text(input.mail?.token, 500, 'Mail-Token'),
    senders,
    mailbox: text(input.mail?.mailbox, 100, 'Mail-Ordner'),
    doneMailbox: text(input.mail?.doneMailbox, 100, 'Ablage-Ordner'),
    pollMinutes,
  };

  const embed = { url: httpUrl(input.embed?.url, 'Embedding-Server'), model: text(input.embed?.model, 100, 'Embedding-Modell') };

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

  // `null` heißt „Standard“, eine leere Liste blendet nichts aus.
  const hiddenEvents = Array.isArray(input.hiddenEvents)
    ? [...new Set(input.hiddenEvents.map((t) => text(t, 200, 'Ausgeblendeter Termin')).filter(Boolean))].slice(0, 50)
    : null;

  return { tz, vaultName: text(input.vaultName, 200, 'Vault-Name'), inboxFolder, zunder: { url: zunderUrl, token: zunderToken }, bridge, flameNote, readingNotes: { folder: readingFolder }, mail, embed, calendars, hiddenEvents, session: validateSession(input.session) };
}

const days = (v, what) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!(Number.isInteger(n) && n >= 1 && n <= 365)) throw new SettingsError(`${what}: ganze Tage zwischen 1 und 365`);
  return n;
};

/** Sitzungsdauer in Tagen (`null` = Standard) und die Generation, die „Überall abmelden“ hochzählt. */
function validateSession(input) {
  const idleDays = days(input?.idleDays, 'Abmelden nach Inaktivität');
  const maxDays = days(input?.maxDays, 'Längste Sitzung');
  if (idleDays && maxDays && maxDays < idleDays) throw new SettingsError('Die längste Sitzung darf nicht kürzer sein als die Zeit bis zum Abmelden ohne Nutzung');
  const g = input?.generation;
  return { idleDays, maxDays, generation: Number.isInteger(g) && g >= 0 ? g : 0 };
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
  const listeners = new Set();

  const d = {
    tz: 'Europe/Berlin',
    vaultName: null,
    inboxFolder: 'inbox',
    zunderUrl: null,
    zunderToken: null,
    bridgeEnabled: true,
    bridgeTag: 'zunder',
    flameNoteEnabled: true,
    readingNotesFolder: '30-ressourcen/lesestapel',
    mailToken: null,
    mailSenders: [],
    mailbox: 'Vault',
    doneMailbox: 'Archive',
    mailPollMinutes: 5,
    embedUrl: null,
    embedModel: 'bge-m3',
    sessionIdleDays: 30,
    sessionMaxDays: 90,
    ...defaults,
  };

  return {
    /** Gespeicherter Stand, wie die Einstellungsseite ihn bearbeitet. */
    stored: () => stored,

    /** Die Umgebungswerte, die für leere Felder gelten. */
    defaults: () => d,

    /** Wirksame Einstellungen: gespeichert, sonst Standard. */
    get() {
      const ownZunder = stored.zunder.url && stored.zunder.token;
      const mailToken = stored.mail.token ?? d.mailToken;
      const senders = stored.mail.senders.length ? stored.mail.senders : d.mailSenders;
      const embedUrl = stored.embed.url ?? d.embedUrl;
      return {
        tz: stored.tz ?? d.tz,
        vaultName: stored.vaultName ?? d.vaultName,
        inboxFolder: stored.inboxFolder ?? d.inboxFolder,
        zunder: ownZunder ? { ...stored.zunder, source: 'einstellungen' } : d.zunderUrl && d.zunderToken ? { url: d.zunderUrl, token: d.zunderToken, source: 'umgebung' } : null,
        // Ohne Zunder-Zugang ruht die Brücke trotzdem; `enabled` sagt nur, ob sie darf.
        bridge: { enabled: stored.bridge.enabled ?? d.bridgeEnabled, tag: stored.bridge.tag ?? d.bridgeTag },
        flameNote: { enabled: stored.flameNote.enabled ?? d.flameNoteEnabled },
        readingNotes: { folder: stored.readingNotes?.folder ?? d.readingNotesFolder },
        // Mail-Abruf nur mit Token und freigegebenen Absendern, damit eine fremde Mail nichts anlegt.
        mail:
          mailToken && senders.length
            ? {
                token: mailToken,
                senders,
                mailbox: stored.mail.mailbox ?? d.mailbox,
                doneMailbox: stored.mail.doneMailbox ?? d.doneMailbox,
                pollMinutes: stored.mail.pollMinutes ?? d.mailPollMinutes,
                source: stored.mail.token ? 'einstellungen' : 'umgebung',
              }
            : null,
        embed: embedUrl ? { url: embedUrl, model: stored.embed.model ?? d.embedModel, source: stored.embed.url ? 'einstellungen' : 'umgebung' } : null,
        calendars: stored.calendars,
        hiddenEvents: stored.hiddenEvents ?? DEFAULT_HIDDEN_EVENTS,
        // Ohne Nutzung nie länger als die Obergrenze.
        session: {
          idleDays: Math.min(stored.session.idleDays ?? d.sessionIdleDays, stored.session.maxDays ?? d.sessionMaxDays),
          maxDays: stored.session.maxDays ?? d.sessionMaxDays,
          generation: stored.session.generation,
        },
        version,
      };
    },

    save(input) {
      const next = validateSettings(input);
      if (file) writePrivate(file, `${JSON.stringify(next, null, 2)}\n`);
      stored = next;
      version += 1;
      for (const fn of listeners) {
        try {
          fn();
        } catch (err) {
          logger.warn?.(`Einstellungen: Reaktion auf Änderung fehlgeschlagen: ${err.message}`);
        }
      }
      return next;
    },

    /** Ruft `fn` nach jedem Speichern auf; liefert eine Funktion zum Abmelden. */
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
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
