import http from 'node:http';
import https from 'node:https';
import { lookup as dnsLookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

/**
 * Holt eine fremde Seite für den Lesestapel, ohne dass sich damit Dienste im
 * eigenen Netz erreichen lassen (SSRF). Vertrauensgrenze, deshalb:
 *
 * - nur `http:` und `https:`, ohne Zugangsdaten in der Adresse (private Feeds
 *   geben sie getrennt als `auth` mit, siehe `splitCredentials`);
 * - die Adresse wird nach der DNS-Auflösung geprüft, und zwar in der
 *   `lookup`-Funktion des Requests: Verbunden wird genau mit der geprüften IP
 *   (kein DNS-Rebinding zwischen Prüfen und Verbinden). IP-Literale, die Node
 *   ohne `lookup` verbindet, prüft `checkHost` vorher;
 * - Weiterleitungen folgen wir selbst (höchstens `maxRedirects`) und prüfen
 *   jeden Schritt neu;
 * - Größe (`maxBytes`, Abbruch mitten im Stream) und Zeit (`timeoutMs` für alle
 *   Schritte zusammen) sind begrenzt. Ohne `Accept-Encoding`, damit keine
 *   gepackte Antwort das Größenlimit umgeht.
 */

export class FetchError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

// Getrennte Listen: Eine IPv6-Regel für ::ffff:0:0/96 träfe in einer gemeinsamen Liste jede IPv4-Adresse.
const BLOCKED_V4 = new BlockList();
const BLOCKED_V6 = new BlockList();
for (const [net, bits] of [
  ['0.0.0.0', 8], // „dieses Netz“
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // CGNAT
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link-local, Metadaten-IP 169.254.169.254
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4], // Multicast
  ['240.0.0.0', 4], // reserviert, Broadcast
]) BLOCKED_V4.addSubnet(net, bits, 'ipv4');
for (const [net, bits] of [
  ['::', 96], // unspezifiziert, Loopback und IPv4-kompatibel (::a.b.c.d)
  ['::ffff:0:0', 96], // IPv4-mapped, auch in Hex-Schreibweise
  ['64:ff9b::', 96], // NAT64
  ['64:ff9b:1::', 48], // NAT64 lokal
  ['2001::', 32], // Teredo, bettet eine IPv4 ein
  ['2002::', 16], // 6to4, bettet eine IPv4 ein
  ['100::', 64],
  ['2001:db8::', 32],
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['fec0::', 10],
  ['ff00::', 8], // Multicast
]) BLOCKED_V6.addSubnet(net, bits, 'ipv6');

/** Ob eine IP öffentlich ist. Alles, was keine gültige IP ist, gilt als nicht öffentlich. */
export function isPublicAddress(ip) {
  const family = isIP(ip);
  if (!family) return false;
  return family === 4 ? !BLOCKED_V4.check(ip, 'ipv4') : !BLOCKED_V6.check(ip, 'ipv6');
}

/** Größte Seite, die `safeFetch` ohne eigene Grenze annimmt. */
export const MAX_PAGE = 5 * 1024 * 1024;

const defaultResolve = (hostname) => dnsLookup(hostname, { all: true, verbatim: true });

/**
 * `resolve(hostname)` → `[{ address, family }]` (Tests setzen eine eigene),
 * `isAllowed(ip)` entscheidet je Adresse (Tests lassen 127.0.0.1 für den
 * Testserver zu). Liefert `{ url, status, contentType, body }` mit `url` nach
 * allen Weiterleitungen und `body` als Text, dazu `bytes` (roh) und `headers`
 * der Antwort. `headers` gehen zusätzlich mit (bedingte Anfragen der Feeds);
 * `304 Not Modified` kommt dann ohne Inhalt zurück. `accept: null` nimmt jeden
 * Inhaltstyp an.
 *
 * `auth` (`{ user, password }`) geht als HTTP Basic Auth mit, aber nur an den
 * Host der Ausgangsadresse: Eine Weiterleitung auf einen anderen Host oder von
 * https auf http bekommt sie nicht.
 */
