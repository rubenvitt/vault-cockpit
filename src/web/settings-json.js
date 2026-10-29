import { DEFAULT_HIDDEN_EVENTS, MAX_CALENDARS, SettingsError } from '../cockpit/settings.js';
import { MIN_PASSPHRASE } from '../cockpit/backup.js';
import { maskSecrets } from '../health/mask.js';
import { EPISODE_LANGUAGES, DEFAULT_EPISODE_LANGUAGE } from '../lesen/languages.js';

/**
 * Einstellungen als JSON für die native App (`/api/einstellungen…`, src/web/http.js):
 * dieselben Abschnitte, Felder, Stände und Texte wie die Seite `/einstellungen`
 * (src/web/render.js), damit die App das Formular ohne eigenes Wissen über die
 * Felder bauen kann. Geheimnisse (Tokens, Passwörter, Kalenderadressen) gehen nie
 * hinaus, nur ob sie gesetzt sind; ein leeres Feld behält den gespeicherten Wert.
 *
 * Gespeichert wird mit denselben Feldnamen wie das HTML-Formular (`fromForm`).
 * `mergeSettingsForm` legt die geschickten Felder über den gespeicherten Stand,
 * die App darf also auch nur einzelne Felder schicken.
 */

export const KIND_LABELS = { ical: 'iCal-Abo', caldav: 'CalDAV' };
export const SCOPE_LABELS = { search: 'Suche', capture: 'Capture', lesestapel: 'Lesestapel', app: 'App', sync: 'Sync' };
/** Was ein Token mit diesem Recht darf, wie auf der Einstellungsseite. */
const SCOPE_TEXT = {
  search: 'GET /api/search (ohne vertrauliche Ordner)',
  capture: '/capture und /funke, nur neue Notizen und Zunder-Aufgaben',
  lesestapel: '/lesestapel/speichern, nur Artikel und PDFs in den Eingang',
  app: 'Geräte-Token der iOS-App: /api/…, Aktionen und alles, was Lesestapel darf',
  sync: 'Ein Gerät des eigenen Syncs: /sync/v1/…, liest und schreibt den ganzen Vault, auch vertrauliche Ordner',
};
const SET = 'gesetzt (leer lassen = unverändert)';

/** Adresse ohne Pfad und Abfrage: iCal-Adressen enthalten oft ein Geheimnis. */
export const maskUrl = (url) => {
  try {
    return `${new URL(url).origin}/…`;
  } catch {
    return '…';
  }
};
export const hostOf = (url) => {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
};

/** Ein Kalender ohne Antwort aus `calendars.check`, mit Termin-Zahl oder mit Fehler (wie das Schild der Seite). */
export const checkText = (check) => (check.ok ? `✓ ${check.count} ${check.count === 1 ? 'Termin' : 'Termine'} diese Woche` : check.error);

/**
 * Stand je Abschnitt für Sprungleiste und Überschriften: `[Text, Ton]` mit Ton
 * `ok`, `warn` oder `off`, oder null (ohne Punkt). Text ohne HTML.
 */
