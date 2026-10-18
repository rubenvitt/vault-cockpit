import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { scrypt, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { writePrivate } from './settings.js';

/**
 * Sicherung der Dateien unter `/data`, die sich nicht neu bauen lassen
 * (Einstellungen, API-Tokens, Merkzettel, Sitzungs-Secret). Index und Vektoren
 * gehören nicht dazu, die entstehen beim Start von selbst.
 *
 * Die Sicherung ist eine JSON-Datei: Kopf im Klartext (Format, Version,
 * scrypt-Parameter mit Salt, IV und Tag von AES-256-GCM, Zeitpunkt) und die
 * Dateien verschlüsselt. Der Kopf geht als zusätzliche Daten in GCM ein, eine
 * Änderung daran fällt beim Öffnen auf. Im Klartext steht nichts, was ein
 * Geheimnis verrät.
 *
 * Gesichert wird je Datei der ganze Inhalt, nicht einzelne Felder. Eine neue
 * Datei unter `/data` braucht nur einen Eintrag in `DATA_FILES`.
 */

export class BackupError extends Error {}

/**
 * Die Dateien, die eine Sicherung erfasst. `setup`: zählt für „leer“, also ob
 * schon jemand das Cockpit eingerichtet hat.
 */
export const DATA_FILES = [
  { name: 'cockpit-settings.json', label: 'Einstellungen (Kalender, Zunder, Mail, Embeddings, Anzeige)', setup: true },
  { name: 'api-tokens.json', label: 'API-Tokens (nur ihre Hashes)', setup: true },
  { name: 'capture-state.json', label: 'Merkzettel von Capture und Zunder-Brücke' },
  { name: 'session-secret', label: 'Secret für das Sitzungs-Cookie' },
];

export const MIN_PASSPHRASE = 12;
/** Größte Sicherung, die das Cockpit schreibt und wieder annimmt. */
export const MAX_BACKUP = 8 * 1024 * 1024;

const FORMAT = 'vault-cockpit-sicherung';
const VERSION = 1;
/** scrypt nach OWASP: 2^17 × 8 braucht 128 MiB und rund eine halbe Sekunde. */
const COST = { N: 2 ** 17, r: 8, p: 1 };
// Grenzen für Parameter aus einer fremden Datei, damit sie den Dienst nicht lahmlegt.
const MAX_SCRYPT_MEM = 256 * 1024 * 1024;

const derive = promisify(scrypt);
const b64 = (buf) => buf.toString('base64');
const unb64 = (s, what, bytes = null) => {
  if (typeof s !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(s)) throw new BackupError(`Keine Sicherung des Cockpits (${what} fehlt)`);
  const buf = Buffer.from(s, 'base64');
  if (bytes !== null && buf.length !== bytes) throw new BackupError(`Keine Sicherung des Cockpits (${what} hat die falsche Länge)`);
  return buf;
};

function key(passphrase, salt, { N, r, p }) {
  return derive(String(passphrase).normalize('NFC'), salt, 32, { N, r, p, maxmem: 2 * 128 * N * r + 1024 * 1024 });
}

/** Kopf in fester Reihenfolge; genau diese Bytes gehen als zusätzliche Daten in GCM ein. */
const headerOf = ({ createdAt, kdf, cipher }) => ({
  format: FORMAT,
  version: VERSION,
  createdAt,
  kdf: { name: 'scrypt', N: kdf.N, r: kdf.r, p: kdf.p, salt: kdf.salt },
  cipher: { name: 'aes-256-gcm', iv: cipher.iv },
});

export function checkPassphrase(passphrase) {
  if (typeof passphrase !== 'string' || [...passphrase].length < MIN_PASSPHRASE) {
    throw new BackupError(`Die Passphrase braucht mindestens ${MIN_PASSPHRASE} Zeichen`);
  }
}

/** Verschlüsselt `files` (Name → Buffer) zu einer Sicherungsdatei (Text). */
export async function seal(files, passphrase, { cost = COST, now = () => Date.now() } = {}) {
  checkPassphrase(passphrase);
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const head = headerOf({ createdAt: new Date(now()).toISOString(), kdf: { ...cost, salt: b64(salt) }, cipher: { iv: b64(iv) } });
  const plain = Buffer.from(JSON.stringify({ files: Object.fromEntries(Object.entries(files).map(([n, buf]) => [n, b64(buf)])) }));
  const c = createCipheriv('aes-256-gcm', await key(passphrase, salt, cost), iv);
  c.setAAD(Buffer.from(JSON.stringify(head)));
  const data = Buffer.concat([c.update(plain), c.final()]);
  return `${JSON.stringify({ ...head, cipher: { ...head.cipher, tag: b64(c.getAuthTag()) }, data: b64(data) }, null, 2)}\n`;
}

/** Öffnet eine Sicherungsdatei; liefert `{ createdAt, files }` (Name → Buffer). */
export async function open(text, passphrase) {
  let doc;
  try {
    doc = JSON.parse(Buffer.isBuffer(text) ? text.toString('utf8') : String(text));
  } catch {
    throw new BackupError('Keine Sicherung des Cockpits (kein JSON)');
  }
  if (doc?.format !== FORMAT) throw new BackupError('Keine Sicherung des Cockpits');
  if (doc.version !== VERSION) throw new BackupError(`Sicherung im Format ${doc.version} kennt dieses Cockpit nicht (erwartet ${VERSION})`);
  const { N, r, p } = doc.kdf ?? {};
  const pow2 = Number.isInteger(N) && N >= 2 ** 10 && (N & (N - 1)) === 0;
  if (doc.kdf?.name !== 'scrypt' || !pow2 || !Number.isInteger(r) || r < 1 || r > 32 || !Number.isInteger(p) || p < 1 || p > 16 || 128 * N * r > MAX_SCRYPT_MEM) {
    throw new BackupError('Sicherung mit unbekannten oder zu großen Schlüsselparametern');
  }
  if (doc.cipher?.name !== 'aes-256-gcm') throw new BackupError('Sicherung mit unbekannter Verschlüsselung');
  if (typeof doc.createdAt !== 'string') throw new BackupError('Keine Sicherung des Cockpits (Zeitpunkt fehlt)');
  const salt = unb64(doc.kdf.salt, 'Salt');
  if (salt.length < 16) throw new BackupError('Keine Sicherung des Cockpits (Salt zu kurz)');
  const iv = unb64(doc.cipher.iv, 'IV', 12);
  const tag = unb64(doc.cipher.tag, 'Tag', 16);
  const data = unb64(doc.data, 'Inhalt');
  checkPassphrase(passphrase);

  const head = headerOf({ createdAt: doc.createdAt, kdf: { N, r, p, salt: doc.kdf.salt }, cipher: { iv: doc.cipher.iv } });
  const d = createDecipheriv('aes-256-gcm', await key(passphrase, salt, { N, r, p }), iv);
  d.setAAD(Buffer.from(JSON.stringify(head)));
  d.setAuthTag(tag);
  let plain;
  try {
    plain = Buffer.concat([d.update(data), d.final()]);
  } catch {
    throw new BackupError('Passphrase falsch oder Datei beschädigt');
  }
  const inner = JSON.parse(plain.toString('utf8'));
  const files = {};
  for (const [name, content] of Object.entries(inner.files ?? {})) files[name] = unb64(content, name);
  return { createdAt: doc.createdAt, files };
}

/** Ob in der Datei ein eingerichteter Stand liegt: fehlend, leer, `{}` und `[]` zählen nicht. */
function holdsState(path) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8').trim();
  } catch {
    return false;
  }
  if (!raw) return false;
  try {
    const v = JSON.parse(raw);
    return v !== null && typeof v === 'object' ? Object.keys(v).length > 0 : true;
  } catch {
    // Unlesbar heißt nicht leer: lieber nachfragen, als still zu überschreiben.
    return true;
  }
}

