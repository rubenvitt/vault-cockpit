import { ActionError } from '../cockpit/actions.js';
import { esc, assets } from '../web/layout.js';
import { hidden } from '../web/render.js';
import { readingPage } from './pages.js';
import { docJson, jsonReply } from './json.js';
import { isRead, remainingMinutes } from './stack.js';
import { ENTWERFEN, EINPFLANZEN, ingestLink } from './ingest-page.js';
import { BYTES_PER_SECOND, KINDS } from './folgen.js';
import { clock, unheard } from './folgen-page.js';

/**
 * „Weiter“ (`/lesen/weiter`): wo jeder Text im Ablauf steht und was als
 * Nächstes geht. Der Ablauf eines Textes: gespeichert → gelesen oder gehört →
 * Ingest-Entwurf → im Wiki → eingepflanzt. Statt „Ingest“ gehen nach dem Lesen
 * auch „In den Vault“ (nur die Rohquelle) und „Fertig, weg“.
 *
 * Gelesen heißt: zu Ende gelesen, mit Lesedatum oder in einer Folge gehört
 * (`isRead` in src/lesen/stack.js). Solche Texte verlassen die Leselisten
 * (Stapel, Hören, Folgen) und stehen hier unter „Entscheiden“, bis über sie
 * entschieden ist. Geschrieben wird dafür nichts: Der Stand ergibt sich aus
 * Status, Lesedatum, `heard_at`, Fortschritt und dem Ingest des Textes.
 *
 * Jeder Text steht in genau einer Stufe (`STAGES`, in dieser Reihenfolge
 * gezeigt): `pruefen` (Entwurf bereit), `anhoeren` (fertige Folge, noch nicht
 * gehört; ihre Texte warten hier statt unter „Entscheiden“, bis die Folge
 * gehört ist), `entscheiden` (gelesen, noch offen),
 * `fehler` (Entwurf oder Einpflanzen fehlgeschlagen), `weiterlesen`
 * (angefangen), `laeuft` (Claude entwirft oder pflanzt ein). Eingang und
 * ungelesener Stapel stehen nur als Zahl da, mit Link. Oben steht „Als
 * Nächstes“: der eine Schritt, mit dem es am meisten weitergeht.
 *
 * `/api/lesen/weiter` liefert dasselbe als JSON für die App; Aktionen sind die
 * bestehenden (Ingest entwerfen, In den Vault, Fertig, weg, Einpflanzen), dazu
 * `/aktion/lesen/weiter/entwerfen` für alle Texte unter „Entscheiden“ auf einmal.
 */

export const WEITER = '/lesen/weiter';
const ALLE_ENTWERFEN = '/aktion/lesen/weiter/entwerfen';
const VAULT = '/aktion/lesen/doc/vault';
const FERTIG = '/aktion/lesen/doc/fertig';

export const STAGES = ['pruefen', 'anhoeren', 'entscheiden', 'fehler', 'weiterlesen', 'laeuft'];
const STAGE_LABELS = { pruefen: 'Prüfen', anhoeren: 'Anhören', entscheiden: 'Entscheiden', fehler: 'Fehler', weiterlesen: 'Weiterlesen', laeuft: 'Läuft' };
const STAGE_HINTS = {
  pruefen: 'Claude hat einen Entwurf fürs Wiki geschrieben. Abhaken, was hinein soll, dauert ein, zwei Minuten.',
  anhoeren: 'Fertige Folgen, noch nicht gehört. Danach stehen ihre Texte unter „Entscheiden“.',
  entscheiden: 'Gelesen oder gehört. Ins Wiki (Claude entwirft), nur als Rohquelle in den Vault oder fertig, weg.',
  fehler: 'Hier hakt es. Erneut versuchen oder ansehen.',
  weiterlesen: 'Angefangen, noch nicht zu Ende.',
  laeuft: 'Claude arbeitet daran. Die Seite aktualisiert sich von selbst.',
};
const ON_DESK = ['eingang', 'stapel'];
const BUSY = ['wartet', 'entwirft'];
const PLANT_BUSY = ['wartet', 'laeuft'];

