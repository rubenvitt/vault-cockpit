import { Worker } from 'node:worker_threads';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';

/** Layout im Worker-Thread: ForceAtlas2 über ein paar tausend Notizen braucht Sekunden. */
export function layoutInWorker(input) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./whole-layout-worker.js', import.meta.url), { workerData: input });
    worker.once('message', resolve);
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (code !== 0) reject(new Error(`Layout-Worker beendet mit Code ${code}`));
    });
  });
}

const sha = (s) => createHash('sha256').update(s).digest('base64url');
const topFolder = (path) => (path.includes('/') ? path.slice(0, path.indexOf('/')) : '');

/**
 * Graph über den ganzen Vault (VCP-40): alle eigenen, nicht vertraulichen
 * Notizen mit ihren Wikilinks, Positionen serverseitig mit ForceAtlas2
 * vorberechnet. Readwise-Importe, vertrauliche und ausgeschlossene Notizen
 * fehlen, wie im Graphen um eine Notiz.
 *
 * Gerechnet wird beim Start und, gebündelt, nach Änderungen am Index. Hat
 * sich an Notizen und Links nichts geändert (der periodische Komplettaufbau),
 * bleibt das Layout, nur Titel werden neu gelesen. Die Positionen liegen in
 * `file`, damit ein Neustart sofort ein Bild hat und das nächste Layout dort
 * weitermacht, statt neu zu würfeln. Während gerechnet wird, liefert `get()`
 * den letzten Stand.
 *
 * Antwort (`payload`) knapp, weil sie aufs iPhone geht: `nodes` als
 * `[pfad, titel, ordner, typ, x, y]` mit Indizes in `folders` und `types`
 * (`-1` ohne Typ), `links` flach als Knotenindizes `[a, b, a, b, …]`.
 */
export function createWholeGraph({ index, file = null, layout = layoutInWorker, debounceMs = 5000, logger = console, now = () => Date.now() }) {
  let snapshot = null;
  let running = null;
  let dirty = true;
  let timer = null;
  // Stand aus der Datei: Signatur von Notizen und Links und die Positionen dazu.
  let { signature: savedSignature, positions } = load();

  function load() {
    if (!file) return { signature: null, positions: new Map() };
    try {
      const data = JSON.parse(readFileSync(file, 'utf8'));
      return { signature: data.signature ?? null, positions: new Map(Object.entries(data.positions ?? {})) };
    } catch {
      return { signature: null, positions: new Map() };
    }
  }

  function save(signature) {
    if (!file) return;
    try {
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, JSON.stringify({ signature, positions: Object.fromEntries(positions) }));
      renameSync(tmp, file);
    } catch (err) {
      logger.warn?.(`Graph-Layout nicht gespeichert: ${err.message}`);
    }
  }

  function build(notes, links, xy, signature, seconds) {
    const folders = [];
    const types = [];
    const slot = (list, value) => {
      let i = list.indexOf(value);
      if (i < 0) i = list.push(value) - 1;
      return i;
    };
    const nodes = notes.map((n, i) => [n.path, n.title || n.basename || n.path, slot(folders, topFolder(n.path)), n.type ? slot(types, n.type) : -1, xy[2 * i], xy[2 * i + 1]]);
    const payload = { version: null, builtAt: new Date(now()).toISOString(), seconds, folders, types, nodes, links };
    payload.version = sha(`${signature}|${JSON.stringify(nodes.map((n) => n[1]))}|${JSON.stringify(types)}`).slice(0, 16);
    const body = Buffer.from(JSON.stringify(payload));
    return { signature, payload, body, gzip: gzipSync(body), etag: `"${payload.version}"`, notes: notes.length, links: links.length / 2 };
  }

  async function refresh() {
    dirty = false;
    const { notes, links: pairs } = index.wholeGraph();
    const at = new Map(notes.map((n, i) => [n.path, i]));
    const links = [];
    for (const [s, t] of pairs) {
      const a = at.get(s);
      const b = at.get(t);
      if (a !== undefined && b !== undefined) links.push(a, b);
    }
    const signature = sha(`${notes.map((n) => n.path).join('\n')}|${links.join(',')}`);

    if (snapshot?.signature === signature || (!snapshot && savedSignature === signature && notes.every((n) => positions.has(n.path)))) {
      const xy = notes.flatMap((n) => positions.get(n.path));
      snapshot = build(notes, links, xy, signature, snapshot?.payload.seconds ?? null);
      return snapshot;
    }
    const started = now();
    const start = notes.map((n) => positions.get(n.path) ?? null);
    const xy = await layout({ count: notes.length, edges: links, start });
    const seconds = Math.round((now() - started) / 100) / 10;
    positions = new Map(notes.map((n, i) => [n.path, [xy[2 * i], xy[2 * i + 1]]]));
    snapshot = build(notes, links, xy, signature, seconds);
    savedSignature = signature;
    save(signature);
    logger.info?.(`Graph über den Vault: ${notes.length} Notizen, ${links.length / 2} Links, Layout in ${seconds} s`);
    return snapshot;
  }

  /** Startet eine Berechnung, falls keine läuft; Fehler landen im Log, der alte Stand bleibt. */
  function kick() {
    if (running) return running;
    running = refresh()
      .catch((err) => {
        dirty = true;
        logger.warn?.(`Graph über den Vault: Layout fehlgeschlagen — ${err.message}`);
        if (!snapshot) throw err;
        return snapshot;
      })
      .finally(() => {
        running = null;
        if (dirty && snapshot) schedule();
      });
    return running;
  }

  function schedule() {
    dirty = true;
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      kick().catch(() => {});
    }, debounceMs);
    timer.unref?.();
  }

  const unsubscribe = index.onChange?.(() => schedule()) ?? (() => {});

  return {
    /** Aktueller Stand; beim ersten Aufruf wird gewartet, danach nie mehr (Neues kommt im Hintergrund). */
    async get() {
      if (!snapshot) return kick();
      if (dirty && !running && !timer) kick().catch(() => {});
      return snapshot;
    },
    /** Rechnet sofort (beim Start). */
    warm: () => kick().catch(() => {}),
    computing: () => Boolean(running),
    stop() {
      unsubscribe();
      if (timer) clearTimeout(timer);
    },
  };
}
