import { localTime, zonedParts } from '../cockpit/week.js';
import { DEFAULT_HIDDEN_EVENTS } from '../cockpit/settings.js';

/**
 * HTML der Wochenansicht. Serverseitig gerendert; alles funktioniert über Links
 * und Formulare. `/static/cockpit.js` macht Abhaken und Schnelleingabe ohne
 * Seitenwechsel, die Content-Security-Policy erlaubt nur eigene Dateien.
 */

const WEEKDAY = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
const MONTHS = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Das bisschen Markdown, das in Feuer-Zielen vorkommt: fett, kursiv, Code, Wikilinks. */
export function inline(md) {
  return esc(md)
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
}

export function dueLabel(due, tz) {
  if (!due) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(due)) {
    const [y, m, d] = due.split('-').map(Number);
    return `${WEEKDAY[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]} ${String(d).padStart(2, '0')}.${String(m).padStart(2, '0')}.`;
  }
  const date = new Date(due);
  if (Number.isNaN(date.getTime())) return '';
  const p = zonedParts(date, tz);
  const wd = WEEKDAY[new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay()];
  return `${wd} ${String(p.day).padStart(2, '0')}.${String(p.month).padStart(2, '0')}. ${localTime(date, tz)}`;
}

function weekTitle(w) {
  const [y1, m1, d1] = w.monday.split('-').map(Number);
  const [y2, m2, d2] = w.sunday.split('-').map(Number);
  const range =
    m1 === m2 ? `${d1}.–${d2}. ${MONTHS[m2 - 1]} ${y2}` : y1 === y2 ? `${d1}. ${MONTHS[m1 - 1]} – ${d2}. ${MONTHS[m2 - 1]} ${y2}` : `${d1}. ${MONTHS[m1 - 1]} ${y1} – ${d2}. ${MONTHS[m2 - 1]} ${y2}`;
  return { short: `KW ${w.week}`, range };
}

const STATUS_MARK = { done: '✓', in_progress: '◐', blocked: '⏸', review: '◑' };

const CHECK_SVG = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7"/></svg>';

/**
 * Kästchen zum Abhaken: ein Formular, das ohne JavaScript per Weiterleitung
 * arbeitet. Erledigte Aufgaben öffnet ein zweiter Klick wieder.
 */
function tickForm(t, ctx) {
  const done = t.status === 'done';
  const label = `${done ? 'Wieder öffnen' : 'Abhaken'}: ${t.title}`;
  const working = t.status === 'in_progress' ? ' working' : t.status === 'blocked' ? ' parked' : '';
  return `<form method="post" action="/aktion/status" class="tick">
      <input type="hidden" name="csrf" value="${esc(ctx.write.csrf)}">
      <input type="hidden" name="back" value="${esc(ctx.back)}">
      <input type="hidden" name="id" value="${esc(t.id)}">
      <input type="hidden" name="status" value="${done ? 'open' : 'done'}">
      <input type="hidden" name="prev" value="${esc(t.status)}">
      <button type="submit" class="check${working}" aria-pressed="${done}" aria-label="${esc(label)}" title="${esc(label)}">${CHECK_SVG}</button>
    </form>`;
}

