import { maskSecrets } from './mask.js';
import { describeWeek, weekOf } from '../cockpit/week.js';

const iso = (ms) => (ms ? new Date(ms).toISOString() : null);

/**
 * Merkzettel für einen Dienst ohne eigenen Status: letzter Erfolg, letzter
 * Fehler mit Text und ob der jüngste Versuch scheiterte. Nur im Speicher.
 */
export function createRunLog({ now = Date.now } = {}) {
  let s = { okAt: null, errorAt: null, error: null, failing: false };
  return {
    ok() {
      s.okAt = now();
      s.failing = false;
    },
    fail(err) {
      s.errorAt = now();
      s.error = String(err?.message ?? err ?? 'unbekannter Fehler');
      s.failing = true;
    },
    reset() {
      s = { okAt: null, errorAt: null, error: null, failing: false };
    },
    snapshot: () => ({ lastOkAt: iso(s.okAt), lastErrorAt: iso(s.errorAt), lastError: s.error, failing: s.failing }),
  };
}

const SYNC_STATE = {
  synced: ['ok', 'synchron'],
  syncing: ['ok', 'gleicht ab'],
  connecting: ['ok', 'verbindet'],
  starting: ['ok', 'startet'],
  disconnected: ['error', 'Verbindung zum Server getrennt'],
  error: ['error', 'meldet einen Fehler'],
  stale: ['error', 'Sidecar meldet sich nicht mehr'],
  stopped: ['error', 'Sync-Client gestoppt'],
  unknown: ['unknown', 'Zustand unbekannt'],
  disabled: ['off', 'aus'],
};

const hostOf = (url) => {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
};
const latest = (...times) => times.filter(Boolean).sort().at(-1) ?? null;
/** Zustand einer Liste von Teilen: Fehler schlägt alles, sonst ok, wenn eins lief. */
const worst = (items) => (items.some((i) => i.state === 'error') ? 'error' : items.some((i) => i.state === 'ok') ? 'ok' : 'unknown');

/**
 * Zustand der Hintergrunddienste für die Seite „Zustand“, den Hinweis in der
 * Kopfzeile und `/health`.
 *
 * Erhoben wird nichts doppelt: Sync, Index und Embeddings liefern dieselben
 * `status()`-Daten wie `vault_stats`, Mail-Abruf, Zunder-Brücke und Kalender
 * merken sich ihren letzten Lauf selbst, der Zunder-Zugang über einen
 * Merkzettel am Client (`zunderAccess`, gefüllt bei jedem Aufruf an Zunder).
 * `services()` liest nur diesen Stand und fragt nichts im Netz ab; `check()`
 * prüft vorher Zunder und Kalender einmal frisch.
 *
 * Je Dienst: `state` (`ok` läuft, `error` Fehler, `off` aus, `unknown` noch
 * kein Lauf), ein kurzer Satz, letzter Erfolg und letzter Fehler mit Text,
 * Kennzahlen (`facts`) und bei Kalender und Brücke die einzelnen Teile
 * (`items`). Fehlertexte sind maskiert (siehe mask.js): Gegenstellen spiegeln
 * gern Adressen mit Geheimnis oder Tokens zurück.
 */
