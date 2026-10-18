// Interaktiver Graph und Live-Suche für `/graph`. Ohne dieses Script bleibt
// das serverseitige SVG mit Links und die Suche als Formular; mit ihm wird der
// Graph zum Zoomen, Ziehen und Aufklappen (sigma + ForceAtlas2 aus
// `/static/vendor/graph-lib.js`), und die Suche zeigt Treffer beim Tippen.
(() => {
  'use strict';

  const graphHref = (path) => `/graph?pfad=${encodeURIComponent(path)}`;
  const noteHref = (path) => `/notiz?pfad=${encodeURIComponent(path)}`;
  const toast = (message, opts) => window.cockpit?.toast(message, opts);

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

  // --- Live-Suche -----------------------------------------------------------

  function liveSearch() {
    const form = document.querySelector('form.search');
    const input = form?.querySelector('input[name=q]');
    if (!input) return;
    const box = el('div', { class: 'live-results', role: 'listbox', id: 'live-results', hidden: true });
    form.append(box);
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-controls', 'live-results');
    input.setAttribute('aria-expanded', 'false');

    let timer = null;
    let controller = null;
    let active = -1;
    let last = '';

    const items = () => [...box.querySelectorAll('a[role=option]')];
    const open = (on) => {
      box.hidden = !on;
      input.setAttribute('aria-expanded', String(on));
    };
    const mark = (i) => {
      const all = items();
      active = all.length ? (i + all.length) % all.length : -1;
      all.forEach((a, j) => a.setAttribute('aria-selected', String(j === active)));
      all[active]?.scrollIntoView({ block: 'nearest' });
    };

    async function run(q) {
      controller?.abort();
      controller = new AbortController();
      let data;
      try {
        const res = await fetch(`/api/suche?q=${encodeURIComponent(q)}`, { credentials: 'same-origin', signal: controller.signal });
        if (!res.ok) return;
        data = await res.json();
      } catch {
        return;
      }
      if (input.value.trim() !== q) return;
      box.replaceChildren();
      if (!data.results.length) {
        box.append(el('p', { class: 'empty', text: `Nichts gefunden für „${q}“.` }));
      } else {
        // Mit Notizseite öffnet ein Treffer die Notiz, der Graph steht daneben.
        const notes = form.dataset.notes === '1';
        for (const r of data.results) {
          const option = el('a', { href: notes ? noteHref(r.path) : graphHref(r.path), role: 'option', 'aria-selected': 'false' },
            el('span', { class: 'title', text: r.title }),
            el('span', { class: 'meta', text: r.path }),
            r.snippet ? el('p', { class: 'snippet meta', text: r.snippet }) : null);
          box.append(notes ? el('div', { class: 'hit' }, option, el('a', { href: graphHref(r.path), class: 'graph-link', tabindex: '-1', text: 'Graph' })) : option);
        }
        if (data.total > data.results.length) box.append(el('a', { href: `/graph?q=${encodeURIComponent(q)}`, class: 'all', text: `Alle ${data.total} Treffer zeigen` }));
      }
      if (data.degraded) box.append(el('p', { class: 'problem', text: data.degraded }));
      active = -1;
      open(true);
    }

    input.addEventListener('input', () => {
      const q = input.value.trim();
      clearTimeout(timer);
      if (q.length < 2) {
        last = '';
        controller?.abort();
        open(false);
        return;
      }
      if (q === last) return;
      timer = setTimeout(() => run((last = q)), 180);
    });
    input.addEventListener('keydown', (e) => {
      if (box.hidden) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        mark(active + (e.key === 'ArrowDown' ? 1 : -1));
      } else if (e.key === 'Enter' && active >= 0) {
        e.preventDefault();
        location.assign(items()[active].href);
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
    // `/` springt in die Suche, wenn nicht gerade getippt wird.
    document.addEventListener('keydown', (e) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target;
      if (t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      e.preventDefault();
      input.focus();
      input.select();
    });
  }

  liveSearch();

  // --- Graph ----------------------------------------------------------------

  const STATUS_MARK = { done: '✓ ', in_progress: '◐ ', blocked: '⏸ ', review: '◑ ', dropped: '✕ ' };
  function labelOf(n) {
    if (n.kind === 'task') return `${STATUS_MARK[n.status] ?? '○ '}${n.ref ? `${n.ref} ` : ''}${n.label ?? ''}`;
    if (n.kind === 'event') return `◷ ${n.label ?? ''}`;
    return String(n.label ?? n.path ?? '');
  }

  /**
   * Knotenattribute für sigma aus einem Knoten von `/api/graph`. `type` wählt
   * in sigma das Zeichenprogramm; der Frontmatter-Typ einer Notiz (etwa
   * „phönix-zyklus“) darf dort nicht landen und heißt deshalb `noteType`.
   */
  function nodeAttrs(n) {
    const { type, ...rest } = n;
    return { ...rest, noteType: type ?? null, label: labelOf(n) };
  }
  window.cockpitGraph = { nodeAttrs };

  const stage = document.querySelector('.graph-stage[data-center]');
  const lib = window.GraphLib;
  if (!stage || !lib) return;
  const probe = document.createElement('canvas');
  if (!(probe.getContext('webgl2') || probe.getContext('webgl'))) return; // SVG bleibt

  const { Graph, Sigma, forceAtlas2 } = lib;
  const centerPath = stage.dataset.center;
  const canLink = stage.dataset.notes === '1';
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Farben aus dem Stylesheet, damit hell und dunkel stimmen.
  let colors = {};
  function readColors() {
    const css = getComputedStyle(document.documentElement);
    const v = (name) => css.getPropertyValue(name).trim();
    colors = { text: v('--text'), muted: v('--muted'), line: v('--line'), accent: v('--accent'), ok: v('--ok'), warn: v('--warn'), surface: v('--surface'), bg: v('--bg') };
  }
  readColors();

  const rgb = (hex) => {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex);
    if (!m) return null;
    const n = parseInt(m[1], 16);
    return [n >> 16, (n >> 8) & 255, n & 255];
  };
  /**
   * `#rrggbb` mit Deckkraft `a`, aber deckend auf den Hintergrund gemischt:
   * Halbtransparentes WebGL hellt sich auf hellem Grund sonst sichtbar auf.
   */
  function alpha(hex, a) {
    const c = rgb(hex);
    const b = rgb(colors.surface) ?? [255, 255, 255];
    if (!c) return hex;
    return `#${c.map((v, i) => Math.round(v * a + b[i] * (1 - a)).toString(16).padStart(2, '0')).join('')}`;
  }

  const graph = new Graph({ multi: false, type: 'undirected', allowSelfLoops: false });
  const loaded = new Set(); // Notizen, deren Nachbarschaft schon geholt wurde
  const filters = { link: true, semantic: true, task: true, event: true };
  let center = `note:${centerPath}`;
  let hovered = null;
  let selected = null;
  let dragged = null;

  function nodeColor(a) {
    if (a.kind === 'task') return a.status === 'done' || a.status === 'dropped' ? colors.muted : a.status === 'blocked' ? colors.warn : colors.ok;
    if (a.kind === 'event') return colors.warn;
    if (a.id === center) return colors.accent;
    return a.onlySimilar ? alpha(colors.accent, 0.55) : colors.muted;
  }

  function edgeColor(a, strength = 0.5) {
    if (a.kind === 'semantic') return alpha(colors.accent, strength);
    if (a.kind === 'task') return alpha(colors.ok, strength);
    if (a.kind === 'event') return alpha(colors.warn, strength);
    return alpha(colors.muted, strength * 0.9);
  }

  /** Nur Notizen, die ausschließlich über „ähnlich“ hängen, zeichnen wir heller. */
  function refreshDerived() {
    graph.forEachNode((id, a) => {
      const kinds = new Set(graph.edges(id).map((e) => graph.getEdgeAttribute(e, 'kind')));
      const onlySimilar = a.kind === 'note' && id !== center && kinds.size === 1 && kinds.has('semantic');
      const degree = graph.degree(id);
      const size = id === center ? 13 : a.kind === 'note' ? Math.min(4 + Math.sqrt(degree) * 2.2, 11) : 4.5;
      graph.mergeNodeAttributes(id, { onlySimilar, size, color: nodeColor({ ...a, id, onlySimilar }), forceLabel: id === center, zIndex: id === center ? 2 : 1 });
    });
    graph.forEachEdge((e, a) => graph.setEdgeAttribute(e, 'color', edgeColor(a)));
  }

  /** Daten aus `/api/graph` einfügen; neue Knoten starten neben `near`. */
  function merge(data, near = null) {
    const origin = near && graph.hasNode(near) ? graph.getNodeAttributes(near) : { x: 0, y: 0 };
    const spread = near ? 0.6 : 1;
    let added = 0;
    for (const n of data.nodes) {
      if (graph.hasNode(n.id)) {
        // Status und Bezeichnung aus der neueren Antwort übernehmen, Lage behalten.
        graph.mergeNodeAttributes(n.id, nodeAttrs(n));
        continue;
      }
      const angle = Math.random() * Math.PI * 2;
      const r = n.id === data.center ? 0 : spread * (n.level >= 2 ? 1.6 : 1) * (0.7 + Math.random() * 0.6);
      graph.addNode(n.id, { ...nodeAttrs(n), x: origin.x + Math.cos(angle) * r, y: origin.y + Math.sin(angle) * r });
      added += 1;
    }
    for (const e of data.edges) {
      if (!graph.hasNode(e.from) || !graph.hasNode(e.to)) continue;
      const key = [e.from, e.to].sort().join('|');
      // Ein echter Link verdrängt „ähnlich“: verlinkt ist mehr als ähnlich.
      if (graph.hasEdge(key)) {
        if (e.kind === 'link' && graph.getEdgeAttribute(key, 'kind') === 'semantic') graph.mergeEdgeAttributes(key, { kind: 'link', score: null });
        continue;
      }
      graph.addEdgeWithKey(key, e.from, e.to, { kind: e.kind, score: e.score ?? null, from: e.from, size: e.kind === 'semantic' ? 1 : 1.4 });
    }
    loaded.add(data.center);
    refreshDerived();
    return added;
  }

  async function fetchGraph(path) {
    const res = await fetch(`/api/graph?pfad=${encodeURIComponent(path)}`, { credentials: 'same-origin' });
    if (res.status === 401) throw new Error('Die Anmeldung ist abgelaufen. Bitte neu laden.');
    if (!res.ok) throw new Error('Diese Notiz ist nicht im Index.');
    return res.json();
  }

  // --- Physik ---------------------------------------------------------------

  let fa2 = null;
  function layoutSettings() {
    const base = forceAtlas2.inferSettings(graph);
    return { ...base, gravity: 0.6, scalingRatio: 12, slowDown: 3 + Math.log(1 + graph.order), barnesHutOptimize: graph.order > 400, strongGravityMode: false, adjustSizes: false };
  }

  let frames = 0;
  let raf = null;
  /** Lässt die Physik eine Weile sichtbar laufen; beim Ziehen bis zum Loslassen. */
  function settle(n = 120) {
    fa2 = layoutSettings();
    frames = Math.max(frames, reducedMotion ? 0 : n);
    if (reducedMotion) {
      forceAtlas2.assign(graph, { iterations: 200, settings: fa2 });
      return;
    }
    if (raf) return;
    const step = () => {
      forceAtlas2.assign(graph, { iterations: 1, settings: fa2 });
      frames -= 1;
      raf = frames > 0 || dragged ? requestAnimationFrame(step) : null;
    };
    raf = requestAnimationFrame(step);
  }

  // --- Darstellung ------------------------------------------------------------

  const font = getComputedStyle(document.body).fontFamily || 'system-ui, sans-serif';

  /** Hover-Beschriftung im Stil der Seite statt der weißen sigma-Box. */
  function drawHover(ctx, data, settings) {
    const size = settings.labelSize;
    ctx.font = `600 ${size}px ${settings.labelFont}`;
    const label = typeof data.label === 'string' ? data.label : '';
    const w = ctx.measureText(label).width;
    const pad = 6;
    const h = size + pad * 2;
    const x = data.x + data.size + 6;
    const y = data.y - h / 2;
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
    ctx.arc(data.x, data.y, data.size + 3, 0, Math.PI * 2);
    ctx.strokeStyle = data.color;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = colors.text;
    ctx.fillText(label, x, data.y + size / 3);
  }

  function drawLabel(ctx, data, settings) {
    if (!data.label) return;
    const size = data.forceLabel ? settings.labelSize + 2 : settings.labelSize;
    ctx.font = `${data.forceLabel ? 600 : 400} ${size}px ${settings.labelFont}`;
    const label = data.label.length > 42 ? `${data.label.slice(0, 41)}…` : data.label;
    const x = data.x + data.size + 4;
    const y = data.y + size / 3;
    // Kontur in Hintergrundfarbe, damit Beschriftungen über Kanten lesbar bleiben.
    ctx.lineWidth = 3;
    ctx.strokeStyle = colors.surface;
    ctx.strokeText(label, x, y);
    ctx.fillStyle = data.dimmed ? colors.muted : colors.text;
    ctx.fillText(label, x, y);
  }

  /** Sichtbar nach Filter: Kanten nach Art, Knoten, solange sie eine sichtbare Kante haben. */
  function visibleEdge(a) {
    return filters[a.kind] !== false;
  }
  function visibleNode(id, a) {
    if (id === center) return true;
    if ((a.kind === 'task' || a.kind === 'event') && !filters[a.kind]) return false;
    return graph.edges(id).some((e) => visibleEdge(graph.getEdgeAttributes(e)));
  }

  /** Beim Hovern tritt die Nachbarschaft hervor, der Rest wird blass. */
  function focusSet() {
    const focus = hovered;
    if (!focus || !graph.hasNode(focus)) return null;
    return new Set([focus, ...graph.neighbors(focus)]);
  }

  stage.classList.add('interactive', 'loading');
  const renderer = new Sigma(graph, stage, {
    allowInvalidContainer: true,
    renderEdgeLabels: false,
    zIndex: true,
    labelFont: font,
    labelSize: 13,
    labelWeight: '400',
    labelColor: { color: colors.text },
    labelDensity: 0.9,
    labelGridCellSize: 90,
    labelRenderedSizeThreshold: 4,
    defaultDrawNodeHover: drawHover,
    defaultDrawNodeLabel: drawLabel,
    minCameraRatio: 0.08,
    maxCameraRatio: 4,
    stagePadding: 40,
    enableCameraRotation: false,
    nodeReducer(id, a) {
      const r = { ...a };
      if (!visibleNode(id, a)) return { ...r, hidden: true };
      const focus = focusSet();
      if (focus && !focus.has(id)) {
        r.color = alpha(colors.muted, 0.18);
        r.label = '';
        r.dimmed = true;
        r.zIndex = 0;
      } else if (focus) {
        r.forceLabel = true;
        r.zIndex = 2;
      }
      if (id === selected) r.highlighted = true;
      return r;
    },
    edgeReducer(id, a) {
      const r = { ...a };
      const [s, t] = graph.extremities(id);
      if (!visibleEdge(a) || !visibleNode(s, graph.getNodeAttributes(s)) || !visibleNode(t, graph.getNodeAttributes(t))) return { ...r, hidden: true };
      const focus = hovered ?? selected;
      if (focus && graph.hasNode(focus)) {
        if (s === focus || t === focus) {
          r.color = a.kind === 'link' ? alpha(colors.text, 0.6) : edgeColor(a, 0.9);
          r.size = (a.size ?? 1) + 0.8;
          r.zIndex = 1;
        } else if (hovered) {
          r.color = alpha(colors.muted, 0.08);
        }
      }
      return r;
    },
  });

  // --- Bedienung: Zoom, Ziehen, Auswahl --------------------------------------

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
      el('button', { type: 'button', title: 'Alles zeigen', 'aria-label': 'Alles zeigen', onclick: fit }, icon('M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4')),
      el('button', { type: 'button', title: 'Physik anstoßen', 'aria-label': 'Physik anstoßen', onclick: () => settle(180) }, icon('M8 2.5a5.5 5.5 0 1 0 5.2 3.7M13.5 2v4h-4'))),
  );

  function fit() {
    renderer.setCustomBBox(null);
    camera.animatedReset({ duration: 300 });
  }

  const card = el('aside', { class: 'graph-card', hidden: true, 'aria-live': 'polite' });
  stage.append(card);

  renderer.on('enterNode', ({ node }) => {
    hovered = node;
    stage.classList.add('over-node');
    renderer.refresh({ skipIndexation: true });
  });
  renderer.on('leaveNode', () => {
    hovered = null;
    stage.classList.remove('over-node');
    renderer.refresh({ skipIndexation: true });
  });

  // Ziehen: Knoten folgt dem Zeiger, die Physik läuft mit, Nachbarn ziehen nach.
  let moved = false;
  renderer.on('downNode', ({ node }) => {
    dragged = node;
    moved = false;
    graph.setNodeAttribute(node, 'fixed', true);
    stage.classList.add('dragging');
    // Ausschnitt einfrieren, sonst skaliert sigma beim Ziehen den ganzen Graphen mit.
    if (!renderer.getCustomBBox()) renderer.setCustomBBox(renderer.getBBox());
    camera.disable();
    settle(1);
  });
  const dragTo = (coords) => {
    if (!dragged) return;
    const p = renderer.viewportToGraph(coords);
    graph.mergeNodeAttributes(dragged, { x: p.x, y: p.y });
    moved = true;
  };
  renderer.getMouseCaptor().on('mousemovebody', (e) => {
    if (!dragged) return;
    dragTo(e);
    e.preventSigmaDefault();
    e.original.preventDefault();
    e.original.stopPropagation();
  });
  renderer.getTouchCaptor().on('touchmove', (e) => {
    if (!dragged || !e.touches?.length) return;
    dragTo(e.touches[0]);
    e.preventSigmaDefault();
    e.original.preventDefault();
  });
  const drop = () => {
    if (!dragged) return;
    graph.removeNodeAttribute(dragged, 'fixed');
    dragged = null;
    stage.classList.remove('dragging');
    camera.enable();
    settle(60);
  };
  renderer.getMouseCaptor().on('mouseup', drop);
  renderer.getTouchCaptor().on('touchup', drop);

  renderer.on('clickNode', ({ node }) => {
    if (moved) return;
    select(node);
  });
  renderer.on('doubleClickNode', ({ node, preventSigmaDefault }) => {
    preventSigmaDefault();
    const a = graph.getNodeAttributes(node);
    if (a.kind === 'note' && a.path) location.assign(graphHref(a.path));
  });
  renderer.on('clickStage', () => select(null));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && selected) select(null);
  });

  // --- Auswahl: Karte mit Aktionen, Nachbarn aufklappen ----------------------

  function chip(label, attrs) {
    return el(attrs.href ? 'a' : 'button', { class: 'chip', type: attrs.href ? null : 'button', ...attrs, text: label });
  }

  function select(node) {
    selected = node && graph.hasNode(node) ? node : null;
    renderer.refresh({ skipIndexation: true });
    if (!selected) {
      card.hidden = true;
      return;
    }
    const a = graph.getNodeAttributes(selected);
    const chips = el('div', { class: 'chips' });
    const meta = [];
    if (a.kind === 'note') {
      meta.push(a.path);
      if (selected !== center) chips.append(chip('Zur Mitte', { href: graphHref(a.path) }));
      if (canLink) chips.append(chip('Notiz ansehen', { href: noteHref(a.path) }));
      const similar = graph.hasEdge([center, selected].sort().join('|')) && graph.getEdgeAttribute([center, selected].sort().join('|'), 'kind') === 'semantic';
      if (similar && canLink) chips.append(chip('Verlinken', { onclick: (e) => link(selected, e.currentTarget) }));
      if (!loaded.has(selected)) {
        chips.append(chip('Nachbarn laden', { class: 'chip quiet', onclick: (e) => expand(selected, e.currentTarget) }));
      }
      const edge = graph.edges(center).find((e) => graph.opposite(center, e) === selected);
      if (edge && graph.getEdgeAttribute(edge, 'kind') === 'semantic') meta.push(`ähnlich, ${Math.round((graph.getEdgeAttribute(edge, 'score') ?? 0) * 100)} %`);
    } else if (a.kind === 'task') {
      meta.push([a.ref, { done: 'erledigt', in_progress: 'in Arbeit', blocked: 'blockiert', review: 'in Review', dropped: 'verworfen' }[a.status] ?? 'offen'].filter(Boolean).join(' · '));
      if (a.url) chips.append(chip('In Zunder öffnen', { href: a.url, target: '_blank', rel: 'noopener' }));
    } else if (a.kind === 'event') {
      const time = (iso) => new Date(iso).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
      meta.push(a.allDay ? 'ganztägig' : `${time(a.start)}–${time(a.end)}`);
      if (a.calendar) meta.push(a.calendar);
    }
    card.replaceChildren(
      el('button', { type: 'button', class: 'close', 'aria-label': 'Schließen', text: '×', onclick: () => select(null) }),
      el('h3', { text: a.kind === 'note' ? a.label : labelOf(a) }),
      el('span', { class: 'meta', text: meta.join(' · ') }),
      chips.childElementCount ? chips : null,
    );
    card.hidden = false;
    // Einfacher Klick auf eine Notiz klappt ihre Nachbarschaft auf.
    if (a.kind === 'note' && !loaded.has(selected)) expand(selected);
  }

  const pending = new Set();
  async function expand(node, button = null) {
    const a = graph.getNodeAttributes(node);
    if (!a.path || pending.has(node) || loaded.has(node)) return;
    pending.add(node);
    if (button) button.disabled = true;
    try {
      const data = await fetchGraph(a.path);
      const added = merge(data, node);
      if (added) renderer.setCustomBBox(null);
      settle(added ? 140 : 40);
      if (selected === node) select(node);
    } catch (err) {
      toast(err.message, { kind: 'error' });
      if (button) button.disabled = false;
    } finally {
      pending.delete(node);
    }
  }

  async function link(node, button) {
    const a = graph.getNodeAttributes(node);
    const send = window.cockpit?.send;
    if (!send) return;
    button.disabled = true;
    try {
      const data = await send('/aktion/verlinken', new URLSearchParams({ pfad: centerPath, ziel: a.path, csrf: stage.dataset.csrf ?? '' }));
      const key = [center, node].sort().join('|');
      if (graph.hasEdge(key)) graph.mergeEdgeAttributes(key, { kind: 'link', score: null, size: 1.4 });
      refreshDerived();
      select(node);
      toast(data.message);
      refreshLists();
    } catch (err) {
      toast(err.message, { kind: 'error' });
      button.disabled = false;
    }
  }

  /** Die Listen unter dem Graphen neu holen (nach dem Verlinken). */
  async function refreshLists() {
    try {
      const res = await fetch(location.href, { headers: { accept: 'text/html' }, credentials: 'same-origin' });
      if (!res.ok) return;
      const fresh = new DOMParser().parseFromString(await res.text(), 'text/html').querySelector('.graph-lists');
      const current = document.querySelector('.graph-lists');
      if (fresh && current) current.replaceWith(document.adoptNode(fresh));
    } catch {
      /* beim nächsten Laden stimmt es wieder */
    }
  }

  // „Verlinken“ in der Liste: ohne Seitenwechsel, der Graph zieht mit.
  document.addEventListener('submit', async (e) => {
    const form = e.target;
    if (!(form instanceof HTMLFormElement) || !form.classList.contains('link-similar') || !window.cockpit) return;
    e.preventDefault();
    const target = `note:${form.elements.ziel.value}`;
    const button = form.querySelector('button');
    if (graph.hasNode(target)) return link(target, button);
    try {
      button.disabled = true;
      const data = await window.cockpit.send(form.action, new URLSearchParams(new FormData(form)));
      toast(data.message);
      refreshLists();
    } catch (err) {
      toast(err.message, { kind: 'error' });
      button.disabled = false;
    }
  });

  // --- Filter nach Art --------------------------------------------------------

  const legend = document.querySelector('[data-filters]');
  if (legend) {
    legend.classList.add('interactive');
    for (const input of legend.querySelectorAll('input[type=checkbox]')) {
      input.hidden = false;
      input.classList.add('sr-only');
      input.addEventListener('change', () => {
        filters[input.name] = input.checked;
        input.closest('label').classList.toggle('off', !input.checked);
        if (selected && !visibleNode(selected, graph.getNodeAttributes(selected))) select(null);
        renderer.refresh({ skipIndexation: true });
      });
    }
    legend.append(el('span', { class: 'hint meta', text: 'Klick: Nachbarn aufklappen · Doppelklick: zur Mitte · Ziehen: Knoten bewegen' }));
  }

  // Hell/dunkel umgeschaltet: Farben neu lesen.
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    readColors();
    renderer.setSetting('labelColor', { color: colors.text });
    refreshDerived();
  });

  // --- Start ------------------------------------------------------------------

  fetchGraph(centerPath)
    .then((data) => {
      merge(data);
      // Vorlauf ohne Animation, damit der erste Blick schon geordnet ist.
      forceAtlas2.assign(graph, { iterations: 120, settings: layoutSettings() });
      stage.classList.remove('loading');
      renderer.refresh();
      camera.setState({ x: 0.5, y: 0.5, ratio: 1 });
      settle(90);
    })
    .catch((err) => {
      // Der Graph ist nicht zu holen: zurück zum SVG.
      renderer.kill();
      stage.classList.remove('interactive', 'loading');
      stage.querySelectorAll('.graph-zoom, .graph-card').forEach((n) => n.remove());
      toast(err.message, { kind: 'error' });
    });
})();
