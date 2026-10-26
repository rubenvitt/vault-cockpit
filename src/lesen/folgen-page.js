import { openSync, readSync, closeSync, statSync } from 'node:fs';
import { esc, assets } from '../web/layout.js';
import { hidden } from '../web/render.js';
import { ActionError } from '../cockpit/actions.js';
import { readingPage } from './pages.js';
import { WINDOWS, fitToWindow, stackItemJson, toRead } from './stack.js';
import { EpisodeError, KINDS, LENGTHS, MAX_DOCS, BYTES_PER_SECOND, STYLES, DEFAULT_STYLE, MAX_TOPICS, MAX_FOCUS, TOPIC_KINDS, TOPIC_LENGTHS, TOPIC_MINUTES } from './folgen.js';
import { jsonReply } from './json.js';
import { IngestError } from './ingest.js';
import { EPISODE_LANGUAGES, DEFAULT_EPISODE_LANGUAGE } from './languages.js';

/**
 * Seiten der Folgen (src/lesen/folgen.js), ohne JavaScript bedienbar:
 *
 * - `/lesen/folgen/neu?zeit=30`: Texte des Zeitfensters zum Abhaken, Art,
 *   Länge, bei Podcast und Report Ton, Schwerpunkt (Themen der Texte, eigener
 *   Wunsch) und ob gleich das Audio entsteht oder erst nur das Transkript,
 *   dazu die geschätzten Zeichen, die ElevenLabs berechnet.
 * - `/lesen/folgen/thema`: Folge zu einem Thema über den ganzen Vault (und das
 *   Internet): Thema, Ziele oder Anlass, Podcast oder Report, Länge frei.
 * - `/lesen/folgen`: alle Folgen als Karten. Fertige mit Abspiel-Knopf
 *   (/static/lesen-folgen.js: eigener Player mit Sperrbildschirm über die
 *   Media Session; in der iOS-App spielt der native Player) und dem Link
 *   „Im Vault“ aufs Transkript (Podcast, Report), entstehende mit
 *   Schritten und Fortschritt, fehlgeschlagene mit „Fortsetzen“, reine
 *   Transkripte mit „Im Vault“ und „Audio erzeugen“. Fertige und Transkripte
 *   bieten „Texte ingesten“: Ingest-Entwürfe für alle Texte der Folge, auch
 *   wenn sie nicht mehr im Stapel liegen (geprüft wird unter Lesen → Ingest).
 * - `/lesen/folgen/stand`: dieselben Karten der Folgen als JSON, damit die
 *   Seite den Fortschritt ohne Neuladen zeigt.
 * - `/lesen/folgen/audio?id=…`: die MP3, mit `Range` (Safari spielt Audio
 *   nur so ab, und Vorspulen braucht es auch).
 * - `/api/lesen/folgen`, `/api/lesen/folgen/neu?zeit=30` und
 *   `/api/lesen/folgen/thema`: dasselbe als JSON für die App (auch ohne Folgen,
 *   dann mit `enabled: false`); angelegt wird über `/aktion/lesen/folge/thema`.
 */

const fmt = new Intl.NumberFormat('de-DE');
const DESCRIPTIONS = {
  vorlesen: 'Die ganzen Texte nacheinander, eine Erzählerstimme.',
  podcast: 'Claude schreibt ein Gespräch zweier Stimmen über die Texte; das Transkript kommt in den Vault.',
  report: 'Claude schreibt einen Bericht: als Notiz in den Vault, und eine Stimme liest ihn.',
};

function when(iso, tz) {
  return new Intl.DateTimeFormat('de-DE', { timeZone: tz, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));
}

const BUSY = ['wartet', 'recherchiert', 'schreibt', 'spricht'];