export function sectionStates({ stored, defaults: d, checks = {} }) {
  const zunder = stored.zunder.url && stored.zunder.token ? ['eigener Zugang', 'ok'] : d.zunderUrl && d.zunderToken ? [`aus der Umgebung (${d.zunderUrl})`, 'ok'] : ['nicht eingerichtet', 'off'];
  const mail = stored.mail.token
    ? stored.mail.senders.length || d.mailSenders.length
      ? ['eigener Token', 'ok']
      : ['es fehlen freigegebene Absender', 'warn']
    : d.mailToken
      ? ['Token aus der Umgebung', 'ok']
      : ['nicht eingerichtet', 'off'];
  const embed = stored.embed.url ? ['eigener Server', 'ok'] : d.embedUrl ? [`aus der Umgebung (${d.embedUrl})`, 'ok'] : ['aus, nur Volltextsuche', 'off'];
  const tts = stored.tts ?? { provider: null, key: null };
  const ttsKey = tts.key ?? d.elevenlabsKey;
  const ttsChoice = tts.provider ?? d.ttsProvider ?? (ttsKey ? 'elevenlabs' : 'geraet');
  const voice = ttsChoice !== 'elevenlabs' ? ['Gerätestimme', 'off'] : !ttsKey ? ['ElevenLabs, es fehlt der API-Key', 'warn'] : [tts.key ? 'ElevenLabs' : 'ElevenLabs, Key aus der Umgebung', 'ok'];
  const bridge = (stored.bridge.enabled ?? d.bridgeEnabled) ? ['an', 'ok'] : ['aus', 'off'];
  const flameNote = (stored.flameNote?.enabled ?? d.flameNoteEnabled ?? true) ? ['an', 'ok'] : ['aus', 'off'];
  const problems = stored.calendars.filter((c) => checks[c.id] && !checks[c.id].ok).length;
  const kalender = !stored.calendars.length ? ['keine', 'off'] : problems ? [`${problems} von ${stored.calendars.length} nicht erreichbar`, 'warn'] : [`${stored.calendars.length} verbunden`, 'ok'];
  return { kalender, zunder, bruecke: bridge, 'feuer-notiz': flameNote, mail, lesestapel: null, embeddings: embed, vorlesen: voice, anzeige: null, anmeldung: null };
}

/** Abschnitte der Seite in ihrer Reihenfolge; Tokens, Kurzbefehle und Sicherung nur, wenn es sie gibt. */
export function sectionNav({ tokens = false, shortcuts = false, backup = false } = {}) {
  return [
    ['kalender', 'Kalender'],
    ['zunder', 'Zunder'],
    ['bruecke', 'Zunder-Brücke'],
    ['feuer-notiz', 'Feuer-Notiz'],
    ['mail', 'Mail'],
    ['lesestapel', 'Lesestapel'],
    ['embeddings', 'Embeddings'],
    ['vorlesen', 'Vorlesen'],
    ['anzeige', 'Anzeige'],
    ['anmeldung', 'Anmeldung'],
    ...(tokens ? [['tokens', 'API-Tokens']] : []),
    ...(shortcuts ? [['kurzbefehle', 'Kurzbefehle']] : []),
    ...(backup ? [['sicherung', 'Sicherung']] : []),
  ];
}

const str = (v) => (v === null || v === undefined ? '' : String(v));
const choice = (v) => (v === true ? 'an' : v === false ? 'aus' : '');

/**
 * Ein Feld: `kind` ist `text`, `number`, `list` (mit Komma), `select` (mit `options`)
 * oder `secret` (nie mit Wert; `set` sagt, ob ein eigener gespeichert ist, `clear`
 * nennt den Haken „… löschen“, den es nur dann gibt). `group`: Unterabschnitt
 * (`collapsed`: auf der Seite zugeklappt).
 */
const field = (name, label, { kind = 'text', value = '', placeholder = '', hint = null, options = null, group = null, collapsed = false, set = undefined, clear = undefined, clearLabel = undefined } = {}) => ({
  name,
  label,
  hint,
  kind,
  value: kind === 'secret' ? '' : str(value),
  placeholder: str(placeholder),
  ...(options ? { options } : {}),
  group,
  collapsed,
  ...(kind === 'secret' ? { set: Boolean(set), clear: clear ?? null, clearLabel: clear ? clearLabel : null } : {}),
});
const onOff = (stdOn) => [
  { value: '', label: `Standard (${stdOn ? 'an' : 'aus'})` },
  { value: 'an', label: 'an' },
  { value: 'aus', label: 'aus' },
];
/** Sprache der Folgen: Standard (Deutsch) und die übrigen. */
export const languageOptions = (d) => [
  { value: '', label: `Standard (${EPISODE_LANGUAGES[d.episodeLanguage] ?? EPISODE_LANGUAGES[DEFAULT_EPISODE_LANGUAGE]})` },
  ...Object.entries(EPISODE_LANGUAGES).map(([value, label]) => ({ value, label })),
];

