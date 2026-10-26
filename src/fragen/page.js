import { esc, assets } from '../web/layout.js';
import { hidden } from '../web/render.js';
import { noteHref } from '../web/markdown-render.js';
import { createLinkResolver } from '../cockpit/note-links.js';
import { ActionError } from '../cockpit/actions.js';
import { readingPage } from '../lesen/pages.js';
import { jsonReply } from '../lesen/json.js';
import { ChatError } from './chat.js';
import { renderBlocks } from './ui.js';

/**
 * Seiten von „Fragen“ (src/fragen/chat.js), im Bereich Lesen neben „Wissen“,
 * ohne JavaScript bedienbar:
 *
 * - `/fragen`: neue Frage und die bisherigen Gespräche; `/fragen?id=…` ein
 *   Gespräch mit Antworten als Bausteinen (src/fragen/ui.js), Nachfragen,
 *   Vorschlägen zum Übernehmen und „Als Notiz speichern“, „Als Folge vertonen“.
 * - `/fragen/stand?id=…`: Stand der laufenden Antwort als JSON (gelesene
 *   Notizen), damit die Seite ohne Neuladen weiß, wann sie fertig ist.
 * - `/api/fragen` und `/api/fragen?id=…`: dasselbe als JSON für die App.
 *
 * `visible(path)`: Indexzeile einer Notiz, die das Cockpit zeigen darf, sonst null.
 */

const BUSY = ['wartet', 'denkt'];
const when = (iso, tz) => new Intl.DateTimeFormat('de-DE', { timeZone: tz, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));
const titleOf = (row) => row.title ?? row.path.split('/').pop().replace(/\.md$/i, '');

function askForm(ctx, { id = null, placeholder, label = 'Fragen', focus = false }) {
  return `<form method="post" action="/aktion/fragen/frage" class="fragen-eingabe" data-fragen-form>
    ${hidden({ csrf: ctx.write.csrf, back: ctx.write.back, id })}
    <label><span class="sr-only">Frage</span><textarea name="frage" rows="3" maxlength="4000" required placeholder="${esc(placeholder)}"${focus ? ' autofocus' : ''}></textarea></label>
    <div class="fragen-eingabe-leiste">
      <label class="folge-check"><input type="checkbox" name="internet" value="1"><span>Auch im Internet suchen</span></label>
      <button type="submit" class="btn primary">${label}</button>
    </div>
  </form>`;
}

function listPage(chat, ctx) {
  const why = chat.missing();
  const intro = '<p class="meta">Claude sucht in deinem ganzen Vault (vertrauliche Ordner bleiben zu) und antwortet mit Karten, Tabellen, Zeitleisten oder Checklisten. Neue Notizen legt es auf Wunsch direkt in der Inbox an; Änderungen an bestehenden Notizen schlägt es vor, du übernimmst sie.</p>';
  const form = why ? `<p class="problem">${esc(why)}</p>` : askForm(ctx, { placeholder: 'z. B. Was habe ich in den letzten Wochen über Energie und Schlaf notiert, und was hilft nachweislich?', focus: true });
  const threads = chat.list();
  const items = threads
    .map((t) => {
      const last = t.turns.at(-1);
      const state = BUSY.includes(last?.status) ? ' · Claude antwortet …' : last?.status === 'fehler' ? ' · Fehler' : '';
      const n = t.turns.filter((x) => x.role === 'du').length;
      return `<li><a href="/fragen?id=${esc(t.id)}">${esc(t.title)}</a> <span class="meta">${esc(when(t.updated_at, ctx.tz))} · ${n} ${n === 1 ? 'Frage' : 'Fragen'}${state}</span></li>`;
    })
    .join('');
  return `<section class="fragen-start">${intro}${form}</section>${threads.length ? `<section><h2>Gespräche</h2><ul class="results fragen-liste">${items}</ul></section>` : ''}`;
}

