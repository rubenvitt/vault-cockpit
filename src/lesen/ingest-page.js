import { ActionError } from '../cockpit/actions.js';
import { esc, assets } from '../web/layout.js';
import { hidden } from '../web/render.js';
import { renderMarkdown, inlineMd } from '../web/markdown-render.js';
import { readingPage } from './pages.js';
import { ReadingError } from './store.js';
import { jsonReply } from './json.js';

/**
 * Oberfläche des Ingests (Dienst: src/lesen/ingest.js, `createIngest`): aus
 * einem Text des Stapels entwirft Claude Seiten für das Mycel-Wiki, und hier
 * wird abgehakt, was davon hinein soll. Ohne JavaScript ist alles ein Formular.
 *
 * - `/lesen/ingest`: Übersicht. Bereite Entwürfe als Karten (Kernaussagen und
 *   was angeboten wird), darunter „In Arbeit“ und „Fehler“, oben „Ganzen Stapel
 *   entwerfen“.
 * - `/lesen/ingest/doc?id=`: Prüfansicht. Digest (Kernaussagen, Neu für dich,
 *   Bestätigt, Widerspricht, Dockt an), die Source-Page mit änderbaren Feldern
 *   und die Vorschläge zum Abhaken, gruppiert. „Ins Wiki übernehmen“ führt zum
 *   nächsten bereiten Entwurf.
 * - `/lesen/ingest/stand?ids=a,b`: Stand als JSON für die Live-Aktualisierung
 *   (/static/lesen-ingest.js): Zähler, je Dokument Status und Abzeichen.
 * - `/api/lesen/ingest` und `/api/lesen/ingest/doc?id=`: dasselbe für die App
 *   (ohne Dienst mit `enabled: false`).
 *
 * Alles, was Claude schreibt, ist Fremdtext: Titel und Pfade nur maskiert,
 * Fließtext über `inlineMd`, Seitentexte über `renderMarkdown` (beide maskieren
 * und lassen kein HTML durch).
 */

export const INGEST = '/lesen/ingest';
export const ingestLink = (id) => `/lesen/ingest/doc?id=${encodeURIComponent(id)}`;
const STAND = '/lesen/ingest/stand';
const ENTWERFEN = '/aktion/lesen/ingest/entwerfen';
const UEBERNEHMEN = '/aktion/lesen/ingest/uebernehmen';
const VERWERFEN = '/aktion/lesen/ingest/verwerfen';
const DOC_STATUS = '/aktion/lesen/doc/status';

const BUSY = ['wartet', 'entwirft'];
const ACTIVE = [...BUSY, 'bereit', 'fehler'];
const SUMMARY_MAX = 80;

/** Nur echte Wiki-Pfade werden Links; alles andere bleibt Text. */
const wikiPath = (p) => typeof p === 'string' && /^wiki\/[^\0]+\.md$/.test(p) && !p.split('/').includes('..');
const noteLink = (p) => `/notiz?pfad=${encodeURIComponent(p)}`;
const docLink = (id) => `/lesen/doc?id=${encodeURIComponent(id)}`;
const httpUrl = (u) => (/^https?:\/\//i.test(u ?? '') ? u : null);
const slugOf = (p) => String(p ?? '').split('/').pop().replace(/\.md$/i, '');
const text = (s) => inlineMd(String(s ?? ''));
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
  if (item.kind === 'synthesis') return ART[item.art] ? `Synthese · ${ART[item.art]}` : 'Synthese';
  if (item.kind === 'question') return 'Frage';
  if (item.kind === 'entity') return ENTITY[item.entity_type] ?? 'Entity';
  if (item.kind === 'concept') return 'Konzept';
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
  { key: 'synthese', label: 'Synthesen & Fragen', hint: 'Claudes Angebote über diesen Text hinaus. Aufklappen, lesen, abhaken.', featured: true, match: (i) => i.kind === 'synthesis' || i.kind === 'question' },
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
  const t = { verknuepfen: 0, bestaetigung: 0, synthese: 0, frage: 0, neu: 0, relation: 0 };
  for (const i of list(draft?.items)) {
    if (i.action === 'verknuepfen') t.verknuepfen += 1;
    else if (i.kind === 'bestaetigung') t.bestaetigung += 1;
    else if (i.kind === 'synthesis') t.synthese += 1;
    else if (i.kind === 'question') t.frage += 1;
    else if (i.action === 'neu') t.neu += 1;
    else if (i.kind === 'relation') t.relation += 1;
  }
  return t;
}

