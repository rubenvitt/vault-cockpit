import { esc } from './render.js';

/**
 * Graph- und Suchseite des Web-Cockpits, serverseitig als SVG gerendert. Wie
 * die Wochenansicht ohne JavaScript: Knoten sind Links, Klick auf eine Notiz
 * zentriert den Graphen neu.
 *
 * Layout radial: die Notiz in der Mitte, direkte Nachbarn (Links, ähnliche
 * Notizen, Aufgaben, Termine) auf dem inneren Ring, nach Art gruppiert, die
 * zweite Link-Ebene auf dem äußeren Ring.
 */

const W = 1000;
const H = 760;
const CX = W / 2;
const CY = H / 2;
const KIND_ORDER = { note: 0, task: 2, event: 3 };
const STATUS_MARK = { done: '✓', in_progress: '◐', blocked: '⏸', review: '◑', dropped: '✕' };

const short = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const graphHref = (path) => `/graph?pfad=${encodeURIComponent(path)}`;

function obsidianLink(path, vaultName) {
  if (!vaultName) return null;
  return `obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodeURIComponent(path.replace(/\.md$/i, ''))}`;
}

/** Positionen der Knoten: Mitte, innerer und äußerer Ring. */
export function layout(graph) {
  const pos = new Map();
  pos.set(graph.center, { x: CX, y: CY });
  const semantic = new Set(graph.edges.filter((e) => e.kind === 'semantic').flatMap((e) => [e.from, e.to]));
  const rank = (n) => (n.kind === 'note' ? (semantic.has(n.id) && !graph.edges.some((e) => e.kind === 'link' && (e.from === n.id || e.to === n.id) && (e.from === graph.center || e.to === graph.center)) ? 1 : 0) : KIND_ORDER[n.kind] ?? 4);

  const inner = graph.nodes.filter((n) => n.id !== graph.center && n.level <= 1).sort((a, b) => rank(a) - rank(b) || String(a.label).localeCompare(String(b.label), 'de'));
  inner.forEach((n, i) => {
    const a = (i / Math.max(inner.length, 1)) * 2 * Math.PI - Math.PI / 2;
    pos.set(n.id, { x: CX + Math.cos(a) * 300, y: CY + Math.sin(a) * 235, a });
  });

  // Äußerer Ring: nach dem Winkel des ersten Nachbarn auf dem inneren Ring sortiert,
  // damit Kinder in der Nähe ihrer Eltern landen.
  const outer = graph.nodes.filter((n) => n.level >= 2);
  const parentAngle = (n) => {
    for (const e of graph.edges) {
      const other = e.from === n.id ? e.to : e.to === n.id ? e.from : null;
      if (other && pos.get(other)?.a !== undefined) return pos.get(other).a;
    }
    return 0;
  };
  outer
    .map((n) => ({ n, a: parentAngle(n) }))
    .sort((x, y) => x.a - y.a)
    .forEach(({ n }, i) => {
      const a = (i / Math.max(outer.length, 1)) * 2 * Math.PI - Math.PI / 2;
      pos.set(n.id, { x: CX + Math.cos(a) * 470, y: CY + Math.sin(a) * 355, a });
    });
  return pos;
}