/** HTML einer Antwort (auch für `/fragen/stand`). */
export function answerHtml(t, n, ctx, { visible, links, progress = null }) {
  const turn = t.turns[n];
  const question = t.turns[n - 1];
  const id = `antwort-${n}`;
  if (BUSY.includes(turn.status)) {
    const read = progress?.turn === n ? progress.read : 0;
    const label = turn.status === 'wartet' ? 'Wartet, bis die Frage davor beantwortet ist' : `Claude sucht im Vault${question?.web ? ' und im Internet' : ''}${read ? ` · ${read} ${read === 1 ? 'Notiz' : 'Notizen'} gelesen` : ''}`;
    return `<article class="fragen-antwort is-busy" id="${id}" data-busy="${esc(t.id)}"><p class="fragen-denkt"><span class="folge-spinner" aria-hidden="true"></span><span data-label>${esc(label)}</span></p><noscript><p class="meta"><a href="/fragen?id=${esc(t.id)}#${id}">Stand aktualisieren</a></p></noscript></article>`;
  }
  if (turn.status === 'fehler') {
    return `<article class="fragen-antwort is-failed" id="${id}"><p class="problem">${esc(turn.error ?? 'Unbekannter Fehler')}</p><form method="post" action="/aktion/fragen/wiederholen" class="inline">${hidden({ csrf: ctx.write.csrf, back: ctx.write.back, id: t.id, turn: n })}<button type="submit" class="btn primary">Erneut fragen</button></form></article>`;
  }
  const blocks = renderBlocks(turn.blocks, { links, visible, write: ctx.write, thread: t.id, turn: n, tasks: turn.tasks ?? {} });
  const created = (turn.created ?? []).length
    ? `<p class="fragen-erledigt">Neu in der Inbox: ${turn.created.map((c) => (visible(c.path) ? `<a href="${esc(noteHref(c.path))}">${esc(c.title)}</a>` : esc(c.title))).join(', ')}</p>`
    : '';
  const read = (turn.read ?? []).map((p) => visible(p)).filter(Boolean);
  const sources = read.length || turn.web?.length
    ? `<details class="fragen-quellen"><summary>${read.length} ${read.length === 1 ? 'Notiz' : 'Notizen'} gelesen${turn.web?.length ? `, ${turn.web.length} ${turn.web.length === 1 ? 'Webseite' : 'Webseiten'}` : ''}</summary><ul>${read.map((r) => `<li><a href="${esc(noteHref(r.path))}">${esc(titleOf(r))}</a></li>`).join('')}${(turn.web ?? []).map((w) => `<li><a href="${esc(w.url)}" rel="noopener noreferrer" target="_blank">${esc(w.title)}</a> <span class="meta">extern</span></li>`).join('')}</ul></details>`
    : '';
  const follow = (turn.followups ?? []).length && n === t.turns.length - 1
    ? `<div class="fragen-weiter">${turn.followups.map((f) => `<form method="post" action="/aktion/fragen/frage" class="inline">${hidden({ csrf: ctx.write.csrf, back: ctx.write.back, id: t.id, frage: f })}<button type="submit" class="chip">${esc(f)}</button></form>`).join('')}</div>`
    : '';
  const episode = `/lesen/folgen/thema?${new URLSearchParams({ thema: question.text.replace(/\s+/g, ' ').slice(0, 300), ziel: 'Anknüpfend an meine Frage im Cockpit; vertiefe, was die Antwort angerissen hat.' })}`;
  const save = turn.saved
    ? `<a href="${esc(noteHref(turn.saved))}" class="btn quiet">Gespeichert</a>`
    : `<form method="post" action="/aktion/fragen/notiz" class="inline">${hidden({ csrf: ctx.write.csrf, back: ctx.write.back, id: t.id, turn: n })}<button type="submit" class="btn quiet">Als Notiz speichern</button></form>`;
  return `<article class="fragen-antwort" id="${id}">${blocks}${created}${sources}<div class="fragen-aktionen">${save}<a href="${esc(episode)}" class="btn quiet">Als Folge vertonen</a></div>${follow}</article>`;
}

function threadPage(chat, t, ctx, deps) {
  const progress = chat.progress(t.id);
  const turns = t.turns
    .map((turn, n) => (turn.role === 'du' ? `<div class="fragen-frage"><p>${esc(turn.text).replace(/\n/g, '<br>')}</p>${turn.web ? '<span class="meta">mit Internet</span>' : ''}</div>` : answerHtml(t, n, ctx, { ...deps, progress })))
    .join('');
  const busy = t.turns.some((x) => BUSY.includes(x.status));
  const more = busy || chat.missing() ? '' : askForm(ctx, { id: t.id, placeholder: 'Nachfragen, vertiefen, „halt das als Notiz fest“, „schlag vor, wie ich die Projektnotiz ergänze“ …', label: 'Nachfragen' });
  const remove = `<form method="post" action="/aktion/fragen/loeschen" class="inline">${hidden({ csrf: ctx.write.csrf, back: '/fragen', id: t.id })}<button type="submit" class="btn quiet">Gespräch löschen</button></form>`;
  return `<p class="meta"><a href="/fragen">← Alle Gespräche</a></p><div class="fragen-verlauf" data-turns>${turns}</div>${more}<p class="fragen-fuss">${remove}</p>`;
}