/** Felder, die jedes Aktionsformular braucht. */
export const hidden = (fields) =>
  Object.entries(fields)
    .filter(([, v]) => v != null)
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`)
    .join('');
export const formHead = (ctx, action, fields = {}) =>
  `<form method="post" action="${action}" class="act">${hidden({ csrf: ctx.write.csrf, back: ctx.back, ...fields })}`;

const STATUS_CHOICES = [
  ['in_progress', 'In Arbeit'],
  ['blocked', 'Blockiert'],
  ['open', 'Offen'],
];
const DUE_CHOICES = [
  ['heute', 'Heute'],
  ['morgen', 'Morgen'],
  ['naechste-woche', 'Nächste Woche'],
];

/**
 * Menü an einer Aufgabe: `<details>` klappt ohne JavaScript auf, jede Gruppe
 * ist ein eigenes Formular. Mit JavaScript bleibt die Seite stehen.
 */
function taskMenu(t, ctx, { inbox = false } = {}) {
  const status = STATUS_CHOICES.map(
    ([value, label]) =>
      `<button type="submit" name="status" value="${value}" class="chip"${t.status === value ? ' aria-current="true" disabled' : ''}>${label}</button>`,
  ).join('');
  const due = DUE_CHOICES.map(([value, label]) => `<button type="submit" name="due" value="${value}" class="chip">${label}</button>`).join('');
  const date = t.due ? String(t.due).slice(0, 10) : '';
  // Phönix-Schritt der angezeigten Woche; Flammen haben ihre eigene Rolle.
  const step = t.phoenix === 'feuer_schritt' ? t.fire : '';
  const week = ctx.week;
  const phoenix =
    t.phoenix === 'flamme' || !week
      ? ''
      : `${formHead(ctx, '/aktion/phoenix', { id: t.id, prev: step })}
          <p class="menu-label">Phönix${step ? ` <span class="hint">Schritt KW ${Number(step.slice(6))}</span>` : ''}</p>
          <div class="chips">${
            step === week.id
              ? '<button type="submit" name="fire" value="" class="chip quiet">Kein Phönix-Schritt</button>'
              : `<button type="submit" name="fire" value="${esc(week.id)}" class="chip">Schritt für KW ${week.week}</button>`
          }</div>
        </form>`;
  return `<details class="menu">
      <summary class="menu-button" aria-label="${esc(`Mehr zu: ${t.title}`)}" title="${inbox ? 'Zuordnen, Status, Fälligkeit' : 'Status, Fälligkeit'}"><span aria-hidden="true">⋯</span></summary>
      <div class="menu-panel">
        <p class="menu-title">${esc(t.title)}</p>
        ${inbox ? assignForm(t, ctx) : ''}
        ${formHead(ctx, '/aktion/status', { id: t.id, prev: t.status })}
          <p class="menu-label">Status</p><div class="chips">${status}${
            inbox ? '<button type="submit" name="status" value="dropped" class="chip danger">Verwerfen</button>' : ''
          }</div>
        </form>
        ${formHead(ctx, '/aktion/faellig', { id: t.id, prev: date })}
          <p class="menu-label">Fällig${t.due ? ` <span class="hint">jetzt ${esc(dueLabel(t.due, ctx.tz))}</span>` : ''}</p>
          <div class="date-row"><label><span class="sr-only">Datum</span><input type="date" name="date" value="${esc(date)}"></label><button type="submit" name="due" value="datum" class="chip">Setzen</button></div>
          <div class="chips">${due}${t.due ? '<button type="submit" name="due" value="keine" class="chip quiet">Ohne</button>' : ''}</div>
        </form>
        ${phoenix}
      </div>
    </details>`;
}

/** „Zuordnen“ für Aufgaben in der Zunder-Inbox: Bereich oder Projekt wählen. */
function assignForm(t, ctx) {
  if (!ctx.targets) return '<p class="problem">Bereiche und Projekte aus Zunder sind gerade nicht abrufbar.</p>';
  const options = ctx.targets
    .map(
      (a) => `<optgroup label="${esc(a.name)}"><option value="area:${esc(a.id)}">${esc(a.name)}</option>${a.projects
        .map((p) => `<option value="project:${esc(p.id)}">${esc(a.name)} / ${esc(p.name)}</option>`)
        .join('')}</optgroup>`,
    )
    .join('');
  return `${formHead(ctx, '/aktion/zuordnen', { id: t.id, prev: 'inbox' })}
          <p class="menu-label">Zuordnen</p>
          <div class="assign-row"><label><span class="sr-only">Bereich oder Projekt</span><select name="ziel" required>
            <option value="">Bereich oder Projekt …</option>${options}<option value="loose">Lose (ohne Bereich)</option>
          </select></label><button type="submit" class="chip">Zuordnen</button></div>
        </form>`;
}

const FLAME_SVG = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.5c.4 2.2 3.5 3.6 3.5 7.2A3.5 3.5 0 0 1 8 14.5a3.5 3.5 0 0 1-3.5-3.8c0-1.6.9-2.6 1.6-3.3.2 1 .7 1.7 1.4 2 .1-2.6-.4-4.6.5-7.9z"/></svg>';
const STOP_SVG = '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="4" y="4" width="8" height="8" rx="1.5"/></svg>';

/** Knopf „Flamme starten/stoppen“ an Flammen und Big Rocks. */
function flameButton(t, ctx) {
  const label = `${t.running ? 'Flamme stoppen' : 'Flamme starten'}: ${t.title}`;
  return `${formHead(ctx, '/aktion/flamme', { id: t.id, an: t.running ? '0' : '1' }).replace('class="act"', 'class="act flame-form"')}
      <button type="submit" class="flame-btn${t.running ? ' running' : ''}" aria-label="${esc(label)}" title="${esc(label)}">${t.running ? STOP_SVG : FLAME_SVG}</button>
    </form>`;
}

/** Leiste oben, solange irgendwo eine Flamme brennt: Timer und Stopp mit einem Klick. */
function burningBar(model, tz, ctx) {
  const t = model.burning;
  if (!t || !ctx.write) return '';
  const since = t.startedAt ? `seit ${localTime(new Date(t.startedAt), tz)}` : 'läuft';
  return `<div class="burning" role="status">
    <span class="ember" aria-hidden="true">${FLAME_SVG}</span>
    <span class="burning-text">Flamme läuft: <a href="${esc(t.url)}">${esc(t.ref ? `${t.ref} ${t.title}` : t.title)}</a></span>
    <span class="timer"${t.startedAt ? ` data-since="${esc(t.startedAt)}"` : ''}>${esc(since)}</span>
    ${formHead(ctx, '/aktion/flamme', { id: t.id, an: '0' })}<button type="submit" class="chip stop">${STOP_SVG} Stopp</button></form>
  </div>`;
}

function taskItem(t, tz, ctx = {}, { area = false, mark = null, live = false, inbox = false, flame = false } = {}) {
  const meta = [t.ref, area ? t.area : t.project, dueLabel(t.due, tz), ...(t.extra ? [t.extra] : [])].filter(Boolean).map(esc).join(' · ');
  const writable = ctx.write && t.id;
  const lead = writable
    ? tickForm(t, ctx)
    : `<span class="mark" aria-label="${esc(t.status)}">${mark ?? STATUS_MARK[t.status] ?? '○'}</span>`;
  return `<li class="task status-${esc(t.status)}${t.overdue ? ' overdue' : ''}" data-id="${esc(t.id ?? '')}" data-status="${esc(t.status)}" data-title="${esc(t.title)}">
    ${lead}
    <span class="body"><a href="${esc(t.url)}">${esc(t.title)}</a>${meta || live ? `<span class="meta">${meta}${live ? `${meta ? ' · ' : ''}<span class="live">läuft</span>` : ''}</span>` : ''}</span>
    ${writable && flame && t.status !== 'done' && t.status !== 'dropped' ? flameButton(t, ctx) : ''}
    ${writable ? taskMenu(t, { ...ctx, tz }, { inbox }) : ''}
  </li>`;
}

const problem = (s) =>
  `<p class="problem${s.unconfigured ? ' unconfigured' : ''}">${esc(s.error)}${s.unconfigured ? ' · <a href="/einstellungen">Einstellungen</a>' : ''}</p>`;

/** Bearbeiten eines Feuer-Abschnitts: klappt ohne JavaScript auf, speichert in die Feuer-Notiz. */
function feuerEdit(ctx, path, field, label, value) {
  return `<details class="inline-edit">
      <summary aria-label="${esc(`${label} bearbeiten`)}" title="${esc(`${label} bearbeiten`)}"><span aria-hidden="true">✎</span> <span class="summary-text">bearbeiten</span></summary>
      ${formHead(ctx, '/aktion/feuer', { pfad: path, feld: field })}
        <label><span class="sr-only">${esc(label)}</span><textarea name="text" rows="${field === 'ziel' ? 3 : 2}" maxlength="2000" required>${esc(value ?? '')}</textarea></label>
        <p><button type="submit" class="chip">Speichern</button></p>
      </form>
    </details>`;
}

/** Feuer-Notiz der Woche anlegen: Feuer-Ziel ist Pflicht, der Erste Zug kann später kommen. */
function feuerCreate(ctx, weekId) {
  return `<details class="inline-edit feuer-create">
      <summary><span aria-hidden="true">＋</span> <span class="summary-text">Feuer anlegen</span></summary>
      ${formHead(ctx, '/aktion/feuer/anlegen', { woche: weekId })}
        <label>Feuer-Ziel<textarea name="ziel" rows="3" maxlength="2000" required></textarea></label>
        <label>Erster Zug <span class="hint">(optional)</span><textarea name="zug" rows="2" maxlength="2000"></textarea></label>
        <p><button type="submit" class="chip">Anlegen</button></p>
      </form>
    </details>`;
}

export function obsidianLink(path, vaultName) {
  if (!vaultName) return null;
  const file = path.replace(/\.md$/i, '');
  return `obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodeURIComponent(file)}`;
}

function feuerSection(model, tz, vaultName, ctx) {
  const f = model.feuer;
  let goal;
  if (!f.ok) goal = problem(f);
  else if (!f.data) goal = `<p class="empty">Für diese Woche gibt es keine Feuer-Notiz.</p>${ctx.write?.notes && !model.week.past ? feuerCreate(ctx, model.week.id) : ''}`;
  else {
    const link = obsidianLink(f.data.path, vaultName);
    const editable = Boolean(ctx.write?.notes);
    goal = `<p class="goal">${f.data.goal ? inline(f.data.goal) : '<span class="empty">Die Notiz hat keinen Abschnitt „Feuer-Ziel“.</span>'}</p>
      ${editable ? feuerEdit(ctx, f.data.path, 'ziel', 'Feuer-Ziel', f.data.goal) : ''}
      ${f.data.alignment ? `<p class="meta">Alignment: ${esc(f.data.alignment)}</p>` : ''}
      ${f.data.firstMove || editable ? `<p class="first-move"><span class="label">Erster Zug</span> ${f.data.firstMove ? inline(f.data.firstMove) : '<span class="empty">noch keiner</span>'}</p>` : ''}
      ${editable ? feuerEdit(ctx, f.data.path, 'zug', 'Erster Zug', f.data.firstMove) : ''}
      <p class="meta">${link ? `<a href="${esc(link)}">${esc(f.data.title)}</a>` : esc(f.data.title)}</p>`;
  }

  const fl = model.flames;
  let flames;
  if (!fl.ok) flames = problem(fl);
  else if (!fl.data.length) flames = '<p class="empty">Keine Flammen geplant.</p>';
  else {
    flames = `<ul class="flames">${fl.data
      .map((t) => {
        const extra = t.running ? null : t.minutes != null ? `${t.minutes} min` : null;
        return taskItem({ ...t, ref: null, project: null, extra }, tz, ctx, { mark: t.status === 'done' ? '✓' : '🕯️', live: t.running, flame: true });
      })
      .join('')}</ul>`;
  }

  return `<section class="feuer">
    <div><h2>Feuer-Ziel</h2>${goal}</div>
    <div><h2>Flammen</h2>${flames}</div>
  </section>`;
}

function rocksSection(model, tz, ctx) {
  const r = model.rocks;
  let body;
  if (!r.ok) body = problem(r);
  else if (!r.data.length) body = '<p class="empty">Diese Woche ist nichts fällig und kein Phönix-Schritt markiert.</p>';
  else {
    body = `<div class="rocks">${r.data
      .map(
        (g) => `<article class="rock${g.tasks.length && g.done === g.tasks.length ? ' all-done' : ''}">
          <h3>${esc(g.area)} <span class="count" data-count>${g.done}/${g.tasks.length}</span></h3>
          <ul>${g.tasks.map((t) => taskItem(t, tz, ctx, { flame: true, live: t.running })).join('')}</ul>
        </article>`,
      )
      .join('')}</div>`;
    if (r.partial) body += '<p class="problem">Nicht alle Zunder-Abfragen haben geantwortet; die Liste ist unvollständig.</p>';
  }
  return `<section><h2>Big Rocks</h2>${body}</section>`;
}

function calendarSection(model, tz) {
  const c = model.calendar;
  if (!c.ok) return `<section><h2>Termine</h2>${problem(c)}</section>`;
  const days = c.data
    .map(
      (d) => `<div class="day${d.today ? ' today' : ''}">
        <h3>${esc(d.label)}</h3>
        ${
          d.events.length
            ? `<ul>${d.events
                .map(
                  (e) => `<li class="event${e.allDay ? ' all-day' : ''}">
                  ${e.allDay ? '' : `<span class="time">${localTime(e.start, tz)}</span>`}
                  <span class="title">${esc(e.title)}</span>
                  ${e.location ? `<span class="meta">${esc(e.location)}</span>` : ''}
                </li>`,
                )
                .join('')}</ul>`
            : '<p class="empty">frei</p>'
        }
      </div>`,
    )
    .join('');
  const failed = (c.errors ?? [])
    .map((e) => `<p class="problem">${esc(e.calendar)}: ${esc(e.error)}</p>`)
    .join('');
  return `<section><h2>Termine</h2>${failed}<div class="week">${days}</div></section>`;
}

function tasksSection(model, tz, ctx) {
  const t = model.tasks;
  let body;
  if (!t.ok) body = problem(t);
  else if (!t.data.length) body = '<p class="empty">Nichts in Arbeit, nichts überfällig.</p>';
  else body = `<ul>${t.data.map((x) => taskItem(x, tz, ctx, { area: true })).join('')}</ul>`;
  return `<section><h2>Aufgaben <span class="hint">in Arbeit und überfällig</span></h2>${body}</section>`;
}

/** Liste, die das Script nach dem Erfassen ergänzt; leer zeigt sie „Leer.“. */
const inboxList = (name, items) =>
  `${items.length ? '' : `<p class="empty" data-empty="${name}">Leer.</p>`}<ul data-list="${name}"${items.length ? '' : ' hidden'}>${items.join('')}</ul>`;

function inboxSection(model, tz, vaultName, ctx) {
  const { vault, zunder, folder } = model.inbox;
  let notes;
  if (!vault.ok) notes = problem(vault);
  else {
    notes = inboxList('vault-inbox', vault.data
      .map((n) => {
        const link = obsidianLink(n.path, vaultName);
        const title = esc(n.title ?? n.path.split('/').pop().replace(/\.md$/i, ''));
        // Mit Notiz-Vorschau öffnet der Titel die Notiz im Cockpit, Obsidian bleibt daneben.
        if (ctx.write?.notes) {
          return `<li class="note"><a href="/notiz?pfad=${encodeURIComponent(n.path)}">${title}</a><span class="meta">${esc(n.path)}${link ? ` · <a href="${esc(link)}">Obsidian</a>` : ''}</span></li>`;
        }
        return `<li class="note">${link ? `<a href="${esc(link)}">${title}</a>` : title}<span class="meta">${esc(n.path)}</span></li>`;
      }));
  }
  let tasks;
  if (!zunder.ok) tasks = problem(zunder);
  else tasks = inboxList('zunder-inbox', zunder.data.map((x) => taskItem(x, tz, { ...ctx, targets: model.inbox.targets }, { inbox: true })));
  return `<section><h2>Inbox</h2>
    <h3>Vault <span class="hint">${esc(folder)}/</span></h3>${notes}
    <h3>Zunder</h3>${tasks}
  </section>`;
}

/**
 * Schnelleingabe: eine Zeile, die beim Tippen wächst. `!` vorne macht eine
 * Zunder-Aufgabe daraus. Die Erfassungs-ID verhindert Doppelte beim Neusenden.
 */
function captureBar(ctx, draft) {
  const task = String(draft ?? '').trimStart().startsWith('!');
  return `<form method="post" action="/aktion/erfassen" class="capture" data-mode="${task ? 'task' : 'note'}">
  <input type="hidden" name="csrf" value="${esc(ctx.write.csrf)}">
  <input type="hidden" name="back" value="${esc(ctx.back)}">
  <input type="hidden" name="cid" value="${esc(ctx.write.captureId)}">
  <label class="capture-field">
    <span class="sr-only">Schnelleingabe</span>
    <span class="capture-mode" aria-hidden="true"><span class="as-note">Notiz</span><span class="as-task">Aufgabe</span></span>
    <textarea name="text" rows="1" maxlength="20000" enterkeyhint="send" autocomplete="off"
      placeholder="Gedanke festhalten … mit ! vorne wird es eine Zunder-Aufgabe">${esc(draft ?? '')}</textarea>
    <kbd class="capture-key" title="Mit / oder n hierher springen">/</kbd>
  </label>
  <button type="submit" class="primary">${task ? 'Aufgabe anlegen' : 'Notiz anlegen'}</button>