/** Felder und Einleitung je Abschnitt des großen Formulars. */
function formSections(stored, d) {
  const tts = stored.tts ?? { provider: null, key: null, voice: null, model: null };
  const ttsDefault = (d.ttsProvider ?? (d.elevenlabsKey ? 'elevenlabs' : 'geraet')) === 'elevenlabs' ? 'ElevenLabs' : 'Gerät';
  const s = stored.session ?? {};
  return {
    kalender: {
      intro: 'Termine aus iCal-Abos (z. B. Outlook, Google) und CalDAV (z. B. Fastmail, iCloud) erscheinen in der Woche.',
      fields: [field('hiddenEvents', 'Ausgeblendete Termine', { kind: 'list', hint: 'Titel, durch Komma getrennt; leer = alle zeigen', value: (stored.hiddenEvents ?? DEFAULT_HIDDEN_EVENTS).join(', ') })],
    },
    zunder: {
      intro: 'Eigener Zugang statt dem aus der Umgebung. Leer lassen, um den aus der Umgebung zu nutzen.',
      fields: [
        field('zunder.url', 'Adresse', { value: stored.zunder.url, placeholder: d.zunderUrl ?? 'https://zunder.example' }),
        field('zunder.token', 'API-Token', { kind: 'secret', hint: 'zt_…', placeholder: stored.zunder.token ? SET : '', set: stored.zunder.token, clear: stored.zunder.token ? 'zunder.clear' : null, clearLabel: 'eigenen Zugang löschen' }),
      ],
    },
    bruecke: {
      intro: 'Offene Checkboxen mit dem Tag werden Zunder-Aufgaben, Abhaken gleicht sich in beide Richtungen ab.',
      fields: [
        field('bridge.enabled', 'Brücke', { kind: 'select', value: choice(stored.bridge.enabled), options: onOff(d.bridgeEnabled) }),
        field('bridge.tag', 'Tag', { hint: 'ohne #', value: stored.bridge.tag, placeholder: d.bridgeTag }),
      ],
    },
    'feuer-notiz': {
      intro: 'Trägt die Flammen der Woche mit den in Zunder gemessenen Minuten in den Abschnitt „Flammen“ der Feuer-Notiz ein, nach jedem Stopp und im Reindex-Intervall. Geschrieben wird nur zwischen den Markern cockpit:flammen.',
      fields: [field('flameNote.enabled', 'Flammen eintragen', { kind: 'select', value: choice(stored.flameNote?.enabled ?? null), options: onOff(d.flameNoteEnabled ?? true) })],
    },
    mail: {
      intro: 'Holt Mails aus einem Fastmail-Ordner ab und macht Notizen daraus, mit ! im Betreff Zunder-Aufgaben.',
      fields: [
        field('mail.token', 'Fastmail-API-Token', { kind: 'secret', hint: 'nur Mail', placeholder: stored.mail.token ? SET : '', set: stored.mail.token, clear: stored.mail.token ? 'mail.clear' : null, clearLabel: 'eigenen Token löschen' }),
        field('mail.senders', 'Freigegebene Absender', { kind: 'list', hint: 'mit Komma', value: stored.mail.senders.join(', '), placeholder: d.mailSenders.join(', ') || 'r@example.dev, @example.dev' }),
        ...[
          field('mail.mailbox', 'Ordner zum Abholen', { value: stored.mail.mailbox, placeholder: d.mailbox }),
          field('mail.doneMailbox', 'Ablage danach', { value: stored.mail.doneMailbox, placeholder: d.doneMailbox }),
          field('mail.pollMinutes', 'Abstand in Minuten', { kind: 'number', value: stored.mail.pollMinutes, placeholder: d.mailPollMinutes }),
        ].map((f) => ({ ...f, group: 'Ordner und Abstand', collapsed: true })),
      ],
    },
    lesestapel: {
      intro: 'Gelesene Texte mit Markierungen kommen als Notiz in diesen Ordner, jede Markierung mit Block-ID zum Verlinken. Das Cockpit schreibt danach nur den Bereich „Markierungen“ neu; in vertraulichen und Readwise-Ordnern legt es nichts an.',
      fields: [
        field('readingNotes.folder', 'Ordner im Vault', { value: stored.readingNotes?.folder, placeholder: d.readingNotesFolder ?? '30-ressourcen/lesestapel' }),
        ...[
          field('ingest.nightly', 'Nachts entwerfen', { kind: 'select', value: choice(stored.ingest?.nightly ?? null), options: onOff(d.ingestNightly ?? true) }),
          field('ingest.hour', 'Uhrzeit', { kind: 'number', hint: 'volle Stunde, 0–23', value: stored.ingest?.hour, placeholder: d.ingestHour ?? 3 }),
          field('ingest.model', 'Claude-Modell', { hint: 'sonnet schont das Abo', value: stored.ingest?.model, placeholder: d.ingestModel ?? 'sonnet' }),
          field('ingest.limit', 'Höchstens je Nacht', { kind: 'number', hint: 'Texte', value: stored.ingest?.limit, placeholder: d.ingestLimit ?? 20 }),
          field('ingest.agent', 'Danach einpflanzen', { kind: 'select', hint: 'Agent arbeitet Übernommenes in die Seiten ein', value: choice(stored.ingest?.agent ?? null), options: onOff(d.ingestAgent ?? true) }),
        ].map((f) => ({ ...f, group: 'Ingest ins Wiki' })),
      ],
      groups: {
        'Ingest ins Wiki': 'Claude entwirft für Texte auf dem Stapel einen Ingest ins Mycel-Wiki; ins Wiki kommt erst, was du unter Lesen → Ingest abhakst. Braucht CLAUDE_CODE_OAUTH_TOKEN wie die Folgen.',
      },
    },
    embeddings: {
      intro: 'Ollama-Server für die semantische Suche und ähnliche Notizen. Fehlt das Modell, lädt das Cockpit es selbst. Ein neues Modell bettet den Vault neu ein.',
      fields: [
        field('embed.url', 'Adresse', { value: stored.embed.url, placeholder: d.embedUrl ?? 'http://ollama:11434' }),
        field('embed.model', 'Modell', { value: stored.embed.model, placeholder: d.embedModel }),
      ],
    },
    vorlesen: {
      intro: 'Wer bei „Unterwegs hören“ vorliest, im Browser und in der iOS-App. Mit ElevenLabs holt der Server jeden Satz als Audio, der Key bleibt auf dem Server. Jeder Satz kostet Zeichen-Kontingent; schon Gehörtes liegt im Cache und kostet nichts mehr. Fällt ElevenLabs aus, liest das Gerät weiter.',
      fields: [
        field('tts.provider', 'Anbieter', { kind: 'select', value: tts.provider, options: [{ value: '', label: `Standard (${ttsDefault})` }, { value: 'geraet', label: 'Gerät' }, { value: 'elevenlabs', label: 'ElevenLabs' }] }),
        field('tts.key', 'ElevenLabs-API-Key', { kind: 'secret', hint: 'nur Text to Speech', placeholder: tts.key ? SET : d.elevenlabsKey ? 'aus der Umgebung' : '', set: tts.key, clear: tts.key ? 'tts.clear' : null, clearLabel: 'eigenen Key löschen' }),
        ...[
          field('tts.voice', 'Stimme', { hint: 'Voice-ID', value: tts.voice, placeholder: d.elevenlabsVoice }),
          field('tts.model', 'Modell', { hint: 'eleven_flash_v2_5 kostet die Hälfte', value: tts.model, placeholder: d.elevenlabsModel }),
        ].map((f) => ({ ...f, group: 'Stimme und Modell', collapsed: true })),
        ...[
          field('episodes.host', 'Moderation', { hint: 'Voice-ID', value: stored.episodes?.host, placeholder: tts.voice ?? d.elevenlabsVoice }),
          field('episodes.guest', 'Gast', { hint: 'Voice-ID', value: stored.episodes?.guest, placeholder: d.episodeGuestVoice }),
          field('episodes.model', 'Claude-Modell', { hint: 'sonnet schont das Abo', value: stored.episodes?.model, placeholder: d.episodeModel ?? 'sonnet' }),
          field('episodes.language', 'Sprache', { kind: 'select', hint: 'Podcast und Report', value: stored.episodes?.language, options: languageOptions(d) }),
        ].map((f) => ({ ...f, group: 'Folgen' })),
      ],
      groups: {
        Folgen: 'Podcast und Report aus dem Stapel (Lesen → Folgen). Claude schreibt sie über die Claude Code CLI mit deinem Abo; den Token aus claude setup-token bekommt das Deployment als CLAUDE_CODE_OAUTH_TOKEN. Ohne eigene Stimme moderiert die Stimme vom Vorlesen.',
      },
    },
    anzeige: {
      intro: null,
      fields: [
        field('tz', 'Zeitzone', { value: stored.tz, placeholder: d.tz }),
        field('vaultName', 'Vault-Name in Obsidian', { hint: 'für Links', value: stored.vaultName, placeholder: d.vaultName }),
        field('inboxFolder', 'Inbox-Ordner im Vault', { value: stored.inboxFolder, placeholder: d.inboxFolder }),
      ],
    },
    anmeldung: {
      intro: 'Jede Nutzung verlängert die Anmeldung. Sie endet erst nach einer Pause ohne Nutzung oder spätestens nach der Obergrenze; dann folgt wieder der Login bei Pocket ID.',
      fields: [
        field('session.idleDays', 'Abmelden nach', { kind: 'number', hint: 'Tagen ohne Nutzung', value: s.idleDays, placeholder: d.sessionIdleDays }),
        field('session.maxDays', 'Spätestens neu anmelden', { kind: 'number', hint: 'nach Tagen', value: s.maxDays, placeholder: d.sessionMaxDays }),
      ],
    },
  };
}