const name = (d) => d?.title || d?.url || 'Ohne Titel';
const docLink = (id, weiter = false) => `/lesen/doc?id=${encodeURIComponent(id)}${weiter ? '#weiter' : ''}`;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const plantOf = (e) => (e?.status === 'uebernommen' ? (e.applied?.plant ?? null) : null);

function day(iso, tz) {
  const t = Date.parse(iso ?? '');
  if (Number.isNaN(t)) return null;
  return new Intl.DateTimeFormat('de-DE', { timeZone: tz, day: 'numeric', month: 'short' }).format(new Date(t));
}

/** Zuletzt fertige Folge je Text: `docId → { id, title, kind }`; `list()` liefert die neueste zuerst. */
function heardIn(episodes) {
  const out = new Map();
  for (const ep of episodes?.list?.() ?? []) {
    if (ep.status !== 'fertig') continue;
    for (const id of ep.docs ?? []) if (!out.has(id)) out.set(id, { id: ep.id, title: ep.title, kind: ep.kind });
  }
  return out;
}

/** Wie gelesen: `gehoert` (mit Folge, falls bekannt) oder `gelesen`, mit Zeitpunkt; null, wenn ungelesen. */
export function readInfo(doc, episodes = new Map()) {
  if (!isRead(doc)) return null;
  if (doc.heard_at && !(doc.read_at > doc.heard_at)) return { how: 'gehoert', at: doc.heard_at, episode: episodes.get(doc.id) ?? null };
  return { how: 'gelesen', at: doc.read_at ?? null, episode: null };
}

/**
 * Die Spur eines Textes: Gelesen · Entwurf · Im Wiki · Eingepflanzt, je Schritt
 * `done`, `busy`, `failed` oder `todo`. „Gespeichert“ fehlt, das ist jeder.
 */
export function trackOf(doc, ingest = null) {
  const read = isRead(doc);
  const s = ingest?.status ?? null;
  const plant = plantOf(ingest);
  const draft = s === 'bereit' || s === 'uebernommen' ? 'done' : BUSY.includes(s) ? 'busy' : s === 'fehler' ? 'failed' : 'todo';
  const planted = !plant ? 'todo' : plant.status === 'fertig' ? 'done' : plant.status === 'fehler' ? 'failed' : 'busy';
  return [
    { key: 'gelesen', label: doc.heard_at && !(doc.read_at > doc.heard_at) ? 'Gehört' : 'Gelesen', state: read || s === 'uebernommen' ? 'done' : doc.progress > 0 ? 'busy' : 'todo' },
    { key: 'entwurf', label: 'Entwurf', state: draft },
    { key: 'wiki', label: 'Im Wiki', state: s === 'uebernommen' ? 'done' : 'todo' },
    { key: 'eingepflanzt', label: 'Eingepflanzt', state: planted },
  ];
}

/**
 * Stufe eines Textes oder null (nichts zu tun: ungelesen im Eingang oder auf
 * dem Stapel, oder erledigt). `ingest` ist die Zeile aus `ingest.list()`.
 */
export function stageOf(doc, ingest = null) {
  const s = ingest?.status ?? null;
  const plant = plantOf(ingest);
  if (s === 'bereit') return 'pruefen';
  if (s === 'fehler' || plant?.status === 'fehler') return 'fehler';
  if (BUSY.includes(s) || PLANT_BUSY.includes(plant?.status)) return 'laeuft';
  if (!doc || !ON_DESK.includes(doc.status)) return null;
  if (isRead(doc)) return 'entscheiden';
  if (doc.status === 'stapel' && doc.progress > 0) return 'weiterlesen';
  return null;
}

/**
 * Alles für Seite und JSON: Texte je Stufe, Zahlen für Eingang und
 * ungelesenen Stapel, und `next`, der eine nächste Schritt.
 * `ingest` und `episodes` sind optional (ohne Dienst keine Ingest-Stufen).
 */