function threadJson(t, chat, visible) {
  const progress = chat.progress(t.id);
  return {
    id: t.id,
    title: t.title,
    createdAt: t.created_at,
    updatedAt: t.updated_at,
    busy: t.turns.some((x) => BUSY.includes(x.status)),
    turns: t.turns.map((x, n) =>
      x.role === 'du'
        ? { role: 'du', text: x.text, web: x.web }
        : {
            role: 'claude',
            status: x.status,
            error: x.error ?? null,
            blocks: x.blocks ?? [],
            followups: x.followups ?? [],
            web: x.web ?? [],
            read: (x.read ?? []).map((p) => visible(p)).filter(Boolean).map((r) => ({ path: r.path, title: titleOf(r) })),
            created: x.created ?? [],
            saved: x.saved ?? null,
            progress: progress?.turn === n ? progress.read : null,
          },
    ),
  };
}

const asAction = async (run) => {
  try {
    return await run();
  } catch (err) {
    if (err instanceof ChatError) throw new ActionError(err.message, err.status);
    throw err;
  }
};

export function fragenRoutes({ chat, index, visible }) {
  const deps = () => ({ visible: (p) => visible(p), links: createLinkResolver({ index, visible }, '') });
  const back = (id, n = null) => `/fragen?id=${encodeURIComponent(id)}${n !== null ? `#antwort-${n}` : ''}`;
  return {
    pages: {
      async '/fragen'(ctx) {
        const id = ctx.url.searchParams.get('id');
        const t = id ? chat.get(id) : null;
        if (id && !t) return { redirect: '/fragen' };
        const body = t ? threadPage(chat, t, ctx, deps()) : listPage(chat, ctx);
        return { html: readingPage(ctx, { key: 'fragen', title: t ? t.title : 'Fragen an den Vault', body, scripts: [assets.fragen] }) };
      },
      async '/fragen/stand'(ctx) {
        const t = chat.get(ctx.url.searchParams.get('id'));
        if (!t) return jsonReply(404, { ok: false, error: 'not_found' });
        const n = t.turns.findIndex((x) => BUSY.includes(x.status));
        const p = chat.progress(t.id);
        return jsonReply(200, { ok: true, busy: n >= 0, html: n >= 0 ? answerHtml(t, n, ctx, { ...deps(), progress: p }) : null });
      },
      async '/api/fragen'(ctx) {
        const id = ctx.url.searchParams.get('id');
        if (id) {
          const t = chat.get(id);
          return t ? jsonReply(200, { ok: true, thread: threadJson(t, chat, visible) }) : jsonReply(404, { ok: false, error: 'not_found' });
        }
        return jsonReply(200, { ok: true, missing: chat.missing(), threads: chat.list().map((t) => ({ id: t.id, title: t.title, updatedAt: t.updated_at, busy: t.turns.some((x) => BUSY.includes(x.status)) })) });
      },
    },
    actions: {
      async '/aktion/fragen/frage'(form) {
        const id = form.get('id') || null;
        const r = await asAction(() => chat.ask({ id, question: form.get('frage') ?? '', web: ['1', 'true', 'on'].includes(String(form.get('internet') ?? '')) }));
        r.done?.catch(() => {});
        return { message: 'Claude sucht im Vault …', redirect: back(r.thread.id, r.turn), id: r.thread.id, turn: r.turn };
      },
      async '/aktion/fragen/wiederholen'(form) {
        const r = await asAction(() => chat.retry(form.get('id'), form.get('turn')));
        r.done?.catch(() => {});
        return { message: 'Claude versucht es noch einmal …', redirect: back(r.thread.id, r.turn) };
      },
      async '/aktion/fragen/uebernehmen'(form) {
        const { path } = await asAction(() => chat.apply(form.get('id'), form.get('turn'), form.get('block')));
        return { message: `Übernommen${path ? `: ${path.split('/').pop().replace(/\.md$/i, '')}` : ''}`, redirect: back(form.get('id'), form.get('turn')) };
      },
      async '/aktion/fragen/verwerfen'(form) {
        await asAction(() => chat.dismiss(form.get('id'), form.get('turn'), form.get('block')));
        return { message: 'Vorschlag verworfen', redirect: back(form.get('id'), form.get('turn')) };
      },
      async '/aktion/fragen/notiz'(form) {
        const made = await asAction(() => chat.saveAsNote(form.get('id'), form.get('turn')));
        return { message: 'Als Notiz in der Inbox gespeichert', redirect: back(form.get('id'), form.get('turn')), link: made.path ? { href: noteHref(made.path), label: 'Öffnen' } : null };
      },
      async '/aktion/fragen/aufgaben'(form) {
        const r = await asAction(() => chat.tasksFrom(form.get('id'), form.get('turn'), form.get('block')));
        return { message: `${r.made} ${r.made === 1 ? 'Aufgabe' : 'Aufgaben'} in der Zunder-Inbox`, redirect: back(form.get('id'), form.get('turn')) };
      },
      async '/aktion/fragen/loeschen'(form) {
        const t = await asAction(() => chat.remove(form.get('id')));
        return { message: `Gelöscht: ${t.title}`, redirect: '/fragen' };
      },
    },
  };
}