/**
 * `dir`: Ordner der Dateien (`/data`), `paths`: abweichende Pfade je Name
 * (z. B. `CAPTURE_STATE_FILE`). `cost` nur für Tests kleiner.
 */
/**
 * Eine ältere Sicherung bringt eine ältere Sitzungs-Generation mit; Cookies,
 * die „Überall abmelden“ seither beendet hat, gälten damit wieder. Deshalb
 * zählt das Wiederherstellen die Generation über beide Stände hinaus hoch:
 * danach meldet sich jedes Gerät neu an.
 */
function withNewGeneration(content, currentPath) {
  const generation = (s) => (Number.isInteger(s?.session?.generation) ? s.session.generation : 0);
  let current = null;
  try {
    current = JSON.parse(readFileSync(currentPath, 'utf8'));
  } catch {
    // keine oder kaputte Einstellungen: zählt als Generation 0
  }
  const restored = JSON.parse(content.toString('utf8'));
  const session = { ...(restored.session ?? {}), generation: Math.max(generation(current), generation(restored)) + 1 };
  return Buffer.from(JSON.stringify({ ...restored, session }, null, 2) + '\n');
}

export function createBackup({ dir, paths = {}, files = DATA_FILES, cost = COST, now = () => Date.now() }) {
  const entries = files.map((f) => ({ ...f, path: paths[f.name] ?? join(dir, f.name) }));
  const byName = new Map(entries.map((e) => [e.name, e]));

  /** Leer: keine Datei mit `setup` hält einen Stand, also nichts eingestellt und keine Tokens. */
  const isEmpty = () => !entries.some((e) => e.setup && holdsState(e.path));

  return {
    isEmpty,

    /** Für die Einstellungsseite: was gesichert wird und ob das Cockpit leer ist. */
    status: () => ({ empty: isEmpty(), files: entries.map(({ name, label, path }) => ({ name, label, present: existsSync(path) })) }),

    /** Liefert `{ filename, body, files }`; `repeat` ist die Wiederholung der Passphrase. */
    async create(passphrase, { repeat } = {}) {
      checkPassphrase(passphrase);
      if (repeat !== undefined && repeat !== passphrase) throw new BackupError('Die beiden Passphrasen stimmen nicht überein');
      const content = {};
      for (const e of entries) {
        if (existsSync(e.path)) content[e.name] = readFileSync(e.path);
      }
      if (!Object.keys(content).length) throw new BackupError('Unter /data liegt noch nichts, das sich sichern ließe');
      const body = await seal(content, passphrase, { cost, now });
      if (Buffer.byteLength(body) > MAX_BACKUP) throw new BackupError('Die Sicherung wäre zu groß zum Wiederherstellen');
      return { filename: `cockpit-sicherung-${new Date(now()).toISOString().slice(0, 10)}.json`, body, files: Object.keys(content) };
    },

    /**
     * Schreibt die Dateien einer Sicherung zurück, jede atomar und nur für den
     * Dienst lesbar. Ist das Cockpit nicht leer, nur mit `replace`. Erst wird
     * alles geprüft, dann geschrieben; unbekannte Dateien bleiben liegen.
     * Laufende Teile lesen den neuen Stand erst nach einem Neustart.
     */
    async restore(text, passphrase, { replace = false } = {}) {
      if (!text?.length) throw new BackupError('Bitte eine Sicherungsdatei wählen');
      if (Buffer.byteLength(text) > MAX_BACKUP) throw new BackupError('Die Datei ist zu groß für eine Sicherung des Cockpits');
      if (!replace && !isEmpty()) {
        throw new BackupError('Das Cockpit ist schon eingerichtet. Zum Überschreiben „Vorhandenes ersetzen“ ankreuzen.');
      }
      const { createdAt, files } = await open(text, passphrase);
      const known = Object.keys(files).filter((n) => byName.has(n));
      const skipped = Object.keys(files).filter((n) => !byName.has(n));
      if (!known.length) throw new BackupError('Die Sicherung enthält keine bekannte Datei');
      for (const n of known) {
        if (!n.endsWith('.json')) continue;
        try {
          JSON.parse(files[n].toString('utf8'));
        } catch {
          throw new BackupError(`${n} in der Sicherung ist kein gültiges JSON`);
        }
      }
      if (files['cockpit-settings.json'] && byName.has('cockpit-settings.json')) {
        files['cockpit-settings.json'] = withNewGeneration(files['cockpit-settings.json'], byName.get('cockpit-settings.json').path);
      }
      for (const n of known) writePrivate(byName.get(n).path, files[n]);
      return { createdAt, files: known, skipped };
    },
  };
}
