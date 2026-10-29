import { esc, head, appHeader } from './layout.js';
import { zonedParts, localTime } from '../cockpit/week.js';

const LABEL = { ok: 'läuft', error: 'Fehler', off: 'aus', unknown: 'unbekannt' };
const TONE = { ok: 'ok', error: 'err', off: 'off', unknown: '' };

const pill = (state) => `<span class="pill${TONE[state] ? ` ${TONE[state]}` : ''}">${LABEL[state] ?? esc(state)}</span>`;
const pad = (n) => String(n).padStart(2, '0');

/** „18.10. 14:32“ in der Zeitzone des Cockpits. */
const stamp = (ms, tz) => {
  const date = new Date(ms);
  const p = zonedParts(date, tz);
  return `${pad(p.day)}.${pad(p.month)}. ${localTime(date, tz)}`;
};

/** „18.10. 14:32 · vor 5 min“ in der Zeitzone des Cockpits. */
export function when(isoTime, tz, now = Date.now()) {
  const date = new Date(isoTime ?? '');
  if (!isoTime || Number.isNaN(date.getTime())) return '–';
  const min = Math.round((now - date.getTime()) / 60_000);
  const ago =
    min < 1 ? 'gerade eben' : min < 60 ? `vor ${min} min` : min < 48 * 60 ? `vor ${Math.round(min / 60)} h` : `vor ${Math.round(min / 1440)} Tagen`;
  return `${stamp(date.getTime(), tz)} · ${ago}`;
}

const time = (isoTime, tz, now) => (isoTime ? `<time datetime="${esc(isoTime)}">${esc(when(isoTime, tz, now))}</time>` : '–');

/**
 * Hinweis in der Kopfzeile, solange ein Dienst einen Fehler meldet: roter Punkt
 * mit „Störung“, Link zur Zustandsseite. Ohne Fehler nichts.
 */
export function healthAlert(failing) {
  if (!failing?.length) return '';
  const names = failing.map((f) => f.name).join(', ');
  return `<a href="/zustand" class="health-alert" title="${esc(`Störung: ${names}`)}"><span class="dot err" aria-hidden="true"></span><span>Störung</span><span class="sr-only">: ${esc(names)}</span></a>`;
}

/** Letzter Fehler: rot, solange er gilt, sonst grau als Vergangenheit. */
function errorBox(s, tz, now) {
  if (!s.lastError && !(s.state === 'error' && s.lastErrorAt)) return '';
  const current = s.state === 'error';
  return `<div class="svc-error${current ? '' : ' past'}">
      <p class="svc-error-head">${current ? 'Fehler' : 'Letzter Fehler'} ${time(s.lastErrorAt, tz, now)}</p>
      ${s.lastError ? `<p class="svc-error-text">${esc(s.lastError)}</p>` : ''}
    </div>`;
}

function items(list, tz, now) {
  if (!list?.length) return '';
  return `<ul class="svc-items">${list
    .map((i) => {
      const meta = [i.summary ? esc(i.summary) : '', i.lastOkAt ? `zuletzt ok ${time(i.lastOkAt, tz, now)}` : ''].filter(Boolean).join(' · ');
      return `<li class="state-${esc(i.state)}">
      <p class="svc-item-head"><span class="dot ${esc(TONE[i.state] ?? '')}" aria-hidden="true"></span><span class="svc-item-name">${esc(i.name)}</span> ${pill(i.state)}</p>
      ${meta ? `<p class="meta">${meta}</p>` : ''}
      ${errorBox(i, tz, now)}
    </li>`;
    })
    .join('')}</ul>`;
}

function serviceCard(s, tz, now) {
  const facts = [
    ...(s.facts ?? []).map((f) => [f.label, 'at' in f ? time(f.at, tz, now) : esc(f.value ?? '–')]),
    ...(s.state !== 'off' && !(s.facts ?? []).some((f) => 'at' in f && f.at === s.lastOkAt) ? [['Letzter Erfolg', time(s.lastOkAt, tz, now)]] : []),
  ];
  return `<section class="svc state-${esc(s.state)}" id="dienst-${esc(s.id)}">
    <h2>${esc(s.name)} ${pill(s.state)}</h2>
    <p class="svc-summary">${esc(s.summary ?? '')}</p>
    ${facts.length ? `<dl class="facts">${facts.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}</dl>` : ''}
    ${s.items?.length ? items(s.items, tz, now) : errorBox(s, tz, now)}
    ${s.links?.length ? `<p class="meta">${s.links.map((l) => `<a href="${esc(l.href)}">${esc(l.label)}</a>`).join(' · ')}</p>` : ''}
  </section>`;
}