function svg(graph) {
  const pos = layout(graph);
  const lines = graph.edges
    .filter((e) => pos.has(e.from) && pos.has(e.to))
    .map((e) => {
      const a = pos.get(e.from);
      const b = pos.get(e.to);
      const title = e.kind === 'semantic' ? `<title>ähnlich, ${Math.round((e.score ?? 0) * 100)} %</title>` : '';
      return `<line class="edge ${esc(e.kind)}" x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}" x2="${b.x.toFixed(1)}" y2="${b.y.toFixed(1)}">${title}</line>`;
    })
    .join('');

  const nodes = graph.nodes
    .filter((n) => pos.has(n.id))
    .map((n) => {
      const p = pos.get(n.id);
      const center = n.id === graph.center;
      const r = center ? 14 : n.level >= 2 ? 5 : 9;
      const mark = n.kind === 'task' ? `${STATUS_MARK[n.status] ?? '○'} ` : n.kind === 'event' ? '◷ ' : '';
      const label = mark + (n.kind === 'task' && n.ref ? `${n.ref} ` : '') + String(n.label ?? '');
      const showLabel = n.level <= 1;
      const anchor = center ? 'middle' : p.x < CX - 10 ? 'end' : p.x > CX + 10 ? 'start' : 'middle';
      const dx = center ? 0 : anchor === 'end' ? -(r + 5) : anchor === 'start' ? r + 5 : 0;
      const dy = center ? -(r + 8) : anchor === 'middle' ? (p.y < CY ? -(r + 6) : r + 14) : 4;
      const text = showLabel ? `<text x="${(p.x + dx).toFixed(1)}" y="${(p.y + dy).toFixed(1)}" text-anchor="${anchor}">${esc(short(label, center ? 60 : 30))}</text>` : '';
      const shape = n.kind === 'note' ? `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${r}"/>` : `<rect x="${(p.x - r).toFixed(1)}" y="${(p.y - r).toFixed(1)}" width="${2 * r}" height="${2 * r}" rx="${n.kind === 'event' ? r : 2}"/>`;
      const body = `<title>${esc(label)}${n.path ? ` — ${esc(n.path)}` : ''}</title>${shape}${text}`;
      const cls = `node ${n.kind}${center ? ' center' : ''}${n.status ? ` status-${esc(n.status)}` : ''}${n.sensitivity ? ' sensitive' : ''}`;
      const href = n.kind === 'note' && !center ? graphHref(n.path) : n.kind === 'task' ? n.url : null;
      return href ? `<a href="${esc(href)}" class="${cls}">${body}</a>` : `<g class="${cls}">${body}</g>`;
    })
    .join('');

  return `<svg class="graph" viewBox="0 0 ${W} ${H}" role="img" aria-label="Graph um ${esc(graph.nodes.find((n) => n.id === graph.center)?.label ?? '')}">${lines}${nodes}</svg>`;
}

function lists(graph, tz) {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const c = graph.center;
  const neighbour = (e) => byId.get(e.from === c ? e.to : e.from);
  const touching = (kind) => graph.edges.filter((e) => e.kind === kind && (e.from === c || e.to === c));

  const outgoing = touching('link').filter((e) => e.from === c).map(neighbour);
  const incoming = touching('link').filter((e) => e.to === c).map(neighbour);
  const similar = touching('semantic').map((e) => ({ n: neighbour(e), score: e.score }));
  const tasks = graph.edges.filter((e) => e.kind === 'task').map((e) => ({ n: byId.get(e.to), from: byId.get(e.from) }));
  const events = touching('event').map(neighbour).sort((a, b) => a.start.localeCompare(b.start));

  const noteLi = (n, extra = '') => `<li><a href="${esc(graphHref(n.path))}">${esc(n.label)}</a>${extra}<span class="meta">${esc(n.path)}</span></li>`;
  const block = (title, items, empty) => `<div><h3>${title}</h3>${items.length ? `<ul>${items.join('')}</ul>` : `<p class="empty">${empty}</p>`}</div>`;
  const time = (iso) => new Date(iso).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', timeZone: tz });

  return `<section class="graph-lists">
    ${block('Verlinkt von hier', outgoing.map((n) => noteLi(n)), 'Keine ausgehenden Links.')}
    ${block('Verweist hierher', incoming.map((n) => noteLi(n)), 'Keine Backlinks.')}
    ${block('Ähnlich, nicht verlinkt', similar.map(({ n, score }) => noteLi(n, ` <span class="score">${Math.round(score * 100)} %</span>`)), 'Keine Vorschläge.')}
    ${block('Aufgaben', tasks.map(({ n, from }) => `<li class="task status-${esc(n.status ?? 'open')}"><span class="mark">${STATUS_MARK[n.status] ?? '○'}</span><span class="body"><a href="${esc(n.url)}">${esc(n.label)}</a><span class="meta">${[n.ref, from.id === c ? null : `aus ${from.label}`].filter(Boolean).map(esc).join(' · ')}</span></span></li>`), 'Keine Zunder-Links.')}
    ${events.length ? block('Termine', events.map((e) => `<li class="event${e.allDay ? ' all-day' : ''}">${e.allDay ? '' : `<span class="time">${time(e.start)}</span>`}<span class="title">${esc(e.label)}</span></li>`), '') : ''}
  </section>`;
}

function page({ title, query = '', body, user }) {
  return `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · Cockpit</title>
<link rel="stylesheet" href="/static/cockpit.css">
</head>
<body>
<header>
  <div><h1>${esc(title)}</h1></div>
  <nav>
    <a href="/">Woche</a>
    <form method="get" action="/graph" class="search"><input type="search" name="q" value="${esc(query)}" placeholder="Vault durchsuchen" aria-label="Vault durchsuchen"><button type="submit">Suchen</button></form>
    <form method="post" action="/logout"><button type="submit" title="${esc(user ?? '')}">Abmelden</button></form>
  </nav>
</header>
<main>
${body}
</main>
</body>
</html>`;
}