/**
 * Ein Kalender für die App: Felder `cal.<index>.…` beim Speichern, Adresse nur als
 * Host (wie auf der Seite), Passwort nur als `passwordSet`, `check` aus `calendars.check`.
 */
const calendarJson = (c, index, check) => ({
  index,
  id: c.id,
  name: c.name,
  kind: c.kind,
  kindLabel: KIND_LABELS[c.kind] ?? c.kind,
  host: hostOf(c.url) || null,
  address: maskUrl(c.url),
  auth: Boolean(c.username),
  username: c.username ?? '',
  passwordSet: Boolean(c.password),
  filter: c.kind === 'caldav' ? (c.filter ?? []) : [],
  check: check ? (check.ok ? { ok: true, count: check.count, text: checkText(check) } : { ok: false, error: maskSecrets(check.error, { max: 200 }), text: maskSecrets(check.error, { max: 200 }) }) : null,
});

/** API-Tokens ohne Hash; `current`: der Geräte-Token, mit dem die App gerade fragt. */
export const tokensJson = (list, currentId = null) =>
  list.map((t) => ({ id: t.id, name: t.name, scope: t.scope, scopeLabel: SCOPE_LABELS[t.scope] ?? t.scope, createdAt: t.createdAt, current: t.id === currentId }));

