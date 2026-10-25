import { ActionError } from '../cockpit/actions.js';
import { esc, assets } from '../web/layout.js';
import { hidden } from '../web/render.js';
import { renderMarkdown, inlineMd, parseMarkdown, parseInline } from '../web/markdown-render.js';
import { readingPage } from './pages.js';
import { ReadingError } from './store.js';
import { jsonReply } from './json.js';

/**
 * Oberfläche des Ingests (Dienst: src/lesen/ingest.js, `createIngest`): aus
 * einem Text des Stapels entwirft Claude Seiten für das Mycel-Wiki, und hier
 * wird abgehakt, was davon hinein soll. Ohne JavaScript ist alles ein Formular.
 *
 * - `/lesen/ingest`: Übersicht. Bereite Entwürfe als Karten (Kernaussagen und
 *   was angeboten wird), darunter „In Arbeit“, „Einpflanzen“ (der Agent nach dem
 *   Übernehmen, src/lesen/einpflanzen.js) und „Fehler“, oben „Ganzen Stapel
 *   entwerfen“.
 * - `/lesen/ingest/doc?id=`: Prüfansicht. Digest (Kernaussagen, Neu für dich,
 *   Bestätigt, Widerspricht, Dockt an), die Source-Page mit änderbaren Feldern
 *   und die Vorschläge zum Abhaken, gruppiert (unter „Synthesen & Fragen“ auch
 *   „Synthese ergänzen“: ein Abschnitt für eine bestehende Synthese, aufklappbar
 *   unter „Was ergänzt wird“). „Ins Wiki übernehmen“ führt zum nächsten bereiten
 *   Entwurf.
 * - `/lesen/ingest/stand?ids=a,b`: Stand als JSON für die Live-Aktualisierung
 *   (/static/lesen-ingest.js): Zähler, je Dokument Status, Stand des
 *   Einpflanzens (`plant`) und Abzeichen.
 * - `/api/lesen/ingest` und `/api/lesen/ingest/doc?id=`: dasselbe für die App
 *   (ohne Dienst mit `enabled: false`). Claudes Texte kommen dort zusätzlich als
 *   Baum (`view`, wie `/api/notiz`: `parseInline`/`parseMarkdown`, Wikilinks wie
 *   in der Prüfansicht umgeschrieben), damit die App nichts selbst parsen muss.
 *
 * Alles, was Claude schreibt, ist Fremdtext: Titel und Pfade nur maskiert,
 * Fließtext über `inlineMd`, Seitentexte über `renderMarkdown` (beide maskieren
 * und lassen kein HTML durch). Wikilinks darin werden vorher umgeschrieben
 * (`pageView`): auf bekannte Wiki-Seiten ein Link mit Titel, sonst lesbarer Text.
 */

export const INGEST = '/lesen/ingest';
export const ingestLink = (id) => `/lesen/ingest/doc?id=${encodeURIComponent(id)}`;
const STAND = '/lesen/ingest/stand';
const ENTWERFEN = '/aktion/lesen/ingest/entwerfen';
const UEBERNEHMEN = '/aktion/lesen/ingest/uebernehmen';
const VERWERFEN = '/aktion/lesen/ingest/verwerfen';
const EINPFLANZEN = '/aktion/lesen/ingest/einpflanzen';
const DOC_STATUS = '/aktion/lesen/doc/status';

const BUSY = ['wartet', 'entwirft'];
const ACTIVE = [...BUSY, 'bereit', 'fehler'];
const PLANT_BUSY = ['wartet', 'laeuft'];
// So lange steht ein fertiges Einpflanzen noch in der Übersicht.
const PLANT_RECENT_MS = 3 * 24 * 3_600_000;
const SUMMARY_MAX = 80;

/** Nur echte Wiki-Pfade werden Links; alles andere bleibt Text. */
const wikiPath = (p) => typeof p === 'string' && /^wiki\/[^\0]+\.md$/.test(p) && !p.split('/').includes('..');
const noteLink = (p) => `/notiz?pfad=${encodeURIComponent(p)}`;
const docLink = (id) => `/lesen/doc?id=${encodeURIComponent(id)}`;
const httpUrl = (u) => (/^https?:\/\//i.test(u ?? '') ? u : null);
const slugOf = (p) => String(p ?? '').split('/').pop().replace(/\.md$/i, '');
const list = (a) => (Array.isArray(a) ? a : []);
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
/** `statusFor` liefert eine Map; ein schlichtes Objekt geht auch. */
const statusIn = (m, id) => (m instanceof Map ? m.get(id) : m?.[id]) ?? null;

const ENTITY = { person: 'Person', tool: 'Werkzeug', org: 'Organisation', product: 'Produkt', project: 'Projekt' };
const ART = { querverbindung: 'Querverbindung', vergleich: 'Vergleich', widerspruch: 'Widerspruch' };
const CONFIDENCE = { high: 'hoch', medium: 'mittel', low: 'niedrig', speculative: 'spekulativ' };
/** Relationstypen des Wikis, auf Deutsch gelesen. */
const RELATION = {
  uses: 'nutzt', 'depends-on': 'hängt ab von', 'part-of': 'Teil von', 'instance-of': 'ist ein', extends: 'erweitert', supports: 'stützt',
  contradicts: 'widerspricht', caused: 'verursachte', fixed: 'behob', supersedes: 'ersetzt', 'authored-by': 'verfasst von', 'owned-by': 'gehört zu',
  'alternative-to': 'Alternative zu', 'related-to': 'verwandt mit', refines: 'verfeinert', 'refined-by': 'verfeinert durch',
};

/** Art eines Vorschlags als Wort (Kennzeichen an der Karte). */
export function kindLabel(item) {
  if (item.action === 'ergaenzen') return 'Synthese ergänzen';
  if (item.kind === 'synthesis') return ART[item.art] ? `Synthese · ${ART[item.art]}` : 'Synthese';
  if (item.kind === 'question') return 'Frage';
  if (item.kind === 'entity') return ENTITY[item.entity_type] ?? 'Entity';
  if (item.kind === 'concept') return 'Konzept';
  // Verknüpfen mit einer anderen Source-Page (der Dienst nimmt den Seitentyp als Art).
  if (item.kind === 'source') return 'Quelle';
  if (item.kind === 'bestaetigung') return 'Bestätigung';
  if (item.kind === 'relation') return 'Relation';
  return item.kind ?? 'Vorschlag';
}

/**
 * Gruppen der Prüfansicht, in dieser Reihenfolge; ein Vorschlag kommt in die
 * erste passende. `featured`: Synthesen und Fragen stehen als Karten da.
 */
export const GROUPS = [
  { key: 'verknuepfen', label: 'Mit bestehenden Seiten verknüpfen', hint: 'Seiten im Wiki, mit denen die Source-Page verknüpft wird.', match: (i) => i.action === 'verknuepfen' },
  { key: 'bestaetigung', label: 'Bestätigungen', hint: 'Der Text stützt, was auf diesen Seiten steht.', match: (i) => i.kind === 'bestaetigung' },
  { key: 'synthese', label: 'Synthesen & Fragen', hint: 'Claudes Angebote über diesen Text hinaus, auch Ergänzungen bestehender Synthesen. Aufklappen, lesen, abhaken.', featured: true, match: (i) => i.kind === 'synthesis' || i.kind === 'question' },
  { key: 'neu', label: 'Neue Seiten', hint: 'Personen, Werkzeuge und Konzepte, die es im Wiki noch nicht gibt.', match: (i) => i.action === 'neu' && (i.kind === 'entity' || i.kind === 'concept') },
  { key: 'relation', label: 'Relationen', hint: 'Typisierte Verweise im Frontmatter der Source-Page.', match: (i) => i.kind === 'relation' },
  { key: 'weitere', label: 'Weitere Vorschläge', hint: '', match: () => true },
];

/** Vorschläge nach Gruppe: `[{ ...group, items }]`, leere Gruppen fallen weg. */
export function groupItems(items) {
  const out = GROUPS.map((g) => ({ ...g, items: [] }));
  for (const item of list(items)) {
    if (!item || typeof item.id !== 'string') continue;
    out.find((g) => g.match(item)).items.push(item);
  }
  return out.filter((g) => g.items.length);
}

/** Zählung eines Entwurfs: was angeboten wird, nach Art. */
export function tally(draft) {
  const t = { verknuepfen: 0, bestaetigung: 0, synthese: 0, ergaenzung: 0, frage: 0, neu: 0, relation: 0 };
  for (const i of list(draft?.items)) {
    if (i.action === 'verknuepfen') t.verknuepfen += 1;
    else if (i.action === 'ergaenzen') t.ergaenzung += 1;
    else if (i.kind === 'bestaetigung') t.bestaetigung += 1;
    else if (i.kind === 'synthesis') t.synthese += 1;
    else if (i.kind === 'question') t.frage += 1;
    else if (i.action === 'neu') t.neu += 1;
    else if (i.kind === 'relation') t.relation += 1;
  }
  return t;
}

/** Hinweis an der Karte, wenn Claude über den Text hinaus etwas anbietet; sonst null. */
export function offerLabel(t) {
  if (t.synthese) return t.synthese === 1 ? 'Synthese angeboten' : 'Synthesen angeboten';
  if (t.ergaenzung) return t.ergaenzung === 1 ? 'Ergänzung angeboten' : 'Ergänzungen angeboten';
  return t.frage ? 'Frage angeboten' : null;
}

/** „3 Verknüpfungen · 1 Synthese · 1 Synthese-Ergänzung · 2 neue Seiten“; ohne Vorschläge „nur die Source-Page“. */
export function tallyLabel(t) {
  const parts = [
    t.verknuepfen && plural(t.verknuepfen, 'Verknüpfung', 'Verknüpfungen'),
    t.bestaetigung && plural(t.bestaetigung, 'Bestätigung', 'Bestätigungen'),
    t.synthese && plural(t.synthese, 'Synthese', 'Synthesen'),
    t.ergaenzung && plural(t.ergaenzung, 'Synthese-Ergänzung', 'Synthese-Ergänzungen'),
    t.frage && plural(t.frage, 'Frage', 'Fragen'),
    t.neu && plural(t.neu, 'neue Seite', 'neue Seiten'),
    t.relation && plural(t.relation, 'Relation', 'Relationen'),
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : 'nur die Source-Page';
}

const titleOf = (e) => e?.draft?.source?.title || e?.doc?.title || e?.doc?.url || 'Ohne Titel';
const docTitle = (e) => e?.doc?.title || e?.doc?.url || titleOf(e);

function when(iso, tz) {
  const t = Date.parse(iso ?? '');
  if (Number.isNaN(t)) return null;
  return new Intl.DateTimeFormat('de-DE', { timeZone: tz, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(t));
}

/** Satz zu einem Entwurf in Arbeit. */
function busyLabel(e, at = Date.now()) {
  if (e.status === 'wartet') return e.origin === 'nacht' ? 'Wartet auf den Nachtlauf' : 'Wartet, bis Claude frei ist';
  const since = Date.parse(e.updated_at ?? e.requested_at ?? '');
  const m = Number.isNaN(since) ? null : Math.max(0, Math.floor((at - since) / 60_000));
  return `Claude entwirft${m === null ? '' : m < 1 ? ', gerade begonnen' : `, seit ${m} Min.`} (meist 1 bis 3 Minuten)`;
}

/** Fehler des Dienstes (`IngestError`) und des Speichers als Meldung der Seite. */
async function run(fn) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ActionError) throw err;
    if (err instanceof ReadingError) throw new ActionError(err.message, err.status ?? 400);
    if (['IngestError', 'PlantError'].includes(err?.name) || ['IngestError', 'PlantError'].includes(err?.constructor?.name)) throw new ActionError(err.message, err.status ?? 400);
    throw err;
  }
}

