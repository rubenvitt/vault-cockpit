import { grantsOf } from '../../cockpit/tokens.js';
import { SyncPathError, MAX_FILE_BYTES, SHADOW_KINDS } from './journal.js';

/** Höchstens so viele Abweichungen nimmt ein Vergleichsbericht an. */
const MAX_REPORT_DIFFS = 2000;

/**
 * Protokoll des eigenen Syncs (VCP-120), Version 1. Jedes Gerät hat einen
 * eigenen API-Token mit dem Recht „Sync“ (Einstellungen → API-Tokens); der
 * Token ist das Gerät, sein Name der Gerätename. Ein Sync-Token liest und
 * schreibt den ganzen Vault, auch vertrauliche Ordner.
 *
 * Nur GET und POST, damit es durch dieselbe CORS-Freigabe geht wie der Rest.
 *
 * - `GET  /sync/v1/state` — `{cursor, files: [{path, hash, size, mtime, seq}]}`,
 *   alle vorhandenen Dateien, für den ersten Abgleich.
 * - `GET  /sync/v1/changes?since=<seq>&limit=<n>` — `{cursor, changes, more}`,
 *   Änderungen nach `since` (älteste zuerst, höchstens 1000); `hash: null`
 *   heißt gelöscht. Mit `more` gleich weiter ab `cursor` holen.
 * - `GET  /sync/v1/file?path=…[&hash=…]` — Inhalt als Bytes, Kopfzeilen
 *   `x-sync-hash`, `x-sync-seq`, `x-sync-mtime`. Mit `hash` eine frühere
 *   Fassung aus dem Blob-Speicher (für den Merge auf dem Gerät).
 * - `POST /sync/v1/file?path=…&base=<hash>[&mtime=<ms>]` — Body: die Bytes.
 *   `base` ist die Fassung, die das Gerät zuletzt kannte, leer für „neu“.
 * - `POST /sync/v1/delete?path=…&base=<hash>` — löschen.
 *
 * Schreiben und Löschen antworten mit `{entry}`, dem Stand auf dem Server.
 * Hat der Server inzwischen eine andere Fassung, löst er das selbst und sagt
 * es in `resolution` (VCP-122): `merged` (zusammengeführt, `entry` ist das
 * Ergebnis), `copy` (Server behält seine Fassung, die des Geräts liegt als
 * `copy` daneben), `restored` (war gelöscht, die Änderung gewinnt) oder
 * `kept` (Löschen auf veralteter Basis, die Datei bleibt). Weicht
 * `entry.hash` von dem ab, was das Gerät hat, holt es die Datei neu. Ein
 * 409 `{error: "conflict", current}` kommt nur noch, wenn sich die Datei
 * gerade während des Abgleichs ändert: dann erneut versuchen. Bei
 * `error: "case"` gibt es den Pfad schon in anderer Groß-/Kleinschreibung.
 * Die Kopfzeile `x-sync-client` (z. B. `obsidian-plugin/0.1.0`) landet in der
 * Geräteliste.
 *
 * Schattenbetrieb (VCP-133): Läuft daneben noch Obsidian Sync, ist das Journal
 * nur lesend; `state` und `changes` tragen dann `readOnly: true`, Schreiben und
 * Löschen antworten mit 403 `read_only`. Geräte vergleichen nur und melden das
 * Ergebnis mit `POST /sync/v1/report` (JSON `{compared, diffs: [{path, kind,
 * since}]}`, `kind` ist `only_local`, `only_server` oder `different`).
 */