export async function safeFetch(input, { resolve = defaultResolve, isAllowed = isPublicAddress, maxBytes = MAX_PAGE, timeoutMs = 15_000, maxRedirects = 5, accept = ['text/html', 'application/xhtml+xml'], headers = {}, auth = null } = {}) {
  const deadline = Date.now() + timeoutMs;
  let url = parseTarget(input);
  const start = url;
  const basic = auth ? `Basic ${Buffer.from(`${auth.user ?? ''}:${auth.password ?? ''}`).toString('base64')}` : null;
  for (let hop = 0; ; hop++) {
    const withAuth = basic && sameHost(url, start);
    const res = await request(url, { resolve, isAllowed, maxBytes, deadline, headers: withAuth ? { ...headers, authorization: basic } : headers });
    if (res.status === 304) return { url: url.href, status: 304, contentType: null, body: '', bytes: res.body, headers: res.headers };
    if (res.status >= 300 && res.status < 400 && res.location) {
      if (hop >= maxRedirects) throw new FetchError('Zu viele Weiterleitungen');
      url = parseTarget(res.location, url);
      continue;
    }
    if (res.status === 401 || res.status === 403) throw new FetchError(`Zugang verweigert (HTTP ${res.status})${withAuth ? ', bitte die Zugangsdaten prüfen' : ''}`);
    if (res.status >= 400) throw new FetchError(`Die Seite antwortet mit HTTP ${res.status}`);
    const type = String(res.contentType ?? '').split(';')[0].trim().toLowerCase();
    if (accept && !accept.includes(type)) throw new FetchError(`Kein Artikel (${type || 'ohne Inhaltstyp'})`, 415);
    return { url: url.href, status: res.status, contentType: res.contentType, body: decode(res.body, res.contentType), bytes: res.body, headers: res.headers };
  }
}

/** Geprüfte Adresse (nur http/https, ohne Anker), sonst `FetchError` mit Status 400. */
export const normalizeUrl = (input) => parseTarget(input).href;

/**
 * Ob Zugangsdaten für `start` auch an `url` gehen dürfen: derselbe Host
 * (samt Port), und nicht von https zurück auf http.
 */
export const sameHost = (url, start) => {
  try {
    const [a, b] = [new URL(url), new URL(start)];
    return a.host === b.host && !(b.protocol === 'https:' && a.protocol === 'http:');
  } catch {
    return false;
  }
};

/**
 * Adresse mit Zugangsdaten (`https://name:passwort@host/feed`) → `{ url, auth }`:
 * die Adresse ohne sie (geprüft wie `normalizeUrl`) und `{ user, password }`
 * (dekodiert), ohne Zugangsdaten `auth: null`.
 */
export function splitCredentials(input) {
  let url;
  try {
    url = new URL(String(input ?? '').trim());
  } catch {
    throw new FetchError('Keine gültige Adresse', 400);
  }
  if (!url.username && !url.password) return { url: normalizeUrl(url.href), auth: null };
  const decode = (s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  };
  const auth = { user: decode(url.username), password: decode(url.password) };
  url.username = '';
  url.password = '';
  return { url: normalizeUrl(url.href), auth };
}

function parseTarget(input, base = undefined) {
  let url;
  try {
    url = new URL(String(input ?? '').trim(), base);
  } catch {
    throw new FetchError('Keine gültige Adresse', 400);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new FetchError('Nur http- und https-Adressen', 400);
  if (url.username || url.password) throw new FetchError('Adressen mit Zugangsdaten werden nicht geholt', 400);
  url.hash = '';
  return url;
}

const blocked = () => new FetchError('Adressen im lokalen oder privaten Netz werden nicht geholt', 400);

/** Prüft alle Adressen des Hosts; IP-Literale direkt, Namen nach der Auflösung. */
async function checkHost(hostname, { resolve, isAllowed }) {
  const host = hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) {
    if (!isAllowed(host)) throw blocked();
    return [{ address: host, family: isIP(host) }];
  }
  let addresses;
  try {
    addresses = await resolve(host);
  } catch {
    throw new FetchError(`${host} ist nicht erreichbar`);
  }
  if (!addresses?.length) throw new FetchError(`${host} ist nicht erreichbar`);
  if (addresses.some((a) => !isAllowed(a.address))) throw blocked();
  return addresses;
}