// --- Abzeichen (Stapel, Leseansicht, Live-Stand) ------------------------------

/**
 * Abzeichen eines Dokuments: „Ingest bereit“ (Link zur Prüfansicht), „wird
 * entworfen…“, „Ingest-Fehler“, „Im Wiki“ oder der Knopf „Ingest entwerfen“
 * (nur, wenn Claude verfügbar ist). `data-ingest-watch` lässt
 * /static/lesen-ingest.js nachfragen, bis der Entwurf fertig ist.
 */
export function ingestBadge(id, status, { ctx, title = '', available = true, ready = 'Ingest bereit', back = null }) {
  const data = `data-ingest-badge="${esc(id)}" data-ingest-status="${esc(status ?? '')}"`;
  const sr = title ? `<span class="sr-only">: ${esc(title)}</span>` : '';
  if (status === 'bereit') return `<a href="${esc(ingestLink(id))}" class="ingest-badge is-ready" ${data}>${esc(ready)}${sr}</a>`;
  if (BUSY.includes(status)) return `<span class="ingest-badge is-busy" ${data} data-ingest-watch="${esc(id)}">${status === 'wartet' ? 'wartet auf Claude…' : 'wird entworfen…'}</span>`;
  if (status === 'fehler') return `<a href="${esc(ingestLink(id))}" class="ingest-badge is-failed" ${data}>Ingest-Fehler${sr}</a>`;
  if (status === 'uebernommen') return `<span class="ingest-badge is-done" ${data}>Im Wiki</span>`;
  if (!available) return '';
  return `<form method="post" action="${ENTWERFEN}" class="act ingest-badge-form" ${data}>${hidden({ csrf: ctx.write.csrf, back: back ?? ctx.write.back, id })}<button type="submit" class="btn quiet">Ingest entwerfen${sr}</button></form>`;
}

// --- Einpflanzen ------------------------------------------------------------

const plantOf = (e) => (e?.status === 'uebernommen' ? (e.applied?.plant ?? null) : null);

/** Satz zum Stand des Einpflanzens. */
function plantLabel(p) {
  if (p.status === 'wartet') return 'Wartet, bis Claude frei ist';
  if (p.status === 'laeuft') return 'Claude pflanzt die Quelle in die Seiten ein, meist 2 bis 6 Minuten';
  if (p.status === 'fehler') return `Einpflanzen fehlgeschlagen: ${p.error || 'unbekannter Fehler'}`;
  const n = list(p.changed).filter((c) => wikiPath(c?.path)).length;
  return n ? `Eingepflanzt in ${plural(n, 'Seite', 'Seiten')}` : 'Eingepflanzt, keine Seite brauchte mehr als den Link';
}

/** In der Übersicht: was wartet, läuft, fehlschlug oder in den letzten Tagen fertig wurde. */
function plantingNow(all, at = Date.now()) {
  return all.filter((e) => {
    const p = plantOf(e);
    if (!p) return false;
    if (p.status !== 'fertig') return true;
    const t = Date.parse(p.finished_at ?? '');
    return !Number.isNaN(t) && at - t < PLANT_RECENT_MS;
  });
}

const plantForm = (ctx, id, back, label, cls = 'btn') => `<form method="post" action="${EINPFLANZEN}" class="act">${hidden({ csrf: ctx.write.csrf, back, id })}<button type="submit" class="${cls}">${label}</button></form>`;

/** Geänderte Seiten mit dem, was sie bekommen haben, und was offen bleibt. */
function plantDetails(p) {
  const changed = list(p.changed).filter((c) => wikiPath(c?.path));
  const pages = changed.length
    ? `<ul class="ingest-plant-pages">${changed.map((c) => `<li><a href="${esc(noteLink(c.path))}" class="ingest-ref">${esc(readable(slugOf(c.path)))}</a>${c.was ? ` – ${inlineMd(c.was)}` : ''}</li>`).join('')}</ul>`
    : '';
  const open = list(p.open).length ? `<p class="meta">Offen für dich:</p><ul class="ingest-plant-open">${list(p.open).map((o) => `<li>${inlineMd(o)}</li>`).join('')}</ul>` : '';
  return `${p.summary ? `<p>${inlineMd(p.summary)}</p>` : ''}${pages}${open}`;
}

/**
 * Stand des Einpflanzens in der Prüfansicht eines übernommenen Entwurfs; läuft
 * es, lädt /static/lesen-ingest.js die Seite neu, sobald es fertig ist.
 */
function plantBlock(e, ctx, planter) {
  if (!planter) return '';
  const id = e.doc_id;
  const back = ingestLink(id);
  const p = plantOf(e);
  const can = Boolean(planter.available?.()?.ok);
  if (!p) {
    return `<section class="ingest-state ingest-plant"><p><b>Einpflanzen</b><span class="meta"> Ein Agent arbeitet die Quelle in die Seiten ein, an die sie andockt, und hält Widersprüche als Spannung fest.</span></p>${can ? plantForm(ctx, id, back, 'Jetzt einpflanzen') : ''}</section>`;
  }
  if (PLANT_BUSY.includes(p.status)) {
    return `<section class="ingest-state ingest-plant" data-ingest-watch="${esc(id)}" data-ingest-plant data-ingest-status="${esc(p.status)}" data-ingest-reload>
      <div class="ingest-state-row"><span class="folge-spinner" aria-hidden="true"></span><p><b>Einpflanzen</b><span class="meta">${esc(plantLabel(p))}. Die Seite aktualisiert sich, sobald es fertig ist.</span></p></div>
      <noscript><p class="meta"><a href="${esc(back)}">Stand aktualisieren</a></p></noscript>
    </section>`;
  }
  if (p.status === 'fehler') {
    return `<section class="ingest-state ingest-plant"><p class="problem">${esc(plantLabel(p))}</p>${plantDetails(p)}${can ? plantForm(ctx, id, back, 'Erneut einpflanzen') : ''}</section>`;
  }
  return `<section class="ingest-state ingest-plant"><p><b>${esc(plantLabel(p))}</b>${p.finished_at ? `<span class="meta"> · ${esc(when(p.finished_at, ctx.tz) ?? '')}</span>` : ''}</p>${plantDetails(p)}${can ? plantForm(ctx, id, back, 'Noch einmal einpflanzen', 'btn quiet') : ''}</section>`;
}