/** `75` → `1:15`, `3725` → `1:02:05`. */
export function clock(seconds) {
  const t = Math.max(0, Math.round(seconds));
  const [h, m, s] = [Math.floor(t / 3600), Math.floor((t % 3600) / 60), t % 60];
  const ss = String(s).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

const minutesSince = (iso, at) => Math.max(0, Math.floor((at - Date.parse(iso)) / 60_000));
const since = (iso, at) => {
  const m = minutesSince(iso, at);
  return m < 1 ? 'gerade begonnen' : `seit ${m} Min.`;
};

/**
 * Wo eine entstehende Folge steht: Schritte, aktueller Schritt, Prozent
 * (`null` = unbestimmt, solange Claude schreibt; `fraction` dasselbe als
 * Anteil 0..1) und ein Satz dazu. Beim Sprechen schätzt `restMinutes` die
 * verbleibende Zeit aus dem bisherigen Tempo (`null`, solange unbekannt).
 */
export function progressOf(ep, at = Date.now()) {
  const writes = ep.kind !== 'vorlesen';
  const topic = ep.source === 'thema';
  const ends = ep.audio === false ? ['Transkript fertig'] : ['Stimmen sprechen', 'Fertig'];
  const steps = !writes ? ['Eingereiht', 'Stimme spricht', 'Fertig'] : topic ? ['Eingereiht', 'Claude recherchiert', 'Claude schreibt', ...ends] : ['Eingereiht', 'Claude schreibt', ...ends];
  const step = (topic ? { wartet: 0, recherchiert: 1, schreibt: 2, spricht: 3 } : { wartet: 0, schreibt: 1, spricht: writes ? 2 : 1 })[ep.status] ?? steps.length - 1;
  if (ep.status === 'wartet') return { steps, step, percent: null, fraction: null, restMinutes: null, label: 'Wartet, bis die Folge davor fertig ist' };
  if (ep.status === 'recherchiert') {
    return { steps, step, percent: null, fraction: null, restMinutes: null, label: `Claude recherchiert im Vault${ep.web ? ' und im Internet' : ''}, ${since(ep.researching_at ?? ep.updated_at, at)} (meist 5 bis 20 Minuten)` };
  }
  if (ep.status === 'schreibt' && topic && ep.chapters_total) {
    const total = ep.chapters_total;
    const current = Math.min(total, Math.max(1, ep.chapter ?? 1));
    const fraction = (current - 1) / total;
    const read = [ep.notes_read ? `${ep.notes_read} ${ep.notes_read === 1 ? 'Notiz' : 'Notizen'}` : null, ep.web_sources ? `${ep.web_sources} ${ep.web_sources === 1 ? 'Webquelle' : 'Webquellen'}` : null].filter(Boolean).join(' und ');
    return { steps, step, percent: Math.floor(fraction * 100), fraction, restMinutes: null, label: `Claude schreibt Kapitel ${current} von ${total}${read ? `, aus ${read}` : ''}` };
  }
  if (ep.status === 'schreibt') {
    const what = ep.kind === 'podcast' ? 'Claude schreibt das Gespräch' : 'Claude schreibt den Report';
    return { steps, step, percent: null, fraction: null, restMinutes: null, label: `${what}, ${since(ep.writing_at ?? ep.updated_at, at)} (meist 1 bis 3 Minuten)` };
  }
  const done = ep.done ?? 0;
  const total = ep.total ?? 0;
  const percent = total ? Math.min(99, Math.floor((done / total) * 100)) : 0;
  const from = ep.speaking_from ?? 0;
  let rest = '';
  let restMinutes = null;
  if (ep.speaking_at && done > from && total > done) {
    const each = (at - Date.parse(ep.speaking_at)) / (done - from);
    restMinutes = Math.round((each * (total - done)) / 60_000);
    rest = restMinutes < 1 ? ', gleich fertig' : `, noch etwa ${restMinutes} Min.`;
  }
  const fraction = total ? Math.min(1, done / total) : 0;
  return { steps, step, percent, fraction, restMinutes, label: `${writes ? 'ElevenLabs spricht' : 'ElevenLabs liest vor'}: ${percent} %${rest}` };
}

/** Dauer der fertigen MP3 (feste Bitrate), sonst null. */
const secondsOf = (ep) => (ep.bytes ? Math.round(ep.bytes / BYTES_PER_SECOND) : null);

const PLAY = '<svg viewBox="0 0 24 24" class="folge-icon-play" aria-hidden="true"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.6-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z"/></svg>';
const PAUSE = '<svg viewBox="0 0 24 24" class="folge-icon-pause" aria-hidden="true"><rect x="6.5" y="5" width="4" height="14" rx="1.2"/><rect x="13.5" y="5" width="4" height="14" rx="1.2"/></svg>';
const RATES = [0.8, 1, 1.2, 1.5, 1.8];

const KIND_ICONS = {
  vorlesen: '<path d="M4 15v-3a8 8 0 0 1 16 0v3"/><rect x="3" y="14" width="4.5" height="6.5" rx="1.6"/><rect x="16.5" y="14" width="4.5" height="6.5" rx="1.6"/>',
  podcast: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M9 21h6"/>',
  report: '<path d="M7 3h7l4 4v14H7z"/><path d="M14 3v4h4M10 12h5M10 16h5"/>',
};
// Gesprochenes Deutsch bei ElevenLabs: rund 900 Zeichen je Minute.
const SPOKEN_CHARS_PER_MINUTE = 900;

/** Zusammenfassung am Knopf einer Themen-Folge, wie bei `newSummary`. */
export function topicSummary({ kind, minutes, web, audio = true }) {
  const m = Number(minutes);
  if (!Number.isInteger(m) || m < TOPIC_MINUTES.min || m > TOPIC_MINUTES.max) return { main: `Länge: ${TOPIC_MINUTES.min} bis ${TOPIC_MINUTES.max} Minuten`, cost: '' };
  const h = m >= 60 ? ` (${m % 60 ? clock(m * 60).replace(/:00$/, '') : m / 60} Std.)` : '';
  const main = `${KINDS[kind] ?? kind} zum Thema · ${m} Min.${h} · Vault${web ? ' und Internet' : ''}${audio ? '' : ' · erst Transkript'}`;
  return { main, cost: audio ? `rund ${fmt.format(m * SPOKEN_CHARS_PER_MINUTE)} Zeichen bei ElevenLabs, dazu dein Claude-Abo` : 'Nur dein Claude-Abo; Audio später auf Knopfdruck' };
}

/**
 * Zusammenfassung am Knopf: `main` (Art, Texte, Dauer) und `cost`. Dieselbe
 * Rechnung macht /static/lesen-folgen.js beim Umschalten.
 */
export function newSummary({ kind, texts, chars, minutes, audio = true }) {
  if (!texts) return { main: 'Bitte mindestens einen Text wählen', cost: '' };
  const n = `${texts} ${texts === 1 ? 'Text' : 'Texte'}`;
  if (kind === 'vorlesen') {
    return { main: `${KINDS.vorlesen} · ${n} · etwa ${Math.max(1, Math.round(chars / SPOKEN_CHARS_PER_MINUTE))} Min.`, cost: chars ? `rund ${fmt.format(chars)} Zeichen bei ElevenLabs` : 'Schon alles gehört, kostet nichts' };
  }
  if (!audio) return { main: `${KINDS[kind]} · ${n} · ${minutes} Min. · erst Transkript`, cost: 'Nur dein Claude-Abo; Audio später auf Knopfdruck' };
  return { main: `${KINDS[kind]} · ${n} · ${minutes} Min.`, cost: `rund ${fmt.format(minutes * SPOKEN_CHARS_PER_MINUTE)} Zeichen bei ElevenLabs, dazu dein Claude-Abo` };
}

/** Themen der Texte für den Schwerpunkt, häufigste zuerst: `[{ label, count }]`. */
export function topicsOf(docs, max = 12) {
  const counts = new Map();
  for (const d of docs) for (const t of new Set(d.topics ?? [])) if (String(t).trim()) counts.set(t, (counts.get(t) ?? 0) + 1);
  return [...counts]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'de'))
    .slice(0, max)
    .map(([label, count]) => ({ label, count }));
}