export function weiterModel({ store, ingest = null, episodes = null }) {
  const heard = heardIn(episodes);
  // Ungehörte Folgen und ihre Texte: Die warten aufs Hören, nicht auf eine Entscheidung.
  const toHear = (episodes?.list?.() ?? []).filter(unheard);
  const waiting = new Set(toHear.flatMap((ep) => ep.docs ?? []));
  const rows = new Map((ingest?.list() ?? []).map((e) => [e.doc_id, e]));
  const stack = store.list({ status: 'stapel', limit: -1 });
  const inbox = store.list({ status: 'eingang', limit: -1 });
  const docs = new Map([...inbox, ...stack].map((d) => [d.id, d]));
  // Texte mit Ingest außerhalb von Eingang und Stapel (etwa aus einer Folge, schon „weg“), nur wenn es dort etwas zu tun gibt.
  for (const [id, e] of rows) if (!docs.has(id) && stageOf(null, e)) docs.set(id, store.get(id) ?? { id, ...e.doc, progress: 0 });

  const stages = Object.fromEntries(STAGES.map((k) => [k, []]));
  // Ungelesen und ohne Stufe: nur gezählt, gelesen wird im Eingang und auf dem Stapel.
  const idle = { eingang: [], stapel: [] };
  for (const doc of docs.values()) {
    const e = rows.get(doc.id) ?? null;
    let stage = stageOf(doc, e);
    // Nur über die Folge „gelesen“, die aber noch nicht gehört: steht unter „Anhören“.
    if (stage === 'entscheiden' && waiting.has(doc.id) && !doc.read_at && !(doc.progress >= 1)) stage = null;
    if (!stage) {
      if (waiting.has(doc.id)) continue;
      idle[doc.status]?.push(doc);
      continue;
    }
    stages[stage].push({ doc, stage, ingest: e, plant: plantOf(e), read: readInfo(doc, heard), track: trackOf(doc, e) });
  }
  // Prüfen: älteste Entwürfe zuerst; Entscheiden: zuletzt Gelesenes zuerst (frisch im Kopf); Weiterlesen: kürzeste Restzeit zuerst.
  const t = (iso) => Date.parse(iso ?? '') || 0;
  stages.pruefen.sort((a, b) => t(a.ingest.drafted_at) - t(b.ingest.drafted_at));
  stages.entscheiden.sort((a, b) => t(b.read?.at ?? b.doc.status_changed_at) - t(a.read?.at ?? a.doc.status_changed_at));
  stages.weiterlesen.sort((a, b) => remainingMinutes(a.doc) - remainingMinutes(b.doc));
  // Anhören: angefangene zuerst, sonst die neueste.
  stages.anhoeren = toHear
    .sort((a, b) => (b.position > 0) - (a.position > 0))
    .map((ep) => ({ stage: 'anhoeren', episode: ep, docs: (ep.docs ?? []).map((id) => store.get(id)).filter(Boolean) }));

  const counts = {
    ...Object.fromEntries(STAGES.map((k) => [k, stages[k].length])),
    eingang: idle.eingang.length,
    stapel: idle.stapel.length,
    stapelMinutes: idle.stapel.reduce((n, d) => n + (d.reading_minutes || 0), 0),
  };
  const available = Boolean(ingest?.available?.()?.ok);
  // Was „Alle entwerfen“ einreiht: gelesen, ohne Entwurf oder mit verworfenem.
  const draftable = available ? stages.entscheiden.filter((x) => !x.ingest || x.ingest.status === 'verworfen').map((x) => x.doc.id) : [];
  return { stages, counts, available, draftable, next: nextStep(stages, counts, draftable) };
}

/**
 * Der eine nächste Schritt, nach Wert: fertige Entwürfe prüfen (Claude hat die
 * Arbeit schon getan), Gelesenes entscheiden, Fehler beheben, Angefangenes
 * weiterlesen, den Eingang sichten, dann vom Stapel lesen oder hören.
 */
