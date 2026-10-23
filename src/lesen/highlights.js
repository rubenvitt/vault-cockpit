import { ActionError } from '../cockpit/actions.js';
import { esc } from '../web/layout.js';
import { readingPage } from './pages.js';
import { docLink } from './doc.js';

/**
 * Markierungen (VCP-71): die Liste „Markiert“ und die Aktionen, mit denen die
 * Leseansicht markiert, Notizen setzt, entfernt und Zitate in die Vault-Inbox
 * schickt. Ein Anker ist Zitat, Präfix, Suffix und ungefähre Stelle
 * (src/lesen/anchor.js).
 *
 * Formularfelder:
 * - `/aktion/lesen/markierung/neu`: `id` (Dokument), `quote`, `prefix`, `suffix`, `start`, `notiz`?
 * - `/aktion/lesen/markierung/notiz`: `id` (Markierung), `notiz` (leer löscht sie)
 * - `/aktion/lesen/markierung/loeschen`: `id` (Markierung); Rückgängig legt sie neu an
 * - `/aktion/lesen/markierung/inbox`: `markierung` (vorhandene) oder `id` (Dokument) mit `quote`, dazu `notiz`?, `cid`
 */

const MAX_QUOTE = 4000;
const MAX_CONTEXT = 200;
const MAX_NOTE = 4000;