/** Ton und Schwerpunkt einer Folge in einer Zeile, ohne Wünsche null. */
export function wishesOf(ep) {
  const parts = [
    ep.language && ep.language !== DEFAULT_EPISODE_LANGUAGE ? (EPISODE_LANGUAGES[ep.language] ?? ep.language) : null,
    ep.style && ep.style !== DEFAULT_STYLE ? (STYLES[ep.style]?.label ?? ep.style) : null,
    ep.topics?.length || ep.focus ? `Schwerpunkt: ${[...(ep.topics ?? []), ...(ep.focus ? [ep.focus] : [])].join(', ')}` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : null;
}

/** Kosten einer Art in einem Satz (Auswahl „Was soll daraus werden?“). */
const kindCost = (kind) => (kind === 'vorlesen' ? 'Kosten nach Textlänge, Gehörtes ist gratis' : '900 Zeichen je Minute, dazu Claude');

/**
 * Was „Neue Folge“ zeigt, für Seite und JSON: Zeitfenster (`zeit`, sonst 30),
 * die passenden Texte des Stapels mit ihren Zeichen fürs Vorlesen (0, wenn
 * schon gehört oder offline geladen), fehlende Voraussetzungen je Art
 * (`missing`), die erste mögliche Art und die Zusammenfassung dazu.
 */
export function newEpisodeModel(episodes, store, zeitParam) {
  const n = Number(zeitParam);
  const zeit = WINDOWS.includes(n) ? n : 30;
  // Schon Gelesenes oder in einer Folge Gehörtes nicht noch einmal.
  const { items } = fitToWindow(toRead(store.list({ status: 'stapel', limit: -1 })), zeit);
  const missing = episodes.availability();
  // Zeichen je Text fürs Vorlesen; Gehörtes und offline Geladenes kostet nichts mehr.
  const charsOf = (id) => {
    try {
      return episodes.preview({ kind: 'vorlesen', docIds: [id] }).chars;
    } catch {
      return 0;
    }
  };
  const docs = items.map((d) => ({ d, chars: charsOf(d.id) }));
  const full = docs.reduce((sum, x) => sum + x.chars, 0);
  const first = Object.keys(KINDS).find((k) => !missing[k]) ?? null;
  const summary = first ? newSummary({ kind: first, texts: docs.length, chars: full, minutes: 10 }) : { main: 'Folgen brauchen ElevenLabs', cost: 'Einstellungen → Vorlesen' };
  const language = episodes.language?.() ?? DEFAULT_EPISODE_LANGUAGE;
  return { zeit, docs, full, missing, first, summary, topics: topicsOf(items), language, languageLabel: EPISODE_LANGUAGES[language] ?? language };
}

function newPage(episodes, store, ctx) {
  const { zeit, docs, missing, first, summary, topics, languageLabel } = newEpisodeModel(episodes, store, ctx.url.searchParams.get('zeit'));
  const picker = `<nav class="chips folge-zeit" aria-label="Zeitfenster">${WINDOWS.map((m) => `<a href="/lesen/folgen/neu?zeit=${m}" class="chip"${m === zeit ? ' aria-current="true"' : ''}>${m} Min.</a>`).join('')}</nav>`;
  const step = (nr, title, hint = '') => `<div class="folge-schritt-kopf"><span class="folge-nr" aria-hidden="true">${nr}</span><div><h2>${title}</h2>${hint ? `<p class="meta">${hint}</p>` : ''}</div></div>`;
  if (!docs.length) return `<section class="folge-schritt">${step(1, 'Welche Texte?', 'Aus dem Stapel, passend zur Zeit, die du hast.')}${picker}<p class="empty">Für dieses Zeitfenster passt nichts vom Stapel.</p></section>`;

  const texts = docs
    .map(
      ({ d, chars }) => `<li><label class="folge-textwahl">
        <input type="checkbox" name="doc" value="${esc(d.id)}" checked data-chars="${chars}">
        <span class="folge-textwahl-text"><span class="lesen-title">${esc(d.title || d.url)}</span><span class="meta">${esc([`${d.reading_minutes} Min. Lesezeit`, d.site].filter(Boolean).join(' · '))}</span></span>
      </label></li>`,
    )
    .join('');

  const kinds = Object.entries(KINDS)
    .map(([kind, label]) => {
      const off = missing[kind];
      return `<label class="folge-wahl${off ? ' is-off' : ''}">
        <input type="radio" name="art" value="${kind}"${off ? ' disabled' : kind === first ? ' checked' : ''}>
        <span class="folge-wahl-icon"><svg viewBox="0 0 24 24" aria-hidden="true">${KIND_ICONS[kind]}</svg></span>
        <span class="folge-wahl-text"><b>${label}</b><span>${esc(DESCRIPTIONS[kind])}</span><span class="meta">${esc(off ?? kindCost(kind))}</span></span>
      </label>`;
    })
    .join('');
  const lengths = LENGTHS.map((m) => `<label><input type="radio" name="laenge" value="${m}"${m === 10 ? ' checked' : ''}><span>${m} Min.</span></label>`).join('');
  const styles = Object.entries(STYLES)
    .map(([key, st]) => `<label class="folge-pille" title="${esc(st.description)}"><input type="radio" name="stil" value="${key}" data-hint="${esc(st.description)}"${key === DEFAULT_STYLE ? ' checked' : ''}><span>${esc(st.label)}</span></label>`)
    .join('');
  const themes = topics.length
    ? `<div class="folge-pillen" role="group" aria-label="Themen der Texte">${topics.map((t) => `<label class="folge-pille"><input type="checkbox" name="thema" value="${esc(t.label)}"><span>${esc(t.label)}<span class="meta"> ${t.count}</span></span></label>`).join('')}</div>`
    : '';

  return `<form method="post" action="/aktion/lesen/folge/neu" class="folge-neu" data-folge-neu>
    ${hidden({ csrf: ctx.write.csrf, back: ctx.write.back })}
    <section class="folge-schritt">
      ${step(1, 'Welche Texte?', 'Aus dem Stapel, passend zur Zeit, die du hast. Abwählen, was nicht hinein soll.')}
      ${picker}
      <ul class="folge-texte">${texts}</ul>
    </section>
    <section class="folge-schritt">
      ${step(2, 'Was soll daraus werden?')}
      <div class="folge-arten">${kinds}</div>
    </section>
    <section class="folge-schritt folge-laenge">
      ${step(3, 'Wie lang?', 'Gilt für Podcast und Report; Vorlesen dauert so lange wie die Texte.')}
      <div class="folge-segmente" role="radiogroup" aria-label="Länge">${lengths}</div>
    </section>
    <section class="folge-schritt folge-claude">
      ${step(4, 'Ton und Schwerpunkt', `Für Claude, bei Podcast und Report, auf ${languageLabel} (Sprache unter Einstellungen → Vorlesen → Folgen). Ohne Schwerpunkt geht es um alles in den Texten.`)}
      <div class="folge-feld">
        <h3>Ton</h3>
        <div class="folge-pillen" role="radiogroup" aria-label="Ton">${styles}</div>
        <p class="meta" data-style-hint>${esc(STYLES[DEFAULT_STYLE].description)}</p>
      </div>
      <div class="folge-feld">
        <h3>Schwerpunkt <span class="meta">optional${topics.length ? `, höchstens ${MAX_TOPICS} Themen` : ''}</span></h3>
        ${themes}
        <label class="folge-fokus"><span class="sr-only">Eigener Schwerpunkt</span><input type="text" name="fokus" maxlength="${MAX_FOCUS}" placeholder="Eigener Wunsch, z. B. Was heißt das für den Alltag?" autocomplete="off"></label>
      </div>
    </section>
    <section class="folge-schritt folge-claude">
      ${step(5, 'Gleich mit Audio?', 'Erst nur das Transkript kostet bei ElevenLabs nichts. Gefällt es dir, wird daraus auf Knopfdruck das Audio, ohne dass Claude noch einmal schreibt.')}
      <div class="folge-segmente" role="radiogroup" aria-label="Audio"><label><input type="radio" name="audio" value="1" checked><span>Mit Audio</span></label><label><input type="radio" name="audio" value="0"><span>Erst nur Transkript</span></label></div>
    </section>
    <div class="folge-los">
      <p class="folge-summe" aria-live="polite"><b data-summary>${esc(summary.main)}</b><span class="meta" data-cost>${esc(summary.cost)}</span></p>
      <button type="submit" class="btn primary"${first ? '' : ' disabled'}>Folge erzeugen</button>
      <p class="meta">Die Folge entsteht im Hintergrund, du kannst die Seite verlassen. Fertige stehen unter <a href="/lesen/folgen">Folgen</a>.</p>
    </div>
  </form>`;
}

const TOPIC_DESCRIPTIONS = {
  podcast: 'Zwei Stimmen sprechen über das Thema, Moderation und Gast.',
  report: 'Eine Stimme erzählt, in Kapiteln, wie ein langer Radiobeitrag.',
};

/** Was „Zu einem Thema“ zeigt, für Seite und JSON. */
export function topicModel(episodes) {
  const missing = episodes.topicMissing();
  return {
    missing,
    kinds: TOPIC_KINDS.map((kind) => ({ kind, label: KINDS[kind], description: TOPIC_DESCRIPTIONS[kind] })),
    defaultKind: 'report',
    lengths: TOPIC_LENGTHS,
    defaultLength: 30,
    min: TOPIC_MINUTES.min,
    max: TOPIC_MINUTES.max,
    spokenCharsPerMinute: SPOKEN_CHARS_PER_MINUTE,
    summary: topicSummary({ kind: 'report', minutes: 30, web: true }),
  };
}

function topicPage(episodes, ctx) {
  const { missing, kinds, defaultKind, lengths, defaultLength, min, max, summary } = topicModel(episodes);
  // Vorbelegt, etwa aus „Als Folge vertonen“ unter einer Antwort in „Fragen“.
  const given = (k, max) => (ctx.url.searchParams.get(k) ?? '').slice(0, max);
  const step = (nr, title, hint = '') => `<div class="folge-schritt-kopf"><span class="folge-nr" aria-hidden="true">${nr}</span><div><h2>${title}</h2>${hint ? `<p class="meta">${hint}</p>` : ''}</div></div>`;
  const kindChoice = kinds
    .map(({ kind, label, description }) => `<label class="folge-wahl">
        <input type="radio" name="art" value="${kind}"${kind === defaultKind ? ' checked' : ''}>
        <span class="folge-wahl-icon"><svg viewBox="0 0 24 24" aria-hidden="true">${KIND_ICONS[kind]}</svg></span>
        <span class="folge-wahl-text"><b>${label}</b><span>${esc(description)}</span></span>
      </label>`)
    .join('');
  const presets = lengths.map((m) => `<label><input type="radio" name="vorschlag" value="${m}"${m === defaultLength ? ' checked' : ''}><span>${m >= 60 && m % 60 === 0 ? `${m / 60} Std.` : `${m} Min.`}</span></label>`).join('');
  return `${missing ? `<p class="problem">${esc(missing)}</p>` : ''}<form method="post" action="/aktion/lesen/folge/thema" class="folge-neu folge-thema" data-folge-thema>
    ${hidden({ csrf: ctx.write.csrf, back: ctx.write.back })}
    <section class="folge-schritt">
      ${step(1, 'Worum geht es?', 'Claude sucht dazu im ganzen Vault: Projekte, Bereiche, Wiki, Tagesnotizen, Reviews. Vertrauliche Ordner bleiben zu.')}
      <label class="thema-feld"><span>Thema</span><input type="text" name="thema" required minlength="3" maxlength="300" value="${esc(given('thema', 300))}" placeholder="z. B. Was ich seit dem Sommer über Führung gelernt habe" autocomplete="off"></label>
      <label class="thema-feld"><span>Ziele, Anlass, Schwerpunkte <span class="meta">(optional)</span></span><textarea name="ziel" rows="4" maxlength="3000" placeholder="Was soll die Folge leisten? Etwa: Autofahrt zum Kunden, ich will mit klarem Kopf ins Gespräch gehen; Fokus auf die letzten sechs Wochen.">${esc(given('ziel', 3000))}</textarea></label>
      <label class="folge-check"><input type="checkbox" name="internet" value="1" checked><span>Auch im Internet recherchieren <span class="meta">(Suchanfragen ohne persönliche Details aus dem Vault)</span></span></label>
    </section>
    <section class="folge-schritt">
      ${step(2, 'Was soll daraus werden?')}
      <div class="folge-arten">${kindChoice}</div>
    </section>
    <section class="folge-schritt">
      ${step(3, 'Wie lang?', `Ab etwa 15 Minuten in Kapiteln, je höchstens 20 Minuten. Zwischen ${min} und ${max} Minuten.`)}
      <div class="folge-segmente" role="radiogroup" aria-label="Vorschläge">${presets}</div>
      <label class="thema-feld folge-minuten"><span>Minuten</span><input type="number" name="minuten" min="${min}" max="${max}" step="1" value="${defaultLength}" required inputmode="numeric"></label>
    </section>
    <section class="folge-schritt">
      ${step(4, 'Gleich mit Audio?', 'Erst nur das Transkript kostet bei ElevenLabs nichts. Gefällt es dir, wird daraus auf Knopfdruck das Audio, ohne dass Claude noch einmal recherchiert oder schreibt.')}
      <div class="folge-segmente" role="radiogroup" aria-label="Audio"><label><input type="radio" name="audio" value="1" checked><span>Mit Audio</span></label><label><input type="radio" name="audio" value="0"><span>Erst nur Transkript</span></label></div>
    </section>
    <div class="folge-los">
      <p class="folge-summe" aria-live="polite"><b data-summary>${esc(summary.main)}</b><span class="meta" data-cost>${esc(summary.cost)}</span></p>
      <button type="submit" class="btn primary"${missing ? ' disabled' : ''}>Folge erzeugen</button>
      <p class="meta">Erst recherchiert Claude, dann schreibt es Kapitel für Kapitel, dann sprechen die Stimmen. Das dauert, bei langen Folgen eine Stunde und mehr; du kannst die Seite verlassen.</p>
    </div>
  </form>`;
}

/**
 * Nach einem Fehler: Knopf und Erklärung, je nachdem, ob Claudes Skript schon
 * da ist; bei einer Themen-Folge, ob die Recherche schon da ist.
 */
const retryOf = (resumable, ep = {}) => {
  if (resumable) return { label: 'Fortsetzen', hint: 'Schon Gesprochenes und Claudes Skript bleiben; es kostet nur, was noch fehlt.' };
  if (ep.source === 'thema' && ep.researched) return { label: 'Fortsetzen', hint: 'Die Recherche und fertige Kapitel bleiben; Claude schreibt nur die fehlenden Kapitel (über dein Abo).' };
  if (ep.source === 'thema') return { label: 'Erneut versuchen', hint: 'Die Recherche fehlt noch, dafür recherchiert Claude noch einmal (über dein Abo).' };
  return { label: 'Erneut versuchen', hint: 'Claudes Skript fehlt noch, dafür schreibt Claude noch einmal (über dein Abo).' };
};

const INGEST_DONE = { bereit: 'bereit zum Prüfen', wartet: 'wird entworfen', entwirft: 'wird entworfen', uebernommen: 'im Wiki', fehler: 'mit Fehler' };

/**
 * Ingest der Texte einer Folge (`ingest`: Dienst aus src/lesen/ingest.js):
 * wie viele es gibt, wie viele „Texte ingesten“ noch anstoßen würde (ohne
 * Entwurf, fehlgeschlagen oder verworfen, wie `request`), wie viele bereit
 * zum Prüfen sind, und der Stand in einem Satz. Ohne Dienst oder ohne Texte null.
 */
export function episodeIngest(ep, { ingest, store }) {
  if (!ingest) return null;
  const ids = (ep.docs ?? []).filter((id) => store.get(id));
  if (!ids.length) return null;
  const statuses = ingest.statusFor(ids);
  const statusOf = (id) => (statuses instanceof Map ? statuses.get(id) : statuses?.[id]) ?? null;
  const counts = new Map();
  for (const id of ids) {
    const label = INGEST_DONE[statusOf(id)];
    if (label) counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const open = ids.filter((id) => [null, 'fehler', 'verworfen'].includes(statusOf(id))).length;
  const label = counts.size ? `Ingest: ${[...counts].map(([what, n]) => `${n} ${what}`).join(' · ')}` : null;
  return { total: ids.length, open, ready: ids.filter((id) => statusOf(id) === 'bereit').length, available: Boolean(ingest.available()?.ok), label };
}

/** „Texte ingesten“ und der Stand darunter, für fertige Folgen und Transkripte. */
function ingestParts(ep, info, ctx) {
  if (!info) return { button: '', line: '' };
  const what = info.total === 1 ? 'Text' : 'Texte';
  const button =
    info.open && info.available
      ? `<form method="post" action="/aktion/lesen/folge/ingest" class="inline">${hidden({ csrf: ctx.write.csrf, back: '/lesen/folgen', id: ep.id })}<button type="submit" class="btn quiet">${what} ingesten<span class="sr-only">: ${esc(ep.title)}</span></button></form>`
      : '';
  const line = info.label ? `<p class="meta folge-ingest">${esc(info.label)}${info.ready ? ' · <a href="/lesen/ingest">Prüfen</a>' : ''}</p>` : '';
  return { button, line };
}

/** „Audio erzeugen“ zu einem Transkript: Knopf und was es kostet. */
const speakOf = (ep) => ({ label: 'Audio erzeugen', hint: `Aus demselben Skript, Claude schreibt nicht noch einmal: rund ${fmt.format(ep.chars ?? 0)} Zeichen bei ElevenLabs.` });

/**
 * Eine Folge als JSON für die App: alle Felder, Dauer der fertigen MP3
 * (`seconds`, `bytes`), bei entstehenden der Stand wie `progressOf`, bei
 * fehlgeschlagenen der Fehler und ob sie sich fortsetzen lässt.
 */
export function episodeJson(ep, { resumable = false, at = Date.now(), ingest = null } = {}) {
  const busy = BUSY.includes(ep.status);
  const failed = ep.status === 'fehler';
  return {
    id: ep.id,
    kind: ep.kind,
    kindLabel: KINDS[ep.kind] ?? ep.kind,
    title: ep.title,
    minutes: ep.minutes ?? null,
    status: ep.status,
    busy,
    docs: ep.docs ?? [],
    chars: ep.chars ?? 0,
    createdAt: ep.created_at,
    updatedAt: ep.updated_at ?? null,
    finishedAt: ep.finished_at ?? null,
    seconds: ep.status === 'fertig' ? secondsOf(ep) : null,
    bytes: ep.bytes ?? null,
    note: ep.note ?? null,
    source: ep.source ?? 'lesestapel',
    topic: ep.topic ?? null,
    goal: ep.goal ?? null,
    web: ep.source === 'thema' ? ep.web !== false : null,
    /** false: erst nur das Transkript (Status `transkript`), Audio auf Knopfdruck. */
    audio: ep.audio !== false,
    language: ep.language ?? null,
    style: ep.style ?? null,
    styleLabel: ep.style ? (STYLES[ep.style]?.label ?? ep.style) : null,
    topics: ep.topics ?? [],
    focus: ep.focus || null,
    wishes: wishesOf(ep),
    speak: ep.status === 'transkript' ? speakOf(ep) : null,
    /** Ingest der Texte (`episodeIngest`), nur bei fertigen Folgen und Transkripten. */
    ingest: ['fertig', 'transkript'].includes(ep.status) ? ingest : null,
    error: failed ? (ep.error ?? 'Unbekannter Fehler') : null,
    resumable: failed && resumable,
    retry: failed ? retryOf(resumable, ep) : null,
    progress: busy ? progressOf(ep, at) : null,
  };
}

/** Eine Folge als Karte; auch für `/lesen/folgen/stand`. */
export function episodeCard(ep, { ctx, resumable = false, at = Date.now(), ingest = null }) {
  const ingestUi = ingestParts(ep, ingest, ctx);
  const remove = (label = 'Löschen') => `<form method="post" action="/aktion/lesen/folge/loeschen" class="inline">${hidden({ csrf: ctx.write.csrf, back: '/lesen/folgen', id: ep.id })}<button type="submit" class="btn quiet">${label}</button></form>`;
  const badge = `<span class="folge-art">${esc(KINDS[ep.kind] ?? ep.kind)}</span>`;
  const wishes = wishesOf(ep);
  const head = (meta) => `<div class="folge-text">${badge}<span class="lesen-title">${esc(ep.title)}</span><span class="meta">${esc(meta.filter(Boolean).join(' · '))}</span>${wishes ? `<span class="meta">${esc(wishes)}</span>` : ''}</div>`;
  const created = when(ep.created_at, ctx.tz);
  const id = encodeURIComponent(ep.id);

  if (ep.status === 'fertig') {
    const seconds = secondsOf(ep);
    const src = `/lesen/folgen/audio?id=${id}`;
    // Transkript von Podcast und Report im Vault.
    const note = ep.note ? `<a href="/notiz?pfad=${esc(encodeURIComponent(ep.note))}" class="btn quiet">Im Vault</a>` : '';
    return `<li class="folge is-ready" data-folge="${esc(ep.id)}" data-status="fertig" data-src="${esc(src)}" data-title="${esc(ep.title)}" data-art="${esc(KINDS[ep.kind] ?? '')}" data-seconds="${seconds ?? ''}" data-bytes="${ep.bytes ?? ''}">
    <div class="folge-card">
      <button type="button" class="folge-play" data-play aria-label="Abspielen: ${esc(ep.title)}" hidden>${PLAY}${PAUSE}</button>
      <a href="${esc(src)}" class="folge-play folge-nojs" aria-label="Abspielen: ${esc(ep.title)}">${PLAY}</a>
      ${head([seconds ? clock(seconds) : ep.minutes ? `${ep.minutes} Min.` : null, created, `${fmt.format(ep.chars ?? 0)} Zeichen`])}
    </div>
    <div class="folge-player" data-player hidden>
      <input type="range" class="folge-seek" data-seek min="0" max="${seconds ?? 0}" step="1" value="0" aria-label="Stelle">
      <div class="folge-row">
        <span class="folge-time"><span data-pos>0:00</span> / <span data-dur>${seconds ? clock(seconds) : '–'}</span></span>
        <span class="folge-skip">
          <button type="button" class="btn quiet" data-skip="-15" aria-label="15 Sekunden zurück">−15 s</button>
          <button type="button" class="btn quiet" data-skip="30" aria-label="30 Sekunden vor">+30 s</button>
          <label class="folge-rate"><span class="sr-only">Tempo</span><select data-rate>${RATES.map((r) => `<option value="${r}"${r === 1 ? ' selected' : ''}>${String(r).replace('.', ',')}×</option>`).join('')}</select></label>
        </span>
      </div>
      <p class="problem" data-error hidden></p>
    </div>
    <div class="folge-actions">${note}${ingestUi.button}<a href="${esc(src)}" class="btn quiet" download="${esc(ep.title.replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'Folge')}.mp3">Herunterladen</a>${remove()}</div>
    ${ingestUi.line}
  </li>`;
  }

  if (ep.status === 'transkript') {
    const speak = speakOf(ep);
    const note = ep.note
      ? `<a href="/notiz?pfad=${esc(encodeURIComponent(ep.note))}" class="btn">Transkript lesen</a>`
      : '<span class="meta">Das Transkript ließ sich nicht im Vault anlegen; das Skript liegt im Cockpit.</span>';
    return `<li class="folge is-transcript" data-folge="${esc(ep.id)}" data-status="transkript">
    <div class="folge-card"><span class="folge-play folge-play-doc" aria-hidden="true"><svg viewBox="0 0 24 24">${KIND_ICONS.report}</svg></span>${head(['Transkript', ep.minutes ? `${ep.minutes} Min.` : null, created])}</div>
    <div class="folge-actions">
      ${note}
      <form method="post" action="/aktion/lesen/folge/sprechen" class="inline">${hidden({ csrf: ctx.write.csrf, back: '/lesen/folgen', id: ep.id })}<button type="submit" class="btn primary">${esc(speak.label)}</button></form>
      ${ingestUi.button}
      ${remove()}
    </div>
    <p class="meta">${esc(speak.hint)}</p>
    ${ingestUi.line}
  </li>`;
  }

  if (ep.status === 'fehler') {
    const again = retryOf(resumable, ep);
    return `<li class="folge is-failed" data-folge="${esc(ep.id)}" data-status="fehler">
    <div class="folge-card">${head([ep.minutes ? `${ep.minutes} Min.` : null, created])}</div>
    <p class="problem">${esc(ep.error ?? 'Unbekannter Fehler')}</p>
    <div class="folge-actions">
      <form method="post" action="/aktion/lesen/folge/fortsetzen" class="inline">${hidden({ csrf: ctx.write.csrf, back: '/lesen/folgen', id: ep.id })}<button type="submit" class="btn primary">${again.label}</button></form>
      ${remove()}
    </div>
    <p class="meta">${esc(again.hint)}</p>
  </li>`;
  }

  const p = progressOf(ep, at);
  const steps = p.steps.map((label, i) => `<li${i < p.step ? ' class="done"' : ''}${i === p.step ? ' aria-current="step"' : ''}>${esc(label)}</li>`).join('');
  const bar = p.percent === null ? `<span class="folge-wait" role="progressbar" aria-label="${esc(p.label)}"></span>` : `<progress class="folge-bar" max="100" value="${p.percent}">${p.percent} %</progress>`;
  return `<li class="folge is-busy" data-folge="${esc(ep.id)}" data-status="${esc(ep.status)}">
    <div class="folge-card"><span class="folge-spinner" aria-hidden="true"></span>${head([ep.minutes ? `${ep.minutes} Min.` : null, created])}</div>
    <ol class="folge-steps">${steps}</ol>
    <div class="folge-progress">${bar}<span class="meta" data-label>${esc(p.label)}</span></div>
    <noscript><p class="meta"><a href="/lesen/folgen">Stand aktualisieren</a></p></noscript>
  </li>`;
}

function listPage(episodes, ctx, ingestOf) {
  const list = episodes.list();
  const head = '<p class="stapel-hoeren"><a href="/lesen/folgen/neu" class="btn primary">Neue Folge</a> <a href="/lesen/folgen/thema" class="btn">Zu einem Thema</a></p>';
  if (!list.length) return `${head}<p class="empty">Noch keine Folgen. Aus dem Stapel lassen sich Texte vorlesen, als Podcast besprechen oder zu einem Report zusammenfassen; zu einem Thema recherchiert Claude im ganzen Vault und im Internet.</p>`;
  const at = Date.now();
  return `${head}<ul class="folgen">${list.map((ep) => episodeCard(ep, { ctx, resumable: episodes.resumable(ep.id), at, ingest: ingestOf(ep) })).join('')}</ul>`;
}

/** `bytes=a-b` → `[start, end]` (einschließlich) in `size`, `null` = ganze Datei, `false` = nicht erfüllbar. */
export function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header ?? '').trim());
  if (!m || (!m[1] && !m[2])) return null;
  let start;
  let end;
  if (!m[1]) {
    start = Math.max(0, size - Number(m[2]));
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  }
  return start <= end && start < size ? [start, end] : false;
}

