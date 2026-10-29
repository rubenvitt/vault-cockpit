'use strict';

/*
 * Cockpit Sync (VCP-121): Obsidian-Plugin, das den Vault über `/sync/v1` mit
 * dem Cockpit abgleicht, auf Desktop und Mobil. Nur Vault-API, requestUrl und
 * WebCrypto, kein Node. Bewusst eine einzige Datei ohne Build-Schritt; die
 * Sync-Logik (createSyncEngine, createApi) hängt nicht an Obsidian und wird
 * unter Node getestet (test/obsidian-plugin.test.js).
 *
 * Ablauf eines Abgleichs: holen, schicken, noch einmal holen.
 * - Holen: Änderungen seit `cursor` (beim ersten Mal der ganze Stand). Was
 *   lokal unverändert ist, wird übernommen bzw. gelöscht (in den
 *   Obsidian-Papierkorb). Ist eine Datei auf beiden Seiten geändert, bleibt
 *   sie fürs Schicken liegen.
 * - Schicken: jede lokal geänderte Datei mit der zuletzt bekannten Fassung als
 *   Basis. Konflikte löst der Server (VCP-122: zusammenführen oder
 *   Konfliktkopie); weicht sein Ergebnis ab, wird es geholt. Lokal gelöschte
 *   Dateien werden auf dem Server gelöscht, außer sie wurden dort inzwischen
 *   geändert (dann kommen sie zurück).
 *
 * Gemerkt wird je Datei die Fassung des Servers (Hash) und Größe und mtime
 * der lokalen Datei dazu; so muss nur neu gehasht werden, was sich geändert hat.
 */

let obsidian = null;
try {
  obsidian = require('obsidian');
} catch {
  // Unter Node (Tests) gibt es nur die Sync-Logik.
}

const VERSION = '0.1.0';
const isHidden = (path) => path.split('/').some((part) => part.startsWith('.'));

