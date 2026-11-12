import { esc, dueLabel, formHead, flashToast, weekPager, inColumns } from './render.js';
import { head, appHeader, weekSwitch } from './layout.js';

/**
 * Planungsseite `/planen?woche=…` (VCP-47): Zunder-Aufgaben suchen und in die
 * Woche holen, Vorschläge aus den Bereichen der Big Rocks, Flamme einplanen,
 * und was schon in der Woche steht, mit „Aus der Woche“. Die Abschnitte stehen
 * untereinander in voller Breite; Bereiche erscheinen in der Rangfolge aus den
 * Einstellungen (`areaOrder`). Jede Aktion ist ein Formular;
 * `/static/cockpit.js` schickt es ohne Seitenwechsel und tauscht danach `main`.
 */

const STATUS_LABEL = { in_progress: 'in Arbeit', blocked: 'blockiert' };
const kw = (id) => `KW ${Number(String(id).slice(6))}`;
const taskName = (t) => (t.ref ? `${t.ref} ${t.title}` : t.title);

const problem = (s) =>
  `<p class="problem${s.unconfigured ? ' unconfigured' : ''}">${esc(s.error)}${s.unconfigured ? ' · <a href="/einstellungen">Einstellungen</a>' : ''}</p>`;

/** Adresse der Planungsseite mit den gegebenen Parametern (leere fallen weg). */
export function planHref(params, hash = '') {
  const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v));
  return `/planen?${q.toString()}${hash}`;
}

/** Auswahl „wann“: Phönix-Schritt der ganzen Woche oder fällig an einem Tag. */
function whenSelect(week) {
  const days = week.days.map((d) => `<option value="${esc(d.date)}">${esc(d.label)}${d.today ? ' (heute)' : ''}</option>`).join('');
  return `<label class="plan-when"><span class="sr-only">Wann</span><select name="wann">
      <option value="schritt">Phönix-Schritt ${esc(kw(week.id))}</option>
      <optgroup label="Fällig am">${days}</optgroup>
    </select></label>`;
}

const actForm = (ctx, action, fields, cls) => formHead(ctx, action, fields).replace('class="act"', `class="act ${cls}"`);

/** „Aus der Woche“: entfernt die Phönix-Markierung, Rückgängig stellt sie wieder her. */
const outForm = (t, ctx) =>
  `${actForm(ctx, '/aktion/woche/raus', { id: t.id }, 'plan-out')}<button type="submit" class="chip quiet" aria-label="${esc(`Aus der Woche nehmen: ${t.title}`)}">Aus der Woche</button></form>`;

function meta(t, tz, { area = true } = {}) {
  return [t.ref, area ? (t.project ? `${t.area} / ${t.project}` : t.area) : t.project, dueLabel(t.due, tz), STATUS_LABEL[t.status]]
    .filter(Boolean)
    .map(esc)
    .join(' · ');
}

/** Eine Aufgabe zum Holen: Titel, Ort, und rechts „Holen“ mit Auswahl, wann. */
function candidate(t, model, ctx, { area = true } = {}) {
  const w = model.week;
  const m = meta(t, model.tz, { area });
  let side;
  if (t.planned) {
    const why = t.planned === 'flamme' ? 'Flamme' : t.planned === 'feuer_schritt' ? 'Phönix-Schritt' : 'fällig';
    side = `<span class="pill ok">${esc(why)} ${esc(kw(w.id))}</span>${t.planned !== 'faellig' ? outForm(t, ctx) : ''}`;
  } else {
    side = `${actForm(ctx, '/aktion/woche/holen', { id: t.id, woche: w.id }, 'plan-add')}${whenSelect(w)}<button type="submit" class="chip" aria-label="${esc(`In die Woche holen: ${t.title}`)}">Holen</button></form>
      <a href="${esc(planHref({ woche: w.id, q: model.query.q, bereich: model.query.area, aus: t.id }, '#flamme'))}" class="chip quiet">Als Flamme</a>`;
  }
  return `<li class="plan-item status-${esc(t.status)}">
    <span class="body"><a href="${esc(t.url)}">${esc(t.title)}</a>${m ? `<span class="meta">${m}</span>` : ''}</span>
    <span class="plan-side">${side}</span>
  </li>`;
}