function readPart(path, start, end) {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(end - start + 1);
    readSync(fd, buf, 0, buf.length, start);
    return buf;
  } finally {
    closeSync(fd);
  }
}

/** Antwort für die MP3 unter `path` mit `Range` (Web und `/api/app/folge`). */
export function audioResponse(path, rangeHeader) {
  const size = statSync(path).size;
  const base = { 'content-type': 'audio/mpeg', 'accept-ranges': 'bytes', 'cache-control': 'private, max-age=86400' };
  const range = parseRange(rangeHeader, size);
  if (range === false) return { status: 416, body: Buffer.alloc(0), headers: { ...base, 'content-range': `bytes */${size}` } };
  const [start, end] = range ?? [0, size - 1];
  const body = size ? readPart(path, start, end) : Buffer.alloc(0);
  return { status: range ? 206 : 200, body, headers: { ...base, 'content-length': String(body.length), ...(range ? { 'content-range': `bytes ${start}-${end}/${size}` } : {}) } };
}

const asAction = (run) => {
  try {
    return run();
  } catch (err) {
    if (err instanceof EpisodeError) throw new ActionError(err.message, err.status);
    throw err;
  }
};

/** JSON der Folgen, auch ohne Folgen (`enabled: false`): Die App fragt, statt zu raten. */
function episodeApi({ store, episodes, ingestOf }) {
  const off = { ok: true, enabled: false };
  const kinds = (missing) => Object.entries(KINDS).map(([kind, label]) => ({ kind, label, description: DESCRIPTIONS[kind], cost: kindCost(kind), missing: missing?.[kind] ?? null }));
  const styles = Object.entries(STYLES).map(([style, st]) => ({ style, label: st.label, description: st.description }));
  return {
    /** Alle Folgen, neueste zuerst, und welche Arten gerade gehen. */
    async '/api/lesen/folgen'() {
      if (!episodes) return jsonReply(200, { ...off, items: [], kinds: kinds(null) });
      const at = Date.now();
      const missing = episodes.availability();
      return jsonReply(200, { ok: true, enabled: true, items: episodes.list().map((ep) => episodeJson(ep, { resumable: episodes.resumable(ep.id), at, ingest: ingestOf(ep) })), availability: missing, kinds: kinds(missing) });
    },
    /** Vorschau für „Neue Folge“: Texte des Zeitfensters mit Zeichen, Arten, Längen und die Zusammenfassung je Art. */
    async '/api/lesen/folgen/neu'(ctx) {
      if (!episodes) return jsonReply(200, { ...off, docs: [], kinds: kinds(null) });
      const { zeit, docs, full, missing, first, summary, topics, language, languageLabel } = newEpisodeModel(episodes, store, ctx.url.searchParams.get('zeit'));
      const summaries = Object.fromEntries(Object.keys(KINDS).filter((k) => !missing[k]).map((kind) => [kind, newSummary({ kind, texts: docs.length, chars: full, minutes: 10 })]));
      return jsonReply(200, {
        ok: true,
        enabled: true,
        zeit,
        windows: WINDOWS,
        docs: docs.map(({ d, chars }) => ({ ...stackItemJson(d), chars })),
        chars: full,
        availability: missing,
        kinds: kinds(missing),
        defaultKind: first,
        lengths: LENGTHS,
        defaultLength: 10,
        maxDocs: MAX_DOCS,
        spokenCharsPerMinute: SPOKEN_CHARS_PER_MINUTE,
        // Podcast und Report: Ton, Themen der Texte für den Schwerpunkt, eigener Wunsch, erst nur Transkript.
        styles,
        defaultStyle: DEFAULT_STYLE,
        topics,
        maxTopics: MAX_TOPICS,
        maxFocus: MAX_FOCUS,
        transcriptOnly: true,
        // Sprache aus den Einstellungen, in der Claude schreibt.
        language,
        languageLabel,
        summary,
        summaries,
      });
    },
    /** Vorgaben für „Zu einem Thema“: Arten, Längen, Grenzen, was fehlt. */
    async '/api/lesen/folgen/thema'() {
      if (!episodes) return jsonReply(200, { ...off });
      return jsonReply(200, { ok: true, enabled: true, ...topicModel(episodes) });
    },
  };
}