export function createSyncHttp({ tokens, journal: journalOf, onWrite = () => {}, maxFileBytes = MAX_FILE_BYTES, logger = console }) {
  // Das Journal gibt es nur, solange der eigene Sync eingestellt ist (Einstellungen → Sync).
  const current = typeof journalOf === 'function' ? journalOf : () => journalOf;

  const json = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };

  function device(req) {
    const m = /^Bearer (\S+)$/.exec(String(req.headers.authorization ?? ''));
    const t = m && tokens.find(m[1]);
    if (!t || !grantsOf(t.scope).includes('sync')) return null;
    const client = String(req.headers['x-sync-client'] ?? '').slice(0, 100) || null;
    return { id: t.id, name: t.name, client };
  }

  function readBody(req, limit = maxFileBytes) {
    return new Promise((resolve, reject) => {
      const declared = Number(req.headers['content-length']);
      if (Number.isFinite(declared) && declared > limit) return reject(Object.assign(new Error('zu groß'), { tooLarge: true }));
      const chunks = [];
      let size = 0;
      req.on('data', (c) => {
        size += c.length;
        if (size > limit) {
          reject(Object.assign(new Error('zu groß'), { tooLarge: true }));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }

  const intParam = (value, fallback) => {
    if (value === null || value === '') return fallback;
    const n = Number(value);
    return Number.isInteger(n) && n >= 0 ? n : null;
  };
  const hashParam = (value) => (value ? (/^[0-9a-f]{64}$/.test(value) ? value : undefined) : null);

  function result(res, out, path) {
    if (out.ok) {
      if (!out.unchanged) onWrite(path);
      if (out.copy) onWrite(out.copy.path);
      const body = { entry: out.entry };
      if (out.resolution) body.resolution = out.resolution;
      if (out.copy) body.copy = out.copy;
      return json(res, 200, body);
    }
    if (out.reason === 'too_large') return json(res, 413, { error: 'too_large' });
    if (out.reason === 'read_only') return json(res, 403, { error: 'read_only', error_description: 'Schattenbetrieb: das Cockpit vergleicht nur, es schreibt nichts' });
    return json(res, 409, { error: out.reason, current: out.current ?? null });
  }

  const routes = {
    'GET /sync/v1/state': (req, res, url, dev, journal) => {
      const snap = journal.snapshot();
      journal.seen(dev, { pulled: true, cursor: snap.cursor });
      return json(res, 200, journal.readOnly ? { ...snap, readOnly: true } : snap);
    },

    'GET /sync/v1/changes': (req, res, url, dev, journal) => {
      const since = intParam(url.searchParams.get('since'), 0);
      const limit = intParam(url.searchParams.get('limit'), 1000);
      if (since === null || limit === null || limit < 1) return json(res, 400, { error: '„since“ und „limit“ müssen ganze Zahlen ab 0 bzw. 1 sein' });
      const out = journal.changes(since, Math.min(limit, 1000));
      journal.seen(dev, { pulled: true, cursor: out.cursor });
      return json(res, 200, journal.readOnly ? { ...out, readOnly: true } : out);
    },

    'GET /sync/v1/file': (req, res, url, dev, journal) => {
      const path = url.searchParams.get('path');
      const hash = hashParam(url.searchParams.get('hash'));
      if (hash === undefined) return json(res, 400, { error: '„hash“ ist kein SHA-256' });
      if (hash) {
        const data = journal.blob(hash);
        if (!data) return json(res, 404, { error: 'not_found' });
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'cache-control': 'no-store', 'x-sync-hash': hash });
        return res.end(data);
      }
      const found = journal.read(path);
      if (!found) return json(res, 404, { error: 'not_found' });
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'cache-control': 'no-store',
        'x-sync-hash': found.entry.hash,
        'x-sync-seq': String(found.entry.seq),
        'x-sync-mtime': String(found.entry.mtime),
      });
      return res.end(found.data);
    },

    'POST /sync/v1/file': async (req, res, url, dev, journal) => {
      const path = url.searchParams.get('path');
      const base = hashParam(url.searchParams.get('base'));
      if (base === undefined) return json(res, 400, { error: '„base“ ist kein SHA-256' });
      const mtime = intParam(url.searchParams.get('mtime'), null);
      let data;
      try {
        data = await readBody(req);
      } catch (err) {
        if (err.tooLarge) return json(res, 413, { error: 'too_large' });
        throw err;
      }
      const out = journal.put(path, data, { base, mtime, device: dev.id, deviceName: dev.name });
      journal.seen(dev, { pushed: true });
      return result(res, out, path);
    },

    'POST /sync/v1/report': async (req, res, url, dev, journal) => {
      let body;
      try {
        body = JSON.parse((await readBody(req, 4 * 1024 * 1024)).toString('utf8'));
      } catch (err) {
        if (err.tooLarge) return json(res, 413, { error: 'too_large' });
        return json(res, 400, { error: 'Bericht ist kein JSON' });
      }
      const diffs = Array.isArray(body?.diffs) ? body.diffs : null;
      if (!diffs || diffs.length > MAX_REPORT_DIFFS) return json(res, 400, { error: `„diffs“ fehlt oder hat mehr als ${MAX_REPORT_DIFFS} Einträge` });
      const clean = [];
      for (const d of diffs) {
        if (typeof d?.path !== 'string' || !d.path || d.path.length > 1024 || !SHADOW_KINDS.includes(d.kind)) return json(res, 400, { error: 'Abweichung braucht „path“ und „kind“' });
        clean.push({ path: d.path, kind: d.kind, since: Number.isFinite(d.since) ? d.since : null });
      }
      const compared = Number.isInteger(body.compared) && body.compared >= 0 ? body.compared : 0;
      journal.report(dev, { compared, diffs: clean });
      journal.seen(dev, { pulled: true });
      return json(res, 200, { ok: true, open: clean.length });
    },

    'POST /sync/v1/delete': (req, res, url, dev, journal) => {
      const path = url.searchParams.get('path');
      const base = hashParam(url.searchParams.get('base'));
      if (base === undefined) return json(res, 400, { error: '„base“ ist kein SHA-256' });
      const out = journal.remove(path, { base, device: dev.id });
      journal.seen(dev, { pushed: true });
      return result(res, out, path);
    },
  };

  return {
    matches: (path) => path.startsWith('/sync/v1/'),

    async handle(req, res, url) {
      const dev = device(req);
      if (!dev) return json(res, 401, { error: 'unauthorized' });
      const journal = current();
      if (!journal) return json(res, 503, { error: 'sync_off', error_description: 'Der eigene Sync ist nicht eingeschaltet (Einstellungen → Sync)' });
      const route = routes[`${req.method} ${url.pathname}`];
      if (!route) {
        const known = Object.keys(routes).some((k) => k.endsWith(` ${url.pathname}`));
        return json(res, known ? 405 : 404, { error: known ? 'method not allowed' : 'not_found' });
      }
      try {
        return await route(req, res, url, dev, journal);
      } catch (err) {
        if (err instanceof SyncPathError) return json(res, 400, { error: err.message });
        logger.error?.(`Sync: ${req.method} ${url.pathname} fehlgeschlagen:`, err.message);
        return json(res, 500, { error: 'server_error' });
      }
    },
  };
}