function request(url, { resolve, isAllowed, maxBytes, deadline, headers }) {
  return new Promise((done, fail) => {
    const left = deadline - Date.now();
    if (left <= 0) return fail(new FetchError('Zeitlimit überschritten', 504));
    let req;
    let settled = false;
    const finish = (fn, v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(v);
    };
    const timer = setTimeout(() => {
      finish(fail, new FetchError('Zeitlimit überschritten', 504));
      req?.destroy();
    }, left);

    checkHost(url.hostname, { resolve, isAllowed }).then((addresses) => {
      if (settled) return;
      try {
        connect(addresses);
      } catch (err) {
        finish(fail, new FetchError(`Abruf fehlgeschlagen: ${err.message}`));
      }
    }, (err) => finish(fail, err));

    function connect(addresses) {
      // Verbunden wird nur mit den eben geprüften Adressen; Node fragt bei
      // Happy Eyeballs mit `all: true`.
      const lookup = (hostname, options, cb) => {
        if (options?.all) cb(null, addresses);
        else cb(null, addresses[0].address, addresses[0].family);
      };
      req = (url.protocol === 'https:' ? https : http).request(url, {
        method: 'GET',
        lookup,
        headers: { 'user-agent': 'vault-cockpit-lesestapel/1', accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1', ...headers },
      });
      req.on('error', (err) => finish(fail, err instanceof FetchError ? err : new FetchError(`Abruf fehlgeschlagen: ${err.message}`)));
      req.on('response', (res) => {
        const base = { status: res.statusCode, location: res.headers.location ?? null, contentType: res.headers['content-type'] ?? null, headers: res.headers };
        if (res.statusCode >= 300 && res.statusCode < 400) {
          // Body eines Redirects nie lesen: ein endloser Body liefe sonst ohne Zeit- und Größenlimit weiter.
          req.destroy();
          return finish(done, { ...base, body: Buffer.alloc(0) });
        }
        if (Number(res.headers['content-length']) > maxBytes) {
          req.destroy();
          return finish(fail, new FetchError('Die Seite ist zu groß', 413));
        }
        const chunks = [];
        let size = 0;
        res.on('data', (c) => {
          size += c.length;
          if (size > maxBytes) {
            finish(fail, new FetchError('Die Seite ist zu groß', 413));
            req.destroy();
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => finish(done, { ...base, body: Buffer.concat(chunks) }));
        res.on('error', (err) => finish(fail, new FetchError(`Abruf fehlgeschlagen: ${err.message}`)));
      });
      req.end();
    }
  });
}

/**
 * Text nach dem Zeichensatz: Byte Order Mark, sonst der Inhaltstyp, sonst die
 * Angabe im Dokument (`<meta charset>`, `<meta http-equiv="Content-Type">`,
 * `<?xml encoding?>` in den ersten 1024 Bytes, wie Browser sie suchen), sonst UTF-8.
 */
export function decode(buf, contentType) {
  const bytes = Buffer.from(buf ?? []);
  const bom = bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])) ? 'utf-8' : bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le' : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : null;
  const charset = bom ?? /charset\s*=\s*["']?([\w.:-]+)/i.exec(contentType ?? '')?.[1] ?? declaredCharset(bytes);
  try {
    return new TextDecoder(charset ?? 'utf-8').decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

/** Zeichensatz aus dem Kopf des Dokuments oder `null`. */
function declaredCharset(bytes) {
  const head = bytes.subarray(0, 1024).toString('latin1');
  const xml = /^\s*<\?xml[^>]*\bencoding\s*=\s*["']([\w.:-]+)["']/i.exec(head)?.[1];
  if (xml) return xml;
  for (const [tag] of head.matchAll(/<meta\b[^>]*>/gi)) {
    const direct = /\bcharset\s*=\s*["']?([\w.:-]+)/i.exec(tag)?.[1];
    if (direct) return direct;
  }
  return null;
}