function plantRow(e, ctx, planter) {
  const p = plantOf(e);
  const busy = PLANT_BUSY.includes(p.status);
  const watch = busy ? ` data-ingest-watch="${esc(e.doc_id)}" data-ingest-plant data-ingest-status="${esc(p.status)}"` : '';
  const retry = p.status === 'fehler' && planter?.available?.()?.ok ? `<div class="ingest-row-actions">${plantForm(ctx, e.doc_id, INGEST, 'Erneut einpflanzen')}</div>` : '';
  const pages = list(p.changed).filter((c) => wikiPath(c?.path));
  return `<li class="ingest-row${busy ? ' is-busy' : p.status === 'fehler' ? ' is-failed' : ''}" data-ingest-doc="${esc(e.doc_id)}"${watch}>
    ${busy ? '<span class="folge-spinner" aria-hidden="true"></span>' : ''}
    <span class="ingest-row-text"><a href="${esc(ingestLink(e.doc_id))}" class="lesen-title">${esc(titleOf(e))}</a><span class="meta">${esc(plantLabel(p))}</span>${
      p.status === 'fertig' && pages.length ? `<span class="meta">${pages.map((c) => esc(readable(slugOf(c.path)))).join(' · ')}</span>` : ''
    }</span>
    ${retry}
  </li>`;
}

// --- Übersicht ---------------------------------------------------------------

/**
 * Wie viele Texte „Ganzen Stapel entwerfen“ anstößt: wie `requestStack` des
 * Dienstes die ohne Entwurf und die fehlgeschlagenen; verworfene nicht.
 */
function openOnStack(store, ingest) {
  const docs = store.list({ status: 'stapel', limit: -1 });
  const st = ingest.statusFor(docs.map((d) => d.id));
  return docs.filter((d) => [null, 'fehler'].includes(statusIn(st, d.id))).length;
}

function readyCard(e, ctx) {
  const view = pageView(e);
  const t = tally(e.draft);
  const kern = list(e.draft?.digest?.kernaussagen).slice(0, 3);
  const offer = offerLabel(t);
  const meta = [e.doc?.site, e.doc?.reading_minutes ? `${e.doc.reading_minutes} Min.` : null, e.origin === 'nacht' ? 'nachts entworfen' : null, when(e.drafted_at, ctx.tz)].filter(Boolean);
  return `<li class="ingest-card" data-ingest-doc="${esc(e.doc_id)}">
    <div class="ingest-card-head">
      <span class="meta">${esc(meta.join(' · '))}</span>
      <a href="${esc(ingestLink(e.doc_id))}" class="ingest-card-title">${esc(titleOf(e))}</a>
    </div>
    ${kern.length ? `<ul class="ingest-kern is-short">${kern.map((k) => `<li>${view.inline(k)}</li>`).join('')}</ul>` : ''}
    <div class="ingest-card-foot">
      <span class="ingest-tally">${esc(tallyLabel(t))}</span>
      ${offer ? `<span class="ingest-pill is-offer">${esc(offer)}</span>` : ''}
      <a href="${esc(ingestLink(e.doc_id))}" class="btn primary">Prüfen<span class="sr-only">: ${esc(titleOf(e))}</span></a>
    </div>
  </li>`;
}

function busyRow(e, at) {
  return `<li class="ingest-row is-busy" data-ingest-doc="${esc(e.doc_id)}" data-ingest-watch="${esc(e.doc_id)}" data-ingest-status="${esc(e.status)}">
    <span class="folge-spinner" aria-hidden="true"></span>
    <span class="ingest-row-text"><a href="${esc(docLink(e.doc_id))}" class="lesen-title">${esc(docTitle(e))}</a><span class="meta">${esc(busyLabel(e, at))}</span></span>
  </li>`;
}

function failedRow(e, ctx, available) {
  const form = (action, fields, label, cls = 'btn quiet') => `<form method="post" action="${action}" class="act">${hidden({ csrf: ctx.write.csrf, back: INGEST, id: e.doc_id, ...fields })}<button type="submit" class="${cls}">${label}</button></form>`;
  return `<li class="ingest-row is-failed" data-ingest-doc="${esc(e.doc_id)}">
    <span class="ingest-row-text"><a href="${esc(docLink(e.doc_id))}" class="lesen-title">${esc(docTitle(e))}</a><span class="meta">${esc([e.doc?.site, when(e.updated_at, ctx.tz)].filter(Boolean).join(' · '))}</span></span>
    <p class="problem">${esc(e.error || 'Der Entwurf ist fehlgeschlagen.')}</p>
    <div class="ingest-row-actions">${available ? form(ENTWERFEN, { force: '1' }, 'Erneut entwerfen', 'btn') : ''}${form(VERWERFEN, {}, 'Verwerfen')}</div>
  </li>`;
}

/** Hinweis, wenn Claude fehlt: Entwürfe abhaken geht trotzdem. */
const unavailable = (av) => `<p class="problem unconfigured">Claude ist gerade nicht verfügbar${av.reason ? `: ${esc(av.reason)}` : ''}. Neue Entwürfe entstehen erst wieder, wenn Claude angebunden ist; fertige lassen sich weiter abhaken.</p>`;

function overview({ store, ingest, planter }, ctx) {
  const av = ingest.available() ?? { ok: false };
  const all = ingest.list();
  const ready = all.filter((e) => e.status === 'bereit');
  const busy = all.filter((e) => BUSY.includes(e.status));
  const failed = all.filter((e) => e.status === 'fehler');
  const planting = planter ? plantingNow(all) : [];
  const open = openOnStack(store, ingest);
  const at = Date.now();

  const stackForm = av.ok && open
    ? `<form method="post" action="${ENTWERFEN}" class="act ingest-stapel">${hidden({ csrf: ctx.write.csrf, back: INGEST, stapel: '1' })}<button type="submit" class="btn">Ganzen Stapel entwerfen</button><span class="meta">${esc(open === 1 ? 'Ein Text auf dem Stapel hat noch keinen fertigen Entwurf.' : `${open} Texte auf dem Stapel haben noch keinen fertigen Entwurf.`)} Claude entwirft einen nach dem anderen.</span></form>`
    : '';
  const intro = `<div class="ingest-intro">${av.ok ? '' : unavailable(av)}${stackForm}</div>`;

  if (!ready.length && !busy.length && !failed.length && !planting.length) {
    const empty = `<div class="ingest-empty">
      <p class="ingest-empty-title">Nichts zum Abhaken</p>
      <p>Claude liest die Texte auf deinem Stapel und schlägt vor, was davon ins Wiki gehört: Source-Page, Verknüpfungen, neue Seiten, Synthesen. Nachts von selbst, oder jetzt per Knopf. Ins Wiki kommt nur, was du hier abhakst.</p>
      ${open ? '' : '<p class="meta">Gerade liegt nichts ohne Entwurf auf dem Stapel.</p>'}
    </div>`;
    return `${intro}<section>${empty}</section>`;
  }

  const sections = [
    `<section class="ingest-ready" aria-labelledby="ingest-bereit"><h2 id="ingest-bereit">Bereit zum Abhaken <span class="hint">${ready.length}</span></h2>${
      ready.length ? `<ul class="ingest-cards">${ready.map((e) => readyCard(e, ctx)).join('')}</ul>` : '<p class="empty">Gerade keiner. Was in Arbeit ist, erscheint hier, sobald Claude fertig ist.</p>'
    }</section>`,
    busy.length ? `<section class="ingest-busy" aria-labelledby="ingest-arbeit"><h2 id="ingest-arbeit">In Arbeit <span class="hint">${busy.length}</span></h2><ul class="ingest-rows">${busy.map((e) => busyRow(e, at)).join('')}</ul><noscript><p class="meta"><a href="${INGEST}">Stand aktualisieren</a></p></noscript></section>` : '',
    planting.length ? `<section class="ingest-planting" aria-labelledby="ingest-einpflanzen"><h2 id="ingest-einpflanzen">Einpflanzen <span class="hint">${planting.length}</span></h2><ul class="ingest-rows">${planting.map((e) => plantRow(e, ctx, planter)).join('')}</ul></section>` : '',
    failed.length ? `<section class="ingest-failed" id="fehler" aria-labelledby="ingest-fehler"><h2 id="ingest-fehler">Fehler <span class="hint">${failed.length}</span></h2><ul class="ingest-rows">${failed.map((e) => failedRow(e, ctx, av.ok)).join('')}</ul></section>` : '',
  ];
  return `${intro}${sections.join('')}`;
}

