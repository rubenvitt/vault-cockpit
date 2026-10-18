/**
 * Fehlertexte für die Anzeige entschärfen.
 *
 * Fehler von Hintergrunddiensten kommen oft ungefiltert aus Bibliotheken und
 * Gegenstellen und können Zugangsdaten enthalten: Kalenderadressen mit
 * geheimem Pfad, `https://user:pass@host`, `?token=…`, `Bearer …` oder einen
 * Token, den eine Gegenstelle zurückspiegelt. Bevor so ein Text auf der
 * Zustandsseite landet, wird er hier maskiert:
 *
 * - bekannte Geheimnisse (aus den Einstellungen) werden wörtlich ersetzt,
 * - jede Adresse schrumpft auf Schema und Host (`https://host/…`), wie die
 *   Einstellungsseite Kalenderadressen zeigt,
 * - `Bearer …`/`Basic …`, `token=…`, `password: …` und Werte mit bekannten
 *   Token-Präfixen (`zt_`, `zi_`, `vct_`, `fmu1-` …) werden zu `•••`,
 * - lange, zufällig aussehende Zeichenketten (Hex, Base64) ebenso.
 *
 * Danach wird auf `max` Zeichen gekürzt.
 */
const HIDDEN = '•••';
const MIN_SECRET = 6;

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function shortenUrl(raw) {
  // Satzzeichen am Ende gehören zum Satz, nicht zur Adresse.
  const [, url, tail] = raw.match(/^(.*?)([).,;:!?'"\]]*)$/);
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname === '/' && !u.search ? '' : '/…'}${tail}`;
  } catch {
    return `${HIDDEN}${tail}`;
  }
}

/**
 * Sieht nach Schlüssel aus (Hex, Base64, JWT), nicht nach Dateiname: Ziffern
 * und Buchstaben gemischt, kaum Bindestriche, keine Dateiendung.
 */
function randomLooking(s) {
  if (/\.(md|ics|json|js|html?)$/i.test(s)) return false;
  return /\d/.test(s) && /[a-z]/i.test(s) && (s.match(/-/g) ?? []).length <= 2;
}

export function maskSecrets(text, { secrets = [], max = 300 } = {}) {
  if (text == null) return null;
  let s = String(text);
  for (const secret of [...new Set(secrets.filter((x) => typeof x === 'string' && x.length >= MIN_SECRET))].sort((a, b) => b.length - a.length)) {
    s = s.replace(new RegExp(escapeRegExp(secret), 'g'), HIDDEN);
  }
  s = s
    .replace(/\b(?:https?|webcal|wss?|ftp):\/\/[^\s<>"'`]+/gi, shortenUrl)
    .replace(/\b(Bearer|Basic|Token)\s+[\w.~+/=-]{4,}/gi, `$1 ${HIDDEN}`)
    .replace(/\b((?:access_|refresh_|api_?|auth_?|id_)?(?:token|key|secret|password|passwort|pass|pwd))(\s*[=:]\s*)("?)[^\s"&,;]+\3/gi, `$1$2${HIDDEN}`)
    .replace(/\b(?:zt|zi|vct|fmu\d|fma\d|sk|ghp|gho|xox[abp])[_-][\w-]{6,}/gi, HIDDEN)
    .replace(/[A-Za-z0-9+_=.-]{32,}/g, (m) => (randomLooking(m) ? HIDDEN : m));
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