export function renderGraph(graph, { vaultName = null, user = null, tz = 'Europe/Berlin' } = {}) {
  const center = graph.nodes.find((n) => n.id === graph.center);
  const link = obsidianLink(center.path, vaultName);
  const problems = graph.problems.length ? graph.problems.map((p) => `<p class="problem">${esc(p)}</p>`).join('') : '';
  return page({
    title: center.label,
    user,
    body: `<section>
      <p class="meta">${esc(center.path)}${link ? ` · <a href="${esc(link)}">In Obsidian öffnen</a>` : ''}</p>
      ${svg(graph)}
      <p class="legend"><span class="key link">Link</span><span class="key semantic">ähnlich, nicht verlinkt</span><span class="key task">Aufgabe</span><span class="key event">Termin</span></p>
      ${problems}
    </section>
    ${lists(graph, tz)}`,
  });
}

const STREAM_LABEL = { text: 'Volltext', semantic: 'Bedeutung', graph: 'Graph' };

export function renderSearch(query, result, { user = null } = {}) {
  let body;
  if (!query) body = '<section><p class="empty">Suchbegriff oder Frage eingeben. Ein Treffer öffnet seinen Graphen.</p></section>';
  else if (!result.results.length) body = `<section><p class="empty">Nichts gefunden für „${esc(query)}“.</p></section>`;
  else {
    body = `<section><h2>${result.total} Treffer</h2><ul class="results">${result.results
      .map(
        (r) => `<li><a href="${esc(graphHref(r.path))}">${esc(r.title ?? r.path)}</a>
          <span class="meta">${esc(r.path)} · ${r.streams.map((s) => STREAM_LABEL[s] ?? s).join(' + ')}</span>
          ${r.snippet ? `<p class="snippet">${esc(r.snippet)}</p>` : ''}</li>`,
      )
      .join('')}</ul></section>`;
  }
  if (result?.degraded) body = `<p class="problem">${esc(result.degraded)}</p>${body}`;
  return page({ title: query ? `Suche: ${query}` : 'Suche', query, body, user });
}

export const GRAPH_CSS = `
.graph { width: 100%; height: auto; display: block; }
.graph .edge { stroke: var(--line); stroke-width: 1.4; }
.graph .edge.link { stroke: var(--muted); stroke-opacity: .55; }
.graph .edge.semantic { stroke: var(--accent); stroke-dasharray: 5 5; stroke-opacity: .8; }
.graph .edge.task { stroke: var(--ok); stroke-opacity: .7; }
.graph .edge.event { stroke: var(--warn); stroke-opacity: .7; }
.graph .node circle, .graph .node rect { fill: var(--surface); stroke: var(--muted); stroke-width: 1.5; }
.graph .node.center circle { fill: var(--accent); stroke: var(--accent); }
.graph .node.task rect { stroke: var(--ok); }
.graph .node.task.status-done rect { fill: var(--ok); }
.graph .node.event rect { stroke: var(--warn); }
.graph .node.sensitive circle { stroke-dasharray: 2 2; }
.graph a.node:hover circle, .graph a.node:hover rect { stroke: var(--accent); stroke-width: 2.5; }
.graph text { fill: var(--text); font-size: 13px; paint-order: stroke; stroke: var(--surface); stroke-width: 3px; }
.graph .node.center text { font-weight: 600; font-size: 15px; }
.legend { display: flex; flex-wrap: wrap; gap: 16px; color: var(--muted); font-size: 13px; margin: 8px 0 0; }
.legend .key::before { content: ""; display: inline-block; width: 22px; margin-right: 6px; vertical-align: middle; border-top: 2px solid var(--muted); }
.legend .key.semantic::before { border-top: 2px dashed var(--accent); }
.legend .key.task::before { border-color: var(--ok); }
.legend .key.event::before { border-color: var(--warn); }
.graph-lists { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 8px 24px; }
.graph-lists h3 { margin-top: 0; }
.graph-lists li { padding: 3px 0; }
.score { color: var(--accent); font-size: 13px; }
.results li { padding: 8px 0; border-top: 1px solid var(--line); }
.results li:first-child { border-top: 0; }
.snippet { margin: 4px 0 0; color: var(--muted); font-size: 14px; }
nav .search { display: flex; gap: 6px; }
nav .search input { font: inherit; padding: 4px 8px; border: 1px solid var(--line); border-radius: 6px; background: var(--bg); color: var(--text); min-width: 220px; }
nav .search button { color: var(--text); border: 1px solid var(--line); border-radius: 6px; padding: 4px 10px; }
`;