/** Die Rechte zur Auswahl beim Anlegen. */
export const scopesJson = () => Object.entries(SCOPE_LABELS).map(([value, label]) => ({ value, label, text: SCOPE_TEXT[value] }));

/** Texte der Abschnitte außerhalb des großen Formulars, wie auf der Seite. */
export const shortcutsIntro = (captureEnabled) =>
  `Auf dem iPhone antippen und importieren. Beim Import fragt iOS nach einem Token: „Zum Lesestapel“ braucht das Recht „Lesestapel“, die übrigen das Recht „Capture“${captureEnabled ? '' : ' (noch keiner angelegt, siehe API-Tokens)'}.`;
const TOKENS_INTRO = 'Für Kurzbefehle, Raycast und Funke. Jeder Token hat genau ein Recht; den Klartext zeigt das Cockpit nur einmal direkt nach dem Anlegen.';
const backupIntro = (status) => ({
  intro: 'Index und Vektoren baut das Cockpit nach einem Verlust von /data selbst neu, diese Dateien nicht. Die Sicherung enthält sie mit einer Passphrase verschlüsselt (scrypt und AES-256-GCM); ohne die Passphrase lässt sie sich nicht öffnen, auch nicht vom Cockpit. Einfacher ist ein Backup des Volumes auf dem Host.',
  restore: `${status.empty ? 'Das Cockpit ist noch leer (keine Einstellungen, keine API-Tokens): Sicherung wählen, Passphrase eingeben, fertig.' : 'Ersetzt Einstellungen, API-Tokens und Merkzettel durch den Stand der Sicherung.'} Danach startet das Cockpit neu; weil das Sitzungs-Secret mit zurückkommt, meldet man sich anschließend neu an.`,
});