function findSection(model, ctx) {
  const w = model.week;
  const { q, area } = model.query;
  const options = (model.areas ?? []).map((a) => `<option value="${esc(a.id)}"${a.id === area ? ' selected' : ''}>${esc(a.name)}</option>`).join('');
  const form = `<form method="get" action="/planen" class="plan-search" role="search">
      <input type="hidden" name="woche" value="${esc(w.id)}">
      <label class="plan-q"><span class="sr-only">Zunder durchsuchen</span><input type="search" name="q" value="${esc(q)}" placeholder="Aufgabe suchen oder Kennung wie VCP-47" enterkeyhint="search" autocomplete="off" spellcheck="false"></label>
      <label class="plan-area"><span class="sr-only">Bereich</span><select name="bereich"><option value="">Alle Bereiche</option>${options}</select></label>
      <button type="submit" class="btn">Suchen</button>
    </form>`;
  let body;
  const r = model.results;
  if (!r) body = '<p class="meta">Suchbegriff eingeben oder einen Bereich wählen. Aufgaben aus Dev-Projekten bleiben außen vor.</p>';
  else if (!r.ok) body = problem(r);
  else if (!r.data.length) body = `<p class="empty">Keine offene Aufgabe gefunden${q ? ` für „${esc(q)}“` : ''}.</p>`;
  else body = `<ul class="plan-list">${r.data.map((t) => candidate(t, model, ctx)).join('')}</ul>`;
  return `<section class="plan-find"><h2>Zur Woche hinzufügen</h2>${form}${body}</section>`;
}

/**
 * Vorschläge je Bereich der Big Rocks. Nur Bereiche mit Vorschlägen (oder
 * einem Fehler) bekommen eine eigene Gruppe; die übrigen stehen in einer
 * Zeile, jeder Name führt zu „alle offenen“ des Bereichs.
 */
function suggestSection(model, ctx) {
  const w = model.week;
  const all = (g) => planHref({ woche: w.id, bereich: g.areaId });
  let body;
  if (!model.suggestions.length) {
    body = '<p class="empty">Noch keine Big Rocks in dieser Woche. Über die Suche oder einen Bereich die erste Aufgabe holen.</p>';
  } else {
    const filled = model.suggestions.filter((g) => !g.ok || g.tasks.length);
    const empty = model.suggestions.filter((g) => g.ok && !g.tasks.length);
    const groups = filled
      .map(
        (g) => `<article class="plan-group">
          <h3>${esc(g.area)} <a href="${esc(all(g))}" class="hint">alle offenen</a></h3>
          ${!g.ok ? problem(g) : `<ul class="plan-list">${g.tasks.map((t) => candidate(t, model, ctx, { area: false })).join('')}</ul>${g.more ? `<p class="meta">und ${g.more} weitere</p>` : ''}`}
        </article>`,
      )
      .join('');
    const rest = empty.length
      ? `<p class="meta plan-none">${filled.length ? 'Nichts offen ohne Termin in' : 'Nichts offen ohne Termin. Alle offenen Aufgaben in'}: ${empty
          .map((g) => `<a href="${esc(all(g))}" title="${esc(`Alle offenen Aufgaben in ${g.area}`)}">${esc(g.area)}</a>`)
          .join(', ')}</p>`
      : '';
    body = `${groups ? `<div class="plan-groups">${groups}</div>` : ''}${rest}`;
  }
  return `<section class="plan-suggest"><h2>Aus den Bereichen <span class="hint">offen und ohne Termin, je Big Rock</span></h2>${body}</section>`;
}

/** Flamme einplanen: Titel, Tag, optional Uhrzeit und Bereich, oder aus einer bestehenden Aufgabe. */
function flameSection(model, ctx) {
  const w = model.week;
  const from = model.from;
  const day = (w.days.find((d) => d.today) ?? w.days[0]).date;
  const days = w.days.map((d) => `<option value="${esc(d.date)}"${d.date === day ? ' selected' : ''}>${esc(d.label)}${d.today ? ' (heute)' : ''}</option>`).join('');
  const places = (model.areas ?? []).map((a) => `<option value="area:${esc(a.id)}">${esc(a.name)}</option>`).join('');
  // Danach zurück auf die Seite ohne `aus`, damit das Formular wieder leer ist.
  const fctx = { ...ctx, back: planHref({ woche: w.id, q: model.query.q, bereich: model.query.area }) };
  return `<section id="flamme" class="plan-flame">
    <h2>Flamme einplanen <span class="hint">Deep-Work-Block für ${esc(kw(w.id))}</span></h2>
    ${actForm(fctx, '/aktion/woche/flamme', { woche: w.id, aus: from?.id ?? null }, 'plan-flame-form')}
      ${from ? `<p class="meta">Als Unteraufgabe von <a href="${esc(from.url)}">${esc(taskName(from))}</a> · <a href="${esc(fctx.back)}#flamme">ohne</a></p>` : ''}
      <div class="grid plan-flame-fields">
        <label class="wide">Titel<input name="titel" required maxlength="500" value="${esc(from?.title ?? '')}" placeholder="z. B. Folien für den Workshop" autocomplete="off"></label>
        <label>Tag<select name="tag">${days}</select></label>
        <label><span>Uhrzeit <span class="hint">optional</span></span><input type="time" name="zeit" step="300"></label>
        ${from ? '' : `<label>Bereich<select name="ort"><option value="loose">Ohne Bereich</option>${places}</select></label>`}
      </div>
      <p class="plan-flame-go"><button type="submit" class="primary">Flamme einplanen</button></p>
    </form>
  </section>`;
}