/**
 * Seite „Zustand“: je Hintergrunddienst läuft / Fehler / aus, letzter Erfolg,
 * letzter Fehler mit (maskiertem) Text und die wichtigsten Kennzahlen. Oben
 * eine Zeile mit allen gestörten Diensten als Sprungmarken. Reines HTML, kein
 * Script; „Neu prüfen“ lädt die Seite einfach neu.
 */
export function renderHealth(services, { tz = 'Europe/Berlin', user = null, now = Date.now() } = {}) {
  const failing = services.filter((s) => s.state === 'error');
  const overview = failing.length
    ? `<p class="problem health-overview">${failing.length === 1 ? 'Ein Dienst meldet' : `${failing.length} Dienste melden`} einen Fehler: ${failing
        .map((s) => `<a href="#dienst-${esc(s.id)}">${esc(s.name)}</a>`)
        .join(', ')}</p>`
    : '<p class="notice health-overview">Alle eingerichteten Dienste laufen.</p>';
  return `<!doctype html>
<html lang="de">
${head('Zustand')}
<body class="page-health">
${appHeader({ current: 'einstellungen', user })}
<div class="page-head">
  <div>
    <h1>Zustand</h1>
    <p class="meta">Stand ${esc(stamp(now, tz))} · Zunder und Kalender werden beim Laden frisch geprüft · <a href="/einstellungen">Einstellungen</a></p>
  </div>
  <a href="/zustand" class="btn">Neu prüfen</a>
</div>
<main class="health-page">
${overview}
<div class="health-list">
${services.map((s) => serviceCard(s, tz, now)).join('\n')}
</div>
</main>
</body>
</html>`;
}

export const HEALTH_CSS = `
/* --- Zustand der Dienste --- */
.dot.err { background: var(--danger); }
.pill.err { background: var(--danger-soft); color: var(--danger); }
.health-alert { display: inline-flex; align-items: center; gap: 6px; padding: 6px 10px; border-radius: var(--r-full); font-size: 13px; font-weight: 600;
  color: var(--danger); text-decoration: none; white-space: nowrap; }
.health-alert:hover { background: var(--danger-soft); color: var(--danger); }
.page-health .page-head { max-width: 1040px; }
.health-page { max-width: 1040px; }
.health-overview { padding: var(--s-3) var(--s-4); border-radius: var(--r-md); }
.notice.health-overview { background: var(--ok-soft); }
.problem.health-overview { background: var(--danger-soft); border-left: 3px solid var(--danger); color: var(--text); font-size: inherit; }
.health-list { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 420px), 1fr)); gap: var(--s-4); align-items: start; }
.svc h2 { display: flex; align-items: center; gap: var(--s-2); }
.svc h2 .pill { margin-left: auto; }
.svc.state-error { border-color: color-mix(in srgb, var(--danger) 45%, var(--line)); }
.svc.state-off .svc-summary { color: var(--text-3); }
.svc-summary { margin: 0 0 var(--s-3); color: var(--text-2); }
.facts { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 4px 14px; margin: 0; font-size: 14px; }
.facts dt { color: var(--muted); }
.facts dd { margin: 0; overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
.svc-error { margin-top: var(--s-3); padding: var(--s-2) var(--s-3); font-size: 14px; background: var(--danger-soft); border-left: 3px solid var(--danger);
  border-radius: var(--r-xs) var(--r-sm) var(--r-sm) var(--r-xs); }
.svc-error.past { background: var(--bg-sunk); border-left-color: var(--line-strong); }
.svc-error p { margin: 0; }
.svc-error-head { font-weight: 600; }
.svc-error-text { font-family: var(--mono); font-size: 13px; white-space: pre-wrap; overflow-wrap: anywhere; margin-top: 2px !important; }
.svc-items { margin-top: var(--s-3); display: grid; gap: var(--s-3); }
.svc-items > li { border-top: 1px solid var(--line); padding-top: var(--s-3); }
.svc-items .meta { margin: 2px 0 0 16px; }
.svc-item-head { margin: 0; display: flex; align-items: center; gap: 8px; }
.svc-item-name { font-weight: 600; overflow-wrap: anywhere; }
.svc-item-head .pill { margin-left: auto; }
@media (max-width: 700px) {
  .health-alert { margin-left: auto; }
  .health-alert + .logout { margin-left: 0; }
}
`;