export function createHealth({
  settings,
  sync = null,
  index = null,
  semantic = () => null,
  mail = () => null,
  bridge = null,
  zunder = () => null,
  zunderAccess = null,
  calendars = null,
  flameNote = null,
  now = () => Date.now(),
}) {
  function secrets() {
    const s = settings.get();
    const d = settings.defaults?.() ?? {};
    const stored = settings.stored?.() ?? {};
    return [
      s.zunder?.token,
      d.zunderToken,
      stored.zunder?.token,
      s.mail?.token,
      d.mailToken,
      stored.mail?.token,
      ...s.calendars.flatMap((c) => [c.password, c.url]),
    ];
  }

  function syncService() {
    const s = sync?.status() ?? { adapter: 'none', state: 'disabled' };
    const [state, summary] = SYNC_STATE[s.state] ?? ['unknown', s.state];
    const stale = s.state === 'stale';
    return {
      id: 'sync',
      name: 'Sync',
      state,
      summary: s.state === 'unknown' && s.reason ? s.reason : summary,
      lastOkAt: s.lastSyncAt ?? null,
      // Ohne eigenen Fehlertext gilt beim Stillstand das letzte Lebenszeichen.
      lastErrorAt: stale && !s.lastError ? (s.heartbeatAt ?? null) : (s.lastError?.at ?? null),
      lastError: stale && !s.lastError ? s.reason : (s.lastError?.message ?? null),
      facts: s.state === 'disabled' ? [] : [
        { label: 'Letzter Abgleich', at: s.lastSyncAt ?? null },
        ...(s.heartbeatAt ? [{ label: 'Letztes Lebenszeichen', at: s.heartbeatAt }] : []),
        { label: 'Dateibeobachtung', value: s.watching ? 'an' : 'aus, nur periodischer Neuaufbau' },
        ...(s.clientVersion ? [{ label: 'Client', value: s.clientVersion }] : []),
      ],
    };
  }

  function indexService() {
    const stats = index.stats();
    const built = iso(index.lastBuiltAt?.());
    const err = index.lastError?.() ?? null;
    return {
      id: 'index',
      name: 'Index',
      state: err?.failing ? 'error' : built ? 'ok' : 'unknown',
      summary: err?.failing ? 'Aufbau fehlgeschlagen' : `${stats.total} Notizen`,
      lastOkAt: built,
      lastErrorAt: iso(err?.at),
      lastError: err?.message ?? null,
      facts: [
        { label: 'Notizen', value: `${stats.total}, davon ${stats.byClass?.core ?? 0} eigene` },
        { label: 'Letzter Aufbau', at: built },
        { label: 'Letzte Änderung', at: iso(index.lastChangedAt?.()) },
      ],
    };
  }

  function embedService() {
    const cfg = settings.get().embed;
    const base = { id: 'embeddings', name: 'Embeddings' };
    if (!cfg) return { ...base, state: 'off', summary: 'aus, nur Volltextsuche', facts: [] };
    const sem = semantic();
    if (!sem) return { ...base, state: 'unknown', summary: 'startet', facts: [{ label: 'Modell', value: cfg.model }] };
    const st = sem.status();
    const total = index?.embeddablePaths ? index.embeddablePaths().length : null;
    const pct = total ? Math.min(100, Math.round((st.notes / total) * 100)) : null;
    const state = st.state === 'error' ? 'error' : st.state === 'running' || st.lastRunAt ? 'ok' : 'unknown';
    const summary =
      st.state === 'error'
        ? 'Embedding-Server antwortet nicht wie erwartet'
        : st.state === 'running'
          ? `bettet ein${st.pending ? `, ${st.pending} ausstehend` : ''}`
          : st.lastRunAt
            ? pct === 100 ? 'vollständig' : `${pct ?? '?'} % eingebettet`
            : 'wartet auf den ersten Abgleich';
    return {
      ...base,
      state,
      summary,
      lastOkAt: st.lastRunAt,
      lastErrorAt: st.lastErrorAt,
      lastError: st.lastError,
      facts: [
        { label: 'Modell', value: st.model ?? cfg.model },
        { label: 'Fortschritt', value: total != null ? `${st.notes} von ${total} Notizen${pct != null ? ` (${pct} %)` : ''}, ${st.chunks} Abschnitte` : `${st.notes} Notizen` },
        ...(st.pending ? [{ label: 'Ausstehend', value: String(st.pending) }] : []),
        ...(hostOf(cfg.url) ? [{ label: 'Server', value: hostOf(cfg.url) }] : []),
      ],
    };
  }

  function mailService() {
    const cfg = settings.get().mail;
    const base = { id: 'mail', name: 'Mail-Abruf' };
    if (!cfg) {
      const token = settings.stored?.().mail?.token ?? settings.defaults?.().mailToken;
      return { ...base, state: 'off', summary: token ? 'aus: es fehlen freigegebene Absender' : 'nicht eingerichtet', facts: [] };
    }
    const m = mail();
    const state = !m ? 'unknown' : m.state === 'error' ? 'error' : m.state === 'ok' ? 'ok' : 'unknown';
    return {
      ...base,
      state,
      summary: !m ? 'startet' : m.state === 'error' ? 'Abruf fehlgeschlagen' : m.state === 'ok' ? `holt „${cfg.mailbox}“ ab` : 'erster Abruf läuft',
      lastOkAt: m?.lastOkAt ?? null,
      lastErrorAt: m?.lastErrorAt ?? null,
      lastError: m?.lastError ?? null,
      facts: [
        { label: 'Ordner', value: `${cfg.mailbox} → ${cfg.doneMailbox}` },
        { label: 'Abstand', value: `alle ${cfg.pollMinutes} min` },
        ...(m?.lastPollAt ? [{ label: 'Letzter Abruf', at: m.lastPollAt }, { label: 'Zuletzt verarbeitet', value: String(m.lastProcessed ?? 0) }] : []),
      ],
    };
  }

  function bridgeService() {
    const base = { id: 'bridge', name: 'Zunder-Brücke' };
    if (!bridge || !bridge.enabled()) return { ...base, state: 'off', summary: 'aus', facts: [] };
    if (!bridge.active()) return { ...base, state: 'off', summary: 'ruht, kein Zunder-Zugang', facts: [{ label: 'Tag', value: `#${bridge.tag}` }] };
    const st = bridge.status();
    const item = (name, r) => ({
      name,
      state: r.failing ? 'error' : r.okAt ? 'ok' : 'unknown',
      summary: r.failing || r.okAt ? null : 'noch kein Lauf',
      lastOkAt: r.okAt,
      lastErrorAt: r.errorAt,
      lastError: r.error,
    });
    const items = [item('Neue Checkboxen → Zunder', st.transfer), item('Abgleich erledigt/verworfen (beide Richtungen)', st.sync)];
    const state = worst(items);
    const failed = items.filter((i) => i.state === 'error');
    const last = [...items].filter((i) => i.lastErrorAt).sort((a, b) => a.lastErrorAt.localeCompare(b.lastErrorAt)).at(-1);
    return {
      ...base,
      state,
      summary: failed.length ? `Fehler: ${failed.map((i) => i.name).join(', ')}` : state === 'ok' ? `überträgt #${bridge.tag}` : 'wartet auf den ersten Lauf',
      lastOkAt: latest(st.transfer.okAt, st.sync.okAt),
      lastErrorAt: last?.lastErrorAt ?? null,
      lastError: last?.lastError ?? null,
      facts: [{ label: 'Tag', value: `#${bridge.tag}` }],
      items,
    };
  }

  /** Flammen in der Feuer-Notiz (VCP-52): Fehler, wenn der letzte Lauf scheiterte. */
  function flameNoteService() {
    const base = { id: 'flame-note', name: 'Feuer-Notiz' };
    if (!settings.get().flameNote?.enabled) return { ...base, state: 'off', summary: 'aus', facts: [] };
    const st = flameNote.status();
    const failing = Boolean(st.lastError && st.lastError.at === st.lastRun);
    const state = failing ? 'error' : st.lastOkAt ? 'ok' : 'unknown';
    return {
      ...base,
      state,
      summary: failing ? 'Flammen nicht eingetragen' : st.lastOkAt ? 'trägt die Flammen der Woche ein' : 'wartet auf den ersten Lauf',
      lastOkAt: st.lastOkAt,
      lastErrorAt: st.lastError?.at ?? null,
      lastError: st.lastError?.message ?? null,
      facts: st.lastWrite ? [{ label: 'Zuletzt geschrieben', value: `${st.lastWrite.path} (${st.lastWrite.week})` }] : [],
    };
  }

  function zunderService() {
    const z = settings.get().zunder;
    const base = { id: 'zunder', name: 'Zunder-Zugang' };
    if (!z) return { ...base, state: 'off', summary: 'nicht eingerichtet', facts: [] };
    const a = zunderAccess?.snapshot() ?? { lastOkAt: null, lastErrorAt: null, lastError: null, failing: false };
    const rejected = a.failing && /HTTP 40[13]\b/.test(a.lastError ?? '');
    return {
      ...base,
      state: a.failing ? 'error' : a.lastOkAt ? 'ok' : 'unknown',
      summary: rejected ? 'Zunder lehnt den Token ab' : a.failing ? 'Zunder nicht erreichbar' : a.lastOkAt ? 'angenommen' : 'noch nicht geprüft',
      lastOkAt: a.lastOkAt,
      lastErrorAt: a.lastErrorAt,
      lastError: a.lastError,
      facts: [
        ...(hostOf(z.url) ? [{ label: 'Adresse', value: hostOf(z.url) }] : []),
        { label: 'Quelle', value: z.source === 'einstellungen' ? 'Einstellungen' : 'Umgebung' },
      ],
    };
  }

  function calendarService() {
    const base = { id: 'calendars', name: 'Kalender' };
    const list = settings.get().calendars;
    if (!list.length || !calendars) return { ...base, state: 'off', summary: 'keine Kalender', facts: [] };
    const items = (calendars.status?.() ?? []).map((c) => ({
      name: c.name,
      state: c.failing ? 'error' : c.lastOkAt ? 'ok' : 'unknown',
      summary: c.failing ? null : c.lastOkAt ? `${c.count} ${c.count === 1 ? 'Termin' : 'Termine'} im letzten Abruf` : 'noch nicht abgerufen',
      lastOkAt: c.lastOkAt,
      lastErrorAt: c.lastErrorAt,
      lastError: c.lastError,
    }));
    const failed = items.filter((i) => i.state === 'error');
    const last = [...items].filter((i) => i.state === 'error' && i.lastErrorAt).sort((a, b) => a.lastErrorAt.localeCompare(b.lastErrorAt)).at(-1);
    return {
      ...base,
      state: worst(items),
      summary: failed.length ? `${failed.length} von ${items.length} nicht erreichbar` : `${items.length} Kalender`,
      lastOkAt: latest(...items.map((i) => i.lastOkAt)),
      lastErrorAt: last?.lastErrorAt ?? null,
      lastError: last ? `${last.name}: ${last.lastError}` : null,
      facts: [],
      items,
    };
  }

  /** Alle Dienste mit maskierten Fehlertexten, ohne Netzabfrage. */
  function services() {
    const hidden = secrets();
    const clean = (s) => ({
      lastOkAt: null,
      lastErrorAt: null,
      lastError: null,
      ...s,
      ...(s.lastError ? { lastError: maskSecrets(s.lastError, { secrets: hidden }) } : {}),
      ...(s.summary ? { summary: maskSecrets(s.summary, { secrets: hidden, max: 200 }) } : {}),
      ...(s.items ? { items: s.items.map(clean) } : {}),
    });
    return [syncService(), ...(index ? [indexService()] : []), embedService(), mailService(), bridgeService(), ...(flameNote ? [flameNoteService()] : []), zunderService(), calendarService()].map(clean);
  }

  return {
    services,

    /** Dienste mit Fehler, knapp für die Kopfzeile. */
    failing: () => services().filter((s) => s.state === 'error').map(({ id, name }) => ({ id, name })),

    /** Für `/health`: steht irgendwo ein Fehler? Ohne Details. */
    degraded() {
      try {
        return services().some((s) => s.state === 'error');
      } catch {
        return true;
      }
    },

    /** Zunder und Kalender einmal frisch prüfen, dann `services()`. */
    async check() {
      const { tz, zunder: z, calendars: list } = settings.get();
      const jobs = [];
      const client = z ? zunder() : null;
      // Leichteste Abfrage; der Merkzettel am Client hält das Ergebnis fest.
      if (client?.listStructure) jobs.push(client.listStructure());
      if (calendars?.check && list.length) {
        const week = describeWeek(weekOf(new Date(now()), tz), tz);
        jobs.push(calendars.check(week.start, week.end));
      }
      await Promise.allSettled(jobs);
      return services();
    },
  };
}