function nextStep(stages, counts, draftable) {
  const first = (k) => stages[k][0];
  if (counts.pruefen) return { stage: 'pruefen', text: counts.pruefen === 1 ? `Einen Entwurf prüfen: ${name(first('pruefen').doc)}` : `${counts.pruefen} Entwürfe warten aufs Prüfen`, href: ingestLink(first('pruefen').doc.id), label: counts.pruefen === 1 ? 'Prüfen' : 'Ersten prüfen' };
  if (counts.anhoeren) {
    const ep = first('anhoeren').episode;
    return { stage: 'anhoeren', text: counts.anhoeren === 1 ? `Folge anhören: ${ep.title}` : `${counts.anhoeren} Folgen warten aufs Anhören, zuerst: ${ep.title}`, href: '/lesen/folgen#hoeren', label: ep.position > 0 ? 'Weiterhören' : 'Anhören' };
  }
  if (counts.entscheiden) {
    const text = counts.entscheiden === 1 ? `Gelesen oder gehört: ${name(first('entscheiden').doc)}. Wie weiter?` : `${counts.entscheiden} Texte sind gelesen oder gehört. Wie weiter?`;
    return draftable.length ? { stage: 'entscheiden', text, action: ALLE_ENTWERFEN, label: draftable.length === 1 ? 'Ingest entwerfen' : `Alle ${draftable.length} entwerfen lassen` } : { stage: 'entscheiden', text, href: '#entscheiden', label: 'Entscheiden' };
  }
  if (counts.fehler) return { stage: 'fehler', text: `${plural(counts.fehler, 'Text hakt', 'Texte haken')}`, href: '#fehler', label: 'Ansehen' };
  if (counts.weiterlesen) {
    const d = first('weiterlesen').doc;
    return { stage: 'weiterlesen', text: `Weiterlesen: ${name(d)}, noch ${remainingMinutes(d)} Min.`, href: docLink(d.id, true), label: 'Weiterlesen' };
  }
  if (counts.eingang) return { stage: 'eingang', text: `${plural(counts.eingang, 'Text wartet', 'Texte warten')} im Eingang aufs Sichten`, href: '/lesen/eingang', label: 'Eingang sichten' };
  if (counts.stapel) return { stage: 'stapel', text: `${plural(counts.stapel, 'Text', 'Texte')} auf dem Stapel, zusammen etwa ${counts.stapelMinutes} Min.`, href: '/lesen/stapel', label: 'Zum Stapel' };
  if (counts.laeuft) return { stage: 'laeuft', text: 'Claude arbeitet gerade, sonst ist nichts offen.', href: '#laeuft', label: 'Ansehen' };
  return { stage: null, text: 'Alles erledigt. Nichts wartet auf dich.', href: null, label: null };
}

// --- Seite -------------------------------------------------------------------

/** Wie der Text gelesen wurde, als kurzer Satz. */
function readLabel(read, tz) {
  if (!read) return null;
  const at = day(read.at, tz);
  if (read.how === 'gehoert') return `gehört${at ? ` am ${at}` : ''}${read.episode ? ` in „${read.episode.title}“` : ''}`;
  return at ? `gelesen am ${at}` : 'zu Ende gelesen';
}

/** Was gerade läuft oder schiefging, als kurzer Satz. */
function stateLabel(x) {
  const s = x.ingest?.status;
  if (s === 'wartet') return 'Entwurf wartet auf Claude';
  if (s === 'entwirft') return 'Claude entwirft';
  if (s === 'fehler') return `Entwurf fehlgeschlagen${x.ingest.error ? `: ${x.ingest.error}` : ''}`;
  if (x.plant?.status === 'wartet') return 'Einpflanzen wartet auf Claude';
  if (x.plant?.status === 'laeuft') return 'Claude pflanzt die Quelle ins Wiki ein';
  if (x.plant?.status === 'fehler') return `Einpflanzen fehlgeschlagen${x.plant.error ? `: ${x.plant.error}` : ''}`;
  return null;
}

const STEP_MARK = { done: '✓', busy: '…', failed: '!', todo: '' };
const track = (steps) => `<ol class="weiter-spur" aria-label="Stand">${steps
  .map((s) => `<li class="is-${s.state}">${STEP_MARK[s.state] ? `<span aria-hidden="true">${STEP_MARK[s.state]}</span> ` : ''}${esc(s.label)}<span class="sr-only">: ${{ done: 'erledigt', busy: 'läuft', failed: 'fehlgeschlagen', todo: 'offen' }[s.state]}</span></li>`)
  .join('')}</ol>`;

