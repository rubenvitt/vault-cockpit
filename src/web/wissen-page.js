import { esc } from './render.js';
import { head, appHeader } from './layout.js';
import { readingNav } from '../lesen/pages.js';
import { SYNTHESIS, fmValue, synthesisChips } from './synthesis-render.js';

const RECENT = 20;
const noteHref = (path) => `/notiz?pfad=${encodeURIComponent(path)}`;

/**
 * Daten für `/wissen`: alle Synthesen, die das Cockpit zeigen darf
 * (`notes.ofType`, dieselbe Grenze wie `/notiz`), gefiltert nach `art`
 * (Querverbindung) und `status` (Entwurf). Mit Frage `q` kommen die Treffer
 * der Hybrid-Suche mit Typfilter `synthesis` in deren Reihenfolge dazu; die
 * Suche bekommt nur die Pfade, die die Filter erfüllen, sonst fielen passende
 * Synthesen hinter der Trefferbegrenzung weg.
 * „Zuletzt bewegt“ sortiert nach `updated`, Notizen ohne Datum zuletzt.
 * `lesen` („Passt zu meinem Lesen“) behält nur die Synthesen unter den
 * zuletzt bewegten `RECENT`, zu denen `evidence` neue passende Markierungen kennt.
 */
export async function wissenView({ notes, search = null, evidence = null }, { q = '', art = '', status = '', lesen = false } = {}) {
  const all = notes.ofType(SYNTHESIS).map((r) => ({
    path: r.path,
    title: r.title ?? r.path.split('/').pop().replace(/\.md$/i, ''),
    art: fmValue(r.frontmatter.art),
    status: fmValue(r.frontmatter.status),
    confidence: fmValue(r.frontmatter.confidence),
    summary: fmValue(r.frontmatter.summary),
    updated: r.updated ?? null,
  }));
  const choices = (k) => [...new Set(all.map((n) => n[k]).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'de'));
  const byUpdated = (a, b) => (b.updated ?? '').localeCompare(a.updated ?? '');
  const fits = lesen && evidence ? await evidence.matching([...all].sort(byUpdated).slice(0, RECENT).map((n) => n.path)) : null;
  const keep = (n) => (!art || n.art === art) && (!status || n.status === status) && (!fits || fits.has(n.path));
  let hits = null;
  let degraded = null;
  if (q && search) {
    const byPath = new Map(all.map((n) => [n.path, n]));
    const r = await search(q, { type: SYNTHESIS, paths: all.filter(keep).map((n) => n.path) });
    hits = r.results.map((h) => byPath.get(h.path)).filter((n) => n && keep(n));
    degraded = r.degraded ?? null;
  }
  const recent = all.filter(keep).sort(byUpdated).slice(0, RECENT);
  return { q, art, status, lesen: Boolean(fits), reading: Boolean(evidence), arts: choices('art'), statuses: choices('status'), hits, recent, degraded, total: all.length };
}

const select = (name, label, value, options) =>
  `<label><span class="hint">${label}</span><select name="${name}"><option value="">alle</option>${options.map((o) => `<option${o === value ? ' selected' : ''}>${esc(o)}</option>`).join('')}</select></label>`;

const item = (n) => `<li><a href="${esc(noteHref(n.path))}">${esc(n.title)}</a>${n.updated ? ` <span class="meta">${esc(n.updated)}</span>` : ''}
    ${synthesisChips(n)}${n.summary ? `<p class="snippet">${esc(n.summary)}</p>` : ''}</li>`;

/** Seite `/wissen`: Fragesuche über die Synthesen, ohne JavaScript über ein GET-Formular. */
export function renderWissen(m, { user = null, nav = null } = {}) {
  const list = (items, empty) => (items.length ? `<ul class="results">${items.map(item).join('')}</ul>` : `<p class="empty">${empty}</p>`);
  const hits = m.hits ? `<section><h2>Treffer</h2>${list(m.hits, `Keine Synthese passt zu „${esc(m.q)}“.`)}</section>` : '';
  return `<!doctype html>
<html lang="de">
${head(m.q ? `Wissen: ${m.q}` : 'Wissen')}
<body class="page-wissen">
${appHeader({ current: 'lesen', user })}
${readingNav('wissen', nav)}
<div class="page-head">
  <div><h1>Wissen</h1><p class="meta">${m.total} Synthesen · <a href="${esc(`/graph${m.q ? `?q=${encodeURIComponent(m.q)}` : ''}`)}">Ganzen Vault durchsuchen</a></p></div>
  <form method="get" action="/wissen" class="wissen-form" role="search">
    <input type="search" name="q" value="${esc(m.q)}" placeholder="Frage an die Synthesen" aria-label="Frage an die Synthesen" enterkeyhint="search" autocomplete="off">
    ${select('art', 'Querverbindung', m.art, m.arts)}
    ${select('status', 'Status', m.status, m.statuses)}
    ${m.reading ? `<label class="wissen-check"><input type="checkbox" name="lesen" value="1"${m.lesen ? ' checked' : ''}> Passt zu meinem Lesen</label>` : ''}
    <button type="submit" class="btn">Suchen</button>
  </form>
</div>
<main>
${m.degraded ? `<p class="problem">${esc(m.degraded)}</p>` : ''}
${hits}
<section><h2>Zuletzt bewegt</h2>${list(m.recent, m.total ? 'Keine Synthese passt zu den Filtern.' : 'Noch keine Synthesen (Frontmatter <code>type: synthesis</code>).')}</section>
</main>
</body>
</html>`;
}

/** Filter aus `?q=…&art=…&status=…&lesen=1`, gleich für `/wissen` und `/api/wissen`. */
export function wissenQuery(url) {
  const p = (k) => (url.searchParams.get(k) ?? '').trim().slice(0, 500);
  return { q: p('q'), art: p('art'), status: p('status'), lesen: p('lesen') === '1' };
}

/** `/wissen?q=…&art=…&status=…&lesen=1` als fertige Seite. */
export async function wissenPage({ notes, search, evidence = null, url, user, nav = null }) {
  return renderWissen(await wissenView({ notes, search, evidence }, wissenQuery(url)), { user, nav });
}