/** „3 Verknüpfungen · 1 Synthese · 2 neue Seiten“; ohne Vorschläge „nur die Source-Page“. */
export function tallyLabel(t) {
  const parts = [
    t.verknuepfen && plural(t.verknuepfen, 'Verknüpfung', 'Verknüpfungen'),
    t.bestaetigung && plural(t.bestaetigung, 'Bestätigung', 'Bestätigungen'),
    t.synthese && plural(t.synthese, 'Synthese', 'Synthesen'),
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
    if (err?.name === 'IngestError' || err?.constructor?.name === 'IngestError') throw new ActionError(err.message, err.status ?? 400);
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

// --- Übersicht ---------------------------------------------------------------

/** Wie viele Texte des Stapels noch keinen Entwurf haben (für „Ganzen Stapel entwerfen“). */
function openOnStack(store, ingest) {
  const docs = store.list({ status: 'stapel', limit: -1 });
  const st = ingest.statusFor(docs.map((d) => d.id));
  return docs.filter((d) => [null, 'verworfen'].includes(statusIn(st, d.id))).length;
}

function readyCard(e, ctx) {
  const t = tally(e.draft);
  const kern = list(e.draft?.digest?.kernaussagen).slice(0, 3);
  const offered = t.synthese + t.frage;
  const meta = [e.doc?.site, e.doc?.reading_minutes ? `${e.doc.reading_minutes} Min.` : null, e.origin === 'nacht' ? 'nachts entworfen' : null, when(e.drafted_at, ctx.tz)].filter(Boolean);
  return `<li class="ingest-card" data-ingest-doc="${esc(e.doc_id)}">
    <div class="ingest-card-head">
      <span class="meta">${esc(meta.join(' · '))}</span>
      <a href="${esc(ingestLink(e.doc_id))}" class="ingest-card-title">${esc(titleOf(e))}</a>
    </div>
    ${kern.length ? `<ul class="ingest-kern is-short">${kern.map((k) => `<li>${text(k)}</li>`).join('')}</ul>` : ''}
    <div class="ingest-card-foot">
      <span class="ingest-tally">${esc(tallyLabel(t))}</span>
      ${offered ? `<span class="ingest-pill is-offer">${esc(t.synthese ? (t.synthese === 1 ? 'Synthese angeboten' : 'Synthesen angeboten') : 'Frage angeboten')}</span>` : ''}
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

function overview({ store, ingest }, ctx) {
  const av = ingest.available() ?? { ok: false };
  const all = ingest.list();
  const ready = all.filter((e) => e.status === 'bereit');
  const busy = all.filter((e) => BUSY.includes(e.status));
  const failed = all.filter((e) => e.status === 'fehler');
  const open = openOnStack(store, ingest);
  const at = Date.now();

  const stackForm = av.ok && open
    ? `<form method="post" action="${ENTWERFEN}" class="act ingest-stapel">${hidden({ csrf: ctx.write.csrf, back: INGEST, stapel: '1' })}<button type="submit" class="btn">Ganzen Stapel entwerfen</button><span class="meta">${esc(open === 1 ? 'Ein Text auf dem Stapel hat noch keinen Entwurf.' : `${open} Texte auf dem Stapel haben noch keinen Entwurf.`)} Claude entwirft einen nach dem anderen.</span></form>`
    : '';
  const intro = `<div class="ingest-intro">${av.ok ? '' : unavailable(av)}${stackForm}</div>`;

  if (!ready.length && !busy.length && !failed.length) {
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
    failed.length ? `<section class="ingest-failed" id="fehler" aria-labelledby="ingest-fehler"><h2 id="ingest-fehler">Fehler <span class="hint">${failed.length}</span></h2><ul class="ingest-rows">${failed.map((e) => failedRow(e, ctx, av.ok)).join('')}</ul></section>` : '',
  ];
  return `${intro}${sections.join('')}`;
}

// --- Prüfansicht -------------------------------------------------------------

/** Link auf eine Wiki-Seite, sonst nur der Titel. */
const pageRef = (path, title) => (wikiPath(path) ? `<a href="${esc(noteLink(path))}" class="ingest-ref">${esc(title || slugOf(path))}</a>` : `<span class="ingest-ref">${esc(title || slugOf(path) || 'Seite')}</span>`);

function digestBlock(draft) {
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

function sourceBlock(draft) {
  const s = draft?.source ?? {};
  const summary = String(s.summary ?? '');
  const tags = list(s.tags).join(', ');
  const meta = [s.confidence ? `Konfidenz: ${CONFIDENCE[s.confidence] ?? s.confidence}` : null, s.slug ? `wiki/sources/${s.slug}.md` : null].filter(Boolean);
  return `<section class="ingest-source" aria-labelledby="ingest-source">
    <h2 id="ingest-source">Source-Page <span class="hint">${esc(meta.join(' · '))}</span></h2>
    <div class="ingest-fields">
      <label class="ingest-field is-wide"><span>Titel</span><input type="text" name="title" value="${esc(s.title ?? '')}" required></label>
      <label class="ingest-field is-wide"><span class="ingest-field-row">Summary <span class="ingest-count${summary.length > SUMMARY_MAX ? ' is-over' : ''}" data-ingest-count-for="summary">${summary.length}/${SUMMARY_MAX}</span></span><input type="text" name="summary" value="${esc(summary)}" maxlength="${SUMMARY_MAX}" data-ingest-summary></label>
      <label class="ingest-field"><span>Slug</span><input type="text" name="slug" value="${esc(s.slug ?? '')}" pattern="[a-z0-9]+(-[a-z0-9]+)*" spellcheck="false" autocapitalize="off" autocomplete="off" title="Kleinbuchstaben, Ziffern und Bindestriche"></label>
      <label class="ingest-field"><span>Tags</span><input type="text" name="tags" value="${esc(tags)}" spellcheck="false" autocapitalize="off" autocomplete="off" placeholder="englisch, mit Komma"></label>
    </div>
    ${s.body ? `<details class="ingest-body"><summary>Text der Source-Page ansehen</summary><div class="md ingest-md">${renderMarkdown(s.body)}</div></details>` : ''}
  </section>`;
}

/** Ein Vorschlag zum Abhaken; Aufklappbares steht neben dem `<label>`, sonst schaltete jeder Tipp darauf das Häkchen um. */
function itemRow(item, featured) {
  const id = esc(item.id);
  const box = `<input type="checkbox" name="item" value="${id}"${item.default === true ? ' checked' : ''}>`;
  const pill = `<span class="ingest-pill${featured ? ' is-offer' : ''}">${esc(kindLabel(item))}</span>`;
  const why = item.warum ? `<span class="ingest-why">${text(item.warum)}</span>` : '';
  let main;
  if (item.kind === 'relation') {
    const type = RELATION[item.type] ?? item.type ?? 'Relation';
    main = `<span class="ingest-item-title"><span class="ingest-rel" title="${esc(item.type ?? '')}">${esc(type)}</span> ${esc(item.title || slugOf(item.to))}</span>`;
  } else if (item.kind === 'bestaetigung') {
    main = `<span class="ingest-item-title">${esc(item.title || slugOf(item.path))}</span>${item.claim ? `<span class="ingest-claim">${text(item.claim)}</span>` : ''}`;
  } else {
    main = `<span class="ingest-item-title">${esc(item.title || item.slug || slugOf(item.path))}</span>${item.summary ? `<span class="ingest-summary">${text(item.summary)}</span>` : ''}`;
  }
  const head = item.kind === 'relation' || item.kind === 'bestaetigung' ? '' : pill;
  const target = item.path ?? item.to;
  const open = wikiPath(target) && item.action !== 'neu' ? `<a href="${esc(noteLink(target))}" class="ingest-open">Seite ansehen<span class="sr-only">: ${esc(item.title || slugOf(target))}</span></a>` : '';
  const involved = list(item.beteiligte).filter(Boolean);
  const extra = [
    involved.length ? `<p class="ingest-involved"><span class="meta">Beteiligt:</span> ${involved.map((p) => pageRef(p, null)).join(', ')}</p>` : '',
    item.body ? `<details class="ingest-body"><summary>${featured ? 'Ganzen Text lesen' : 'Text der Seite ansehen'}</summary><div class="md ingest-md">${renderMarkdown(item.body)}</div></details>` : '',
    open,
  ].filter(Boolean).join('');
  const where = item.action === 'neu' && item.slug ? `<span class="ingest-path">neu: ${esc(item.slug)}</span>` : '';
  return `<li class="ingest-item${featured ? ' is-featured' : ''}" data-item="${id}">
    <label class="ingest-pick">${box}<span class="ingest-pick-text">${head}${main}${why}${where}</span></label>
    ${extra ? `<div class="ingest-item-more">${extra}</div>` : ''}
  </li>`;
}

function itemGroups(draft) {
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
    <ul class="ingest-items">${g.items.map((i) => itemRow(i, g.featured)).join('')}</ul>
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

/** Prüfansicht eines bereiten Entwurfs: ein Formular, die Nebenaktionen per `formaction`. */
function reviewForm(e, ctx, nav) {
  const draft = e.draft ?? {};
  const chosen = list(draft.items).filter((i) => i?.default === true).length;
  const back = ingestLink(e.doc_id);
  return `<form method="post" action="${UEBERNEHMEN}" class="ingest-form" data-ingest-form>
    ${hidden({ csrf: ctx.write.csrf, back, id: e.doc_id })}
    <button type="submit" class="ingest-guard" disabled hidden aria-hidden="true" tabindex="-1"></button>
    ${digestBlock(draft)}
    ${sourceBlock(draft)}
    ${itemGroups(draft)}
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
function reviewState(e, doc, ctx, available) {
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
    return `<section class="ingest-state"><p class="notice">Schon im Wiki${e.applied_at ? `, seit ${esc(when(e.applied_at, ctx.tz) ?? '')}` : ''}.</p>${wikiPath(src) ? `<p><a href="${esc(noteLink(src))}" class="btn">Source-Page öffnen</a></p>` : ''}</section>`;
  }
  const what = e?.status === 'verworfen' ? 'Der letzte Entwurf wurde verworfen.' : 'Für diesen Text gibt es noch keinen Entwurf.';
  return `<section class="ingest-state"><p class="empty">${what}</p>${available ? draftForm('Ingest entwerfen') : ''}</section>`;
}

// --- JSON --------------------------------------------------------------------

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
    tally: t,
    tallyLabel: tallyLabel(t),
  };
}