</form>`;
}

/** Meldung nach einer Aktion ohne JavaScript, mit Rückgängig als Formular. */
export function flashToast(flash, ctx) {
  if (!flash?.message) return '';
  const undo =
    flash.undo?.action?.startsWith('/aktion/') && ctx.write
      ? `<form method="post" action="${esc(flash.undo.action)}" class="act">${hidden({ csrf: ctx.write.csrf, back: ctx.back, ...flash.undo.fields })}<button type="submit" class="toast-action">Rückgängig</button></form>`
      : '';
  const kind = flash.kind === 'error' ? 'error' : 'ok';
  return `<div class="toast ${kind}" role="${kind === 'error' ? 'alert' : 'status'}"><span class="toast-text">${esc(flash.message)}</span>${undo}<button type="button" class="toast-close" aria-label="Schließen">×</button></div>`;
}

/**
 * @param {object} [opts.write]  `{ csrf, captureId }`, wenn die Seite schreiben darf
 * @param {string} [opts.back]   Rücksprung nach einer Aktion ohne JavaScript
 * @param {object} [opts.flash]  `{ kind, message, undo }` aus der letzten Aktion
 * @param {string} [opts.draft]  Text, der nach einem Fehler wieder ins Eingabefeld kommt
 */
export function renderWeek(model, { user = null, write = null, back = '/', flash = null, draft = null } = {}) {
  const { tz, vaultName } = model;
  const w = model.week;
  const title = weekTitle(w);
  const ctx = { write, back, week: w };
  return `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title.short)} · Cockpit</title>