/** Kurzbefehle zum Laden; `file` ist die Adresse der Datei (mit Geräte-Token ladbar). */
export const shortcutsJson = (shortcuts) => shortcuts.map((s) => ({ slug: s.slug, title: s.title, text: s.text, file: `/kurzbefehle/${s.slug}.shortcut`, filename: s.file }));

/** Sicherung: welche Dateien sie erfasst, ob das Cockpit noch leer ist, wie lang die Passphrase sein muss. */
export const backupJson = (status) => ({
  empty: status.empty,
  files: status.files.map(({ name, label, present }) => ({ name, label, present })),
  minPassphrase: MIN_PASSPHRASE,
  // Ohne Einstellungen und Tokens braucht das Wiederherstellen keinen Haken „Vorhandenes ersetzen“ (`ersetzen=1`).
  needsReplace: !status.empty,
  ...backupIntro(status),
});

/**
 * Alles, was die Einstellungsseite zeigt, als JSON. `checks` aus `calendars.check`,
 * `tokens` aus `tokens.list()` (oder null ohne Tokens), `backup` aus `backup.status()`.
 */
export function settingsJson({ stored, defaults, checks = {}, tokens = null, currentToken = null, shortcuts = [], captureEnabled = false, backup = null }) {
  const states = sectionStates({ stored, defaults, checks });
  const forms = {
    ...formSections(stored, defaults),
    tokens: { intro: TOKENS_INTRO },
    kurzbefehle: { intro: shortcutsIntro(captureEnabled) },
    sicherung: { intro: backup ? backupIntro(backup).intro : null },
  };
  const nav = sectionNav({ tokens: Boolean(tokens), shortcuts: shortcuts.length > 0, backup: Boolean(backup) });
  return {
    sections: nav.map(([id, title]) => {
      const state = states[id] ?? null;
      const form = forms[id];
      return { id, title, state: state ? { text: state[0], tone: state[1] } : null, intro: form?.intro ?? null, fields: form?.fields ?? [], groups: form?.groups ?? {} };
    }),
    calendars: {
      items: stored.calendars.map((c, i) => calendarJson(c, i, checks[c.id])),
      // Ein neuer Kalender bekommt die nächste freie Nummer (`cal.<next>.…`).
      next: stored.calendars.length,
      max: MAX_CALENDARS,
      kinds: Object.entries(KIND_LABELS).map(([value, label]) => ({ value, label })),
    },
    signOutEverywhere: { action: '/api/einstellungen/abmelden', label: 'Überall abmelden', text: 'Beendet die Anmeldung im Browser auf allen Geräten. Geräte-Tokens der App bleiben gültig, bis sie unter API-Tokens widerrufen werden.' },
    tokens: tokens ? tokensJson(tokens, currentToken) : null,
    scopes: tokens ? scopesJson() : null,
    shortcuts: shortcutsJson(shortcuts),
    captureEnabled: Boolean(captureEnabled),
    backup: backup ? backupJson(backup) : null,
    secretHint: 'Leere Geheimnisfelder behalten den gespeicherten Wert.',
  };
}