/** Knöpfe der nächsten Schritte eines Textes. */
function actions(x, ctx, { available, planting, vault }) {
  const id = x.doc.id;
  const sr = `<span class="sr-only">: ${esc(name(x.doc))}</span>`;
  const form = (action, fields, label, cls = 'btn quiet') => `<form method="post" action="${action}" class="act">${hidden({ csrf: ctx.write.csrf, back: ctx.write.back, id, ...fields })}<button type="submit" class="${cls}">${label}${sr}</button></form>`;
  const open = (label = 'Öffnen', cls = 'btn quiet', weiter = false) => `<a href="${esc(docLink(id, weiter))}" class="${cls}">${label}${sr}</a>`;
  switch (x.stage) {
    case 'pruefen':
      return [`<a href="${esc(ingestLink(id))}" class="btn primary">Prüfen${sr}</a>`, open('Text')];
    case 'entscheiden':
      return [
        available && x.ingest?.status !== 'uebernommen' ? form(ENTWERFEN, {}, 'Ins Wiki: entwerfen', 'btn primary') : '',
        vault ? form(VAULT, { volltext: '1' }, 'Nur in den Vault') : '',
        form(FERTIG, {}, 'Fertig, weg'),
        open(),
      ];
    case 'fehler':
      return x.plant?.status === 'fehler'
        ? [planting ? form(EINPFLANZEN, {}, 'Erneut einpflanzen', 'btn') : '', `<a href="${esc(ingestLink(id))}" class="btn quiet">Ansehen${sr}</a>`]
        : [available ? form(ENTWERFEN, { force: '1' }, 'Erneut entwerfen', 'btn') : '', `<a href="${esc(ingestLink(id))}" class="btn quiet">Ansehen${sr}</a>`];
    case 'weiterlesen':
      return [open('Weiterlesen', 'btn primary', true)];
    default:
      return [];
  }
}

/** Eine ungehörte Folge: Art, Länge, Stelle und ihre Texte, dazu Anhören und „Als gehört markieren“. */
function episodeRow(x, ctx) {
  const ep = x.episode;
  const seconds = ep.bytes ? Math.round(ep.bytes / BYTES_PER_SECOND) : null;
  const meta = [KINDS[ep.kind] ?? ep.kind, seconds ? clock(seconds) : ep.minutes ? `${ep.minutes} Min.` : null, ep.position > 0 ? `angefangen, bei ${clock(ep.position)}` : null].filter(Boolean).join(' · ');
  const texts = x.docs.length ? `<p class="meta weiter-folge-texte">${x.docs.length === 1 ? 'Text' : `${x.docs.length} Texte`}: ${x.docs.map((d) => `<a href="${esc(docLink(d.id))}">${esc(name(d))}</a>`).join(', ')}</p>` : '';
  const mark = `<form method="post" action="/aktion/lesen/folge/gehoert" class="act">${hidden({ csrf: ctx.write.csrf, back: ctx.write.back, id: ep.id, gehoert: '1' })}<button type="submit" class="btn quiet">Als gehört markieren<span class="sr-only">: ${esc(ep.title)}</span></button></form>`;
  return `<li class="weiter-item is-anhoeren" data-weiter-folge="${esc(ep.id)}">
    <div class="weiter-item-head"><a href="/lesen/folgen#hoeren" class="lesen-title">${esc(ep.title)}</a></div>
    <span class="meta">${esc(meta)}</span>
    ${texts}
    <div class="weiter-acts"><a href="/lesen/folgen#hoeren" class="btn primary">${ep.position > 0 ? 'Weiterhören' : 'Anhören'}<span class="sr-only">: ${esc(ep.title)}</span></a>${mark}</div>
  </li>`;
}