async function sha256(data) {
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

class SyncHttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * Protokoll-Client. `request(method, path, params, body)` liefert
 * `{status, headers, body: ArrayBuffer}`; die Kopfzeilen in Kleinbuchstaben.
 */
function createApi(request) {
  const text = (r) => new TextDecoder().decode(r.body);
  const json = (r) => {
    try {
      return JSON.parse(text(r));
    } catch {
      return {};
    }
  };
  const check = (r) => {
    if (r.status === 200) return r;
    if (r.status === 401) throw new SyncHttpError(401, 'Token ungültig oder ohne Recht „Sync“');
    if (r.status === 503) throw new SyncHttpError(503, 'Eigener Sync ist im Cockpit aus (Einstellungen → Sync)');
    throw new SyncHttpError(r.status, json(r).error || `HTTP ${r.status}`);
  };
  return {
    async state() {
      return json(check(await request('GET', '/sync/v1/state')));
    },
    async changes(since) {
      return json(check(await request('GET', '/sync/v1/changes', { since: String(since) })));
    },
    /** Inhalt und Fassung einer Datei, oder null, wenn es sie nicht (mehr) gibt. */
    async get(path) {
      const r = await request('GET', '/sync/v1/file', { path });
      if (r.status === 404) return null;
      check(r);
      return { data: r.body, hash: r.headers['x-sync-hash'], mtime: Number(r.headers['x-sync-mtime']) || null };
    },
    async put(path, data, base, mtime) {
      const params = { path, base: base || '' };
      if (mtime) params.mtime = String(Math.floor(mtime));
      const r = await request('POST', '/sync/v1/file', params, data);
      if (r.status === 401 || r.status === 503) check(r);
      return { status: r.status, body: json(r) };
    },
    async del(path, base) {
      const r = await request('POST', '/sync/v1/delete', { path, base: base || '' });
      if (r.status === 401 || r.status === 503) check(r);
      return { status: r.status, body: json(r) };
    },
  };
}

/**
 * Sync-Logik. `fs` ist der lokale Vault:
 * `list() → [{path, size, mtime}]`, `stat(path) → {size, mtime} | null`,
 * `read(path) → ArrayBuffer`, `write(path, data, mtime)`, `remove(path)`.
 * `state` (`{cursor, files}`) wird fortgeschrieben und mit `save` gesichert.
 */
function createSyncEngine({ fs, api, state, save = async () => {}, log = () => {} }) {
  if (!state.files) state.files = {};
  if (state.cursor === undefined) state.cursor = null;
  let stats;

  const remember = (path, hash, st) => {
    state.files[path] = { hash, size: st.size, mtime: st.mtime };
  };

  /** Lokaler Stand mit Hash; gehasht wird nur, wenn sich Größe oder mtime geändert haben. */
  async function local(path) {
    const st = await fs.stat(path);
    if (!st) return null;
    const known = state.files[path];
    if (known && known.size === st.size && known.mtime === st.mtime) return { ...st, hash: known.hash };
    const data = await fs.read(path);
    return { ...st, hash: await sha256(data), data };
  }

  /**
   * Holt die Fassung des Servers. `expect` ist der Hash, den die lokale Datei
   * haben muss, damit sie überschrieben werden darf (null = darf nicht existieren,
   * undefined = egal); sonst bleibt sie fürs Schicken liegen.
   */
  async function download(path, expect) {
    if (expect !== undefined) {
      const now = await local(path);
      if ((now?.hash ?? null) !== expect) return false;
    }
    const got = await api.get(path);
    if (!got) return false;
    await fs.write(path, got.data, got.mtime);
    remember(path, got.hash, await fs.stat(path));
    stats.down += 1;
    return true;
  }

  async function removeLocal(path) {
    await fs.remove(path);
    delete state.files[path];
    stats.removed += 1;
  }

  async function applyRemote({ path, hash }) {
    if (isHidden(path)) return;
    const known = state.files[path];
    if (known && known.hash === hash) return;
    const mine = await local(path);
    if (hash === null) {
      if (!mine) delete state.files[path];
      else if (known && mine.hash === known.hash) await removeLocal(path);
      // Sonst lokal geändert: Ändern gewinnt, das Schicken stellt sie wieder her.
      return;
    }
    // Lokal gelöscht und dort geändert: Ändern gewinnt.
    if (!mine) return void (await download(path, null));
    if (mine.hash === hash) return remember(path, hash, mine);
    if (known && mine.hash === known.hash) return void (await download(path, known.hash));
    // Auf beiden Seiten geändert: das Schicken lässt den Server zusammenführen.
  }

  async function pull() {
    if (state.cursor === null) {
      // Erster Abgleich (oder neuer Server): alles vergleichen, nichts vorausgesetzt.
      state.files = {};
      const snap = await api.state();
      for (const entry of snap.files) await applyRemote(entry);
      state.cursor = snap.cursor;
      return;
    }
    for (;;) {
      const page = await api.changes(state.cursor);
      if (page.cursor < state.cursor) {
        // Der Server zählt neu (Journal neu aufgebaut): einmal komplett abgleichen.
        log('Sync: Server-Stand ist neu, gleiche komplett ab');
        state.cursor = null;
        return pull();
      }
      for (const entry of page.changes) await applyRemote(entry);
      state.cursor = page.cursor;
      if (!page.more) return;
    }
  }

  async function push() {
    const seen = new Set();
    for (const f of await fs.list()) {
      if (isHidden(f.path)) continue;
      seen.add(f.path);
      const known = state.files[f.path];
      if (known && known.size === f.size && known.mtime === f.mtime) continue;
      const mine = await local(f.path);
      if (!mine) continue;
      if (known && mine.hash === known.hash) {
        remember(f.path, mine.hash, mine);
        continue;
      }
      await upload(f.path, mine);
    }
    for (const path of Object.keys(state.files)) {
      if (seen.has(path) || isHidden(path)) continue;
      if (await fs.stat(path)) continue;
      const res = await api.del(path, state.files[path].hash);
      if (res.status !== 200) {
        stats.problems.push(`${path}: ${res.body.error || `HTTP ${res.status}`}`);
        continue;
      }
      if (res.body.entry?.hash) {
        // Auf dem Server inzwischen geändert: die Datei kommt zurück.
        await download(path, null);
      } else {
        delete state.files[path];
        stats.up += 1;
      }
    }
  }

  async function upload(path, mine) {
    const data = mine.data ?? (await fs.read(path));
    const res = await api.put(path, data, state.files[path]?.hash ?? null, mine.mtime);
    if (res.status !== 200) {
      // 409 heißt: gerade geändert, beim nächsten Mal wieder. 413/400/case: bleibt lokal.
      if (res.status !== 409 || res.body.error === 'case') stats.problems.push(`${path}: ${res.body.error || `HTTP ${res.status}`}`);
      return;
    }
    const { entry, resolution } = res.body;
    stats.up += 1;
    if (resolution === 'copy') stats.conflicts.push(res.body.copy.path);
    if (entry.hash === mine.hash) remember(path, entry.hash, mine);
    // Zusammengeführt oder Server behält seine Fassung (die eigene liegt als Kopie dort).
    else await download(path, mine.hash);
  }

  return {
    /** Ein voller Abgleich; liefert, was passiert ist. */
    async sync() {
      stats = { down: 0, up: 0, removed: 0, conflicts: [], problems: [] };
      try {
        await pull();
        await push();
        await pull();
      } finally {
        await save();
      }
      return stats;
    },
  };
}

module.exports = { createSyncEngine, createApi, sha256, SyncHttpError, isHidden };

if (obsidian) {
  const { Plugin, PluginSettingTab, Setting, Notice, Platform, requestUrl, debounce, setIcon } = obsidian;

  const DEFAULTS = { url: '', token: '', intervalMinutes: 5, state: { cursor: null, files: {} } };

  /** Lokaler Vault über die Adapter-API (sieht auch Anhänge, schreibt Bytes). */
  const vaultFs = (app) => {
    const adapter = app.vault.adapter;
    return {
      list: async () => app.vault.getFiles().map((f) => ({ path: f.path, size: f.stat.size, mtime: f.stat.mtime })),
      async stat(path) {
        const st = await adapter.stat(path);
        return st && st.type === 'file' ? { size: st.size, mtime: st.mtime } : null;
      },
      read: (path) => adapter.readBinary(path),
      async write(path, data, mtime) {
        const dir = path.split('/').slice(0, -1).join('/');
        if (dir && !(await adapter.exists(dir))) await adapter.mkdir(dir);
        await adapter.writeBinary(path, data, mtime ? { mtime } : undefined);
      },
      async remove(path) {
        const file = app.vault.getAbstractFileByPath(path);
        if (file) await app.vault.trash(file, false);
        else if (await adapter.exists(path)) await adapter.trashLocal(path);
      },
    };
  };

  module.exports = class CockpitSyncPlugin extends Plugin {
    async onload() {
      this.settings = Object.assign({}, DEFAULTS, await this.loadData());
      this.running = null;
      this.again = false;
      this.last = null;

      this.statusEl = this.addStatusBarItem();
      this.ribbon = this.addRibbonIcon('refresh-cw', 'Cockpit Sync: jetzt abgleichen', () => this.syncNow(true));
      this.addCommand({ id: 'sync-now', name: 'Jetzt abgleichen', callback: () => this.syncNow(true) });
      this.addSettingTab(new CockpitSyncSettings(this.app, this));
      this.show('bereit');

      const soon = debounce(() => this.syncNow(), 5000, true);
      this.app.workspace.onLayoutReady(() => {
        this.syncNow();
        for (const name of ['create', 'modify', 'delete', 'rename']) this.registerEvent(this.app.vault.on(name, soon));
      });
      this.restartInterval();
      // Mobil: beim Zurückkommen in die App.
      this.registerDomEvent(document, 'visibilitychange', () => {
        if (document.visibilityState === 'visible') this.syncNow();
      });
    }

    restartInterval() {
      if (this.timer) window.clearInterval(this.timer);
      const minutes = Number(this.settings.intervalMinutes) || 0;
      this.timer = minutes > 0 ? this.registerInterval(window.setInterval(() => this.syncNow(), minutes * 60_000)) : null;
    }

    show(text, error = false) {
      this.statusEl.setText(`Cockpit Sync: ${text}`);
      this.statusEl.toggleClass('mod-warning', error);
      this.ribbon.setAttribute('aria-label', `Cockpit Sync: ${text}`);
    }

    async saveSettings() {
      await this.saveData(this.settings);
    }

    request(method, path, params = {}, body) {
      const base = this.settings.url.replace(/\/+$/, '');
      return requestUrl({
        url: `${base}${path}?${new URLSearchParams(params)}`,
        method,
        headers: { authorization: `Bearer ${this.settings.token}`, 'x-sync-client': `obsidian-plugin/${VERSION}` },
        body,
        contentType: body ? 'application/octet-stream' : undefined,
        throw: false,
      }).then((r) => ({
        status: r.status,
        headers: Object.fromEntries(Object.entries(r.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v])),
        body: r.arrayBuffer,
      }));
    }

    /** Ein Abgleich zur Zeit; was währenddessen ausgelöst wird, läuft danach einmal. */
    async syncNow(manual = false) {
      if (!this.settings.url || !this.settings.token) {
        this.show('nicht eingerichtet', true);
        if (manual) new Notice('Cockpit Sync: Cockpit-URL und Token in den Einstellungen eintragen');
        return;
      }
      if (this.running) {
        this.again = true;
        return this.running;
      }
      this.running = (async () => {
        do {
          this.again = false;
          this.show('gleicht ab …');
          try {
            const engine = createSyncEngine({
              fs: vaultFs(this.app),
              api: createApi((...a) => this.request(...a)),
              state: this.settings.state,
              save: () => this.saveSettings(),
              log: (m) => console.log(m),
            });
            const s = await engine.sync();
            this.last = new Date();
            const time = this.last.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            this.show(s.problems.length ? `${time}, ${s.problems.length} Problem(e)` : `✓ ${time}`, s.problems.length > 0);
            if (s.conflicts.length) new Notice(`Cockpit Sync: Konflikt, deine Fassung liegt als Kopie daneben:\n${s.conflicts.join('\n')}`, 15000);
            if (s.problems.length) console.warn('Cockpit Sync:', s.problems);
            if (manual) new Notice(`Cockpit Sync: ${s.down} geholt, ${s.up} geschickt, ${s.removed} gelöscht`);
          } catch (err) {
            this.show(Platform.isMobile ? 'offline?' : `Fehler: ${err.message}`, true);
            if (manual || err.status === 401) new Notice(`Cockpit Sync: ${err.message}`);
            this.again = false;
          }
        } while (this.again);
      })();
      try {
        await this.running;
      } finally {
        this.running = null;
      }
    }
  };

  class CockpitSyncSettings extends PluginSettingTab {
    constructor(app, plugin) {
      super(app, plugin);
      this.plugin = plugin;
    }

    display() {
      const { containerEl } = this;
      const s = this.plugin.settings;
      containerEl.empty();
      new Setting(containerEl)
        .setName('Cockpit-URL')
        .setDesc('Adresse des Vault-Cockpits, z. B. https://vault.example.org')
        .addText((t) =>
          t.setPlaceholder('https://…').setValue(s.url).onChange(async (v) => {
            const url = v.trim();
            // Anderer Server: beim nächsten Mal komplett abgleichen.
            if (url.replace(/\/+$/, '') !== s.url.replace(/\/+$/, '')) s.state = { cursor: null, files: {} };
            s.url = url;
            await this.plugin.saveSettings();
          }),
        );
      new Setting(containerEl)
        .setName('Geräte-Token')
        .setDesc('Im Cockpit unter Einstellungen → API-Tokens mit dem Recht „Sync“ anlegen, ein Token je Gerät.')
        .addText((t) => {
          t.inputEl.type = 'password';
          t.setValue(s.token).onChange(async (v) => {
            s.token = v.trim();
            await this.plugin.saveSettings();
          });
        });
      new Setting(containerEl)
        .setName('Abgleich alle … Minuten')
        .setDesc('Zusätzlich gleicht das Plugin beim Start, nach Änderungen und beim Zurückkommen in die App ab. 0 = nur dann.')
        .addText((t) =>
          t.setValue(String(s.intervalMinutes)).onChange(async (v) => {
            s.intervalMinutes = Math.max(0, Number.parseInt(v, 10) || 0);
            await this.plugin.saveSettings();
            this.plugin.restartInterval();
          }),
        );
      new Setting(containerEl)
        .setName('Jetzt abgleichen')
        .setDesc(this.plugin.last ? `Zuletzt: ${this.plugin.last.toLocaleString()}` : 'Noch kein Abgleich in dieser Sitzung.')
        .addButton((b) => {
          setIcon(b.buttonEl, 'refresh-cw');
          b.onClick(() => this.plugin.syncNow(true));
        });
    }
  }
}