// --- Prüfansicht -------------------------------------------------------------

/** Slug als Wörter, wenn kein Titel bekannt ist: `local-first-software` → „local first software“. */
const readable = (slug) => String(slug ?? '').replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();

/** Link auf eine Wiki-Seite, sonst nur der Titel. */
const pageRef = (path, title) => (wikiPath(path) ? `<a href="${esc(noteLink(path))}" class="ingest-ref">${esc(title || readable(slugOf(path)))}</a>` : `<span class="ingest-ref">${esc(title || readable(slugOf(path)) || 'Seite')}</span>`);

/**
 * Seiten, die ein Entwurf kennt, nach Slug (klein geschrieben): `{ path, title }`,
 * `path` nur für bestehende Wiki-Seiten. Vorrang hat `links` des Dienstes
 * (`{ slug: { path, title } }`, falls er es liefert), dann Vorschläge und Digest,
 * die neuen Seiten (ohne Pfad) und die Source-Page selbst.
 */
function knownPages(e) {
  const draft = e?.draft ?? {};
  const d = draft.digest ?? {};
  const known = new Map();
  const put = (slug, path, title) => {
    const key = String(slug ?? '').trim().replace(/\.md$/i, '').toLowerCase();
    if (!key) return;
    const was = known.get(key) ?? { path: null, title: null };
    known.set(key, { path: was.path ?? (wikiPath(path) ? path : null), title: was.title ?? (title ? String(title) : null) });
  };
  const links = e?.links;
  if (links && typeof links === 'object') for (const [slug, v] of links instanceof Map ? links : Object.entries(links)) put(slug, v?.path, v?.title);
  const newSlugs = new Set(list(draft.items).filter((i) => i?.action === 'neu' && i.slug).map((i) => String(i.slug).toLowerCase()));
  for (const x of [...list(draft.items), ...list(d.bestaetigt), ...list(d.widerspricht), ...list(d.dockt_an)]) {
    if (!x) continue;
    if (x.action === 'neu') put(x.slug, null, x.title);
    else {
      const path = x.path ?? x.to;
      // Eine Relation auf eine Seite, die erst mit diesem Entwurf entsteht, ist noch kein Link.
      if (typeof path === 'string' && !newSlugs.has(slugOf(path).toLowerCase())) put(slugOf(path), path, x.title);
    }
  }
  for (const i of list(draft.items)) for (const p of list(i?.beteiligte)) if (typeof p === 'string') put(slugOf(p), p, null);
  put(draft.source?.slug, null, draft.source?.title);
  return known;
}

