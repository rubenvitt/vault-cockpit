import { esc, dueLabel } from './render.js';
import { head, appHeader } from './layout.js';

/** Balken als SVG (die CSP erlaubt keine Inline-Styles); `v` in Prozent. */
const bar = (v, cls = '') => `<svg class="bar ${cls}" viewBox="0 0 100 8" preserveAspectRatio="none" aria-hidden="true"><rect class="track" width="100" height="8"/><rect class="fill" width="${Math.max(0, Math.min(100, v))}" height="8"/></svg>`;

const hours = (min) => (min >= 60 ? `${Math.floor(min / 60)} h${min % 60 ? ` ${min % 60} min` : ''}` : `${min} min`);

/**
 * Wochenrückblick: oben drei Kennzahlen, darunter je Lebensbereich ein
 * Balken erledigt/geplant und die Flammen-Zeit, offen Gebliebenes zum
 * Aufklappen. Zahlen stehen immer als Text daneben; die Balken sind nur Form.
 */
export function renderReview(model, { user = null } = {}) {
  const w = model.week;
  let body;
  if (!model.ok) {
    body = `<section><p class="problem${model.unconfigured ? ' unconfigured' : ''}">${esc(model.error)}${model.unconfigured ? ' · <a href="/einstellungen">Einstellungen</a>' : ''}</p></section>`;
  } else if (!model.areas.length) {
    body = '<section><p class="empty">In dieser Woche war nichts geplant und nichts wurde erledigt.</p></section>';
  } else {
    const t = model.totals;
    const maxMin = Math.max(1, ...model.areas.map((a) => a.minutes));
    const share = t.planned ? Math.round((t.done / t.planned) * 100) : null;
    body = `<section class="stats">
      <div class="stat"><span class="stat-value">${t.done}<span class="stat-of">/${t.planned}</span></span><span class="stat-label">geplant erledigt${share != null ? ` · ${share} %` : ''}</span></div>
      <div class="stat"><span class="stat-value">${t.extra}</span><span class="stat-label">außerdem erledigt</span></div>
      <div class="stat"><span class="stat-value">${esc(hours(t.minutes))}</span><span class="stat-label">Flammen-Zeit</span></div>
    </section>
    <section>
      <h2>Je Lebensbereich</h2>
      <div class="review-head" aria-hidden="true"><span></span><span>erledigt / geplant</span><span>Flammen-Zeit</span></div>
      <ul class="review">${model.areas
        .map((a) => {
          const pct = a.planned ? Math.round((a.done / a.planned) * 100) : 0;
          const flame = Math.round((a.minutes / maxMin) * 100);
          return `<li>
          <span class="review-area">${esc(a.area)}${a.extra ? ` <span class="hint">+${a.extra} außerdem</span>` : ''}</span>
          <span class="meter" data-label="erledigt" title="${a.done} von ${a.planned} geplanten erledigt">${bar(pct, a.planned && a.done === a.planned ? 'full' : '')}<span class="meter-text">${a.planned ? `${a.done}/${a.planned}` : '–'}</span></span>
          <span class="meter flame" data-label="Flammen" title="${esc(hours(a.minutes))} Flammen-Zeit">${bar(flame)}<span class="meter-text">${a.minutes ? esc(hours(a.minutes)) : '–'}</span></span>
          ${a.open.length ? `<details class="review-open"><summary>${a.open.length} offen geblieben</summary><ul>${a.open
            .map((x) => `<li><a href="${esc(x.url)}">${esc(x.title)}</a>${x.due ? ` <span class="meta">${esc(dueLabel(x.due, model.tz))}</span>` : ''}</li>`)
            .join('')}</ul></details>` : ''}
        </li>`;
        })
        .join('')}</ul>
    </section>
    ${model.flames.length ? `<section><h2>Flammen</h2><ul class="review-flames">${model.flames
      .map((f) => `<li><a href="${esc(f.url)}">${esc(f.title)}</a><span class="meta">${esc(f.area)} · ${esc(hours(f.minutes))}</span></li>`)
      .join('')}</ul></section>` : ''}`;
  }
  return `<!doctype html>
<html lang="de">
${head(`Rückblick KW ${w.week}`)}
<body class="page-review">
${appHeader({ current: 'rueckblick', user, links: { woche: `/?woche=${w.id}`, rueckblick: `/rueckblick?woche=${w.id}` } })}
<div class="page-head">
  <h1>Rückblick KW ${w.week} <span class="range">${esc(w.monday.split('-').reverse().join('.'))} – ${esc(w.sunday.split('-').reverse().join('.'))}</span></h1>
  <nav class="pager" aria-label="Wochen">
    <a href="/rueckblick?woche=${esc(w.prev)}" rel="prev" class="pager-step" aria-label="Vorige Woche, KW ${Number(w.prev.slice(6))}"><span aria-hidden="true">‹</span> KW ${Number(w.prev.slice(6))}</a>
    <a href="/?woche=${esc(w.id)}" class="pager-now">Zur Woche</a>
    <a href="/rueckblick?woche=${esc(w.next)}" rel="next" class="pager-step" aria-label="Nächste Woche, KW ${Number(w.next.slice(6))}">KW ${Number(w.next.slice(6))} <span aria-hidden="true">›</span></a>
  </nav>
</div>
<main class="review-page">
${body}
</main>
</body>
</html>`;
}