const ACTIONS = { draft: ENTWERFEN, apply: UEBERNEHMEN, discard: VERWERFEN };

// --- Routen ------------------------------------------------------------------

/**
 * Seiten, Stand und Aktionen des Ingests. Ohne `ingest` gibt es nur die
 * JSON-Endpunkte mit `enabled: false`, damit die App fragt statt rät.
 */
export function ingestRoutes({ store, ingest = null, logger = console }) {
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
        actions: ACTIONS,
      });
    },
    async '/api/lesen/ingest/doc'(ctx) {
      if (!ingest) return jsonReply(200, off);
      const id = ctx.url.searchParams.get('id') ?? '';
      const e = ingest.get(id);
      if (!e) return jsonReply(404, { error: 'not_found', message: 'Für diesen Text gibt es keinen Entwurf.' });
      const nav = neighbours(ingest, id);
      return jsonReply(200, {
        ok: true,
        enabled: true,
        ingest: ingestJson(e),
        draft: e.draft ?? null,
        applied: e.applied ?? null,
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
        return { html: readingPage(ctx, { key: 'ingest', title: 'Ingest', body: overview({ store, ingest }, ctx), scripts: [assets.lesenIngest] }) };
      },
      async '/lesen/ingest/doc'(ctx) {
        const id = ctx.url.searchParams.get('id') ?? '';
        const e = ingest.get(id);
        const doc = e?.doc ?? store.get(id);
        if (!e && !doc) return { status: 404, html: readingPage(ctx, { key: 'ingest', title: 'Nicht gefunden', body: '<section><p class="empty">Diesen Text gibt es nicht (mehr).</p></section>' }) };
        const av = ingest.available() ?? { ok: false };
        const nav = e?.status === 'bereit' ? neighbours(ingest, id) : null;
        const body = e?.status === 'bereit' && e.draft ? reviewForm(e, ctx, nav) : `${av.ok ? '' : unavailable(av)}${reviewState(e, { ...doc, id }, ctx, av.ok)}`;
        return {
          html: readingPage(ctx, { key: 'ingest', title: `Ingest: ${docTitle(e ?? { doc })}`, heading: reviewHead(e, { ...doc, id }, nav), bodyClass: 'page-ingest', body, scripts: [assets.lesenIngest] }),
        };
      },
      /** Stand für /static/lesen-ingest.js: Zähler und je Dokument (`ids`, sonst alle offenen) Status und Abzeichen. */
      async [STAND](ctx) {
        const ids = (ctx.url.searchParams.get('ids') ?? '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 500);
        const back = ctx.url.searchParams.get('back');
        const safeBack = typeof back === 'string' && /^\/lesen\/[\w/-]*$/.test(back) ? back : '/lesen/stapel';
        const available = Boolean(ingest.available()?.ok);
        let items;
        if (ids.length) {
          const st = ingest.statusFor(ids);
          items = ids.map((id) => ({ id, status: statusIn(st, id) }));
        } else {
          items = ingest.list().filter((e) => ACTIVE.includes(e.status)).map((e) => ({ id: e.doc_id, status: e.status }));
        }
        const out = items.map(({ id, status }) => {
          const title = nameOf(id);
          return { id, status, busy: BUSY.includes(status), title, badge: ingestBadge(id, status, { ctx, title, available, back: safeBack }) };
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
        const pages = list(r?.written).filter((p) => p !== r.source && wikiPath(p) && p !== 'wiki/log.md');
        const linked = list(r?.linked).length;
        const title = source.title ?? titleOf(e);
        const message = `Im Wiki: ${title}${pages.length ? ` + ${plural(pages.length, 'Seite', 'Seiten')}` : ''}${linked ? `, ${linked} verknüpft` : ''}`;
        logger.info?.(`Ingest übernommen: ${id} → ${r?.source ?? '?'}`);
        return { message, link: wikiPath(r?.source) ? { href: noteLink(r.source), label: 'Source-Page öffnen' } : null, redirect: nextAfter(order, id), result: r ?? null };
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