/**
 * Was schon in der Woche steht: die Flammen und darunter die Big Rocks je
 * Bereich, einzeilig und in zwei Spalten (schmal untereinander).
 */
function weekSection(model, ctx) {
  const p = model.planned;
  const tz = model.tz;
  if (!p.ok) return `<section><h2>In ${esc(kw(model.week.id))}</h2>${problem(p)}</section>`;
  const row = (t, { area = false } = {}) => {
    const m = meta(t, tz, { area });
    const closed = t.status === 'done' || t.status === 'dropped';
    const side = t.planned === 'faellig' ? '<span class="hint">fällig</span>' : closed ? '' : outForm(t, ctx);
    return `<li class="plan-item status-${esc(t.status)}">
      <span class="body"><span class="mark" aria-hidden="true">${t.status === 'done' ? '✓' : t.phoenix === 'flamme' ? '🕯️' : '○'}</span><a href="${esc(t.url)}">${esc(t.title)}</a>${m ? `<span class="meta">${m}</span>` : ''}</span>
      <span class="plan-side">${side}</span>
    </li>`;
  };
  const group = (name, tasks, opts, none = '') => `<div class="plan-group">
      <h3>${esc(name)}${tasks.length ? ` <span class="count-badge">${tasks.length}</span>` : ''}</h3>
      ${tasks.length ? `<ul class="plan-list">${tasks.map((t) => row(t, opts)).join('')}</ul>` : none}
    </div>`;
  const groups = [
    { html: group('Flammen', p.flames, { area: true }, '<p class="empty">Keine Flammen geplant.</p>'), rows: p.flames.length + 1.5 },
    ...p.rocks.map((g) => ({ html: group(g.area, g.tasks), rows: g.tasks.length + 1.5 })),
  ];
  return `<section class="plan-week">
    <h2>In ${esc(kw(model.week.id))} <span class="hint">Flammen und Big Rocks</span> <a href="/?woche=${esc(model.week.id)}" class="hint">zur Woche</a></h2>
    <div class="plan-cols">${inColumns(groups, (g) => g.rows)
      .map((col) => `<div class="plan-col">${col.map((g) => g.html).join('')}</div>`)
      .join('')}</div>
    ${p.rocks.length ? '' : '<p class="empty">Nichts fällig und kein Phönix-Schritt markiert.</p>'}
    ${p.partial ? `<p class="problem">Nicht alle Zunder-Abfragen haben geantwortet; die Liste ist unvollständig.${p.error ? ` ${esc(p.error)}` : ''}</p>` : ''}
  </section>`;
}

/**
 * @param {object} [opts.write]  `{ csrf }`, wenn die Seite schreiben darf
 * @param {string} [opts.back]   Rücksprung nach einer Aktion ohne JavaScript
 * @param {object} [opts.flash]  `{ kind, message, undo }` aus der letzten Aktion
 */
export function renderPlan(model, { user = null, write = null, back = '/planen', flash = null } = {}) {
  const w = model.week;
  const ctx = { write, back, week: w };
  const range = `${w.days[0].label.slice(3)}–${w.days[6].label.slice(3)}`;
  let body;
  if (!model.ok) body = `<section>${problem(model)}</section>`;
  else if (!write) body = '<section><p class="problem unconfigured">Planen braucht die Cockpit-Aktionen (Zunder-Zugang).</p></section>';
  else {
    body = `${findSection(model, ctx)}
${suggestSection(model, ctx)}
${flameSection(model, ctx)}
${weekSection(model, ctx)}`;
  }
  return `<!doctype html>
<html lang="de">
${head(`Planen ${kw(w.id)}`, { script: Boolean(write) })}
<body class="page-plan">
${appHeader({ current: 'woche', user })}
<div class="page-head">
  <h1>Woche planen <span class="range">${esc(kw(w.id))} · ${esc(range)}</span></h1>
  <div class="page-tools">
  ${weekSwitch(w.id, 'planen', { thisWeek: w.current })}
  ${weekPager(w, (id) => (id ? planHref({ woche: id }) : '/planen'), { verb: ' planen' })}
  </div>
</div>
<main class="plan-page">
${body}
</main>
<div class="toasts" aria-live="polite">${flashToast(flash, ctx)}</div>
</body>
</html>`;
}