<meta name="theme-color" content="#f6f5f2" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#171614" media="(prefers-color-scheme: dark)">
<link rel="stylesheet" href="/static/cockpit.css">
${write ? '<script src="/static/cockpit.js" defer></script>' : ''}
</head>
<body>
<header>
  <div>
    <h1>${esc(title.short)} <span class="range">${esc(title.range)}</span></h1>
  </div>
  <nav>
    <a href="/?woche=${esc(w.prev)}" rel="prev">← KW ${Number(w.prev.slice(6))}</a>
    ${w.current ? '' : '<a href="/">Diese Woche</a>'}
    <a href="/?woche=${esc(w.next)}" rel="next">KW ${Number(w.next.slice(6))} →</a>
    <a href="/rueckblick?woche=${esc(w.id)}">Rückblick</a>
    <a href="/graph">Suche &amp; Graph</a>
    <a href="/einstellungen" class="quiet">Einstellungen</a>
    <form method="post" action="/logout"><button type="submit" title="${esc(user ?? '')}">Abmelden</button></form>
  </nav>
</header>
${write ? `<div class="capture-wrap">${captureBar(ctx, draft)}</div>` : ''}
<main>
${burningBar(model, tz, ctx)}
${feuerSection(model, tz, vaultName, ctx)}
${rocksSection(model, tz, ctx)}
${calendarSection(model, tz)}
<div class="columns">
${tasksSection(model, tz, ctx)}
${inboxSection(model, tz, vaultName, ctx)}
</div>
</main>
<div class="toasts" aria-live="polite">${flashToast(flash, ctx)}</div>
</body>
</html>`;
}

const KIND_LABEL = { ical: 'iCal-Abo', caldav: 'CalDAV' };

/** Adresse ohne Pfad und Abfrage: iCal-Adressen enthalten oft ein Geheimnis. */
const maskUrl = (url) => {
  try {
    const u = new URL(url);
    return `${u.origin}/…`;
  } catch {
    return '…';
  }
};

function calendarRow(c, i, check) {
  const isNew = !c;
  const v = (k) => (c ? esc(c[k] ?? '') : '');
  const kind = c?.kind ?? 'ical';
  const status = check
    ? check.ok
      ? `<span class="ok">✓ erreichbar, ${check.count} Termine diese Woche</span>`
      : `<span class="problem">${esc(check.error)}</span>`
    : '';
  return `<fieldset class="calendar">
    <legend>${isNew ? 'Neuer Kalender' : esc(c.name)} ${status}</legend>
    ${isNew ? '' : `<input type="hidden" name="cal.${i}.id" value="${v('id')}">`}
    <div class="grid">
      <label>Name<input name="cal.${i}.name" value="${v('name')}" maxlength="80" placeholder="z. B. Privat"></label>
      <label>Art<select name="cal.${i}.kind">
        ${Object.entries(KIND_LABEL).map(([k, l]) => `<option value="${k}"${k === kind ? ' selected' : ''}>${l}</option>`).join('')}
      </select></label>
      <label class="wide">Adresse<input name="cal.${i}.url" type="text" inputmode="url" autocomplete="off"
        placeholder="${isNew ? 'https://… oder webcal://…' : `${esc(maskUrl(c.url))} (leer lassen = unverändert)`}"></label>
      <label><span>Benutzer <span class="hint">optional</span></span><input name="cal.${i}.username" value="${v('username')}" autocomplete="off"></label>
      <label><span>Passwort <span class="hint">optional</span></span><input name="cal.${i}.password" type="password" autocomplete="new-password"
        placeholder="${c?.password ? 'gesetzt (leer lassen = unverändert)' : ''}"></label>
      <label class="wide"><span>Nur diese Kalender <span class="hint">CalDAV, Anzeigenamen mit Komma; leer = alle</span></span><input name="cal.${i}.filter" value="${c ? esc((c.filter ?? []).join(', ')) : ''}"></label>
    </div>
    ${isNew ? '' : `<label class="check"><input type="checkbox" name="cal.${i}.remove" value="1"> entfernen</label>`}
  </fieldset>`;
}

/**
 * Einstellungsseite. Passwörter, Tokens und Kalenderadressen werden nie
 * zurückgegeben: Ein leeres Feld behält den gespeicherten Wert.
 */
/** Abschnitt „API-Tokens“: eigene Formulare, damit „Speichern“ oben die Tokens nie berührt. */
function tokenSection(tokens, created, tz) {
  const date = (iso) => new Date(iso).toLocaleDateString('de-DE', { timeZone: tz });
  const rows = tokens
    .map(
      (t) => `<li><span>${esc(t.name)} <span class="meta">angelegt am ${esc(date(t.createdAt))}</span></span>
    <form method="post" action="/einstellungen/tokens/widerrufen"><input type="hidden" name="id" value="${esc(t.id)}"><button type="submit">Widerrufen</button></form></li>`,
    )
    .join('');
  return `<section>
  <h2>API-Tokens</h2>
  <p class="meta">Für <code>GET /api/search</code> mit <code>Authorization: Bearer vct_…</code>. Ein Token kann nur suchen, nur in eigenen Notizen ohne vertrauliche Ordner.</p>
  ${created ? `<div class="created"><p class="notice">Token „${esc(created.name)}“ angelegt. Jetzt kopieren, er wird nicht noch einmal angezeigt:</p><p><code>${esc(created.token)}</code></p></div>` : ''}
  ${rows ? `<ul class="tokens">${rows}</ul>` : '<p class="empty">Noch keine Tokens.</p>'}
  <form method="post" action="/einstellungen/tokens" class="token-new">
    <label>Name<input name="name" maxlength="80" required placeholder="z. B. Raycast"></label>
    <button type="submit" class="primary">Token anlegen</button>
  </form>
