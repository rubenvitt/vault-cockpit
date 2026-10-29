// Ganzer Vault als Graph (`/graph/alles`, VCP-40). Knoten und Positionen kommen
// fertig von `/api/graph/alles` (ForceAtlas2 läuft auf dem Server), hier wird
// nur gezeichnet (sigma aus `/static/vendor/graph-lib.js`): Zoomen und Ziehen
// der Fläche, Beschriftungen erst beim Hineinzoomen, Suche springt zum Knoten,
// Klick zeigt eine Karte mit dem Weg zur Nachbarschaft.
(() => {
  'use strict';

  const stage = document.querySelector('.graph-stage[data-whole]');
  const lib = window.GraphLib;
  if (!stage || !lib) return;
  const probe = document.createElement('canvas');
  if (!(probe.getContext('webgl2') || probe.getContext('webgl'))) return; // Hinweis bleibt

  const { Graph, Sigma } = lib;
  const toast = (message, opts) => window.cockpit?.toast(message, opts);
  const go = (url) => (window.cockpitWechsel ? window.cockpitWechsel(url) : location.assign(url));
  const graphHref = (path) => `/graph?pfad=${encodeURIComponent(path)}`;
  const noteHref = (path) => `/notiz?pfad=${encodeURIComponent(path)}`;
  const canNotes = stage.dataset.notes === '1';
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  function el(tag, attrs = {}, ...children) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v === true ? '' : v);
    }
    e.append(...children.filter((c) => c != null));
    return e;
  }

  // --- Farben -------------------------------------------------------------------

  let colors = {};
  function readColors() {
    const css = getComputedStyle(document.documentElement);
    const v = (name) => css.getPropertyValue(name).trim();
    colors = { text: v('--text'), muted: v('--muted'), line: v('--line'), accent: v('--accent'), surface: v('--surface'), bg: v('--bg') };
  }
  readColors();
  const dark = () => matchMedia('(prefers-color-scheme: dark)').matches;

  // Gut unterscheidbar auf hellem und dunklem Grund; was nicht unter die ersten zehn kommt, ist grau.
  const PALETTE = ['#4e79a7', '#f28e2b', '#e15759', '#59a14f', '#b07aa1', '#76b7b2', '#edc948', '#ff9da7', '#9c755f', '#8cd17d'];
  const rgb = (hex) => {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex);
    if (!m) return null;
    const n = parseInt(m[1], 16);
    return [n >> 16, (n >> 8) & 255, n & 255];
  };
  /** Deckend auf den Hintergrund gemischt (halbtransparentes WebGL hellt sich sonst auf). */
  function alpha(hex, a) {
    const c = rgb(hex);
    const b = rgb(colors.surface) ?? [255, 255, 255];
    if (!c) return hex;
    return `#${c.map((v, i) => Math.round(v * a + b[i] * (1 - a)).toString(16).padStart(2, '0')).join('')}`;
  }

  // --- Zustand ------------------------------------------------------------------

  const graph = new Graph({ type: 'undirected', multi: false, allowSelfLoops: false });
  let data = null;
  let mode = 'folder'; // Färbung nach Ordner oder Typ
  let groups = []; // [{ key, label, count, color }] der aktuellen Färbung
  let groupOf = null; // Knoten → Gruppenindex
  let picked = null; // hervorgehobene Gruppe aus der Legende
  let hovered = null;
  let hoverSet = null;
  let selected = null;
  let found = null; // Treffer der Suche (Set), solange getippt wird

  /** Gruppen der Färbung, nach Größe; Ordner „“ heißt „Oberste Ebene“, ohne Typ „ohne Typ“. */
  function computeGroups() {
    const counts = new Map();
    const idx = mode === 'folder' ? 2 : 3;
    for (const n of data.nodes) counts.set(n[idx], (counts.get(n[idx]) ?? 0) + 1);
    const names = mode === 'folder' ? data.folders : data.types;
    const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    const rest = { key: 'rest', label: 'Sonstige', count: 0, color: colors.muted };
    const byKey = new Map();
    groups = [];
    for (const [key, count] of sorted) {
      const label = key === -1 ? 'ohne Typ' : names[key] || 'Oberste Ebene';
      if (key !== -1 && groups.length < PALETTE.length) {
        const g = { key, label, count, color: PALETTE[groups.length] };
        groups.push(g);
        byKey.set(key, groups.length - 1);
      } else if (key === -1) {
        byKey.set(key, -1);
      } else {
        rest.count += count;
        byKey.set(key, -2);
      }
    }
    if (counts.has(-1)) groups.push({ key: -1, label: 'ohne Typ', count: counts.get(-1), color: colors.muted });
    if (rest.count) groups.push(rest);
    const index = (key) => {
      const i = byKey.get(key);
      if (i >= 0) return i;
      return groups.findIndex((g) => g.key === (i === -1 ? -1 : 'rest'));
    };
    groupOf = new Map(data.nodes.map((n, i) => [String(i), index(n[idx])]));
    picked = null;
  }

  function paint() {
    graph.forEachNode((id) => graph.setNodeAttribute(id, 'color', groups[groupOf.get(id)]?.color ?? colors.muted));
    const edge = alpha(colors.muted, dark() ? 0.35 : 0.28);
    graph.forEachEdge((e) => graph.setEdgeAttribute(e, 'color', edge));
  }

  // --- Darstellung ----------------------------------------------------------------

  const font = getComputedStyle(document.body).fontFamily || 'system-ui, sans-serif';

  function drawLabel(ctx, d, settings) {
    if (!d.label) return;
    const size = d.forceLabel ? settings.labelSize + 1 : settings.labelSize;
    ctx.font = `${d.forceLabel ? 600 : 400} ${size}px ${settings.labelFont}`;
    const label = d.label.length > 42 ? `${d.label.slice(0, 41)}…` : d.label;
    const x = d.x + d.size + 3;
    const y = d.y + size / 3;
    ctx.lineWidth = 3;
    ctx.strokeStyle = colors.surface;
    ctx.strokeText(label, x, y);
    ctx.fillStyle = colors.text;
    ctx.fillText(label, x, y);
  }

  function drawHover(ctx, d, settings) {
    const size = settings.labelSize;
    ctx.font = `600 ${size}px ${settings.labelFont}`;
    const label = typeof d.label === 'string' ? d.label : '';
    const w = ctx.measureText(label).width;
    const pad = 6;
    const h = size + pad * 2;
    const x = d.x + d.size + 6;
    const y = d.y - h / 2;
    ctx.fillStyle = colors.surface;
    ctx.strokeStyle = colors.line;
    ctx.lineWidth = 1;
    ctx.shadowColor = 'rgba(0,0,0,.18)';
    ctx.shadowBlur = 12;
    ctx.beginPath();
    ctx.roundRect ? ctx.roundRect(x - pad, y, w + pad * 2, h, 6) : ctx.rect(x - pad, y, w + pad * 2, h);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(d.x, d.y, d.size + 3, 0, Math.PI * 2);
    ctx.strokeStyle = d.color;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = colors.text;
    ctx.fillText(label, x, d.y + size / 3);
  }

  /** Was gerade hervortritt: Hover-Nachbarschaft, sonst Auswahl, sonst Suchtreffer, sonst Gruppe. */
  function emphasis(id) {
    if (hoverSet) return hoverSet.has(id);
    if (selected) return id === selected || graph.areNeighbors(id, selected);
    if (found) return found.has(id);
    if (picked !== null) return groupOf.get(id) === picked;
    return null;
  }

  let renderer = null;
  function start() {
    stage.classList.add('interactive');
    renderer = new Sigma(graph, stage, {
      allowInvalidContainer: true,
      renderEdgeLabels: false,
      zIndex: true,
      labelFont: font,
      labelSize: 12,
      labelWeight: '400',
      labelColor: { color: colors.text },
      // Beschriftungen erst, wenn ein Knoten groß genug gezeichnet wird (Zoom), dicht genug für Übersicht.
      labelRenderedSizeThreshold: 7,
      labelDensity: 0.6,
      labelGridCellSize: 110,
      defaultDrawNodeLabel: drawLabel,
      defaultDrawNodeHover: drawHover,
      // Flüssig auch auf dem iPhone: beim Bewegen keine Kanten und Beschriftungen.
      hideEdgesOnMove: graph.size > 3000,
      hideLabelsOnMove: true,
      minCameraRatio: 0.02,
      maxCameraRatio: 3,
      stagePadding: 24,
      enableCameraRotation: false,
      nodeReducer(id, a) {
        const on = emphasis(id);
        if (on === null) return id === selected ? { ...a, highlighted: true } : a;
        // Fest beschriftet nur, was gemeint ist; Nachbarn teilen sich das Raster der übrigen Beschriftungen.
        if (on) return { ...a, zIndex: 2, forceLabel: id === selected || id === hovered || Boolean(!selected && !hoverSet && found && found.size <= 12), highlighted: id === selected };
        return { ...a, color: alpha(colors.muted, 0.2), label: '', zIndex: 0 };
      },
      edgeReducer(id, a) {
        const focus = hovered ?? selected;
        if (focus) {
          const [s, t] = graph.extremities(id);
          if (s === focus || t === focus) return { ...a, color: alpha(colors.text, 0.55), size: 1.2, zIndex: 1 };
          return { ...a, color: alpha(colors.muted, 0.08) };
        }
        if (found || picked !== null) {
          const [s, t] = graph.extremities(id);
          if (!emphasis(s) || !emphasis(t)) return { ...a, color: alpha(colors.muted, 0.08) };
        }
        return a;
      },
    });

    renderer.on('enterNode', ({ node }) => {
      hovered = node;
      hoverSet = new Set([node, ...graph.neighbors(node)]);
      stage.classList.add('over-node');
      renderer.refresh({ skipIndexation: true });
    });
    renderer.on('leaveNode', () => {
      hovered = null;
      hoverSet = null;
      stage.classList.remove('over-node');
      renderer.refresh({ skipIndexation: true });
    });
    renderer.on('clickNode', ({ node }) => select(node));
    renderer.on('doubleClickNode', ({ node, preventSigmaDefault }) => {
      preventSigmaDefault();
      go(graphHref(graph.getNodeAttribute(node, 'path')));
    });
    renderer.on('clickStage', () => select(null));
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && selected) select(null);
    });

    const camera = renderer.getCamera();
    const icon = (d) => {
      const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      s.setAttribute('viewBox', '0 0 16 16');
      s.setAttribute('aria-hidden', 'true');
      const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      p.setAttribute('d', d);
      s.append(p);
      return s;
    };
    stage.append(
      el('div', { class: 'graph-zoom' },
        el('button', { type: 'button', title: 'Vergrößern', 'aria-label': 'Vergrößern', onclick: () => camera.animatedZoom({ duration: 200 }) }, icon('M8 3v10M3 8h10')),
        el('button', { type: 'button', title: 'Verkleinern', 'aria-label': 'Verkleinern', onclick: () => camera.animatedUnzoom({ duration: 200 }) }, icon('M3 8h10')),
        el('button', { type: 'button', title: 'Alles zeigen', 'aria-label': 'Alles zeigen', onclick: () => camera.animatedReset({ duration: 300 }) }, icon('M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4'))),
      card,
    );
  }

  // --- Auswahl ------------------------------------------------------------------

  const card = el('aside', { class: 'graph-card', hidden: true, 'aria-live': 'polite' });
  const chip = (label, attrs) => el(attrs.href ? 'a' : 'button', { class: 'chip', type: attrs.href ? null : 'button', ...attrs, text: label });

  function select(node) {
    selected = node && graph.hasNode(node) ? node : null;
    renderer.refresh({ skipIndexation: true });
    if (!selected) {
      card.hidden = true;
      return;
    }
    const a = graph.getNodeAttributes(selected);
    const g = groups[groupOf.get(selected)];
    const degree = graph.degree(selected);
    card.replaceChildren(
      el('button', { type: 'button', class: 'close', 'aria-label': 'Schließen', text: '×', onclick: () => select(null) }),
      el('h3', { text: a.label }),
      el('span', { class: 'meta', text: [a.path, degree === 1 ? '1 Link' : `${degree} Links`].join(' · ') }),
      g ? el('span', { class: 'meta' }, el('span', { class: 'swatch', style: `background:${g.color}` }), g.label) : null,
      el('div', { class: 'chips' },
        chip('Nachbarschaft', { href: graphHref(a.path) }),
        canNotes ? chip('Notiz ansehen', { href: noteHref(a.path) }) : null),
    );
    card.hidden = false;
  }

  /** Kamera auf einen Knoten, nah genug, dass die Beschriftungen ringsum lesbar sind. */
  function jumpTo(node) {
    const d = renderer.getNodeDisplayData(node);
    if (!d) return;
    renderer.getCamera().animate({ x: d.x, y: d.y, ratio: 0.3 }, { duration: reducedMotion ? 0 : 450 });
    select(node);
    // Auf dem iPhone ist die Fläche höher als der sichtbare Rest unter der Suche.
    const box = stage.getBoundingClientRect();
    if (box.top < 0 || box.bottom > innerHeight) stage.scrollIntoView({ block: 'center', behavior: reducedMotion ? 'auto' : 'smooth' });
  }

  // --- Suche im Graphen ---------------------------------------------------------

  function search() {
    const form = document.querySelector('form.whole-search');
    const input = form?.querySelector('input[name=q]');
    if (!input) return;
    const box = el('div', { class: 'live-results', role: 'listbox', id: 'whole-results', hidden: true });
    form.append(box);
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-controls', 'whole-results');
    input.setAttribute('aria-expanded', 'false');
    const fold = (s) => s.toLocaleLowerCase('de').normalize('NFD').replace(/\p{Diacritic}/gu, '');
    const keys = new Map();
    graph.forEachNode((id, a) => keys.set(id, [fold(a.label), fold(a.path)]));
    /** 0: Titel beginnt mit der Eingabe, 1: Titel enthält sie, 2: alle Wörter in Titel oder Pfad, sonst -1. */
    const scoreOf = (q, words, label, path) => {
      const at = label.indexOf(q);
      if (at === 0) return 0;
      if (at > 0) return 1;
      return words.every((w) => label.includes(w) || path.includes(w)) ? 2 : -1;
    };
    let hits = [];
    let active = -1;

    const open = (on) => {
      box.hidden = !on;
      input.setAttribute('aria-expanded', String(on));
    };
    const mark = (i) => {
      const all = [...box.querySelectorAll('[role=option]')];
      active = all.length ? (i + all.length) % all.length : -1;
      all.forEach((a, j) => a.setAttribute('aria-selected', String(j === active)));
      all[active]?.scrollIntoView({ block: 'nearest' });
    };
    const pick = (id) => {
      open(false);
      found = null;
      input.blur();
      jumpTo(id);
    };

    function run() {
      const q = fold(input.value.trim());
      if (q.length < 2) {
        found = null;
        hits = [];
        open(false);
        renderer.refresh({ skipIndexation: true });
        return;
      }
      // Titel zuerst (Anfang vor Mitte), dann einzelne Wörter; Knoten mit mehr Links vorn.
      const words = q.split(/\s+/).filter(Boolean);
      const scored = [];
      for (const [id, [label, path]] of keys) {
        const score = scoreOf(q, words, label, path);
        if (score >= 0) scored.push([score, -graph.degree(id), id]);
      }
      scored.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      hits = scored.map((s) => s[2]);
      found = new Set(hits);
      box.replaceChildren();
      if (!hits.length) box.append(el('p', { class: 'empty', text: `Keine Notiz heißt so. Volltext und Bedeutung: Enter.` }));
      for (const id of hits.slice(0, 8)) {
        const a = graph.getNodeAttributes(id);
        box.append(el('a', { href: graphHref(a.path), role: 'option', 'aria-selected': 'false', onclick: (e) => { e.preventDefault(); pick(id); } },
          el('span', { class: 'title', text: a.label }),
          el('span', { class: 'meta', text: a.path })));
      }
      if (hits.length > 8) box.append(el('p', { class: 'meta all', text: `${hits.length} Notizen passen, im Graphen hervorgehoben.` }));
      active = -1;
      open(true);
      renderer.refresh({ skipIndexation: true });
    }

    input.addEventListener('input', run);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (box.hidden) return;
        e.preventDefault();
        mark(active + (e.key === 'ArrowDown' ? 1 : -1));
      } else if (e.key === 'Enter' && hits.length && (active >= 0 || hits.length === 1 || fold(graph.getNodeAttribute(hits[0], 'label')) === fold(input.value.trim()))) {
        // Eindeutig: springen. Sonst geht das Formular an die Suche (Volltext und Bedeutung).
        e.preventDefault();
        pick(hits[Math.max(active, 0)]);
      } else if (e.key === 'Escape') {
        open(false);
      }
    });
    input.addEventListener('focus', () => {
      if (box.childElementCount && input.value.trim().length >= 2) open(true);
    });
    document.addEventListener('click', (e) => {
      if (!form.contains(e.target)) open(false);
    });
    document.addEventListener('keydown', (e) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target;
      if (t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      e.preventDefault();
      input.focus();
      input.select();
    });
  }

  // --- Legende ------------------------------------------------------------------

  const legend = document.querySelector('[data-whole-legend]');
  function renderLegend() {
    if (!legend) return;
    const modeButton = (key, label) =>
      el('button', { type: 'button', class: 'chip', 'aria-pressed': String(mode === key), onclick: () => {
        if (mode === key) return;
        mode = key;
        computeGroups();
        paint();
        renderLegend();
        renderer.refresh({ skipIndexation: true });
      } }, label);
    legend.replaceChildren(
      el('span', { class: 'mode', role: 'group', 'aria-label': 'Färbung' }, el('span', { class: 'meta', text: 'Farbe nach' }), modeButton('folder', 'Ordner'), modeButton('type', 'Typ')),
      ...groups.map((g, i) => el('button', { type: 'button', class: 'key', 'aria-pressed': String(picked === i), title: `${g.label} hervorheben`, onclick: () => {
        picked = picked === i ? null : i;
        renderLegend();
        renderer.refresh({ skipIndexation: true });
      } }, el('span', { class: 'swatch', style: `background:${g.color}` }), g.label, el('span', { class: 'count meta', text: String(g.count) }))),
    );
    legend.hidden = false;
  }

  // --- Start --------------------------------------------------------------------

  const stats = document.querySelector('[data-whole-stats]');
  function load(d) {
    data = d;
    const degree = new Uint32Array(d.nodes.length);
    for (const i of d.links) degree[i] += 1;
    d.nodes.forEach(([path, label, , , x, y], i) => {
      graph.addNode(String(i), { path, label, x, y, size: Math.min(1.5 + Math.sqrt(degree[i]) * 0.9, 12) });
    });
    for (let k = 0; k + 1 < d.links.length; k += 2) {
      const a = String(d.links[k]);
      const b = String(d.links[k + 1]);
      if (a !== b && !graph.hasEdge(a, b)) graph.addEdge(a, b, { size: 0.5 });
    }
    computeGroups();
    paint();
  }

  stage.classList.add('interactive', 'loading');
  fetch(stage.dataset.whole, { credentials: 'same-origin' })
    .then((res) => {
      if (res.status === 401) throw new Error('Die Anmeldung ist abgelaufen. Bitte neu laden.');
      if (!res.ok) throw new Error('Der Graph ist gerade nicht zu haben.');
      return res.json();
    })
    .then((d) => {
      load(d);
      start();
      stage.classList.remove('loading');
      renderLegend();
      search();
      if (stats) {
        const when = d.builtAt ? new Date(d.builtAt).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : null;
        stats.textContent = [`${graph.order.toLocaleString('de-DE')} Notizen`, `${graph.size.toLocaleString('de-DE')} Links`, when ? `Stand ${when}` : null].filter(Boolean).join(' · ');
      }
      const focus = stage.dataset.focus;
      if (focus) {
        const id = graph.findNode((_, a) => a.path === focus);
        if (id) requestAnimationFrame(() => jumpTo(id));
      }
    })
    .catch((err) => {
      renderer?.kill();
      stage.classList.remove('interactive', 'loading');
      toast(err.message, { kind: 'error' });
    });

  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    readColors();
    if (!renderer) return;
    renderer.setSetting('labelColor', { color: colors.text });
    computeGroups();
    paint();
    renderLegend();
  });
})();