/** Feldnamen des großen Formulars (außer den Kalendern `cal.N.…`). */
const FIELDS = new Set([
  'tz', 'vaultName', 'inboxFolder',
  'zunder.url', 'zunder.token', 'zunder.clear',
  'bridge.enabled', 'bridge.tag', 'flameNote.enabled', 'readingNotes.folder',
  'mail.token', 'mail.clear', 'mail.senders', 'mail.mailbox', 'mail.doneMailbox', 'mail.pollMinutes',
  'embed.url', 'embed.model',
  'tts.provider', 'tts.key', 'tts.clear', 'tts.voice', 'tts.model',
  'episodes.host', 'episodes.guest', 'episodes.model', 'episodes.language',
  'ingest.nightly', 'ingest.hour', 'ingest.model', 'ingest.limit', 'ingest.agent',
  'hiddenEvents', 'session.idleDays', 'session.maxDays', 'cal.auth',
]);
const CAL_FIELD = /^cal\.(\d{1,2})\.(id|name|kind|url|auth|username|password|filter|remove)$/;
/** Haken: gesetzt heißt an; leer, `0` oder `false` heißt aus (ein Formular ließe ihn dann weg). */
const CHECKBOX = /^(?:zunder|mail|tts)\.clear$|^cal\.\d{1,2}\.(?:auth|remove)$/;
const OFF = new Set(['', '0', 'false', 'aus', 'nein']);

/**
 * Das Formular, das die Seite mit dem gespeicherten Stand schicken würde, ohne
 * etwas zu ändern: Geheimnisse leer (= unverändert), `hiddenEvents` fehlt (=
 * unverändert, auch der Standard bleibt Standard).
 */
export function formOfSettings(stored) {
  const f = new URLSearchParams();
  const put = (k, v) => f.set(k, str(v));
  put('tz', stored.tz);
  put('vaultName', stored.vaultName);
  put('inboxFolder', stored.inboxFolder);
  put('zunder.url', stored.zunder.url);
  put('bridge.enabled', choice(stored.bridge.enabled));
  put('bridge.tag', stored.bridge.tag);
  put('flameNote.enabled', choice(stored.flameNote?.enabled ?? null));
  put('readingNotes.folder', stored.readingNotes?.folder);
  put('mail.senders', stored.mail.senders.join(', '));
  put('mail.mailbox', stored.mail.mailbox);
  put('mail.doneMailbox', stored.mail.doneMailbox);
  put('mail.pollMinutes', stored.mail.pollMinutes);
  put('embed.url', stored.embed.url);
  put('embed.model', stored.embed.model);
  put('tts.provider', stored.tts?.provider);
  put('tts.voice', stored.tts?.voice);
  put('tts.model', stored.tts?.model);
  put('episodes.host', stored.episodes?.host);
  put('episodes.guest', stored.episodes?.guest);
  put('episodes.model', stored.episodes?.model);
  put('episodes.language', stored.episodes?.language);
  put('ingest.nightly', choice(stored.ingest?.nightly ?? null));
  put('ingest.hour', stored.ingest?.hour);
  put('ingest.model', stored.ingest?.model);
  put('ingest.limit', stored.ingest?.limit);
  put('ingest.agent', choice(stored.ingest?.agent ?? null));
  put('session.idleDays', stored.session?.idleDays);
  put('session.maxDays', stored.session?.maxDays);
  put('cal.auth', '1');
  stored.calendars.forEach((c, i) => {
    put(`cal.${i}.id`, c.id);
    put(`cal.${i}.name`, c.name);
    put(`cal.${i}.kind`, c.kind);
    if (c.username) put(`cal.${i}.auth`, '1');
    put(`cal.${i}.username`, c.username);
    put(`cal.${i}.filter`, (c.filter ?? []).join(', '));
  });
  return f;
}

/**
 * Geschickte Felder über den gespeicherten Stand legen (für `fromForm`). Ein
 * unbekanntes Feld ist ein Fehler (`SettingsError` mit `field`), damit sich kein
 * Tippfehler still verliert. `csrf` und `back` zählen nicht.
 */
export function mergeSettingsForm(stored, posted) {
  const form = formOfSettings(stored);
  for (const key of new Set(posted.keys())) {
    if (key === 'csrf' || key === 'back') continue;
    if (!FIELDS.has(key) && !CAL_FIELD.test(key)) throw new SettingsError(`Unbekanntes Feld „${key}“`, key);
    const value = posted.get(key) ?? '';
    if (CHECKBOX.test(key) && OFF.has(value.trim().toLowerCase())) form.delete(key);
    else form.set(key, value);
  }
  return form;
}