/** Text aus dem Formular, auf `max` Zeichen begrenzt. */
function field(form, name, max, label) {
  const v = form.get(name) ?? '';
  if (v.length > max) throw new ActionError(`${label} ist zu lang (höchstens ${max} Zeichen)`);
  return v;
}
const noteOf = (form) => field(form, 'notiz', MAX_NOTE, 'Die Notiz').trim() || null;
const href = (u) => (/^https?:\/\//i.test(u ?? '') ? u : null);

/** Notiz für die Vault-Inbox: Zitat als Blockzitat (beginnt also nie mit `!`), Notiz, Quelle. */
export function inboxText({ quote, note, doc }) {
  const title = String(doc.title || doc.url).replace(/[[\]]/g, '');
  const url = href(doc.url);
  return [
    String(quote).trim().split(/\r?\n/).map((l) => `> ${l}`.trimEnd()).join('\n'),
    note,
    `Aus ${url ? `[${title}](${url})` : title}`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

function renderMarked(items, facets, filter, ctx) {
  const option = (value, current) => `<option value="${esc(value)}"${value === current ? ' selected' : ''}>${esc(value)}</option>`;
  const select = (name, label, values, current) =>
    values.length ? `<label class="lesen-filter-field"><span>${label}</span><select name="${name}"><option value="">alle</option>${values.map((v) => option(v, current)).join('')}</select></label>` : '';
  const filters =
    facets.sites.length || facets.topics.length
      ? `<form method="get" action="/lesen/markiert" class="lesen-filter">${select('quelle', 'Quelle', facets.sites, filter.site)}${select('thema', 'Thema', facets.topics, filter.topic)}<button type="submit" class="btn">Filtern</button>${filter.site || filter.topic ? '<a href="/lesen/markiert" class="btn quiet">Alle zeigen</a>' : ''}</form>`
      : '';
  const filtered = Boolean(filter.site || filter.topic);
  const body = items.length
    ? `<ul class="lesen-list">${items
        .map(
          (h) => `<li class="lesen-item">
    <blockquote class="lesen-quote">${esc(h.quote)}</blockquote>
    ${h.note ? `<p class="lesen-excerpt">${esc(h.note)}</p>` : ''}
    <span class="meta"><a href="${esc(`${docLink(h.doc_id)}#h-${h.id}`)}">${esc(h.doc_title || h.doc_url)}</a>${h.doc_site ? ` · ${esc(h.doc_site)}` : ''}${h.doc_topics.length ? ` · ${h.doc_topics.map(esc).join(', ')}` : ''}</span>
  </li>`,
        )
        .join('')}</ul>`
    : `<p class="empty">${filtered ? 'Für diese Auswahl ist nichts markiert.' : 'Noch nichts markiert.'}</p>`;
  return readingPage(ctx, { key: 'markiert', title: 'Markiert', body: `${filters ? `<section>${filters}</section>` : ''}<section>${body}</section>` });
}

/**
 * `capture` legt eine Notiz in der Vault-Inbox an (`actions.capture` des
 * Cockpits, mit dessen Prüfung des Inbox-Ordners); ohne gibt es „In Inbox“ nicht.
 * `onChange(docId)` hört jede Änderung an Markierungen.
 */
export function highlightRoutes({ store, asAction, capture = null, onChange = () => {}, logger = console }) {
  const docOf = (id) => {
    const doc = store.get(id);
    if (!doc) throw new ActionError('Diesen Artikel gibt es nicht', 404);
    return doc;
  };
  const highlightOf = (id) => {
    const h = store.getHighlight(id);
    if (!h) throw new ActionError('Diese Markierung gibt es nicht', 404);
    return h;
  };

  return {
    pages: {
      async '/lesen/markiert'(ctx) {
        const filter = { site: ctx.url.searchParams.get('quelle') || null, topic: ctx.url.searchParams.get('thema') || null };
        return { html: renderMarked(store.listHighlights(filter), store.highlightFacets(), filter, ctx) };
      },
    },
    actions: {
      async '/aktion/lesen/markierung/neu'(form) {
        const doc = docOf(form.get('id'));
        const quote = field(form, 'quote', MAX_QUOTE, 'Die Auswahl');
        if (!quote.trim()) throw new ActionError('Nichts ausgewählt');
        const start = Number.parseInt(form.get('start') ?? '', 10);
        const h = await asAction(() =>
          store.addHighlight({
            doc_id: doc.id,
            quote,
            prefix: field(form, 'prefix', MAX_CONTEXT, 'Der Text davor'),
            suffix: field(form, 'suffix', MAX_CONTEXT, 'Der Text danach'),
            start_hint: Number.isFinite(start) && start >= 0 ? start : null,
            note: noteOf(form),
          }),
        );
        onChange(doc.id);
        return { message: h.note ? 'Markiert, mit Notiz' : 'Markiert', highlight: { id: h.id }, undo: { action: '/aktion/lesen/markierung/loeschen', fields: { id: h.id } } };
      },

      async '/aktion/lesen/markierung/notiz'(form) {
        const h = highlightOf(form.get('id'));
        const note = noteOf(form);
        await asAction(() => store.updateHighlight(h.id, { note }));
        onChange(h.doc_id);
        return { message: note ? 'Notiz gespeichert' : 'Notiz entfernt', highlight: { id: h.id }, undo: { action: '/aktion/lesen/markierung/notiz', fields: { id: h.id, notiz: h.note ?? '' } } };
      },

      async '/aktion/lesen/markierung/loeschen'(form) {
        const h = highlightOf(form.get('id'));
        store.deleteHighlight(h.id);
        onChange(h.doc_id);
        const fields = { id: h.doc_id, quote: h.quote, prefix: h.prefix, suffix: h.suffix, start: h.start_hint ?? '', notiz: h.note ?? '' };
        return { message: 'Markierung entfernt', undo: { action: '/aktion/lesen/markierung/neu', fields } };
      },

      async '/aktion/lesen/markierung/inbox'(form, session) {
        if (!capture) throw new ActionError('Die Vault-Inbox ist hier nicht angebunden', 503);
        const h = form.get('markierung') ? highlightOf(form.get('markierung')) : null;
        const doc = docOf(h?.doc_id ?? form.get('id'));
        const quote = h?.quote ?? field(form, 'quote', MAX_QUOTE, 'Die Auswahl');
        if (!quote.trim()) throw new ActionError('Nichts ausgewählt');
        const captureId = form.get('cid') || (h ? `lesen-${h.id}` : null);
        const result = await capture({ text: inboxText({ quote, note: h?.note ?? noteOf(form), doc }), captureId });
        if (!result.duplicate) logger.info?.(`Lesestapel: Zitat aus ${doc.url} in die Inbox (${session.sub})`);
        return { message: `${result.duplicate ? 'Schon in der Inbox' : 'In der Inbox'}: ${result.path}`, result };
      },
    },
  };
}
