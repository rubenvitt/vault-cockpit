// Leseansicht (VCP-71, src/lesen/doc.js): Markieren per Textauswahl, Notizen,
// Fortschritt speichern, Schriftgröße und Tastenkürzel. Braucht /static/cockpit.js
// (window.cockpit) davor. Ohne Script bleibt der Text lesbar, jede Entscheidung
// (Fertig, weg · In den Vault) ist ein Formular.
//
// Anker zählen Zeichen in `textContent` von `.lesen-text`, genau wie
// src/lesen/anchor.js auf dem Server. Deshalb steht dort nur der Artikel, und
// Hinweise an Markierungen kommen per CSS, nie als Text.
//
// Hooks für spätere Aufgaben, als Ereignisse auf `document`:
// - `lesen:verbinden` (abbrechbar, `detail`: { docId, anchor?, highlightId? }) –
//   „Verbinden“ (VCP-73); wer es mit `preventDefault()` übernimmt, ersetzt den Hinweis.
// - `lesen:markierung` (`detail`: { action, ...Antwort }) – nach jeder Änderung an
//   Markierungen über diese Seite mit JavaScript. Verlässlich auch ohne Script sind
//   die Aktionen in src/lesen/highlights.js.
//
// Ohne Netz oder auf der gespeicherten Seite (VCP-80) gehen Markieren, Notiz,
// Fortschritt und die Entscheidungen in den Puffer von /static/offline.js
// (`window.cockpitPuffer`) und von dort später raus. Neue Markierungen tragen
// dafür immer eine eigene ID (`cid`); wartende zeigt die Seite per CSS-Highlight.
(() => {
  'use strict';

  const bar = document.querySelector('.lesen-selbar');
  if (!bar || !window.cockpit || !document.querySelector('.lesen-reader')) return;
  const { toast, send, csrf } = window.cockpit;
  const CONTEXT = 32;
  const BLOCKS = 'p, h1, h2, h3, h4, h5, h6, li, blockquote, pre, figure, table, dt, dd';
  // Nach einem Formular aus /static/cockpit.js wird `main` ausgetauscht: Elemente immer frisch holen.
  const reader = () => document.querySelector('.lesen-reader');
  const textEl = () => document.querySelector('.lesen-text');
  const docId = () => reader()?.dataset.doc;
  const newId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const html = document.documentElement;
  html.classList.add('lesen-js');
  // offline.js läuft nach diesem Skript: erst beim Aufruf nachsehen.
  const puffer = () => window.cockpitPuffer;
  const NEW = '/aktion/lesen/markierung/neu';
  const BUFFERED = {
    [NEW]: 'Markierung',
    '/aktion/lesen/markierung/notiz': 'Notiz',
    '/aktion/lesen/doc/fortschritt': 'Lesefortschritt',
    '/aktion/lesen/doc/status': 'Status',
    '/aktion/lesen/doc/fertig': 'Fertig, weg',
    '/aktion/lesen/doc/vault': 'In den Vault',
  };

  /** Zeichen im Lesetext vor (`node`, `offset`). */
  function offsetOf(root, node, offset) {
    const r = document.createRange();
    r.selectNodeContents(root);
    r.setEnd(node, offset);
    return r.toString().length;
  }

  /** Anker der Auswahl, wenn sie ganz im Lesetext liegt: { quote, prefix, suffix, start }. */
  function anchorOf(sel) {
    const root = textEl();
    if (!root || !sel || sel.isCollapsed || !sel.rangeCount) return null;
    const range = sel.getRangeAt(0);
    if (!root.contains(range.commonAncestorContainer)) return null;
    const text = root.textContent;
    const start = offsetOf(root, range.startContainer, range.startOffset);
    const end = offsetOf(root, range.endContainer, range.endOffset);
    const quote = text.slice(start, end);
    if (!quote.trim()) return null;
    return { quote, prefix: text.slice(Math.max(0, start - CONTEXT), start), suffix: text.slice(end, end + CONTEXT), start: String(start) };
  }

  // --- Leiste für Auswahl und Markierungen -----------------------------------

  // Unten fixiert, nicht an der Auswahl: Dort zeigt iOS sein eigenes Menü.
  // `current` ist { anchor } für eine neue Auswahl oder { id } für eine angetippte Markierung.
  let current = null;
  let hideTimer = null;

  function show(state) {
    clearTimeout(hideTimer);
    current = state;
    bar.querySelector('[data-cmd=mark]').hidden = Boolean(state.id);
    bar.querySelector('[data-cmd=delete]').hidden = !state.id;
    bar.hidden = false;
  }
  function hide() {
    current = null;
    bar.hidden = true;
  }

  // `selectionchange` statt `mouseup`: kommt auch, wenn man die Auswahl auf dem iPhone mit den Griffen zieht.
  document.addEventListener('selectionchange', () => {
    const anchor = anchorOf(getSelection());
    if (anchor) return show({ anchor });
    // Verzögert: Ein Tipp auf die Leiste hebt die Auswahl auf dem iPhone auf, bevor `click` ankommt.
    if (current?.anchor) {
      clearTimeout(hideTimer);
      hideTimer = setTimeout(hide, 400);
    }
  });
  // Am Desktop behält die Auswahl so ihren Stand, während man klickt.
  bar.addEventListener('mousedown', (e) => e.preventDefault());
  bar.addEventListener('click', (e) => {
    const b = e.target instanceof Element ? e.target.closest('button[data-cmd]') : null;
    if (b) run(b.dataset.cmd);
  });
  document.addEventListener('click', (e) => {
    if (!(e.target instanceof Element) || bar.contains(e.target)) return;
    const mark = e.target.closest('.lesen-text mark[data-hl]');
    if (mark && getSelection().isCollapsed) show({ id: mark.dataset.hl });
    else if (current?.id) hide();
  });

  // Formulare der Seitenleiste (Entfernen) über denselben Weg, damit Ansicht und Ereignis stimmen.
  // Mit `true` vor /static/cockpit.js, das sonst die Ladeleiste für einen Seitenwechsel zeigt.
  document.addEventListener(
    'submit',
    (e) => {
      const form = e.target;
      if (!(form instanceof HTMLFormElement) || !form.hasAttribute('data-hl-form')) return;
      e.preventDefault();
      post(form.getAttribute('action'), Object.fromEntries(new FormData(form)));
    },
    true,
  );

  const noteOf = (id) => document.querySelector(`mark[data-hl="${CSS.escape(id)}"]`)?.title ?? '';

  async function run(cmd) {
    const s = current;
    if (!s) return;
    if (cmd === 'mark' && s.anchor) return post(NEW, { id: docId(), ...s.anchor, cid: newId() });
    if (cmd === 'note') {
      // shortcut: Notiz über prompt(); ein eigenes Eingabefeld in der Leiste, wenn längere Notizen üblich werden.
      const note = window.prompt('Notiz zur Markierung', s.id ? noteOf(s.id) : '');
      if (note === null) return;
      return s.id ? post('/aktion/lesen/markierung/notiz', { id: s.id, notiz: note }) : post(NEW, { id: docId(), ...s.anchor, notiz: note, cid: newId() });
    }
    if (cmd === 'delete' && s.id) return post('/aktion/lesen/markierung/loeschen', { id: s.id });
    if (cmd === 'inbox') return post('/aktion/lesen/markierung/inbox', s.id ? { markierung: s.id } : { id: docId(), ...s.anchor, cid: newId() }, { reload: false });
    if (cmd === 'link') {
      const handled = !document.dispatchEvent(new CustomEvent('lesen:verbinden', { cancelable: true, detail: { docId: docId(), anchor: s.anchor ?? null, highlightId: s.id ?? null } }));
      if (!handled) toast('Verbinden kommt mit den Querverbindungen.');
    }
  }

  async function post(action, fields, { reload = true } = {}) {
    if (BUFFERED[action] && puffer()?.offline()) return buffer(action, fields);
    try {
      const data = await send(action, new URLSearchParams({ ...fields, csrf: csrf() }));
      hide();
      getSelection().removeAllRanges();
      if (reload) await refresh();
      document.dispatchEvent(new CustomEvent('lesen:markierung', { detail: { action, ...data } }));
      toast(data.message, data.undo ? { action: { label: 'Rückgängig', run: () => post(data.undo.action, data.undo.fields) } } : {});
    } catch (err) {
      if (err.offline && BUFFERED[action] && (await buffer(action, fields))) return;
      toast(err.message, { kind: 'error' });
    }
  }

  // --- Ohne Netz: Puffer -------------------------------------------------------

  /**
   * Legt die Aktion in den Puffer. Schlüssel: neue Markierung ihre `cid`, sonst
   * Aktion und Ziel, damit nur der letzte Stand rausgeht. `true`, wenn es geklappt hat.
   */
  async function buffer(action, fields, { quiet = false } = {}) {
    const p = puffer();
    const title = document.querySelector('.lesen-doc-head h1')?.textContent ?? '';
    const id = action === NEW ? fields.cid : `${action}:${fields.id}`;
    const ok = p ? await p.queue({ id, action, fields, label: `${BUFFERED[action]}: ${title}`, quiet }) : false;
    if (quiet) return ok;
    if (!ok) {
      toast('Ohne Netz, und dieses Gerät kann gerade nichts zwischenspeichern. Nichts gespeichert.', { kind: 'error' });
      return false;
    }
    hide();
    if (action === NEW) {
      paint(fields);
      getSelection().removeAllRanges();
    }
    toast(`${BUFFERED[action]} wartet auf Netz und geht automatisch raus.`);
    return true;
  }

  // Wartende Markierungen als CSS-Highlight: ändert den Text nicht, die Anker stimmen weiter.
  const waiting = window.Highlight && CSS.highlights ? new Highlight() : null;
  if (waiting) CSS.highlights.set('lesen-wartet', waiting);

  /** Bereich im Lesetext von Zeichen `start` bis `end`, gezählt wie `offsetOf`. */
  function rangeAt(root, start, end) {
    const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    let pos = 0;
    let begun = false;
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      const len = n.data.length;
      if (!begun && start <= pos + len) {
        range.setStart(n, start - pos);
        begun = true;
      }
      if (begun && end <= pos + len) {
        range.setEnd(n, end - pos);
        return range;
      }
      pos += len;
    }
    return null;
  }

  function paint(fields) {
    const root = textEl();
    const start = Number(fields.start);
    if (!waiting || !root || !Number.isFinite(start)) return;
    const range = rangeAt(root, start, start + fields.quote.length);
    if (range && range.toString() === fields.quote) waiting.add(range);
  }

  // Beim Öffnen: Was für diesen Artikel noch im Puffer wartet, wieder zeigen.
  document.addEventListener('DOMContentLoaded', async () => {
    for (const e of (await puffer()?.pending().catch(() => [])) ?? []) if (e.action === NEW && !e.error && e.fields.id === docId()) paint(e.fields);
  });

  // Entscheidungen ohne Netz (Fertig, weg · In den Vault · Zurück auf den Stapel): in den Puffer, der Server
  // schreibt die Notiz beim Nachsenden. Die Knöpfe bleiben, wie sie sind; die Meldung sagt, dass es wartet.
  // shortcut: Im Funkloch mit `navigator.onLine` true gehen sie über cockpit.js und melden nur den Fehler;
  // „Entfernen“ und „In Inbox“ puffern gar nicht. Bei Bedarf dort auf `err.offline` hin puffern.
  document.addEventListener(
    'submit',
    async (e) => {
      const form = e.target;
      if (!(form instanceof HTMLFormElement) || !form.hasAttribute('data-decide') || !puffer()?.offline()) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      // Das CSRF-Token holt der Puffer beim Nachsenden frisch.
      const fields = Object.fromEntries(new FormData(form));
      delete fields.csrf;
      delete fields.back;
      await buffer(form.getAttribute('action'), fields);
    },
    true,
  );

  /** Lesetext und Seitenleiste neu vom Server, mit den Markierungen an ihrer Stelle. */
  async function refresh() {
    try {
      const res = await fetch(location.href, { headers: { accept: 'text/html' }, credentials: 'same-origin' });
      if (!res.ok) return;
      const fresh = new DOMParser().parseFromString(await res.text(), 'text/html');
      for (const sel of ['.lesen-text', '.lesen-side']) {
        const next = fresh.querySelector(sel);
        if (next) document.querySelector(sel)?.replaceWith(document.adoptNode(next));
      }
    } catch {
      /* Die Meldung kommt trotzdem; beim nächsten Laden stimmt die Ansicht. */
    }
  }

  // --- Fortschritt ------------------------------------------------------------

  let best = Number(document.querySelector('.lesen-progress progress')?.value) || 0;
  let dirty = false;
  let saveTimer = null;

  /** Anteil bis zum unteren Bildrand und Anfang des obersten sichtbaren Absatzes. */
  function position(withAnchor) {
    const root = textEl();
    if (!root) return null;
    const rect = root.getBoundingClientRect();
    const progress = rect.height ? Math.min(1, Math.max(0, (innerHeight - rect.top) / rect.height)) : 1;
    if (!withAnchor) return { progress };
    let anchor = 0;
    for (const b of root.querySelectorAll(BLOCKS)) {
      if (b.getBoundingClientRect().bottom > 0) {
        anchor = offsetOf(root, b, 0);
        break;
      }
    }
    return { progress, anchor };
  }

  function showProgress() {
    const p = position(false);
    if (!p) return;
    best = Math.max(best, p.progress);
    const meter = document.querySelector('.lesen-progress progress');
    if (meter) meter.value = best;
    const rest = document.querySelector('[data-rest]');
    const minutes = Number(reader()?.dataset.minutes) || 0;
    if (rest) rest.textContent = best >= 1 ? 'gelesen' : minutes ? `noch ${Math.max(1, Math.ceil(minutes * (1 - best)))} min` : '';
  }

  /** Speichert den Stand; `keepalive`, damit es auch beim Verlassen der Seite ankommt. */
  function save(keepalive = false) {
    clearTimeout(saveTimer);
    if (!dirty) return;
    dirty = false;
    const p = position(true);
    if (!p) return;
    // Zurückblättern senkt den Fortschritt nicht, verschiebt aber die Stelle zum Weiterlesen.
    const fields = { id: docId(), fortschritt: Math.max(best, p.progress).toFixed(3), anker: String(p.anchor) };
    const later = () => buffer('/aktion/lesen/doc/fortschritt', fields, { quiet: true });
    if (puffer()?.offline()) return void later();
    const body = new URLSearchParams({ csrf: csrf(), ...fields });
    fetch('/aktion/lesen/doc/fortschritt', { method: 'POST', keepalive, credentials: 'same-origin', headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' }, body }).catch(later);
  }

  addEventListener(
    'scroll',
    () => {
      dirty = true;
      showProgress();
      clearTimeout(saveTimer);
      saveTimer = setTimeout(save, 1500);
    },
    { passive: true },
  );
  addEventListener('pagehide', () => save(true));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') save(true);
  });

  // --- Darstellung --------------------------------------------------------------

  const PREFS = 'lesen-darstellung';
  let prefs = { size: 3, sans: false };
  try {
    prefs = { ...prefs, ...JSON.parse(localStorage.getItem(PREFS) ?? '{}') };
  } catch {
    /* privater Modus: Standard */
  }
  function applyPrefs() {
    html.dataset.readSize = String(prefs.size);
    html.toggleAttribute('data-read-sans', prefs.sans);
    for (const b of document.querySelectorAll('[data-font]')) b.setAttribute('aria-pressed', String(prefs.sans));
    try {
      localStorage.setItem(PREFS, JSON.stringify(prefs));
    } catch {
      /* egal */
    }
  }
  applyPrefs();
  document.addEventListener('click', (e) => {
    const b = e.target instanceof Element ? e.target.closest('.lesen-view button') : null;
    if (!b) return;
    if (b.dataset.size) prefs.size = Math.min(5, Math.max(1, prefs.size + Number(b.dataset.size)));
    else prefs.sans = !prefs.sans;
    applyPrefs();
  });

  // --- Tastenkürzel -------------------------------------------------------------

  /** Zum nächsten (`1`) oder vorigen (`-1`) Absatz. */
  function step(dir) {
    const blocks = [...(textEl()?.querySelectorAll(BLOCKS) ?? [])].filter((b) => !b.parentElement.closest(BLOCKS));
    const tops = blocks.map((b) => b.getBoundingClientRect().top);
    // Bezugslinie ist `scroll-margin-top` der Absätze (cockpit.css), damit der Fortschrittsbalken nichts verdeckt.
    const line = 64;
    const i = dir > 0 ? tops.findIndex((t) => t > line + 4) : tops.findLastIndex((t) => t < line - 4);
    const smooth = !matchMedia('(prefers-reduced-motion: reduce)').matches;
    blocks[i]?.scrollIntoView({ block: 'start', behavior: smooth ? 'smooth' : 'auto' });
  }

  document.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return;
    const t = e.target;
    if (t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    const key = e.key.toLowerCase();
    const cmd = { h: 'mark', n: 'note', l: 'link' }[key];
    if (cmd) {
      if (!current) return;
      e.preventDefault();
      run(cmd);
    } else if (key === 'e' || key === 'v') {
      // E: Fertig, weg · V: In den Vault (mit der Wahl im Formular).
      e.preventDefault();
      document.querySelector(`form[data-decide=${key === 'e' ? 'fertig' : 'vault'}]`)?.requestSubmit();
    } else if (key === 'j' || key === 'k') {
      e.preventDefault();
      step(key === 'j' ? 1 : -1);
    }
  });
})();