/**
 * Die Aktionen der Planung für `createWebHttp`. Jede liefert `{ message, task, undo }`
 * wie die übrigen; `changed` meldet eine Änderung (etwa, um einen Zwischenspeicher
 * der Wochenansicht zu leeren).
 */
export function planRoutes(plan, { tz, logger = console, changed = () => {} }) {
  const restoreUndo = (task, fields) => (fields ? { action: '/aktion/woche/zuruecksetzen', fields: { id: task.id, ...fields } } : null);
  return {
    async '/aktion/woche/holen'(form, session) {
      const r = await plan.add(form.get('id'), form.get('woche'), form.get('wann'));
      const t = r.task;
      if (!r.changed) return { message: `Steht schon in ${kw(r.week)}: ${taskName(t)}`, task: t };
      changed();
      logger.info?.(`Cockpit: ${t.ref ?? t.id} in ${r.week} (${r.fields.phoenix ? 'Phönix-Schritt' : `fällig ${t.due}`}) (${session.sub})`);
      const message = r.fields.phoenix ? `Phönix-Schritt ${kw(r.week)}: ${taskName(t)}` : `Fällig ${dueLabel(t.due, tz())}: ${taskName(t)}`;
      return { message, task: t, undo: restoreUndo(t, r.undo) };
    },
    async '/aktion/woche/raus'(form, session) {
      const r = await plan.remove(form.get('id'));
      const t = r.task;
      if (!r.changed) return { message: `Ist nicht als Phönix markiert: ${taskName(t)}`, task: t };
      changed();
      logger.info?.(`Cockpit: ${t.ref ?? t.id} aus ${r.was.fire} genommen (${session.sub})`);
      return { message: `Aus ${kw(r.was.fire)} genommen: ${taskName(t)}`, task: t, undo: restoreUndo(t, r.undo) };
    },
    async '/aktion/woche/zuruecksetzen'(form, session) {
      const t = await plan.restore(form.get('id'), { phoenix: form.get('phoenix'), due: form.get('due') });
      changed();
      logger.info?.(`Cockpit: ${t.ref ?? t.id} zurückgesetzt (${session.sub})`);
      return { message: `Zurückgesetzt: ${taskName(t)}`, task: t };
    },
    async '/aktion/woche/flamme'(form, session) {
      const from = form.get('aus') || '';
      const r = await plan.createFlame({ week: form.get('woche'), title: form.get('titel'), day: form.get('tag'), time: form.get('zeit'), place: form.get('ort'), from });
      const t = r.task;
      changed();
      logger.info?.(`Cockpit: Flamme ${t.ref ?? t.id} für ${t.due} angelegt (${session.sub})`);
      // Rückgängig verwirft die neue Flamme; gelöscht wird im Cockpit nichts.
      return {
        message: `Flamme ${dueLabel(t.due, tz())} eingeplant: ${taskName(t)}`,
        task: t,
        undo: { action: '/aktion/status', fields: { id: t.id, status: 'dropped' } },
        // Aus einer bestehenden Aufgabe: zurück zum leeren Formular.
        redirect: from ? planHref({ woche: r.week }, '#flamme') : null,
      };
    },
  };
}

