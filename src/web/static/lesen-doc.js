// Leseansicht (VCP-71, src/lesen/doc.js): Markieren per Textauswahl oder ganzer
// Absatz, Notizen, Fortschritt speichern, Schriftgröße und Tastenkürzel. Braucht /static/cockpit.js
// (window.cockpit) davor. Ohne Script bleibt der Text lesbar, jede Entscheidung
// (Fertig, weg · In den Vault) ist ein Formular.
//
// Anker zählen Zeichen in `textContent` von `.lesen-text`, genau wie
// src/lesen/anchor.js auf dem Server. Deshalb steht dort nur der Artikel, und
// Hinweise an Markierungen kommen per CSS, nie als Text. Auch der Strich am
// aktiven Absatz (`.lesen-fokus`) hängt am Leser, nicht im Lesetext.
//
// Hooks für spätere Aufgaben, als Ereignisse auf `document`:
// - `lesen:verbinden` (abbrechbar, `detail`: { docId, anchor?, highlightId? }) –
//   „Verbinden“ (VCP-73); wer es mit `preventDefault()` übernimmt, ersetzt den Hinweis.
// - `lesen:markierung` (`detail`: { action, ...Antwort }) – nach jeder Änderung an
//   Markierungen über diese Seite mit JavaScript. Verlässlich auch ohne Script sind
//   die Aktionen in src/lesen/highlights.js.
//
// Ohne Netz oder auf der gespeicherten Seite (VCP-80) gehen Markieren, Notiz,
// Entfernen, In Inbox, Fortschritt und die Entscheidungen in den Puffer von
// /static/offline.js (`window.cockpitPuffer`) und von dort später raus, auch
// wenn erst das Senden zeigt, dass kein Netz da ist (Funkloch, VCP-87). Neue
// Markierungen tragen dafür immer eine eigene ID (`cid`); wartende zeigt die
// Seite per CSS-Highlight, wartendes Entfernen blendet die Markierung aus.
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
  const REMOVE = '/aktion/lesen/markierung/loeschen';
  const BUFFERED = {
    [NEW]: 'Markierung',
    '/aktion/lesen/markierung/notiz': 'Notiz',
    [REMOVE]: 'Entfernen',
    '/aktion/lesen/markierung/inbox': 'In Inbox',
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
    const mark = e.target.closest('.lesen-text mark[data-hl]:not([data-weg])');
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

  async function run(cmd, s = current) {
    if (!s) return;
    if (cmd === 'mark' && s.anchor) return post(NEW, { id: docId(), ...s.anchor, cid: newId() });
    if (cmd === 'note') {
      // shortcut: Notiz über prompt(); ein eigenes Eingabefeld in der Leiste, wenn längere Notizen üblich werden.
      const note = window.prompt('Notiz zur Markierung', s.id ? noteOf(s.id) : '');
      if (note === null) return;
      return s.id ? post('/aktion/lesen/markierung/notiz', { id: s.id, notiz: note }) : post(NEW, { id: docId(), ...s.anchor, notiz: note, cid: newId() });
    }
    if (cmd === 'delete' && s.id) return post(REMOVE, { id: s.id });
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
   * Legt die Aktion in den Puffer. Schlüssel: neue Markierung ihre `cid`, eine
   * neue Stelle für die Inbox Aktion und `cid`, sonst Aktion und Ziel, damit nur
   * der letzte Stand rausgeht. `true`, wenn es geklappt hat.
   */
  async function buffer(action, fields, { quiet = false } = {}) {
    const p = puffer();
    const title = document.querySelector('.lesen-doc-head h1')?.textContent ?? '';
    // Das CSRF-Token holt der Puffer beim Nachsenden frisch; `back` braucht nur der Weg ohne JavaScript.
    const rest = { ...fields };
    delete rest.csrf;
    delete rest.back;
    const id = action === NEW ? rest.cid : `${action}:${rest.cid ?? rest.markierung ?? rest.id}`;
    const ok = p ? await p.queue({ id, action, fields: rest, label: `${BUFFERED[action]}: ${title}`, quiet }) : false;
    if (quiet) return ok;
    if (!ok) {
      toast('Ohne Netz, und dieses Gerät kann gerade nichts zwischenspeichern. Nichts gespeichert.', { kind: 'error' });
      return false;
    }
    hide();
    getSelection().removeAllRanges();
    if (action === NEW) paint(rest);
    if (action === REMOVE) gone(rest.id);
    toast(`${BUFFERED[action]} wartet auf Netz und geht automatisch raus.`);
    return true;
  }

  /** Markierung, deren Entfernen wartet: im Text ohne Farbe, in der Seitenleiste weg. Der Text bleibt, die Anker stimmen weiter. */
  function gone(id) {
    for (const m of document.querySelectorAll(`.lesen-text mark[data-hl="${CSS.escape(id)}"]`)) m.dataset.weg = '';
    const item = document.querySelector(`.lesen-notes li[data-hl="${CSS.escape(id)}"]`);
    if (item) item.hidden = true;
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
    for (const e of (await puffer()?.pending().catch(() => [])) ?? []) {
      if (e.error) continue;
      if (e.action === NEW && e.fields.id === docId()) paint(e.fields);
      if (e.action === REMOVE) gone(e.fields.id);
    }
  });

  // Entscheidungen ohne Netz (Fertig, weg · In den Vault · Zurück auf den Stapel): in den Puffer, der Server
  // schreibt die Notiz beim Nachsenden. Die Knöpfe bleiben, wie sie sind; die Meldung sagt, dass es wartet.
  const decision = (form) => buffer(form.getAttribute('action'), Object.fromEntries(new FormData(form)));
  document.addEventListener(
    'submit',
    async (e) => {
      const form = e.target;
      if (!(form instanceof HTMLFormElement) || !form.hasAttribute('data-decide') || !puffer()?.offline()) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      await decision(form);
    },
    true,
  );
  // Funkloch: `navigator.onLine` sagt true, das Senden über cockpit.js scheitert. Dann fragt es hier nach.
  window.cockpitLesen = { decision: (form) => (form.hasAttribute('data-decide') && BUFFERED[form.getAttribute('action')] ? decision(form) : Promise.resolve(false)) };

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

  // --- Aktiver Absatz ------------------------------------------------------------

  // Wie bei Readwise: Ein Strich am linken Rand zeigt den aktiven Absatz. J/K schieben ihn
  // weiter, ein Klick setzt ihn, beim Scrollen wandert er mit, sobald er aus dem Bild ist.
  // Ohne Auswahl wirken H, N und L auf ihn. Gemerkt wird die Nummer des Absatzes, weil
  // `refresh()` den Lesetext austauscht.
  // Bezugslinie ist `scroll-margin-top` der Absätze (cockpit.css), damit der Fortschrittsbalken nichts verdeckt.
  const LINE = 64;
  let active = -1;
  // Bis dahin scrollt J/K selbst: Der Strich bleibt, wo die Taste ihn hingesetzt hat.
  let steerUntil = 0;
  const fokus = document.createElement('div');
  fokus.className = 'lesen-fokus';
  fokus.setAttribute('aria-hidden', 'true');
  fokus.hidden = true;

  /** Absätze des Lesetexts, ohne die in einem anderen Absatz (Absätze im Zitat zählen nicht einzeln). */
  const blocks = () => [...(textEl()?.querySelectorAll(BLOCKS) ?? [])].filter((b) => !b.parentElement.closest(BLOCKS));
  const activeBlock = () => blocks()[active] ?? null;
  const inView = (r) => r.bottom > LINE && r.top < innerHeight;

  /** Strich neben den aktiven Absatz setzen; nach `refresh()` oder neuem `main` neu einhängen. */
  function place() {
    const b = activeBlock();
    const r = reader();
    if (!b || !r) return void (fokus.hidden = true);
    if (fokus.parentElement !== r) r.append(fokus);
    const top = b.getBoundingClientRect().top - r.getBoundingClientRect().top;
    fokus.style.top = `${top}px`;
    fokus.style.height = `${b.getBoundingClientRect().height}px`;
    fokus.hidden = false;
  }

  function activate(i) {
    active = i;
    place();
  }

  /** Erster Absatz, der unter dem Fortschrittsbalken zu sehen ist. */
  const firstVisible = () => blocks().findIndex((b) => b.getBoundingClientRect().bottom > LINE + 4);

  /** Aktiven Absatz einen weiter (`1`) oder zurück (`-1`); scrollt nur, wenn er nicht ganz zu sehen ist. */
  function step(dir) {
    const all = blocks();
    if (!all.length) return;
    const now = all[active];
    const i = now && inView(now.getBoundingClientRect()) ? Math.min(all.length - 1, Math.max(0, active + dir)) : Math.max(0, firstVisible());
    activate(i);
    const r = all[i].getBoundingClientRect();
    if (r.top >= LINE - 4 && r.bottom <= innerHeight) return;
    const smooth = !matchMedia('(prefers-reduced-motion: reduce)').matches;
    steerUntil = Date.now() + (smooth ? 800 : 100);
    all[i].scrollIntoView({ block: 'start', behavior: smooth ? 'smooth' : 'auto' });
  }

  addEventListener(
    'scroll',
    () => {
      if (Date.now() < steerUntil) return;
      const b = activeBlock();
      if (!b || !inView(b.getBoundingClientRect())) activate(firstVisible());
    },
    { passive: true },
  );
  // Bilder laden nach, Schriftgröße und Fensterbreite ändern sich: Der Strich zieht mit.
  if (window.ResizeObserver) new ResizeObserver(() => place()).observe(document.body);
  document.addEventListener('DOMContentLoaded', () => requestAnimationFrame(() => activate(firstVisible())));
  document.addEventListener('lesen:markierung', () => place());
  document.addEventListener('click', (e) => {
    if (!(e.target instanceof Element) || !getSelection().isCollapsed) return;
    const b = e.target.closest(BLOCKS);
    const i = b ? blocks().findIndex((x) => x === b || x.contains(b)) : -1;
    if (i !== -1) activate(i);
  });

  /** Markierung, die den ganzen Absatz deckt (sonst `null`): H nimmt sie wieder weg, N bearbeitet ihre Notiz. */
  function wholeHighlight(b) {
    const marks = [...b.querySelectorAll('mark[data-hl]')];
    const id = marks[0]?.dataset.hl;
    if (!id || marks.some((m) => m.dataset.hl !== id)) return null;
    const squash = (s) => s.replace(/\s+/g, '');
    return squash(marks.map((m) => m.textContent).join('')) === squash(b.textContent) ? id : null;
  }

  /** Anker für den ganzen Absatz `b`, ohne Leerraum am Rand; `null` ohne Text (etwa ein Bild). */
  function blockAnchor(b) {
    const root = textEl();
    const text = root.textContent;
    let start = offsetOf(root, b, 0);
    let end = offsetOf(root, b, b.childNodes.length);
    while (start < end && /\s/.test(text[start])) start++;
    while (end > start && /\s/.test(text[end - 1])) end--;
    if (start === end) return null;
    return { quote: text.slice(start, end), prefix: text.slice(Math.max(0, start - CONTEXT), start), suffix: text.slice(end, end + CONTEXT), start: String(start) };
  }

  /** H, N und L ohne Auswahl: auf den aktiven Absatz. H auf einem ganz markierten Absatz entfernt die Markierung. */
  function runOnBlock(cmd) {
    const b = activeBlock();
    if (!b) return;
    const id = wholeHighlight(b);
    if (id) return run(cmd === 'mark' ? 'delete' : cmd, { id });
    const anchor = blockAnchor(b);
    if (!anchor) return toast('In diesem Absatz gibt es keinen Text zum Markieren.');
    return run(cmd, { anchor });
  }

  document.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return;
    const t = e.target;
    if (t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    const key = e.key.toLowerCase();
    const cmd = { h: 'mark', n: 'note', l: 'link' }[key];
    if (cmd) {
      e.preventDefault();
      if (current) run(cmd);
      else runOnBlock(cmd);
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