/** `[[Ziel#Abschnitt|Anzeige]]` außerhalb von Code: bekannte Seite → `[[pfad|Titel]]`, sonst lesbarer Text. */
function rewriteLinks(src, known, { block = false } = {}) {
  // In Tabellenzeilen trennt `\|` die Anzeige ab, ein bloßes `|` die Spalten.
  const one = (sep) => (all, bang, inner) => {
    const [targetPart, ...aliasParts] = inner.split('|');
    const alias = aliasParts.join('|').trim();
    const [base, ...anchor] = targetPart.split('#');
    const key = base.trim().replace(/\\$/, '').replace(/\.md$/i, '').toLowerCase();
    const page = known.get(key) ?? known.get(key.split('/').pop());
    const label = (alias || page?.title || readable(key.split('/').pop()) || inner).replace(/[[\]|\n]/g, ' ').trim();
    if (!page?.path) return label;
    const at = anchor.length ? `#${anchor.join('#').replace(/\\$/, '')}` : '';
    return `[[${page.path.replace(/\.md$/, '')}${at}${sep}${label}]]`;
  };
  const inline = (line) => {
    const sep = block && /^\s*\|/.test(line) ? '\\|' : '|';
    return line.split(/(`[^`\n]*`)/).map((part, i) => (i % 2 ? part : part.replace(/(!?)\[\[([^[\]\n]+)\]\]/g, one(sep)))).join('');
  };
  if (!block) return inline(src);
  let fence = null;
  return src.split('\n').map((line) => {
    const m = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length) fence = null;
      return line;
    }
    if (m) {
      fence = m[1];
      return line;
    }
    return inline(line);
  }).join('\n');
}

/**
 * Darstellung von Claudes Text für einen Entwurf: `inline` für Sätze, `block`
 * für Seitentexte, `title(path)` für Pfade ohne eigenen Titel. Wikilinks auf
 * bekannte Seiten werden Links mit Titel, alle anderen lesbarer Text.
 */
function pageView(e) {
  const { known, links } = linksOf(e);
  return {
    known,
    inline: (s) => inlineMd(rewriteLinks(String(s ?? ''), known), links),
    block: (s) => renderMarkdown(rewriteLinks(String(s ?? ''), known, { block: true }), { links }),
    title: (path) => known.get(slugOf(path).toLowerCase())?.title ?? null,
  };
}

/** Bekannte Seiten eines Entwurfs und der Auflöser dazu: nur bestehende Wiki-Seiten werden Links. */
function linksOf(e) {
  const known = knownPages(e);
  const paths = new Set([...known.values()].map((p) => p.path).filter(Boolean));
  const links = {
    wikilink: (target) => (paths.has(`${target}.md`) ? { kind: 'note', path: `${target}.md` } : null),
    markdownLink: () => null,
    image: () => null,
  };
  return { known, links };
}

/**
 * Wie `pageView`, aber als Baum für die App (`NoteInline`/`NoteBlock` dort):
 * `inline` für Sätze, `block` für Seitentexte (Checkboxen nur zur Anzeige).
 */
function treeView(e) {
  const { known, links } = linksOf(e);
  return {
    known,
    inline: (s) => parseInline(rewriteLinks(String(s ?? ''), known), links),
    block: (s) => parseMarkdown(rewriteLinks(String(s ?? ''), known, { block: true }), { links, checkboxes: false }),
    title: (path) => known.get(slugOf(path).toLowerCase())?.title ?? null,
  };
}

function digestBlock(draft, view) {
  const text = view.inline;
  const d = draft?.digest ?? {};
  const kern = list(d.kernaussagen);
  const neu = list(d.neu);
  const ok = list(d.bestaetigt);
  const contra = list(d.widerspricht);
  const dock = list(d.dockt_an);
  const hints = list(draft?.hinweise);
  const block = (cls, title, body) => `<div class="ingest-d ${cls}"><h3>${title}</h3>${body}</div>`;
  const parts = [
    kern.length ? `<ul class="ingest-kern">${kern.map((k) => `<li>${text(k)}</li>`).join('')}</ul>` : '<p class="empty">Claude hat keine Kernaussagen notiert.</p>',
    neu.length ? block('is-neu', 'Neu für dich', `<ul>${neu.map((n) => `<li>${text(n)}</li>`).join('')}</ul>`) : '',
    ok.length ? block('is-ok', 'Bestätigt', `<ul>${ok.map((b) => `<li>${pageRef(b.path, b.title)}<span>${text(b.claim)}</span></li>`).join('')}</ul>`) : '',
    contra.length
      ? block('is-contra', 'Widerspricht', contra.map((c) => `<div class="problem"><p>${pageRef(c.path, c.title)}: ${text(c.claim)}</p>${c.vorschlag ? `<p class="meta">Vorschlag: ${text(c.vorschlag)}</p>` : ''}<p class="meta">Das Cockpit ändert die Seite nicht. Auflösung per <code>/wiki-lint</code>.</p></div>`).join(''))
      : '',
    dock.length ? block('is-dock', 'Dockt an', `<ul>${dock.map((x) => `<li>${pageRef(x.path, x.title)}${x.warum ? `<span>${text(x.warum)}</span>` : ''}</li>`).join('')}</ul>`) : '',
    hints.length ? `<ul class="ingest-hinweise">${hints.map((h) => `<li>${text(h)}</li>`).join('')}</ul>` : '',
  ];
  return `<section class="ingest-digest" aria-labelledby="ingest-digest"><h2 id="ingest-digest">Das Wichtigste</h2>${parts.join('')}</section>`;
}

/**
 * `applied`: Stand eines unterbrochenen Übernehmens (src/lesen/ingest.js). Steht
 * die Source-Page schon im Wiki, wirken Änderungen an ihren Feldern nicht mehr,
 * der Slug ist ab dem ersten Schreiben fest; dann sind die Felder schreibgeschützt.
 */
function sourceBlock(draft, applied, view) {
  const s = { ...(draft?.source ?? {}), ...(applied?.slug ? { slug: applied.slug } : {}) };
  const written = list(applied?.steps).includes('source');
  const lock = (on) => (on ? ' readonly' : '');
  const summary = String(s.summary ?? '');
  const tags = list(s.tags).join(', ');
  const meta = [s.confidence ? `Konfidenz: ${CONFIDENCE[s.confidence] ?? s.confidence}` : null, s.slug ? `wiki/sources/${s.slug}.md` : null].filter(Boolean);
  return `<section class="ingest-source" aria-labelledby="ingest-source">
    <h2 id="ingest-source">Source-Page <span class="hint">${esc(meta.join(' · '))}</span></h2>
    <div class="ingest-fields">
      <label class="ingest-field is-wide"><span>Titel</span><input type="text" name="title" value="${esc(s.title ?? '')}" required${lock(written)}></label>
      <label class="ingest-field is-wide"><span class="ingest-field-row">Summary <span class="ingest-count${summary.length > SUMMARY_MAX ? ' is-over' : ''}" data-ingest-count-for="summary">${summary.length}/${SUMMARY_MAX}</span></span><input type="text" name="summary" value="${esc(summary)}" maxlength="${SUMMARY_MAX}" data-ingest-summary${lock(written)}></label>
      <label class="ingest-field"><span>Slug</span><input type="text" name="slug" value="${esc(s.slug ?? '')}" pattern="[a-z0-9]+(-[a-z0-9]+)*" spellcheck="false" autocapitalize="off" autocomplete="off" title="Kleinbuchstaben, Ziffern und Bindestriche"${lock(Boolean(applied?.slug))}></label>
      <label class="ingest-field"><span>Tags</span><input type="text" name="tags" value="${esc(tags)}" spellcheck="false" autocapitalize="off" autocomplete="off" placeholder="englisch, mit Komma"${lock(written)}></label>
    </div>
    ${s.body ? `<details class="ingest-body"><summary>Text der Source-Page ansehen</summary><div class="md ingest-md">${view.block(s.body)}</div></details>` : ''}
  </section>`;
}

/** Beschriftung des aufklappbaren Texts eines Vorschlags. */
export const bodyLabel = (item, featured) => (item.action === 'ergaenzen' ? 'Was ergänzt wird' : featured ? 'Ganzen Text lesen' : 'Text der Seite ansehen');

/**
 * Ein Vorschlag zum Abhaken. Der Titel einer bestehenden Seite ist selbst der
 * eigenes Symbol „↗“ zum Öffnen neben dem `<label>` (nicht der Titel: ein Tipp
 * darauf soll das Häkchen umschalten); Aufklappbares steht ebenfalls daneben,
 * sonst schaltete jeder Tipp darauf das Häkchen um.
 */
function itemRow(item, featured, view) {
  const id = esc(item.id);
  const box = `<input type="checkbox" name="item" value="${id}"${item.default === true ? ' checked' : ''}>`;
  const pill = `<span class="ingest-pill${featured ? ' is-offer' : ''}">${esc(kindLabel(item))}</span>`;
  const why = item.warum ? `<span class="ingest-why">${view.inline(item.warum)}</span>` : '';
  const target = item.path ?? item.to;
  // Nur bestehende Seiten verlinken: nicht, was neu angelegt wird, auch nicht als Ziel einer Relation.
  const exists = item.action !== 'neu' && wikiPath(target) && view.known.get(slugOf(target).toLowerCase())?.path === target;
  // Der Titel bleibt Teil des <label> (Tippen schaltet das Häkchen); geöffnet wird über ein eigenes Symbol daneben.
  const name = (label) => esc(label);
  const titleText = item.title || item.slug || readable(slugOf(target));
  const open = exists ? `<a href="${esc(noteLink(target))}" class="ingest-item-open" title="Seite öffnen" aria-label="${esc(`„${titleText}“ öffnen`)}">↗</a>` : '';
  let main;
  if (item.kind === 'relation') {
    const type = RELATION[item.type] ?? item.type ?? 'Relation';
    main = `<span class="ingest-item-title"><span class="ingest-rel" title="${esc(item.type ?? '')}">${esc(type)}</span> ${name(item.title || readable(slugOf(item.to)))}</span>`;
  } else if (item.kind === 'bestaetigung') {
    main = `<span class="ingest-item-title">${name(item.title || readable(slugOf(item.path)))}</span>${item.claim ? `<span class="ingest-claim">${view.inline(item.claim)}</span>` : ''}`;
  } else {
    main = `<span class="ingest-item-title">${name(item.title || item.slug || readable(slugOf(item.path)))}</span>${item.summary ? `<span class="ingest-summary">${view.inline(item.summary)}</span>` : ''}`;
  }
  const head = item.kind === 'relation' || item.kind === 'bestaetigung' ? '' : pill;
  const involved = list(item.beteiligte).filter(Boolean);
  const extra = [
    involved.length ? `<p class="ingest-involved"><span class="meta">Beteiligt:</span> ${involved.map((p) => pageRef(p, view.title(p))).join(', ')}</p>` : '',
    item.body ? `<details class="ingest-body"><summary>${esc(bodyLabel(item, featured))}</summary><div class="md ingest-md">${view.block(item.body)}</div></details>` : '',
  ].filter(Boolean).join('');
  const where = item.action === 'neu' && item.slug ? `<span class="ingest-path">neu: ${esc(item.slug)}</span>` : item.action === 'ergaenzen' && wikiPath(item.path) ? `<span class="ingest-path">ergänzt: ${esc(slugOf(item.path))}</span>` : '';
  return `<li class="ingest-item${featured ? ' is-featured' : ''}${open ? ' has-open' : ''}" data-item="${id}">
    ${open}<label class="ingest-pick">${box}<span class="ingest-pick-text"><span class="ingest-item-head">${head}${main}</span>${why}${where}</span></label>
    ${extra ? `<div class="ingest-item-more">${extra}</div>` : ''}
  </li>`;
}

function itemGroups(draft, view) {
  const groups = groupItems(draft?.items);
  if (!groups.length) return '<section class="ingest-group"><p class="empty">Claude schlägt nichts über die Source-Page hinaus vor.</p></section>';
  return groups
    .map(
      (g) => `<section class="ingest-group${g.featured ? ' is-featured' : ''}" data-ingest-group="${g.key}" aria-labelledby="ingest-g-${g.key}">
    <div class="ingest-group-head">
      <h2 id="ingest-g-${g.key}">${esc(g.label)} <span class="hint">${g.items.length}</span></h2>
      <span class="ingest-all" data-ingest-all hidden><button type="button" class="chip quiet" data-select="all">alle</button><button type="button" class="chip quiet" data-select="none">keine</button></span>
    </div>
    ${g.hint ? `<p class="meta ingest-group-hint">${esc(g.hint)}</p>` : ''}
    <ul class="ingest-items">${g.items.map((i) => itemRow(i, g.featured, view)).join('')}</ul>
  </section>`,
    )
    .join('');
}

/** Satz am Knopf: was übernommen wird. Dieselbe Rechnung macht /static/lesen-ingest.js beim Abhaken. */
export const applySummary = (n) => (n ? `Source-Page und ${plural(n, 'Vorschlag', 'Vorschläge')}` : 'Nur die Source-Page');

/** Bereite Entwürfe in der Reihenfolge der Übersicht: voriger, nächster, Stelle. */
function neighbours(ingest, id) {
  const ids = ingest.list({ status: 'bereit' }).map((e) => e.doc_id);
  const i = ids.indexOf(id);
  if (i < 0) return { prev: null, next: ids[0] ?? null, position: null, total: ids.length };
  return { prev: ids[i - 1] ?? null, next: ids[i + 1] ?? null, position: i + 1, total: ids.length };
}

/** Wohin nach Übernehmen oder Erledigen: der nächste bereite Entwurf, sonst der vorige, sonst die Übersicht. */
function nextAfter(ids, id) {
  const i = ids.indexOf(id);
  const rest = i < 0 ? ids : [...ids.slice(i + 1), ...ids.slice(0, i).reverse()];
  const next = rest.find((x) => x !== id);
  return next ? ingestLink(next) : INGEST;
}

const KEYS = [
  ['J / K', 'nächster / voriger Entwurf'],
  ['Leertaste', 'Häkchen umschalten'],
  ['Enter', 'übernehmen (zweimal)'],
  ['E', 'ohne Wiki erledigen'],
];

function reviewHead(e, doc, nav) {
  const original = httpUrl(doc?.url);
  const meta = [doc?.site, doc?.reading_minutes ? `${doc.reading_minutes} Min. Lesezeit` : null].filter(Boolean);
  const pager = nav && nav.total > 0 && nav.position
    ? `<nav class="pager ingest-pager" aria-label="Entwürfe">${nav.prev ? `<a href="${esc(ingestLink(nav.prev))}" rel="prev" data-ingest-prev aria-label="Voriger Entwurf">‹</a>` : '<span aria-hidden="true">‹</span>'}<span class="pager-now">${nav.position} von ${nav.total}</span>${nav.next ? `<a href="${esc(ingestLink(nav.next))}" rel="next" data-ingest-next aria-label="Nächster Entwurf">›</a>` : '<span aria-hidden="true">›</span>'}</nav>`
    : '';
  return `<div class="ingest-kopf">
    <p class="meta">${esc(meta.join(' · ') || 'Ingest-Entwurf')}</p>
    <h1 class="ingest-h1">${esc(docTitle(e ?? { doc }))}</h1>
    <p class="ingest-links"><a href="${esc(docLink(doc?.id ?? e?.doc_id))}">Text lesen</a>${original ? `<a href="${esc(original)}" rel="noopener noreferrer" target="_blank">Original</a>` : ''}<a href="${INGEST}">Alle Entwürfe</a></p>
  </div>${pager}`;
}

/**
 * Unterbrochenes Übernehmen: Der Entwurf bleibt bereit, `error` und `applied`
 * sagen, was schon geschrieben ist. Ohne diesen Hinweis sähe die Prüfansicht
 * aus wie vorher, obwohl Rohquelle und Source-Page schon im Vault liegen.
 */
function haltedBlock(e) {
  const a = e?.applied;
  if (!e?.error || !a || (!list(a.steps).length && !a.source)) return '';
  const written = list(a.steps).includes('source') && wikiPath(a.source);
  return `<section class="ingest-state" role="status"><p class="problem">Übernehmen unterbrochen: ${esc(e.error)}</p><p class="meta">${
    written ? `Die Source-Page <a href="${esc(noteLink(a.source))}">${esc(slugOf(a.source))}</a> ist schon geschrieben; ihre Felder lassen sich hier nicht mehr ändern.` : 'Ein Teil ist schon geschrieben.'
  } „Ins Wiki übernehmen“ setzt dort fort, ohne etwas doppelt zu schreiben.</p></section>`;
}

/** Prüfansicht eines bereiten Entwurfs: ein Formular, die Nebenaktionen per `formaction`. */
function reviewForm(e, ctx, nav) {
  const draft = e.draft ?? {};
  const chosen = list(draft.items).filter((i) => i?.default === true).length;
  const back = ingestLink(e.doc_id);
  const view = pageView(e);
  return `<form method="post" action="${UEBERNEHMEN}" class="ingest-form" data-ingest-form>
    ${hidden({ csrf: ctx.write.csrf, back, id: e.doc_id })}
    <button type="submit" class="ingest-guard" disabled hidden aria-hidden="true" tabindex="-1"></button>
    ${haltedBlock(e)}
    ${digestBlock(draft, view)}
    ${sourceBlock(draft, e.applied, view)}
    ${itemGroups(draft, view)}
    <div class="ingest-weitere">
      <button type="submit" class="btn quiet" formaction="${ENTWERFEN}" formnovalidate name="force" value="1" data-confirm="Claude entwirft neu, der jetzige Entwurf geht verloren.">Neu entwerfen</button>
      <button type="submit" class="btn quiet" formaction="${VERWERFEN}" formnovalidate name="done" value="1" data-ingest-done>Ohne Wiki erledigen <kbd>E</kbd></button>
      <button type="submit" class="btn quiet danger" formaction="${VERWERFEN}" formnovalidate data-confirm="Entwurf verwerfen? Der Text bleibt auf dem Stapel.">Entwurf verwerfen</button>
    </div>
    <div class="ingest-los">
      <p class="ingest-summe" aria-live="polite"><b data-ingest-sum>${esc(applySummary(chosen))}</b><span class="meta">Der Text kommt mit nach <code>raw/</code> und gilt danach als gelesen.</span></p>
      <button type="submit" class="btn primary" data-ingest-apply>Ins Wiki übernehmen <span class="ingest-n" data-ingest-n>${chosen + 1}</span></button>
    </div>
    <section class="lesen-keys ingest-keys"><h2>Tastenkürzel</h2><dl>${KEYS.map(([k, label]) => `<div><dt><kbd>${k}</kbd></dt><dd>${label}</dd></div>`).join('')}</dl></section>
  </form>`;
}

/** Prüfansicht, wenn (noch) kein bereiter Entwurf da ist. */
function reviewState(e, doc, ctx, available, planter = null) {
  const id = e?.doc_id ?? doc.id;
  const back = ingestLink(id);
  const draftForm = (label, force = false, cls = 'btn primary') =>
    available ? `<form method="post" action="${ENTWERFEN}" class="act">${hidden({ csrf: ctx.write.csrf, back, id, force: force ? '1' : null })}<button type="submit" class="${cls}">${label}</button></form>` : '';
  if (e && BUSY.includes(e.status)) {
    return `<section class="ingest-state" data-ingest-watch="${esc(id)}" data-ingest-status="${esc(e.status)}" data-ingest-reload>
      <div class="ingest-state-row"><span class="folge-spinner" aria-hidden="true"></span><p><b>${e.status === 'wartet' ? 'Wartet auf Claude' : 'Claude entwirft'}</b><span class="meta">${esc(busyLabel(e))}. Die Seite aktualisiert sich, sobald der Entwurf da ist.</span></p></div>
      <noscript><p class="meta"><a href="${esc(back)}">Stand aktualisieren</a></p></noscript>
    </section>`;
  }
  if (e?.status === 'fehler') {
    return `<section class="ingest-state"><p class="problem">${esc(e.error || 'Der Entwurf ist fehlgeschlagen.')}</p><div class="ingest-row-actions">${draftForm('Erneut entwerfen', true)}<form method="post" action="${VERWERFEN}" class="act">${hidden({ csrf: ctx.write.csrf, back: INGEST, id })}<button type="submit" class="btn quiet">Verwerfen</button></form></div></section>`;
  }
  if (e?.status === 'uebernommen') {
    const src = e.applied?.source;
    return `<section class="ingest-state"><p class="notice">Schon im Wiki${e.applied_at ? `, seit ${esc(when(e.applied_at, ctx.tz) ?? '')}` : ''}.</p>${wikiPath(src) ? `<p><a href="${esc(noteLink(src))}" class="btn">Source-Page öffnen</a></p>` : ''}</section>${plantBlock(e, ctx, planter)}`;
  }
  // Vom Dienst verworfen, weil die Rohquelle schon im Wiki ist: Grund nennen, kein neuer Entwurf.
  if (e?.status === 'verworfen' && e.error) return `<section class="ingest-state"><p class="notice">${esc(e.error)}</p></section>`;
  const what = e?.status === 'verworfen' ? 'Der letzte Entwurf wurde verworfen.' : 'Für diesen Text gibt es noch keinen Entwurf.';
  return `<section class="ingest-state"><p class="empty">${what}</p>${available ? draftForm('Ingest entwerfen') : ''}</section>`;
}

// --- JSON --------------------------------------------------------------------

/** Stand des Einpflanzens für die App; null, solange nichts übernommen oder eingereiht ist. */
function plantJson(e) {
  const p = plantOf(e);
  if (!p) return null;
  return {
    status: p.status,
    label: plantLabel(p),
    summary: p.summary ?? null,
    changed: list(p.changed).filter((c) => wikiPath(c?.path)).map((c) => ({ path: c.path, title: readable(slugOf(c.path)), was: c.was ?? null })),
    open: list(p.open),
    error: p.status === 'fehler' ? (p.error ?? null) : null,
    requestedAt: p.requested_at ?? null,
    finishedAt: p.finished_at ?? null,
  };
}

/** Ein Eintrag als JSON für die App (ohne die Texte des Entwurfs). */
export function ingestJson(e) {
  const t = tally(e.draft);
  return {
    id: e.doc_id,
    status: e.status,
    origin: e.origin ?? null,
    title: titleOf(e),
    docTitle: docTitle(e),
    url: e.doc?.url ?? null,
    site: e.doc?.site ?? null,
    readingMinutes: e.doc?.reading_minutes ?? null,
    docStatus: e.doc?.status ?? null,
    error: e.status === 'fehler' ? (e.error ?? 'Der Entwurf ist fehlgeschlagen.') : null,
    model: e.model ?? null,
    requestedAt: e.requested_at ?? null,
    draftedAt: e.drafted_at ?? null,
    appliedAt: e.applied_at ?? null,
    updatedAt: e.updated_at ?? null,
    kernaussagen: list(e.draft?.digest?.kernaussagen),
    // Die ersten drei als Baum (Wikilinks als Titel), für die Karten der App.
    kern: list(e.draft?.digest?.kernaussagen).slice(0, 3).map(treeView(e).inline),
    tally: t,
    tallyLabel: tallyLabel(t),
    offerLabel: offerLabel(t),
    plant: plantJson(e),
  };
}

/** Seite im Wiki als `{ path, title }`; `path` nur für echte Wiki-Pfade (sonst kein Link). */
const refJson = (path, title) => ({ path: wikiPath(path) ? path : null, title: title || readable(slugOf(path)) || 'Seite' });

/** Unterbrochenes Übernehmen wie `haltedBlock`: Meldung und, falls schon geschrieben, die Source-Page. */
function haltedJson(e) {
  const a = e?.applied;
  if (!e?.error || !a || (!list(a.steps).length && !a.source)) return null;
  const written = list(a.steps).includes('source') && wikiPath(a.source);
  return { message: e.error, source: written ? a.source : null };
}

/** Ein Vorschlag für die App, wie `itemRow`: Titel, Kennzeichen, Texte als Baum, `open` nur für bestehende Seiten. */
function itemJson(item, t) {
  const target = item.path ?? item.to;
  const exists = item.action !== 'neu' && wikiPath(target) && t.known.get(slugOf(target).toLowerCase())?.path === target;
  return {
    id: item.id,
    kind: item.kind ?? null,
    action: item.action ?? null,
    label: kindLabel(item),
    title: item.title || item.slug || readable(slugOf(target)) || 'Vorschlag',
    default: item.default === true,
    open: exists ? target : null,
    slug: item.action === 'neu' ? (item.slug ?? null) : null,
    relation: item.kind === 'relation' ? (RELATION[item.type] ?? item.type ?? 'Relation') : null,
    claim: item.claim ? t.inline(item.claim) : null,
    summary: item.summary ? t.inline(item.summary) : null,
    warum: item.warum ? t.inline(item.warum) : null,
    body: item.body ? t.block(item.body) : null,
    beteiligte: list(item.beteiligte).filter((p) => typeof p === 'string' && p).map((p) => refJson(p, t.title(p))),
  };
}

/**
 * Prüfansicht als Baum für die App: Digest, Hinweise, Source-Page (mit dem Slug
 * eines unterbrochenen Übernehmens und den Sperren wie `sourceBlock`), Vorschläge
 * und der Abbruch. Fremdtext bleibt Text, die App setzt ihn nur.
 */
function appView(e) {
  const draft = e?.draft;
  if (!draft) return null;
  const d = draft.digest ?? {};
  const t = treeView(e);
  const applied = e.applied;
  const s = { ...(draft.source ?? {}), ...(applied?.slug ? { slug: applied.slug } : {}) };
  return {
    kernaussagen: list(d.kernaussagen).map(t.inline),
    neu: list(d.neu).map(t.inline),
    bestaetigt: list(d.bestaetigt).map((b) => ({ ...refJson(b.path, b.title), claim: t.inline(b.claim) })),
    widerspricht: list(d.widerspricht).map((c) => ({ ...refJson(c.path, c.title), claim: t.inline(c.claim), vorschlag: c.vorschlag ? t.inline(c.vorschlag) : null })),
    docktAn: list(d.dockt_an).map((x) => ({ ...refJson(x.path, x.title), warum: x.warum ? t.inline(x.warum) : null })),
    hinweise: list(draft.hinweise).map(t.inline),
    source: {
      title: String(s.title ?? ''),
      summary: String(s.summary ?? ''),
      slug: String(s.slug ?? ''),
      tags: list(s.tags).map(String),
      confidence: s.confidence ?? null,
      confidenceLabel: s.confidence ? (CONFIDENCE[s.confidence] ?? s.confidence) : null,
      path: s.slug ? `wiki/sources/${s.slug}.md` : null,
      body: s.body ? t.block(s.body) : null,
      // Wie die `readonly` der Prüfansicht: Felder fest, sobald die Seite steht; der Slug ab dem ersten Schreiben.
      locked: list(applied?.steps).includes('source'),
      slugLocked: Boolean(applied?.slug),
    },
    items: list(draft.items).filter((i) => i && typeof i.id === 'string').map((i) => itemJson(i, t)),
    halted: haltedJson(e),
  };
}

const ACTIONS = { draft: ENTWERFEN, apply: UEBERNEHMEN, discard: VERWERFEN, plant: EINPFLANZEN };

/**
 * Rücksprung der ausgetauschten Abzeichen: eine Seite unter `/lesen/` samt
 * Query (die Leseansicht braucht ihr `?id=`), sonst der Stapel.
 */
export function standBack(raw) {
  const fallback = { back: '/lesen/stapel', path: '/lesen/stapel' };
  if (typeof raw !== 'string' || !raw.startsWith('/lesen/') || raw.length > 500) return fallback;
  let url;
  try {
    url = new URL(raw, 'http://cockpit.invalid');
  } catch {
    return fallback;
  }
  if (url.origin !== 'http://cockpit.invalid' || !/^\/lesen\/[\w/-]*$/.test(url.pathname)) return fallback;
  return { back: url.pathname + url.search, path: url.pathname };
}

/**
 * Meldung nach dem Übernehmen; `confirmed` (bestätigte Seiten) zählt der Dienst getrennt von `linked`,
 * `extended` die ergänzten Synthesen; ältere Fassungen kennen beides nicht. `plant`: Einpflanzen eingereiht.
 */
export function appliedMessage(title, r) {
  const pages = list(r?.written).filter((p) => p !== r.source && wikiPath(p) && p !== 'wiki/log.md');
  const linked = list(r?.linked).length;
  const confirmed = Array.isArray(r?.confirmed) ? r.confirmed.length : 0;
  const extended = list(r?.extended).length;
  const plant = r?.plant === 'wartet' || r?.plant === 'laeuft' ? ' · Claude pflanzt es jetzt ein' : '';
  return `Im Wiki: ${title}${pages.length ? ` + ${plural(pages.length, 'Seite', 'Seiten')}` : ''}${linked ? `, ${linked} verknüpft` : ''}${confirmed ? `, ${confirmed} bestätigt` : ''}${extended ? `, ${plural(extended, 'Synthese', 'Synthesen')} ergänzt` : ''}${plant}`;
}

// --- Routen ------------------------------------------------------------------

/**
 * Seiten, Stand und Aktionen des Ingests. Ohne `ingest` gibt es nur die
 * JSON-Endpunkte mit `enabled: false`, damit die App fragt statt rät.
 */
export function ingestRoutes({ store, ingest = null, planter = null, logger = console }) {
  const off = { ok: true, enabled: false };
  const api = {
    async '/api/lesen/ingest'() {
      if (!ingest) return jsonReply(200, { ...off, ready: [], busy: [], failed: [] });
      const all = ingest.list();
      const av = ingest.available() ?? { ok: false };
      return jsonReply(200, {
        ok: true,
        enabled: true,
        available: Boolean(av.ok),
        reason: av.ok ? null : (av.reason ?? null),
        counts: ingest.counts(),
        openOnStack: openOnStack(store, ingest),
        ready: all.filter((e) => e.status === 'bereit').map(ingestJson),
        busy: all.filter((e) => BUSY.includes(e.status)).map((e) => ({ ...ingestJson(e), label: busyLabel(e) })),
        failed: all.filter((e) => e.status === 'fehler').map(ingestJson),
        // Einpflanzen nach dem Übernehmen: wartet, läuft, fehlgeschlagen oder in den letzten Tagen fertig.
        planting: planter ? plantingNow(all).map(ingestJson) : [],
        plantAvailable: Boolean(planter?.available?.()?.ok),
        actions: ACTIONS,
      });
    },
    /**
     * Ein Entwurf; für einen Text ohne Entwurf `ingest.status: null` (die App
     * bietet dann „Ingest entwerfen“ an), für unbekannte Texte 404. `error` ist
     * der rohe Fehler des Eintrags (auch der Abbruch beim Übernehmen und der
     * Grund eines vom Dienst verworfenen), `view` der Entwurf als Baum.
     */
    async '/api/lesen/ingest/doc'(ctx) {
      if (!ingest) return jsonReply(200, off);
      const id = ctx.url.searchParams.get('id') ?? '';
      const doc = store.get(id);
      const e = ingest.get(id) ?? (doc ? { doc_id: id, status: null, doc: { id, title: doc.title, url: doc.url, site: doc.site, reading_minutes: doc.reading_minutes, status: doc.status } } : null);
      if (!e) return jsonReply(404, { error: 'not_found', message: 'Für diesen Text gibt es keinen Entwurf.' });
      const nav = neighbours(ingest, id);
      return jsonReply(200, {
        ok: true,
        enabled: true,
        available: Boolean(ingest.available()?.ok),
        ingest: ingestJson(e),
        error: e.error ?? null,
        draft: e.draft ?? null,
        applied: e.applied ?? null,
        view: appView(e),
        links: Object.fromEntries(knownPages(e)),
        groups: groupItems(e.draft?.items).map((g) => ({ key: g.key, label: g.label, hint: g.hint, featured: Boolean(g.featured), items: g.items.map((i) => ({ id: i.id, label: kindLabel(i), default: i.default === true })) })),
        selected: list(e.draft?.items).filter((i) => i?.default === true).map((i) => i.id),
        summaryMax: SUMMARY_MAX,
        prev: nav.prev,
        next: nav.next,
        position: nav.position,
        total: nav.total,
        actions: ACTIONS,
      });
    },
  };
  if (!ingest) return { pages: api, actions: {} };

  const must = (id) => {
    const e = ingest.get(id);
    if (!e) throw new ActionError('Für diesen Text gibt es keinen Entwurf', 404);
    return e;
  };
  const nameOf = (id) => {
    const e = ingest.get(id);
    return e ? docTitle(e) : (store.get(id)?.title ?? store.get(id)?.url ?? 'Text');
  };
  const readyIds = () => ingest.list({ status: 'bereit' }).map((e) => e.doc_id);
  const fromReview = (form) => String(form.get('back') ?? '').startsWith('/lesen/ingest/doc');

  return {
    pages: {
      ...api,
      async [INGEST](ctx) {
        return { html: readingPage(ctx, { key: 'ingest', title: 'Ingest', body: overview({ store, ingest, planter }, ctx), scripts: [assets.lesenIngest] }) };
      },
      async '/lesen/ingest/doc'(ctx) {
        const id = ctx.url.searchParams.get('id') ?? '';
        const e = ingest.get(id);
        const doc = e?.doc ?? store.get(id);
        if (!e && !doc) return { status: 404, html: readingPage(ctx, { key: 'ingest', title: 'Nicht gefunden', body: '<section><p class="empty">Diesen Text gibt es nicht (mehr).</p></section>' }) };
        const av = ingest.available() ?? { ok: false };
        const nav = e?.status === 'bereit' ? neighbours(ingest, id) : null;
        const body = e?.status === 'bereit' && e.draft ? reviewForm(e, ctx, nav) : `${av.ok ? '' : unavailable(av)}${reviewState(e, { ...doc, id }, ctx, av.ok, planter)}`;
        return {
          html: readingPage(ctx, { key: 'ingest', title: `Ingest: ${docTitle(e ?? { doc })}`, heading: reviewHead(e, { ...doc, id }, nav), bodyClass: 'page-ingest', body, scripts: [assets.lesenIngest] }),
        };
      },
      /** Stand für /static/lesen-ingest.js: Zähler und je Dokument (`ids`, sonst alle offenen) Status und Abzeichen. */
      async [STAND](ctx) {
        const ids = (ctx.url.searchParams.get('ids') ?? '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 500);
        const { back: safeBack, path } = standBack(ctx.url.searchParams.get('back'));
        const available = Boolean(ingest.available()?.ok);
        // Die Leseansicht nennt das fertige Abzeichen „Ingest prüfen“ (src/lesen/doc.js); der Austausch soll es nicht umbenennen.
        const ready = path === '/lesen/doc' ? 'Ingest prüfen' : 'Ingest bereit';
        let items;
        if (ids.length) {
          const st = ingest.statusFor(ids);
          items = ids.map((id) => ({ id, status: statusIn(st, id) }));
        } else {
          items = ingest.list().filter((e) => ACTIVE.includes(e.status)).map((e) => ({ id: e.doc_id, status: e.status }));
        }
        const out = items.map(({ id, status }) => {
          const title = nameOf(id);
          const plant = status === 'uebernommen' ? (ingest.get(id)?.applied?.plant?.status ?? null) : null;
          return { id, status, plant, busy: BUSY.includes(status), title, badge: ingestBadge(id, status, { ctx, title, available, ready, back: safeBack }) };
        });
        return jsonReply(200, { ok: true, counts: ingest.counts(), available, items: out });
      },
    },
    actions: {
      /** Entwerfen: `id` (mit `force=1` neu) oder `stapel=1` für alle Texte des Stapels ohne Entwurf. */
      async [ENTWERFEN](form) {
        if (form.get('stapel') === '1') {
          const r = await run(() => ingest.requestStack({ origin: 'knopf' }));
          const n = typeof r === 'number' ? r : Number(r?.count ?? r?.length ?? 0);
          return { message: n ? `${plural(n, 'Text wird', 'Texte werden')} entworfen, einer nach dem anderen.` : 'Nichts zu entwerfen: Jeder Text auf dem Stapel hat schon einen Entwurf.', count: n };
        }
        const id = form.get('id') ?? '';
        if (!id) throw new ActionError('Welcher Text? Die Angabe fehlt');
        if (!ingest.get(id) && !store.get(id)) throw new ActionError('Diesen Text gibt es nicht', 404);
        const force = form.get('force') === '1';
        await run(() => ingest.request([id], { origin: 'knopf', force }));
        const e = ingest.get(id);
        const title = nameOf(id);
        logger.info?.(`Ingest: ${force ? 'neu entwerfen' : 'entwerfen'} ${id}`);
        const message = e?.status === 'bereit' ? `Liegt schon bereit: ${title}` : e?.status === 'uebernommen' ? `Schon im Wiki: ${title}` : `Wird entworfen: ${title}`;
        return { message, ingest: { id, status: e?.status ?? null } };
      },
      /** Übernehmen: `item` mehrfach, dazu die Felder der Source-Page; danach der nächste bereite Entwurf. */
      async [UEBERNEHMEN](form) {
        const id = form.get('id') ?? '';
        const e = must(id);
        const items = form.getAll('item').filter(Boolean);
        const source = {};
        for (const key of ['title', 'summary', 'slug']) {
          const v = form.get(key);
          if (typeof v === 'string' && v.trim()) source[key] = v.trim();
        }
        if (form.has('tags')) source.tags = [...new Set(String(form.get('tags')).split(/[,\n]/).map((t) => t.trim().toLowerCase().replace(/^#/, '')).filter(Boolean))];
        const order = readyIds();
        const r = await run(() => ingest.apply(id, { items, source }));
        const message = appliedMessage(source.title ?? titleOf(e), r);
        logger.info?.(`Ingest übernommen: ${id} → ${r?.source ?? '?'}`);
        return { message, link: wikiPath(r?.source) ? { href: noteLink(r.source), label: 'Source-Page öffnen' } : null, redirect: nextAfter(order, id), result: r ?? null };
      },
      /** Einpflanzen von Hand: für ältere Ingests, nach einem Fehler oder noch einmal. */
      async [EINPFLANZEN](form) {
        const id = form.get('id') ?? '';
        const e = must(id);
        if (!planter) throw new ActionError('Einpflanzen ist hier nicht eingerichtet', 409);
        const status = await run(() => planter.request(id));
        logger.info?.(`Einpflanzen: ${id} eingereiht`);
        return { message: `${status === 'laeuft' ? 'Wird schon eingepflanzt' : 'Wird eingepflanzt'}: ${titleOf(e)}`, plant: { id, status } };
      },
      /** Verwerfen; `done=1` erledigt den Text ohne Wiki (gelesen, weg), mit Rückgängig. */
      async [VERWERFEN](form) {
        const id = form.get('id') ?? '';
        const e = must(id);
        const done = form.get('done') === '1';
        const order = readyIds();
        await run(() => ingest.discard(id, { done }));
        const title = docTitle(e);
        const previous = e.doc?.status;
        const undo = done && previous && previous !== 'weg' ? { action: DOC_STATUS, fields: { id, status: previous } } : null;
        return {
          message: done ? `Erledigt, ohne Wiki: ${title}` : `Entwurf verworfen: ${title}`,
          ...(undo ? { undo } : {}),
          ...(fromReview(form) ? { redirect: nextAfter(order, id) } : {}),
        };
      },
    },
  };
}