export const PLAN_CSS = `
/* --- Wochenplanung --- */
.plan-page { max-width: 1100px; }
.plan-search { display: flex; flex-wrap: wrap; gap: 8px; margin: 0 0 var(--s-4); }
.plan-search .plan-q { flex: 1 1 260px; display: flex; min-width: 0; }
.plan-search .plan-q input { flex: 1; }
.plan-search .plan-area { flex: 0 1 220px; display: flex; min-width: 0; }
.plan-search .plan-area select { flex: 1; min-width: 0; }
.plan-list > li + li { border-top: 1px solid var(--line); }
.plan-item { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 6px var(--s-3); padding: 6px 0; }
.plan-item .body { flex: 1 1 240px; min-width: 0; overflow-wrap: anywhere; }
.plan-item .body > a { text-decoration-color: transparent; }
.plan-item .body > a:hover { text-decoration-color: var(--accent); }
.plan-item .mark { display: inline-block; width: 20px; color: var(--text-3); }
.plan-item.status-done .body > a { text-decoration: line-through; color: var(--text-2); }
.plan-item .meta { font-size: var(--t-xs); }
.plan-side { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; flex: 0 1 auto; }
.plan-side form { margin: 0; display: flex; gap: 6px; align-items: center; }
.plan-side select { font-size: 14px; padding: 4px 8px; min-height: 32px; background: var(--surface-2); max-width: 190px; }
.plan-side a.chip { text-decoration: none; display: inline-flex; align-items: center; }
.plan-page h2 a.hint { margin-left: auto; color: var(--accent); }
/* Gruppen je Bereich: Name mit Haarlinie, darunter die Zeilen; keine Kacheln (wie die Big Rocks der Woche) */
.plan-groups { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 380px), 1fr)); gap: var(--s-4) var(--s-7); align-items: start; }
.plan-group h3 { margin: 0; padding-bottom: 4px; display: flex; gap: var(--s-2); align-items: baseline; border-bottom: 2px solid var(--line); }
.plan-group h3 a { margin-left: auto; font-size: var(--t-xs); }
.plan-group > .empty { padding: var(--s-2) 0; }
.plan-none { margin: 0; }
.plan-groups + .plan-none { margin-top: var(--s-4); }
.plan-none a { color: var(--text); }
/* Flamme einplanen: breit eine Zeile, der Knopf daneben; schmal brechen die Felder um */
.plan-flame form { margin: 0; display: flex; flex-wrap: wrap; align-items: flex-end; gap: var(--s-3) var(--s-4); }
.plan-flame .plan-flame-fields { flex: 1 1 560px; display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: var(--s-3); }
.plan-flame .plan-flame-fields .wide { grid-column: span 2; }
.plan-flame label { display: flex; flex-direction: column; gap: 6px; font-size: 14px; font-weight: 500; }
.plan-flame input, .plan-flame select { width: 100%; }
.plan-flame form > p { margin: 0; }
.plan-flame form > .meta { flex-basis: 100%; }
/* In der Woche: zwei Spalten, jede Aufgabe eine Zeile, der Ort steht hinter dem Titel */
.plan-cols { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: var(--s-4) var(--s-7); align-items: start; }
.plan-col { display: grid; gap: var(--s-4); align-content: start; min-width: 0; }
.plan-week .plan-item { padding: 4px 0; min-height: 34px; flex-wrap: nowrap; }
.plan-week .plan-item .body { flex: 1 1 auto; }
.plan-week .plan-side { flex: none; }
.plan-week .plan-side .chip { white-space: nowrap; }
.plan-week .plan-item .meta { display: inline; margin-left: var(--s-2); }
.plan-week .plan-list > li + li { border-top: 0; }
.plan-week .plan-side .hint { font-size: var(--t-xs); color: var(--text-3); }
.plan-week .plan-side .chip { min-height: 26px; padding: 2px 10px; font-size: var(--t-xs); }
.plan-week > .empty { margin-top: var(--s-3); }
h2 .h2-link { margin-left: auto; text-transform: none; letter-spacing: 0; font-weight: 500; color: var(--accent); font-size: var(--t-sm); }
@media (max-width: 900px) {
  .plan-cols { grid-template-columns: minmax(0, 1fr); }
}
@media (max-width: 700px) {
  .plan-flame .plan-flame-fields { grid-template-columns: repeat(2, minmax(0, 1fr)); flex-basis: 100%; }
  .plan-flame form > p { flex-basis: 100%; }
  /* Schmal steht der Ort wieder unter dem Titel, eingerückt bis hinter das Zeichen. */
  .plan-week .plan-item { min-height: 40px; padding: 6px 0; }
  .plan-week .plan-item .body { overflow-wrap: break-word; }
  .plan-week .plan-item .meta { display: block; margin-left: 24px; }
  .plan-week .plan-side { flex-basis: auto; flex: none; }
  .plan-week .plan-side .chip { min-height: 40px; font-size: var(--t-sm); }
  .plan-search .plan-area { flex-basis: 100%; }
  .plan-search .btn { flex: 1; min-height: 44px; }
  .plan-side { flex-basis: 100%; }
  /* 16px, damit iOS beim Antippen nicht hineinzoomt */
  .plan-search input, .plan-search select, .plan-side select, .plan-flame input, .plan-flame select { font-size: 16px; }
  .plan-side select, .plan-side .chip { min-height: 40px; }
  .plan-side select { max-width: none; flex: 1; }
  .plan-side form.plan-add { flex: 1; }
  .plan-flame button.primary { width: 100%; min-height: 44px; }
}
`;