function row(x, ctx, opts) {
  if (x.stage === 'anhoeren') return episodeRow(x, ctx);
  const d = x.doc;
  const minutes = x.stage === 'weiterlesen' ? `noch ${remainingMinutes(d)} Min.` : d.reading_minutes ? `${d.reading_minutes} Min.` : null;
  const meta = [d.site, minutes, readLabel(x.read, ctx.tz)].filter(Boolean).join(' · ');
  const state = stateLabel(x);
  // Läuft etwas, beobachtet das Ingest-Skript den Stand und baut `main` neu, sobald er sich ändert.
  const plantBusy = PLANT_BUSY.includes(x.plant?.status);
  const watch = x.stage === 'laeuft' ? ` data-ingest-watch="${esc(d.id)}"${plantBusy ? ` data-ingest-plant data-ingest-status="${esc(x.plant.status)}"` : ` data-ingest-status="${esc(x.ingest?.status ?? '')}"`}` : '';
  const acts = actions(x, ctx, opts).filter(Boolean).join('');
  return `<li class="weiter-item is-${x.stage}" data-weiter-doc="${esc(d.id)}"${watch}>
    <div class="weiter-item-head">
      ${x.stage === 'laeuft' ? '<span class="folge-spinner" aria-hidden="true"></span>' : ''}
      <a href="${esc(x.stage === 'pruefen' || x.stage === 'fehler' ? ingestLink(d.id) : docLink(d.id, x.stage === 'weiterlesen'))}" class="lesen-title">${esc(name(d))}</a>
    </div>
    ${meta ? `<span class="meta">${esc(meta)}</span>` : ''}
    ${state ? `<p class="${x.stage === 'fehler' ? 'problem' : 'meta'}">${esc(state)}</p>` : ''}
    ${track(x.track)}
    ${acts ? `<div class="weiter-acts">${acts}</div>` : ''}
  </li>`;
}

function hero(model, ctx) {
  const n = model.next;
  const button = n.action
    ? `<form method="post" action="${n.action}" class="act">${hidden({ csrf: ctx.write.csrf, back: ctx.write.back })}<button type="submit" class="btn primary">${esc(n.label)}</button></form>`
    : n.href
      ? `<a href="${esc(n.href)}" class="btn primary">${esc(n.label)}</a>`
      : '';
  return `<section class="weiter-next${n.stage ? '' : ' is-clear'}" aria-labelledby="weiter-next"><h2 id="weiter-next">Als Nächstes</h2><p>${esc(n.text)}</p>${button}</section>`;
}

function section(key, items, ctx, opts, extra = '') {
  if (!items.length) return '';
  return `<section class="weiter-stufe" id="${key}" aria-labelledby="weiter-${key}">
    <h2 id="weiter-${key}">${STAGE_LABELS[key]} <span class="hint">${items.length}</span></h2>
    <p class="meta">${esc(STAGE_HINTS[key])}</p>${extra}
    <ul class="weiter-list">${items.map((x) => row(x, ctx, opts)).join('')}</ul>
  </section>`;
}

/** Ungelesenes: nur Zahl und Weg dorthin, gelesen wird im Stapel. */
function unreadSection({ counts }, folgen) {
  if (!counts.eingang && !counts.stapel) return '';
  const parts = [
    counts.eingang ? `<li><a href="/lesen/eingang">Eingang</a><span class="meta"> · ${plural(counts.eingang, 'Text', 'Texte')} zu sichten</span></li>` : '',
    counts.stapel
      ? `<li><a href="/lesen/stapel">Stapel</a><span class="meta"> · ${plural(counts.stapel, 'Text', 'Texte')}, etwa ${counts.stapelMinutes} Min.</span> <a href="/lesen/hoeren?zeit=15" class="btn quiet">Unterwegs hören</a>${folgen ? ' <a href="/lesen/folgen/neu?zeit=30" class="btn quiet">Folge erzeugen</a>' : ''}</li>`
      : '',
  ];
  return `<section class="weiter-stufe weiter-ungelesen" aria-labelledby="weiter-ungelesen"><h2 id="weiter-ungelesen">Noch ungelesen</h2><p class="meta">Was du hörst oder zu Ende liest, landet von selbst oben unter „Entscheiden“.</p><ul class="weiter-unread">${parts.join('')}</ul></section>`;
}

// --- JSON --------------------------------------------------------------------