export function folgenRoutes({ store, episodes, ingest = null }) {
  const ingestOf = (ep) => (['fertig', 'transkript'].includes(ep.status) ? episodeIngest(ep, { ingest, store }) : null);
  const api = episodeApi({ store, episodes, ingestOf });
  if (!episodes) return { pages: api, actions: {} };
  return {
    pages: {
      ...api,
      async '/lesen/folgen'(ctx) {
        return { html: readingPage(ctx, { key: 'folgen', title: 'Folgen', body: `<section>${listPage(episodes, ctx, ingestOf)}</section>`, scripts: [assets.lesenFolgen] }) };
      },
      async '/lesen/folgen/stand'(ctx) {
        const at = Date.now();
        const items = episodes.list().map((ep) => ({ id: ep.id, status: ep.status, busy: BUSY.includes(ep.status), html: episodeCard(ep, { ctx, resumable: episodes.resumable(ep.id), at, ingest: ingestOf(ep) }) }));
        return { status: 200, body: JSON.stringify({ ok: true, items }), headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } };
      },
      async '/lesen/folgen/thema'(ctx) {
        return { html: readingPage(ctx, { key: 'folgen', title: 'Folge zu einem Thema', body: topicPage(episodes, ctx), scripts: [assets.lesenFolgen] }) };
      },
      async '/lesen/folgen/neu'(ctx) {
        return { html: readingPage(ctx, { key: 'folgen', title: 'Neue Folge', body: newPage(episodes, store, ctx), scripts: [assets.lesenFolgen] }) };
      },
      async '/lesen/folgen/audio'(ctx) {
        const path = episodes.audioPath(ctx.url.searchParams.get('id') ?? '');
        if (!path) return { status: 404, body: 'Diese Folge gibt es nicht (oder sie ist noch nicht fertig).', headers: { 'content-type': 'text/plain; charset=utf-8' } };
        return audioResponse(path, ctx.range);
      },
    },
    actions: {
      async '/aktion/lesen/folge/neu'(form) {
        const ep = asAction(() =>
          episodes.create({
            kind: form.get('art') ?? '',
            docIds: form.getAll('doc'),
            minutes: Number(form.get('laenge') ?? 10),
            audio: form.get('audio') !== '0',
            style: form.get('stil') || undefined,
            topics: form.getAll('thema'),
            focus: form.get('fokus') ?? '',
          }),
        );
        ep.done?.catch(() => {});
        if (ep.audio === false) return { message: `${KINDS[ep.kind]}: Claude schreibt das Transkript, Audio danach auf Knopfdruck.`, redirect: '/lesen/folgen' };
        return { message: `${KINDS[ep.kind]} entsteht im Hintergrund, rund ${fmt.format(ep.chars)} Zeichen.`, redirect: '/lesen/folgen' };
      },
      async '/aktion/lesen/folge/thema'(form) {
        const ep = asAction(() =>
          episodes.createTopic({
            kind: form.get('art') ?? '',
            topic: form.get('thema') ?? '',
            goal: form.get('ziel') ?? '',
            minutes: Number(form.get('minuten') ?? form.get('vorschlag') ?? 30),
            // Ohne Haken schickt das Formular nichts; die App schickt `internet=0` oder `1`.
            web: ['1', 'true', 'on'].includes(String(form.get('internet') ?? '')),
            audio: form.get('audio') !== '0',
          }),
        );
        ep.done?.catch(() => {});
        if (ep.audio === false) return { message: `${KINDS[ep.kind]} zu „${ep.topic}“: erst die Recherche, dann das Transkript; Audio danach auf Knopfdruck.`, redirect: '/lesen/folgen' };
        return { message: `${KINDS[ep.kind]} zu „${ep.topic}“ entsteht im Hintergrund: erst die Recherche, dann ${ep.minutes} Minuten Text und Stimme.`, redirect: '/lesen/folgen' };
      },
      async '/aktion/lesen/folge/sprechen'(form) {
        const ep = asAction(() => episodes.speak(form.get('id') ?? ''));
        ep.done?.catch(() => {});
        return { message: `Audio entsteht: ${ep.title}, rund ${fmt.format(ep.chars ?? 0)} Zeichen.`, redirect: '/lesen/folgen' };
      },
      async '/aktion/lesen/folge/fortsetzen'(form) {
        const ep = asAction(() => episodes.retry(form.get('id') ?? ''));
        ep.done?.catch(() => {});
        return { message: `Geht weiter: ${ep.title}`, redirect: '/lesen/folgen' };
      },
      /** Ingest-Entwürfe für alle Texte der Folge, gleich ob sie noch im Stapel liegen. */
      async '/aktion/lesen/folge/ingest'(form) {
        if (!ingest) throw new ActionError('Ingest ist nicht eingerichtet', 409);
        const ep = episodes.get(form.get('id') ?? '');
        if (!ep) throw new ActionError('Diese Folge gibt es nicht', 404);
        const ids = (ep.docs ?? []).filter((id) => store.get(id));
        if (!ids.length) throw new ActionError('Die Texte dieser Folge gibt es nicht mehr', 404);
        let started;
        try {
          started = ingest.request(ids, { origin: 'knopf' });
        } catch (err) {
          if (err instanceof IngestError) throw new ActionError(err.message, err.status);
          throw err;
        }
        started.done?.catch?.(() => {});
        const n = started.queued.length;
        if (!n) return { message: 'Für diese Texte gibt es schon Entwürfe, oder sie sind im Wiki.', redirect: '/lesen/folgen' };
        return { message: `Ingest für ${n} ${n === 1 ? 'Text' : 'Texte'} angestoßen; prüfen unter Lesen → Ingest.`, redirect: '/lesen/folgen' };
      },
      async '/aktion/lesen/folge/loeschen'(form) {
        const ep = asAction(() => episodes.remove(form.get('id') ?? ''));
        return { message: `Gelöscht: ${ep.title}`, redirect: '/lesen/folgen' };
      },
    },
  };
}
