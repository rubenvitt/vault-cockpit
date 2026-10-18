import { localTime, zonedParts } from '../cockpit/week.js';
import { DEFAULT_HIDDEN_EVENTS } from '../cockpit/settings.js';
import { esc, head, appHeader, icon } from './layout.js';

export { esc };

/**
 * HTML der Wochenansicht. Serverseitig gerendert; alles funktioniert über Links
 * und Formulare. `/static/cockpit.js` macht Abhaken und Schnelleingabe ohne
 * Seitenwechsel, die Content-Security-Policy erlaubt nur eigene Dateien.
 */

const WEEKDAY = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
const MONTHS = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];

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
      <summary aria-label="${esc(`${label} bearbeiten`)}" title="${esc(`${label} bearbeiten`)}"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10.5 2.5l3 3-8 8H2.5v-3z"/></svg></summary>
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
    const meta = [f.data.alignment ? `Alignment: ${esc(f.data.alignment)}` : '', link ? `<a href="${esc(link)}">${esc(f.data.title)}</a>` : esc(f.data.title)].filter(Boolean).join(' · ');
    // Bearbeiten sitzt als kleiner Stift rechts; aufgeklappt ersetzt das Feld den Text.
    goal = `<div class="editable">
        <p class="goal">${f.data.goal ? inline(f.data.goal) : '<span class="empty">Die Notiz hat keinen Abschnitt „Feuer-Ziel“.</span>'}</p>
        ${editable ? feuerEdit(ctx, f.data.path, 'ziel', 'Feuer-Ziel', f.data.goal) : ''}
      </div>
      ${f.data.firstMove || editable ? `<div class="editable"><p class="first-move"><span class="label">Erster Zug</span> ${f.data.firstMove ? inline(f.data.firstMove) : '<span class="empty">noch keiner</span>'}</p>
        ${editable ? feuerEdit(ctx, f.data.path, 'zug', 'Erster Zug', f.data.firstMove) : ''}</div>` : ''}
      <p class="meta feuer-meta">${meta}</p>`;
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
          <progress class="rock-progress" value="${g.done}" max="${g.tasks.length}" aria-hidden="true"></progress>
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
  // Vergangene Tage der laufenden Woche treten zurück; auf dem iPhone bleibt nur die Zahl.
  const todayAt = c.data.findIndex((d) => d.today);
  const days = c.data
    .map(
      (d, i) => `<div class="day${d.today ? ' today' : ''}${i < todayAt ? ' past' : ''}">
        <h3>${esc(d.label)}${i < todayAt && d.events.length ? ` <span class="day-count">${d.events.length} ${d.events.length === 1 ? 'Termin' : 'Termine'}</span>` : ''}</h3>
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
  const today = todayAt >= 0 ? c.data[todayAt].events.length : null;
  return `<section><h2>Termine${today != null ? ` <span class="hint">heute ${today ? `${today} ${today === 1 ? 'Termin' : 'Termine'}` : 'frei'}</span>` : ''}</h2>${failed}<div class="week">${days}</div></section>`;
}

function tasksSection(model, tz, ctx) {
  const t = model.tasks;
  let body;
  if (!t.ok) body = problem(t);
  else if (!t.data.length) body = '<p class="empty">Nichts in Arbeit, nichts überfällig.</p>';
  else body = `<ul>${t.data.map((x) => taskItem(x, tz, ctx, { area: true })).join('')}</ul>`;
  return `<section><h2>Aufgaben <span class="hint">in Arbeit und überfällig</span>${t.ok && t.data.length ? ` <span class="count-badge">${t.data.length}</span>` : ''}</h2>${body}</section>`;
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
          return `<li class="note"><a href="/notiz?pfad=${encodeURIComponent(n.path)}" title="${esc(n.path)}">${title}</a>${link ? `<a href="${esc(link)}" class="note-out" aria-label="${esc(`In Obsidian öffnen: ${n.title ?? n.path}`)}">Obsidian</a>` : ''}</li>`;
        }
        return `<li class="note">${link ? `<a href="${esc(link)}" title="${esc(n.path)}">${title}</a>` : `<span title="${esc(n.path)}">${title}</span>`}</li>`;
      }));
  }
  let tasks;
  if (!zunder.ok) tasks = problem(zunder);
  else tasks = inboxList('zunder-inbox', zunder.data.map((x) => taskItem(x, tz, { ...ctx, targets: model.inbox.targets }, { inbox: true })));
  const open = (vault.ok ? vault.data.length : 0) + (zunder.ok ? zunder.data.length : 0);
  return `<section><h2>Inbox${open ? ` <span class="count-badge" data-inbox-count>${open}</span>` : ''}</h2>
    <h3>Vault <span class="hint">${esc(folder)}/</span></h3>${notes}
    <h3>Zunder</h3>${tasks}
  </section>`;
}

/**
 * Schnelleingabe: eine Zeile, die beim Tippen wächst. `!` vorne macht eine
 * Zunder-Aufgabe daraus. Die Erfassungs-ID verhindert Doppelte beim Neusenden.
 */
function captureBar(ctx, draft, focus = false) {
  const task = String(draft ?? '').trimStart().startsWith('!');
  return `<form method="post" action="/aktion/erfassen" class="capture" data-mode="${task ? 'task' : 'note'}">
  <input type="hidden" name="csrf" value="${esc(ctx.write.csrf)}">
  <input type="hidden" name="back" value="${esc(ctx.back)}">
  <input type="hidden" name="cid" value="${esc(ctx.write.captureId)}">
  <label class="capture-field">
    <span class="sr-only">Schnelleingabe</span>
    <span class="capture-mode" aria-hidden="true"><span class="as-note">Notiz</span><span class="as-task">Aufgabe</span></span>
    <textarea name="text" rows="1" maxlength="20000" enterkeyhint="send" autocomplete="off"${focus ? ' autofocus' : ''}
      placeholder="Gedanke festhalten … mit ! vorne wird es eine Zunder-Aufgabe">${esc(draft ?? '')}</textarea>
    <kbd class="capture-key" title="Mit / oder n hierher springen">/</kbd>
  </label>
  <button type="submit" class="primary"><svg viewBox="0 0 24 24" class="icon send" aria-hidden="true"><path d="M12 19V5M6 11l6-6 6 6"/></svg><span class="capture-label">${task ? 'Aufgabe anlegen' : 'Notiz anlegen'}</span></button>
</form>
<p class="capture-preview" data-capture-preview aria-live="polite" hidden></p>`;
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
export function renderWeek(model, { user = null, write = null, back = '/', flash = null, draft = null, focus = false } = {}) {
  const { tz, vaultName } = model;
  const w = model.week;
  const title = weekTitle(w);
  const ctx = { write, back, week: w };
  const prev = Number(w.prev.slice(6));
  const next = Number(w.next.slice(6));
  return `<!doctype html>
<html lang="de">
${head(title.short, { script: Boolean(write) })}
<body class="page-week">
${appHeader({ current: 'woche', user, links: { rueckblick: `/rueckblick?woche=${w.id}` } })}
<div class="page-head">
  <h1>${esc(title.short)} <span class="range">${esc(title.range)}</span></h1>
  <nav class="pager" aria-label="Wochen">
    <a href="/?woche=${esc(w.prev)}" rel="prev" class="pager-step" aria-label="Vorige Woche, KW ${prev}"><span aria-hidden="true">‹</span> KW ${prev}</a>
    ${w.current ? '<span class="pager-now" aria-current="date">Diese Woche</span>' : '<a href="/" class="pager-now">Diese Woche</a>'}
    <a href="/?woche=${esc(w.next)}" rel="next" class="pager-step" aria-label="Nächste Woche, KW ${next}">KW ${next} <span aria-hidden="true">›</span></a>
  </nav>
</div>
${write ? `<div class="capture-wrap">${captureBar(ctx, draft, focus)}</div>` : ''}
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

/** Kleines Schild für Zustände: `ok`, `warn`, `off` oder neutral. */
const pill = (text, tone = '') => `<span class="pill${tone ? ` ${tone}` : ''}">${text}</span>`;

const hostOf = (url) => {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
};

/**
 * Ein Kalender: kompakte Zeile (Name, Art, Erreichbarkeit), „Bearbeiten“
 * klappt die Felder auf. Benutzer und Passwort zeigt die Seite bei CalDAV
 * immer, bei iCal-Abos nur nach „Mit Anmeldung“; „Nur diese Kalender“ nur bei
 * CalDAV. Das regelt CSS (`:has`), das Formular bleibt ohne JavaScript gleich.
 */
function calendarRow(c, i, check) {
  const isNew = !c;
  const v = (k) => (c ? esc(c[k] ?? '') : '');
  const kind = c?.kind ?? 'ical';
  const status = !check
    ? ''
    : check.ok
      ? pill(`✓ ${check.count} ${check.count === 1 ? 'Termin' : 'Termine'} diese Woche`, 'ok')
      : pill(esc(check.error), 'warn');
  const summary = isNew
    ? `<summary class="cal-add"><span aria-hidden="true">＋</span> Neuer Kalender</summary>`
    : `<summary class="cal-row">
        <span class="cal-name">${esc(c.name)}</span>
        <span class="cal-meta">${esc(KIND_LABEL[c.kind] ?? c.kind)}${hostOf(c.url) ? ` · ${esc(hostOf(c.url))}` : ''}</span>
        ${status}
        <span class="cal-edit">Bearbeiten</span>
      </summary>`;
  return `<details class="cal${isNew ? ' cal-new' : ''}"${check && !check.ok ? ' data-problem' : ''}>
    ${summary}
    <div class="cal-body">
    ${isNew ? '' : `<input type="hidden" name="cal.${i}.id" value="${v('id')}">`}
    <div class="grid">
      <label>Name<input name="cal.${i}.name" value="${v('name')}" maxlength="80" placeholder="z. B. Privat"></label>
      <label>Art<select name="cal.${i}.kind" class="cal-kind">
        ${Object.entries(KIND_LABEL).map(([k, l]) => `<option value="${k}"${k === kind ? ' selected' : ''}>${l}</option>`).join('')}
      </select></label>
      <label class="wide"><span>Adresse <span class="hint only-ical">die geheime .ics-Adresse, wie Kalender-Apps sie zum Teilen anbieten</span><span class="hint only-caldav">Kalender-Home oder ein einzelner Kalender</span></span><input name="cal.${i}.url" type="text" inputmode="url" autocomplete="off"
        placeholder="${isNew ? 'https://… oder webcal://…' : `${esc(maskUrl(c.url))} (leer lassen = unverändert)`}"></label>
      <label class="checkline wide auth-toggle only-ical"><input type="checkbox" name="cal.${i}.auth" value="1"${c?.username ? ' checked' : ''}> Mit Anmeldung <span class="hint">(selten nötig)</span></label>
      <label class="auth"><span>Benutzer</span><input name="cal.${i}.username" value="${v('username')}" autocomplete="off"></label>
      <label class="auth"><span>Passwort <span class="hint only-caldav">App-Passwort</span></span><input name="cal.${i}.password" type="password" autocomplete="new-password"
        placeholder="${c?.password ? 'gesetzt (leer lassen = unverändert)' : ''}"></label>
      <label class="wide only-caldav"><span>Nur diese Kalender <span class="hint">Anzeigenamen mit Komma; leer = alle</span></span><input name="cal.${i}.filter" value="${c ? esc((c.filter ?? []).join(', ')) : ''}"></label>
    </div>
    ${isNew ? '' : `<div class="cal-actions"><button type="submit" name="cal.${i}.remove" value="1" class="btn quiet danger">Kalender entfernen</button></div>`}
    </div>
  </details>`;
}

/** Abschnitt „API-Tokens“: eigene Formulare, damit „Speichern“ oben die Tokens nie berührt. */
const SCOPE_LABEL = { search: 'Suche', capture: 'Capture' };

function tokenSection(tokens, created, tz, token) {
  const date = (iso) => new Date(iso).toLocaleDateString('de-DE', { timeZone: tz });
  const rows = tokens
    .map(
      (t) => `<li><span class="token-name">${esc(t.name)} ${pill(esc(SCOPE_LABEL[t.scope] ?? t.scope))}<span class="meta">angelegt am ${esc(date(t.createdAt))}</span></span>
    <form method="post" action="/einstellungen/tokens/widerrufen">${token}<input type="hidden" name="id" value="${esc(t.id)}"><button type="submit" class="btn quiet danger">Widerrufen</button></form></li>`,
    )
    .join('');
  return `<section id="tokens">
  <h2>API-Tokens ${pill(tokens.length ? String(tokens.length) : 'keine')}</h2>
  <p class="meta">Für Kurzbefehle, Raycast und Funke. <b>Suche</b> darf <code>GET /api/search</code> (ohne vertrauliche Ordner), <b>Capture</b> darf <code>/capture</code> und <code>/funke</code> und kann nur neue Notizen und Zunder-Aufgaben anlegen.</p>
  ${created ? `<div class="created"><p class="notice">${esc(SCOPE_LABEL[created.scope] ?? '')}-Token „${esc(created.name)}“ angelegt. Jetzt kopieren, er wird nicht noch einmal angezeigt:</p><p><code>${esc(created.token)}</code></p></div>` : ''}
  ${rows ? `<ul class="tokens">${rows}</ul>` : '<p class="empty">Noch keine Tokens.</p>'}
  <details class="cal cal-new token-add">
    <summary class="cal-add"><span aria-hidden="true">＋</span> Neuer Token</summary>
    <form method="post" action="/einstellungen/tokens" class="token-new cal-body">${token}
      <label>Name<input name="name" maxlength="80" required placeholder="z. B. Raycast"></label>
      <label>Recht<select name="scope">${Object.entries(SCOPE_LABEL).map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select></label>
      <button type="submit" class="primary">Token anlegen</button>
    </form>
  </details>
</section>`;
}

/** Abschnitt „Kurzbefehle“: die signierten iOS-Kurzbefehle zum Laden. */
function shortcutSection(shortcuts, captureEnabled) {
  const items = shortcuts
    .map((s) => `<li><a href="/kurzbefehle/${esc(s.slug)}.shortcut" download="${esc(s.file)}" class="btn">${esc(s.title)}</a> <span class="meta">${esc(s.text)}</span></li>`)
    .join('');
  return `<section id="kurzbefehle">
  <h2>Kurzbefehle</h2>
  <p class="meta">Auf dem iPhone antippen und importieren. Beim Import fragt iOS nach einem Token mit dem Recht „Capture“${captureEnabled ? '' : ' (noch keiner angelegt, siehe <a href="#tokens">API-Tokens</a>)'}.</p>
  <ul class="shortcuts">${items}</ul>
</section>`;
}

/**
 * Einstellungsseite. Passwörter, Tokens und Kalenderadressen werden nie
 * zurückgegeben: Ein leeres Feld behält den gespeicherten Wert. Links eine
 * Sprungleiste mit dem Stand jedes Abschnitts, auf dem iPhone oben als Leiste.
 */
export function renderSettings({ stored, defaults, checks = {}, notice = null, error = null, tokens = null, created = null, shortcuts = [], captureEnabled = false, tz = 'Europe/Berlin', user = null, csrf = '' }) {
  const d = defaults;
  const token = `<input type="hidden" name="csrf" value="${esc(csrf)}">`;
  const zunder = stored.zunder.url && stored.zunder.token
    ? ['eigener Zugang', 'ok']
    : d.zunderUrl && d.zunderToken
      ? [`aus der Umgebung (${esc(d.zunderUrl)})`, 'ok']
      : ['nicht eingerichtet', 'off'];
  const mail = stored.mail.token
    ? (stored.mail.senders.length || d.mailSenders.length) ? ['eigener Token', 'ok'] : ['es fehlen freigegebene Absender', 'warn']
    : d.mailToken
      ? ['Token aus der Umgebung', 'ok']
      : ['nicht eingerichtet', 'off'];
  const embed = stored.embed.url ? ['eigener Server', 'ok'] : d.embedUrl ? [`aus der Umgebung (${esc(d.embedUrl)})`, 'ok'] : ['aus, nur Volltextsuche', 'off'];
  const bridgeOn = stored.bridge.enabled ?? d.bridgeEnabled;
  const bridge = bridgeOn ? ['an', 'ok'] : ['aus', 'off'];
  const problems = stored.calendars.filter((c) => checks[c.id] && !checks[c.id].ok).length;
  const cal = !stored.calendars.length
    ? ['keine', 'off']
    : problems
      ? [`${problems} von ${stored.calendars.length} nicht erreichbar`, 'warn']
      : [`${stored.calendars.length} verbunden`, 'ok'];
  const rows = stored.calendars.map((c, i) => calendarRow(c, i, checks[c.id])).join('');
  const nav = [
    ['kalender', 'Kalender', cal],
    ['zunder', 'Zunder', zunder],
    ['bruecke', 'Zunder-Brücke', bridge],
    ['mail', 'Mail', mail],
    ['embeddings', 'Embeddings', embed],
    ['anzeige', 'Anzeige', null],
    ...(tokens ? [['tokens', 'API-Tokens', null]] : []),
    ...(shortcuts.length ? [['kurzbefehle', 'Kurzbefehle', null]] : []),
  ];
  const head2 = (title, state) => `<h2>${title}${state ? ` ${pill(state[0], state[1])}` : ''}</h2>`;
  return `<!doctype html>
<html lang="de">
${head('Einstellungen')}
<body class="page-settings">
${appHeader({ current: 'einstellungen', user })}
<div class="page-head"><h1>Einstellungen</h1></div>
<main class="settings">
<nav class="settings-nav" aria-label="Abschnitte">${nav
    .map(([id, label, state]) => `<a href="#${id}">${state ? `<span class="dot ${state[1]}" aria-hidden="true"></span>` : '<span class="dot" aria-hidden="true"></span>'}${label}</a>`)
    .join('')}</nav>
<div class="settings-body">
${notice ? `<p class="notice">${esc(notice)}</p>` : ''}
${error ? `<p class="problem">${esc(error)}</p>` : ''}
<form method="post" action="/einstellungen">${token}
<button type="submit" class="sr-only" tabindex="-1" aria-hidden="true">Speichern</button>
<input type="hidden" name="cal.auth" value="1">
<section id="kalender">
  ${head2('Kalender', cal)}
  <p class="meta">Termine aus iCal-Abos (z. B. Outlook, Google) und CalDAV (z. B. Fastmail, iCloud) erscheinen in der Woche.</p>
  <div class="cal-list">
  ${rows}
  ${calendarRow(null, stored.calendars.length)}
  </div>
  <label class="field"><span>Ausgeblendete Termine <span class="hint">Titel, durch Komma getrennt; leer = alle zeigen</span></span><input name="hiddenEvents" value="${esc((stored.hiddenEvents ?? DEFAULT_HIDDEN_EVENTS).join(', '))}"></label>
</section>
<section id="zunder">
  ${head2('Zunder', zunder)}
  <p class="meta">Eigener Zugang statt dem aus der Umgebung. Leer lassen, um den aus der Umgebung zu nutzen.</p>
  <div class="grid">
    <label>Adresse<input name="zunder.url" value="${esc(stored.zunder.url ?? '')}" placeholder="${esc(d.zunderUrl ?? 'https://zunder.example')}"></label>
    <label><span>API-Token <span class="hint">zt_…</span></span><input name="zunder.token" type="password" autocomplete="new-password"
      placeholder="${stored.zunder.token ? 'gesetzt (leer lassen = unverändert)' : ''}"></label>
  </div>
  ${stored.zunder.token ? '<label class="checkline"><input type="checkbox" name="zunder.clear" value="1"> eigenen Zugang löschen</label>' : ''}
</section>
<section id="bruecke">
  ${head2('Zunder-Brücke', bridge)}
  <p class="meta">Offene Checkboxen mit dem Tag werden Zunder-Aufgaben, Abhaken gleicht sich in beide Richtungen ab.</p>
  <div class="grid">
    <label>Brücke<select name="bridge.enabled">
      <option value=""${stored.bridge.enabled === null ? ' selected' : ''}>Standard (${d.bridgeEnabled ? 'an' : 'aus'})</option>
      <option value="an"${stored.bridge.enabled === true ? ' selected' : ''}>an</option>
      <option value="aus"${stored.bridge.enabled === false ? ' selected' : ''}>aus</option>
    </select></label>
    <label><span>Tag <span class="hint">ohne #</span></span><input name="bridge.tag" value="${esc(stored.bridge.tag ?? '')}" placeholder="${esc(d.bridgeTag)}"></label>
  </div>
</section>
<section id="mail">
  ${head2('Mail', mail)}
  <p class="meta">Holt Mails aus einem Fastmail-Ordner ab und macht Notizen daraus, mit <code>!</code> im Betreff Zunder-Aufgaben.</p>
  <div class="grid">
    <label><span>Fastmail-API-Token <span class="hint">nur Mail</span></span><input name="mail.token" type="password" autocomplete="new-password"
      placeholder="${stored.mail.token ? 'gesetzt (leer lassen = unverändert)' : ''}"></label>
    <label><span>Freigegebene Absender <span class="hint">mit Komma</span></span><input name="mail.senders" value="${esc(stored.mail.senders.join(', '))}" placeholder="${esc(d.mailSenders.join(', ') || 'r@example.dev, @example.dev')}"></label>
  </div>
  <details class="more">
    <summary>Ordner und Abstand</summary>
    <div class="grid">
      <label>Ordner zum Abholen<input name="mail.mailbox" value="${esc(stored.mail.mailbox ?? '')}" placeholder="${esc(d.mailbox)}"></label>
      <label>Ablage danach<input name="mail.doneMailbox" value="${esc(stored.mail.doneMailbox ?? '')}" placeholder="${esc(d.doneMailbox)}"></label>
      <label>Abstand in Minuten<input name="mail.pollMinutes" inputmode="numeric" value="${esc(stored.mail.pollMinutes ?? '')}" placeholder="${esc(d.mailPollMinutes)}"></label>
    </div>
  </details>
  ${stored.mail.token ? '<label class="checkline"><input type="checkbox" name="mail.clear" value="1"> eigenen Token löschen</label>' : ''}
</section>
<section id="embeddings">
  ${head2('Embeddings', embed)}
  <p class="meta">Ollama-Server für die semantische Suche und ähnliche Notizen. Fehlt das Modell, lädt das Cockpit es selbst. Ein neues Modell bettet den Vault neu ein.</p>
  <div class="grid">
    <label>Adresse<input name="embed.url" value="${esc(stored.embed.url ?? '')}" placeholder="${esc(d.embedUrl ?? 'http://ollama:11434')}"></label>
    <label>Modell<input name="embed.model" value="${esc(stored.embed.model ?? '')}" placeholder="${esc(d.embedModel)}"></label>
  </div>
</section>
<section id="anzeige">
  ${head2('Anzeige')}
  <div class="grid">
    <label>Zeitzone<input name="tz" value="${esc(stored.tz ?? '')}" placeholder="${esc(d.tz)}"></label>
    <label><span>Vault-Name in Obsidian <span class="hint">für Links</span></span><input name="vaultName" value="${esc(stored.vaultName ?? '')}" placeholder="${esc(d.vaultName ?? '')}"></label>
    <label>Inbox-Ordner im Vault<input name="inboxFolder" value="${esc(stored.inboxFolder ?? '')}" placeholder="${esc(d.inboxFolder)}"></label>
  </div>
</section>
<p class="save-bar"><span class="meta">Leere Geheimnisfelder behalten den gespeicherten Wert.</span><button type="submit" class="primary">Speichern</button></p>
</form>
${tokens ? tokenSection(tokens, created, tz, token) : ''}
${shortcuts.length ? shortcutSection(shortcuts, captureEnabled) : ''}
</div>
</main>
</body>
</html>`;
}

export function renderMessage(title, text, { link = null } = {}) {
  return `<!doctype html>
<html lang="de">
${head(title)}
<body class="page-message"><main class="message"><a href="/" class="brand" aria-label="Cockpit">${icon('flame', 'brand-mark')}<span class="brand-name">Cockpit</span></a><h1>${esc(title)}</h1><p>${esc(text)}</p>${link ? `<p><a href="${esc(link.href)}" class="btn primary">${esc(link.label)}</a></p>` : ''}</main></body>
</html>`;
}