export const REVIEW_CSS = `
/* --- Wochenrückblick --- */
.review-page { max-width: 960px; }
.stats { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; background: none; border: 0; padding: 0; }
.stat { background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-lg); box-shadow: var(--shadow-1); padding: 14px 18px; display: grid; gap: 2px; }
.stat-value { font-size: 30px; font-weight: 700; font-variant-numeric: tabular-nums; line-height: 1.1; }
.stat-of { font-size: 18px; color: var(--muted); font-weight: 500; }
.stat-label { color: var(--muted); font-size: 13px; }
.review-head, .review > li { display: grid; grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr) minmax(0, 1fr); gap: 6px 16px; align-items: center; }
.review-head { font-size: 12px; color: var(--muted); padding-bottom: 4px; }
.review > li { padding: 10px 0; border-top: 1px solid var(--line); }
.review-area { font-weight: 600; overflow-wrap: anywhere; }
.review-area .hint { color: var(--muted); font-size: 13px; }
.meter { display: flex; align-items: center; gap: 8px; }
.meter .bar { flex: 1; min-width: 0; height: 8px; border-radius: 4px; overflow: hidden; display: block; }
.meter .track { fill: var(--line); }
.meter .fill { fill: var(--ok); }
.meter.flame .fill { fill: var(--accent); }
.meter-text { flex: none; width: 84px; text-align: right; font-variant-numeric: tabular-nums; font-size: 14px; }
.review-open { grid-column: 1 / -1; font-size: 14px; }
.review-open summary { cursor: pointer; color: var(--muted); }
.review-open ul { margin: 6px 0 0; padding-left: 4px; display: grid; gap: 4px; }
.review-open .meta { display: inline; }
.review-flames li { display: flex; justify-content: space-between; gap: 12px; padding: 5px 0; border-top: 1px solid var(--line); }
.review-flames li:first-child { border-top: 0; }
.review-flames .meta { display: inline; text-align: right; }
@media (max-width: 600px) {
  .stats { gap: 8px; }
  .stat { padding: 10px 12px; }
  .stat-value { font-size: 22px; }
  .stat-of { font-size: 15px; }
  .stat-label { font-size: 12px; line-height: 1.3; }
  .review-head { display: none; }
  .review > li { grid-template-columns: 1fr; }
  /* Ohne Spaltenköpfe sagt jede Zeile selbst, was sie misst. */
  .meter::before { content: attr(data-label); flex: none; width: 64px; font-size: 12px; color: var(--muted); }
  .meter-text { width: 72px; }
}
`;