</section>`;
}

/** Abschnitt „Kurzbefehle“: die signierten iOS-Kurzbefehle zum Laden. */
function shortcutSection(shortcuts, captureEnabled) {
  const items = shortcuts
    .map((s) => `<li><a href="/kurzbefehle/${esc(s.slug)}.shortcut" download="${esc(s.file)}">${esc(s.title)}</a> <span class="meta">${esc(s.text)}</span></li>`)
    .join('');
  return `<section>
  <h2>Kurzbefehle</h2>
  <p class="meta">Auf dem iPhone antippen und importieren. Beim Import fragt iOS nach dem Capture-Token${captureEnabled ? '' : ' (Capture ist auf dem Server gerade aus)'}.</p>
  <ul class="shortcuts">${items}</ul>
</section>`;
}

export function renderSettings({ stored, defaults, checks = {}, notice = null, error = null, tokens = null, created = null, shortcuts = [], captureEnabled = false, tz = 'Europe/Berlin', user = null }) {
  const d = defaults;
  const zunderStatus = stored.zunder.url && stored.zunder.token
    ? 'eigener Zugang gespeichert'
    : d.zunderUrl && d.zunderToken
      ? `aus der Umgebung (${esc(d.zunderUrl)})`
      : 'nicht eingerichtet';
  const rows = stored.calendars.map((c, i) => calendarRow(c, i, checks[c.id])).join('');
  return `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Einstellungen · Cockpit</title>
<link rel="stylesheet" href="/static/cockpit.css">
</head>
<body>
<header>
  <h1>Einstellungen</h1>
  <nav>
    <a href="/">← Zur Woche</a>
    <form method="post" action="/logout"><button type="submit" title="${esc(user ?? '')}">Abmelden</button></form>
  </nav>
</header>
<main class="settings">
${notice ? `<p class="notice">${esc(notice)}</p>` : ''}
${error ? `<p class="problem">${esc(error)}</p>` : ''}
<form method="post" action="/einstellungen">
<section>
  <h2>Kalender</h2>
  <p class="meta">iCal-Abo: die geheime .ics-Adresse eines Kalenders, wie Kalender-Apps sie zum Teilen anbieten. CalDAV: das Kalender-Home oder ein einzelner Kalender, mit Benutzer und App-Passwort.</p>
  ${rows}
  ${calendarRow(null, stored.calendars.length)}
  <label><span>Ausgeblendete Termine <span class="hint">Titel, durch Komma getrennt; leer = alle zeigen</span></span><input name="hiddenEvents" value="${esc((stored.hiddenEvents ?? DEFAULT_HIDDEN_EVENTS).join(', '))}"></label>
</section>
<section>
  <h2>Zunder</h2>
  <p class="meta">Stand: ${zunderStatus}. Leer lassen, um den Zugang aus der Umgebung zu nutzen.</p>
  <div class="grid">
    <label>Adresse<input name="zunder.url" value="${esc(stored.zunder.url ?? '')}" placeholder="${esc(d.zunderUrl ?? 'https://zunder.example')}"></label>
    <label><span>API-Token <span class="hint">zt_…</span></span><input name="zunder.token" type="password" autocomplete="new-password"
      placeholder="${stored.zunder.token ? 'gesetzt (leer lassen = unverändert)' : ''}"></label>
  </div>
  ${stored.zunder.token ? '<label class="check"><input type="checkbox" name="zunder.clear" value="1"> eigenen Zugang löschen</label>' : ''}
</section>
<section>
  <h2>Anzeige</h2>
  <div class="grid">
    <label>Zeitzone<input name="tz" value="${esc(stored.tz ?? '')}" placeholder="${esc(d.tz)}"></label>
    <label><span>Vault-Name in Obsidian <span class="hint">für „In Obsidian öffnen“</span></span><input name="vaultName" value="${esc(stored.vaultName ?? '')}" placeholder="${esc(d.vaultName ?? '')}"></label>
    <label>Inbox-Ordner im Vault<input name="inboxFolder" value="${esc(stored.inboxFolder ?? '')}" placeholder="${esc(d.inboxFolder)}"></label>
  </div>
