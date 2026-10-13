import { localTime, zonedParts } from '../cockpit/week.js';

/**
 * HTML der Wochenansicht. Serverseitig gerendert, ohne JavaScript im Browser:
 * Blättern zwischen Wochen sind Links, Abmelden ist ein Formular. Die
 * Content-Security-Policy erlaubt deshalb nur das eigene Stylesheet.
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

function dueLabel(due, tz) {
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

function taskItem(t, tz, { area = false } = {}) {
  const mark = STATUS_MARK[t.status] ?? '○';
  const meta = [t.ref, area ? t.area : t.project, dueLabel(t.due, tz)].filter(Boolean).map(esc).join(' · ');
  return `<li class="task status-${esc(t.status)}${t.overdue ? ' overdue' : ''}">
    <span class="mark" aria-label="${esc(t.status)}">${mark}</span>
    <span class="body"><a href="${esc(t.url)}">${esc(t.title)}</a>${meta ? `<span class="meta">${meta}</span>` : ''}</span>
  </li>`;
}

const problem = (s) => `<p class="problem${s.unconfigured ? ' unconfigured' : ''}">${esc(s.error)}</p>`;

function obsidianLink(path, vaultName) {
  if (!vaultName) return null;
  const file = path.replace(/\.md$/i, '');
  return `obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodeURIComponent(file)}`;
}

function feuerSection(model, tz, vaultName) {
  const f = model.feuer;
  let goal;
  if (!f.ok) goal = problem(f);
  else if (!f.data) goal = '<p class="empty">Für diese Woche gibt es keine Feuer-Notiz.</p>';
  else {
    const link = obsidianLink(f.data.path, vaultName);
    goal = `<p class="goal">${f.data.goal ? inline(f.data.goal) : '<span class="empty">Die Notiz hat keinen Abschnitt „Feuer-Ziel“.</span>'}</p>
      ${f.data.alignment ? `<p class="meta">Alignment: ${esc(f.data.alignment)}</p>` : ''}
      ${f.data.firstMove ? `<p class="first-move"><span class="label">Erster Zug</span> ${inline(f.data.firstMove)}</p>` : ''}
      <p class="meta">${link ? `<a href="${esc(link)}">${esc(f.data.title)}</a>` : esc(f.data.title)}</p>`;
  }

  const fl = model.flames;
  let flames;
  if (!fl.ok) flames = problem(fl);
  else if (!fl.data.length) flames = '<p class="empty">Keine Flammen geplant.</p>';
  else {
    flames = `<ul class="flames">${fl.data
      .map((t) => {
        const measured = t.running ? '<span class="live">läuft</span>' : t.minutes != null ? `${t.minutes} min` : '';
        return `<li class="task status-${esc(t.status)}">
          <span class="mark">${t.status === 'done' ? '✓' : '🕯️'}</span>
          <span class="body"><a href="${esc(t.url)}">${esc(t.title)}</a>
          <span class="meta">${[dueLabel(t.due, tz), measured].filter(Boolean).join(' · ')}</span></span>
        </li>`;
      })
      .join('')}</ul>`;
  }

  return `<section class="feuer">
    <div><h2>Feuer-Ziel</h2>${goal}</div>
    <div><h2>Flammen</h2>${flames}</div>
  </section>`;
}

function rocksSection(model, tz) {
  const r = model.rocks;
  let body;
  if (!r.ok) body = problem(r);
  else if (!r.data.length) body = '<p class="empty">Diese Woche ist nichts fällig und kein Phönix-Schritt markiert.</p>';
  else {
    body = `<div class="rocks">${r.data
      .map(
        (g) => `<article class="rock">
          <h3>${esc(g.area)} <span class="count">${g.done}/${g.tasks.length}</span></h3>
          <ul>${g.tasks.map((t) => taskItem(t, tz)).join('')}</ul>
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
  return `<section><h2>Termine</h2><div class="week">${days}</div></section>`;
}

function tasksSection(model, tz) {
  const t = model.tasks;
  let body;
  if (!t.ok) body = problem(t);
  else if (!t.data.length) body = '<p class="empty">Nichts in Arbeit, nichts überfällig.</p>';
  else body = `<ul>${t.data.map((x) => taskItem(x, tz, { area: true })).join('')}</ul>`;
  return `<section><h2>Aufgaben <span class="hint">in Arbeit und überfällig</span></h2>${body}</section>`;
}

function inboxSection(model, tz, vaultName) {
  const { vault, zunder, folder } = model.inbox;
  let notes;
  if (!vault.ok) notes = problem(vault);
  else if (!vault.data.length) notes = '<p class="empty">Leer.</p>';
  else {
    notes = `<ul>${vault.data
      .map((n) => {
        const link = obsidianLink(n.path, vaultName);
        const title = esc(n.title ?? n.path.split('/').pop().replace(/\.md$/i, ''));
        return `<li class="note">${link ? `<a href="${esc(link)}">${title}</a>` : title}<span class="meta">${esc(n.path)}</span></li>`;
      })
      .join('')}</ul>`;
  }
  let tasks;
  if (!zunder.ok) tasks = problem(zunder);
  else if (!zunder.data.length) tasks = '<p class="empty">Leer.</p>';
  else tasks = `<ul>${zunder.data.map((x) => taskItem(x, tz)).join('')}</ul>`;
  return `<section><h2>Inbox</h2>
    <h3>Vault <span class="hint">${esc(folder)}/</span></h3>${notes}
    <h3>Zunder</h3>${tasks}
  </section>`;
}

export function renderWeek(model, { tz = 'Europe/Berlin', vaultName = null, user = null } = {}) {
  const w = model.week;
  const title = weekTitle(w);
  return `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title.short)} · Cockpit</title>
<link rel="stylesheet" href="/static/cockpit.css">
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
    <form method="post" action="/logout"><button type="submit" title="${esc(user ?? '')}">Abmelden</button></form>
  </nav>
</header>
<main>
${feuerSection(model, tz, vaultName)}
${rocksSection(model, tz)}
${calendarSection(model, tz)}
<div class="columns">
${tasksSection(model, tz)}
${inboxSection(model, tz, vaultName)}
</div>
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
code { font-size: 13px; background: var(--line); padding: 1px 4px; border-radius: 4px; }
.message { max-width: 520px; }
@media (max-width: 900px) {
  .feuer, .columns { grid-template-columns: 1fr; }
  .week { grid-template-columns: 1fr; }
  .day { min-height: 0; }
}
`;