const episodeItemJson = (x) => ({
  stage: 'anhoeren',
  episode: { id: x.episode.id, kind: x.episode.kind, kindLabel: KINDS[x.episode.kind] ?? x.episode.kind, title: x.episode.title, seconds: x.episode.bytes ? Math.round(x.episode.bytes / BYTES_PER_SECOND) : null, position: x.episode.position ?? null, finishedAt: x.episode.finished_at ?? null },
  docs: x.docs.map((d) => ({ id: d.id, title: d.title ?? null, url: d.url })),
});

const itemJson = (x) => (x.stage === 'anhoeren' ? episodeItemJson(x) : docItemJson(x));

const docItemJson = (x) => ({
  ...docJson(x.doc),
  stage: x.stage,
  remaining: x.stage === 'weiterlesen' ? remainingMinutes(x.doc) : null,
  read: x.read ? { how: x.read.how, at: x.read.at, episode: x.read.episode } : null,
  ingest: x.ingest ? { status: x.ingest.status, error: x.ingest.error ?? null, plant: x.plant ? { status: x.plant.status, error: x.plant.error ?? null } : null } : null,
  state: stateLabel(x),
  track: x.track,
});

// --- Routen ------------------------------------------------------------------

/**
 * Seite, JSON und „Alle entwerfen“. `ingest`, `planter`, `episodes` wie in
 * src/lesen/http.js; `vault`: Lesestapel-Notizen angebunden („Nur in den Vault“).
 */
export function weiterRoutes({ store, ingest = null, planter = null, episodes = null, vault = false }) {
  const model = () => weiterModel({ store, ingest, episodes });
  return {
    pages: {
      async [WEITER](ctx) {
        const m = model();
        const opts = { available: m.available, planting: Boolean(planter?.available?.()?.ok), vault };
        const bulk = m.draftable.length > 1
          ? `<form method="post" action="${ALLE_ENTWERFEN}" class="act weiter-bulk">${hidden({ csrf: ctx.write.csrf, back: ctx.write.back })}<button type="submit" class="btn">Alle ${m.draftable.length} entwerfen lassen</button><span class="meta">Claude entwirft einen nach dem anderen; ins Wiki kommt nur, was du danach abhakst.</span></form>`
          : '';
        const body = [
          hero(m, ctx),
          ...STAGES.map((k) => section(k, m.stages[k], ctx, opts, k === 'entscheiden' ? bulk : '')),
          unreadSection(m, Boolean(episodes)),
        ].join('');
        return { html: readingPage(ctx, { key: 'weiter', title: 'Wie weiter?', body, scripts: ingest ? [assets.lesenIngest] : [] }) };
      },
      async '/api/lesen/weiter'() {
        const m = model();
        return jsonReply(200, {
          ok: true,
          next: m.next,
          counts: m.counts,
          stages: STAGES.map((k) => ({ key: k, label: STAGE_LABELS[k], hint: STAGE_HINTS[k], items: m.stages[k].map(itemJson) })),
          ingestAvailable: m.available,
          plantAvailable: Boolean(planter?.available?.()?.ok),
          draftable: m.draftable.length,
          vault,
          episodes: Boolean(episodes),
        });
      },
    },
    actions: {
      /** Ingest für alle gelesenen Texte unter „Entscheiden“ ohne Entwurf (auch verworfene: hier ausdrücklich gewollt, anders als nachts). */
      async [ALLE_ENTWERFEN]() {
        if (!ingest) throw new ActionError('Ingest ist hier nicht angebunden', 503);
        const { draftable } = model();
        if (!draftable.length) return { message: 'Nichts zu entwerfen: Jeder gelesene Text hat schon einen Entwurf.', count: 0 };
        let queued;
        try {
          const r = ingest.request(draftable, { origin: 'knopf' });
          queued = typeof r === 'number' ? r : (r?.queued?.length ?? 0);
        } catch (err) {
          throw new ActionError(err.message, err.status ?? 409);
        }
        return { message: queued ? `${plural(queued, 'Text wird', 'Texte werden')} entworfen, einer nach dem anderen.` : 'Nichts eingereiht.', count: queued };
      },
    },
  };
}