</section>
<p><button type="submit" class="primary">Speichern</button></p>
</form>
${tokens ? tokenSection(tokens, created, tz) : ''}
${shortcuts.length ? shortcutSection(shortcuts, captureEnabled) : ''}
</main>
</body>
</html>`;
}

export function renderMessage(title, text, { link = null } = {}) {
  return `<!doctype html>
<html lang="de">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · Cockpit</title><link rel="stylesheet" href="/static/cockpit.css"></head>
<body><main class="message"><h1>${esc(title)}</h1><p>${esc(text)}</p>${link ? `<p><a href="${esc(link.href)}">${esc(link.label)}</a></p>` : ''}</main></body>
</html>`;
}

export const CSS = `:root {
  --bg: #f6f5f2; --surface: #ffffff; --text: #1f1d1a; --muted: #6b665e; --line: #e4e0d8;
  --accent: #c2410c; --accent-soft: #fff1e8; --ok: #15803d; --warn: #b45309; --today: #fff7ed;
  --r-sm: 6px; --r-md: 8px; --r-lg: 12px; --shadow-pop: 0 10px 30px rgb(0 0 0 / .16);
  color-scheme: light dark;
}
@media (prefers-color-scheme: dark) {
  :root { --bg: #171614; --surface: #211f1c; --text: #ece8e1; --muted: #a39d93; --line: #35322d;
    --accent: #fb923c; --accent-soft: #2c2018; --ok: #4ade80; --warn: #fbbf24; --today: #2a221b; }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text);
  font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
a { color: inherit; text-decoration-color: var(--line); text-underline-offset: 2px; }
a:hover { text-decoration-color: var(--accent); }
header { display: flex; flex-wrap: wrap; gap: 12px; justify-content: space-between; align-items: center;
  padding: 16px clamp(16px, 4vw, 40px); border-bottom: 1px solid var(--line); background: var(--surface); }
h1 { margin: 0; font-size: 22px; }
h1 .range { font-weight: 400; color: var(--muted); font-size: 16px; margin-left: 8px; }
nav { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
nav a { text-decoration: none; padding: 4px 10px; border: 1px solid var(--line); border-radius: 6px; }
nav form { margin: 0; }
nav button { font: inherit; color: var(--muted); background: none; border: 0; cursor: pointer; padding: 4px; }
main { max-width: 1280px; margin: 0 auto; padding: 24px clamp(16px, 4vw, 40px) 48px; display: grid; gap: 28px; }
section { background: var(--surface); border: 1px solid var(--line); border-radius: 10px; padding: 18px 20px; }
h2 { margin: 0 0 12px; font-size: 13px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); }
h3 { margin: 12px 0 6px; font-size: 15px; }
.hint { text-transform: none; letter-spacing: 0; font-weight: 400; }
ul { list-style: none; margin: 0; padding: 0; }
.feuer { display: grid; grid-template-columns: 2fr 1fr; gap: 24px; border-color: var(--accent); background: var(--accent-soft); }
.goal { font-size: 19px; line-height: 1.45; margin: 0 0 8px; }
.first-move .label { font-weight: 600; margin-right: 6px; }
.meta { display: block; color: var(--muted); font-size: 13px; }
.empty { color: var(--muted); margin: 0; }
.problem { color: var(--warn); margin: 0; font-size: 14px; }
.problem.unconfigured { color: var(--muted); }
.task { display: flex; gap: 8px; padding: 5px 0; }
.task .mark { width: 1.2em; flex: none; text-align: center; color: var(--muted); }
.task.status-done .body > a { text-decoration: line-through; color: var(--muted); }
.task.status-done .mark { color: var(--ok); }
.task.overdue .meta { color: var(--warn); }
.live { color: var(--accent); font-weight: 600; }
.rocks { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 16px; }
.rock { border: 1px solid var(--line); border-radius: 8px; padding: 10px 14px; }
.rock h3 { margin-top: 0; display: flex; justify-content: space-between; gap: 8px; }
.count { flex: none; color: var(--muted); font-weight: 400; font-size: 13px; }
.week { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 10px; }
.day { border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; min-height: 90px; }
.day.today { background: var(--today); border-color: var(--accent); }
.day h3 { margin: 0 0 6px; font-size: 13px; }
.event { padding: 3px 0; font-size: 14px; border-top: 1px solid var(--line); }
.event:first-child { border-top: 0; }
.event .time { color: var(--muted); font-variant-numeric: tabular-nums; margin-right: 4px; }
.event.all-day .title { font-weight: 600; }
.columns { display: grid; grid-template-columns: 1fr 1fr; gap: 28px; }
.note { padding: 4px 0; }
nav a.quiet { border: 0; color: var(--muted); }
.settings form { display: grid; gap: 20px; }
.settings .hint { color: var(--muted); }
.settings fieldset { border: 1px solid var(--line); border-radius: 8px; padding: 10px 14px 12px; margin: 0 0 14px; }
.settings legend { font-weight: 600; padding: 0 6px; }
.settings legend .ok, .settings legend .problem { font-weight: 400; font-size: 13px; margin-left: 8px; }
.ok { color: var(--ok); }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 10px 16px; }
.grid .wide { grid-column: 1 / -1; }
.settings label { display: flex; flex-direction: column; gap: 4px; font-size: 14px; }
.settings label.check { flex-direction: row; align-items: center; gap: 6px; margin-top: 8px; color: var(--muted); }
.settings input:not([type=checkbox]), .settings select { font: inherit; color: var(--text); background: var(--bg);
  border: 1px solid var(--line); border-radius: 6px; padding: 6px 8px; min-width: 0; }
button.primary { font: inherit; font-weight: 600; color: #fff; background: var(--accent); border: 0; border-radius: 6px; padding: 8px 18px; cursor: pointer; }
.notice { color: var(--ok); margin: 0; }
.tokens li { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 6px 0; border-top: 1px solid var(--line); }
.tokens li:first-child { border-top: 0; }
.shortcuts { padding-left: 1.2em; }
.shortcuts li { margin: 6px 0; }
.tokens form, .settings .token-new { margin: 0; display: flex; gap: 12px; align-items: end; flex-wrap: wrap; }
.created { border: 1px solid var(--ok); border-radius: 8px; padding: 8px 12px; margin-bottom: 12px; }
.created code { word-break: break-all; }
code { font-size: 13px; background: var(--line); padding: 1px 4px; border-radius: 4px; }
.message { max-width: 520px; }
/* --- Schreiben: Schnelleingabe, Abhaken, Meldungen --- */
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.capture-wrap { position: sticky; top: 0; z-index: 5; padding: 12px clamp(16px, 4vw, 40px);
  background: color-mix(in srgb, var(--bg) 88%, transparent); backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);
  border-bottom: 1px solid var(--line); }
.capture { max-width: 1280px; margin: 0 auto; display: flex; gap: 10px; align-items: flex-end; }
.capture-field { flex: 1; display: flex; align-items: flex-start; gap: 10px; min-width: 0; background: var(--surface);
  border: 1px solid var(--line); border-radius: 12px; padding: 8px 10px 8px 8px;
  box-shadow: 0 1px 2px rgb(0 0 0 / .04); transition: border-color .15s, box-shadow .15s; }
.capture-field:focus-within { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
.capture textarea { flex: 1; min-width: 0; resize: none; border: 0; outline: 0; background: none; color: var(--text);
  font: inherit; font-size: 16px; line-height: 1.45; padding: 3px 0; max-height: 240px; }
.capture textarea::placeholder { color: var(--muted); }
.capture-mode { flex: none; font-size: 12px; font-weight: 600; letter-spacing: .02em; padding: 4px 8px; border-radius: 999px;
  background: var(--line); color: var(--muted); transition: background .15s, color .15s; margin-top: 1px; }
.capture .as-task, .capture[data-mode=task] .as-note { display: none; }
.capture[data-mode=task] .as-task { display: inline; }
.capture[data-mode=task] .capture-mode { background: var(--accent); color: #fff; }
.capture-key { flex: none; font: 12px/1 ui-monospace, monospace; color: var(--muted); border: 1px solid var(--line);
  border-bottom-width: 2px; border-radius: 5px; padding: 3px 6px; margin-top: 3px; }
.capture-field:focus-within .capture-key { visibility: hidden; }
.capture button.primary { flex: none; min-height: 44px; border-radius: 12px; transition: opacity .15s, transform .1s; }
.capture button.primary:active { transform: scale(.97); }
.capture.busy button.primary { opacity: .6; cursor: progress; }
.capture.nudge .capture-field { animation: nudge .3s; }
@keyframes nudge { 25% { transform: translateX(-4px); } 75% { transform: translateX(4px); } }

.tick { margin: 0; flex: none; display: flex; }
.check { --size: 20px; width: var(--size); height: var(--size); margin: 1px 0 0; padding: 0; flex: none; cursor: pointer;
  display: grid; place-items: center; border-radius: 50%; border: 1.5px solid var(--muted); background: var(--surface);
  color: #fff; position: relative; transition: background .18s, border-color .18s, transform .1s; }
.check::before { content: ''; position: absolute; inset: -12px; }
.check svg { width: 12px; height: 12px; fill: none; stroke: currentColor; stroke-width: 2.4; stroke-linecap: round;
  stroke-linejoin: round; stroke-dasharray: 16; stroke-dashoffset: 16; transition: stroke-dashoffset .25s ease-out .05s; }
.check:hover { border-color: var(--ok); }
.check:hover svg { stroke-dashoffset: 0; color: var(--ok); }
.check:active { transform: scale(.88); }
.check:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.check.working { border-color: var(--accent); background: linear-gradient(90deg, var(--accent-soft) 50%, var(--surface) 50%); }
.check.parked { border-style: dashed; }
.check[aria-pressed=true] { background: var(--ok); border-color: var(--ok); }
.check[aria-pressed=true] svg { stroke-dashoffset: 0; color: #fff; }
.task .body { min-width: 0; overflow-wrap: anywhere; }
.task .body > a { transition: color .2s; }
.task.status-done .body > a { text-decoration: line-through; text-decoration-color: var(--muted); }
.task.busy { opacity: .7; }
.task.just-done .check { animation: pop .35s ease-out; }
@keyframes pop { 50% { transform: scale(1.25); } }
.rock.all-done { border-color: var(--ok); }
.rock.all-done .count { color: var(--ok); font-weight: 600; }
.fresh { animation: fresh 1.6s ease-out; border-radius: 6px; }
@keyframes fresh { from { background: var(--accent-soft); } to { background: transparent; } }

.toasts { position: fixed; z-index: 10; left: 50%; bottom: max(16px, env(safe-area-inset-bottom)); transform: translateX(-50%);
  display: grid; gap: 8px; width: min(560px, calc(100vw - 24px)); pointer-events: none; }
.toast { pointer-events: auto; display: flex; align-items: center; gap: 10px; padding: 10px 10px 10px 14px; border-radius: 12px;
  background: var(--text); color: var(--bg); box-shadow: 0 8px 24px rgb(0 0 0 / .18); font-size: 14px;
  animation: toast-in .22s ease-out; transition: opacity .2s, transform .2s; }
.toast.error { background: var(--warn); color: #fff; }
.toast.leaving { opacity: 0; transform: translateY(6px); }
.toast-text { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.toast form { margin: 0; }
.toast-action, .toast-close { font: inherit; color: inherit; background: none; border: 0; cursor: pointer; min-height: 32px; }
.toast-action { font-weight: 700; padding: 4px 8px; border-radius: 8px; color: var(--accent); }
.toast.error .toast-action { color: inherit; text-decoration: underline; }
.toast-action:hover { background: rgb(127 127 127 / .2); }
.toast-close { font-size: 20px; line-height: 1; padding: 0 6px; opacity: .7; }
@keyframes toast-in { from { opacity: 0; transform: translateY(10px); } }
/* --- Flammen: Knopf an Aufgaben, Leiste oben --- */
.flame-form { margin: 0; flex: none; display: flex; }
.flame-btn { width: 30px; height: 26px; display: grid; place-items: center; padding: 0; cursor: pointer; border: 0;
  border-radius: var(--r-sm); background: none; color: var(--muted); }
.flame-btn svg { width: 15px; height: 15px; fill: currentColor; }
.flame-btn:hover { background: var(--accent-soft); color: var(--accent); }
.flame-btn.running { color: var(--accent); }
.flame-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.burning { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; padding: 10px 14px 10px 12px;
  border-radius: var(--r-lg); background: var(--accent); color: #fff; box-shadow: 0 4px 16px rgb(194 65 12 / .25); }
.burning a { color: inherit; text-decoration-color: rgb(255 255 255 / .5); }
.burning .ember svg { width: 20px; height: 20px; fill: currentColor; display: block; animation: flicker 1.6s ease-in-out infinite; }
.burning-text { flex: 1; min-width: 0; font-weight: 600; overflow-wrap: anywhere; }
.burning .timer { font-variant-numeric: tabular-nums; font-weight: 700; font-size: 17px; }
.burning form { margin: 0; }
.burning .chip.stop { background: rgb(255 255 255 / .18); color: #fff; border-color: rgb(255 255 255 / .45); display: inline-flex; align-items: center; gap: 6px; font-weight: 600; }
.burning .chip.stop svg { width: 12px; height: 12px; fill: currentColor; }
.burning .chip.stop:hover { background: rgb(255 255 255 / .3); }
@keyframes flicker { 50% { transform: scale(1.12) rotate(-4deg); opacity: .85; } }
@media (prefers-color-scheme: dark) { .burning { color: #1b1009; } .burning .chip.stop { color: #1b1009; border-color: rgb(0 0 0 / .3); background: rgb(0 0 0 / .1); } }

/* --- Feuer-Ziel bearbeiten --- */
.inline-edit { margin: -4px 0 10px; }
.inline-edit > summary { list-style: none; display: inline-flex; gap: 4px; align-items: center; cursor: pointer; font-size: 13px;
  color: var(--muted); border-radius: var(--r-sm); padding: 2px 6px; margin-left: -6px; }
.inline-edit > summary::-webkit-details-marker { display: none; }
.inline-edit > summary:hover, .inline-edit[open] > summary { color: var(--accent); background: var(--surface); }
.inline-edit form { margin: 6px 0 0; }
.inline-edit textarea { width: 100%; font: inherit; font-size: 16px; line-height: 1.45; color: var(--text); background: var(--surface);
  border: 1px solid var(--accent); border-radius: var(--r-md); padding: 8px 10px; resize: vertical; }
.inline-edit p { margin: 6px 0 0; }
.feuer-create { margin: 8px 0 0; }
.feuer-create label { display: block; margin: 8px 0 0; font-size: 13px; color: var(--muted); }
.feuer-create textarea { margin-top: 4px; }
.feuer-create .hint { color: var(--muted); }

/* --- Menü an Aufgaben: Bausteine .menu, .chip --- */
.task { position: relative; }
.task .body { flex: 1; }
.menu { flex: none; }
.menu-button { list-style: none; cursor: pointer; display: grid; place-items: center; width: 30px; height: 26px;
  border-radius: var(--r-sm); color: var(--muted); font-size: 18px; line-height: 1; user-select: none; }
.menu-button::-webkit-details-marker { display: none; }
.menu-button:hover, .menu[open] > .menu-button { background: var(--line); color: var(--text); }
.menu-button:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.menu-panel { position: absolute; right: 0; top: calc(100% - 2px); z-index: 6; width: min(310px, calc(100vw - 32px));
  display: grid; gap: 12px; padding: 12px 14px; background: var(--surface); border: 1px solid var(--line);
  border-radius: var(--r-lg); box-shadow: var(--shadow-pop); animation: pop-in .14s ease-out; }
.menu-panel form { margin: 0; }
.menu-title { display: none; margin: 0; font-weight: 600; overflow-wrap: anywhere; }
.menu-label { margin: 0 0 6px; font-size: 12px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; }
.menu-label .hint { text-transform: none; letter-spacing: 0; font-weight: 400; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; }
.chip { font: inherit; font-size: 13px; color: var(--text); background: var(--bg); border: 1px solid var(--line);
  border-radius: 999px; padding: 4px 12px; min-height: 32px; cursor: pointer; transition: border-color .15s, background .15s; }
.chip:hover { border-color: var(--accent); }
.chip:active { transform: scale(.97); }
.chip[aria-current=true] { background: var(--accent-soft); border-color: var(--accent); color: var(--accent); cursor: default; }
.chip.quiet { color: var(--muted); }
.chip.danger { color: var(--warn); }
.menu-panel form { display: flex; flex-direction: column; }
.date-row { order: 2; display: flex; gap: 6px; margin-top: 8px; align-items: center; }
.date-row label, .assign-row label { flex: 1; display: flex; min-width: 0; }
.assign-row { display: flex; gap: 6px; align-items: center; }
.assign-row select { flex: 1; min-width: 0; font: inherit; font-size: 14px; color: var(--text); background: var(--bg);
  border: 1px solid var(--line); border-radius: var(--r-sm); padding: 4px 8px; min-height: 32px; }
.date-row input { flex: 1; min-width: 0; font: inherit; font-size: 14px; color: var(--text); background: var(--bg);
  border: 1px solid var(--line); border-radius: var(--r-sm); padding: 4px 8px; min-height: 32px; }
form.act.busy { opacity: .6; pointer-events: none; }
@keyframes pop-in { from { opacity: 0; transform: translateY(-4px); } }
@keyframes sheet-in { from { opacity: 0; transform: translateY(16px); } }
main.refreshing { transition: opacity .2s; }
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation: none !important; transition: none !important; }
}
@media (max-width: 600px) {
  .menu-panel { position: fixed; left: 8px; right: 8px; top: auto; bottom: max(8px, env(safe-area-inset-bottom)); width: auto;
    z-index: 20; padding: 16px; animation-name: sheet-in; }
  .menu-title { display: block; }
  /* Abdunkeln dahinter; ein Tipp darauf trifft die Zusammenfassung und schließt, auch ohne JavaScript. */
  .menu[open] > .menu-button::before { content: ''; position: fixed; inset: 0; z-index: 19; background: rgb(0 0 0 / .35); cursor: default; }
  .chip { min-height: 40px; padding: 6px 14px; font-size: 15px; }
  .date-row input, .assign-row select { min-height: 40px; font-size: 16px; }
  .menu-button { width: 36px; height: 32px; }
  .capture button.primary { padding: 8px 12px; }
  .capture-key { display: none; }
  .check { --size: 24px; }
  .task { padding: 8px 0; gap: 10px; }
}
@media (max-width: 900px) {
  .feuer, .columns { grid-template-columns: 1fr; }
  .week { grid-template-columns: 1fr; }
  .day { min-height: 0; }
}
`;
