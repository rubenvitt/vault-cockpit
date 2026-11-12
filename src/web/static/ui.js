// Auf jeder Seite (auch ohne Schreibrechte): Rückmeldung beim Tippen und, weiter
// unten, die Befehlspalette (⌘K bzw. Strg+K).
//
// Rückmeldung: Ein Tipp soll sofort etwas sichtbar ändern, auch wenn die nächste
// Seite noch beim Server ist: Der getippte Link bleibt gedrückt, der Reiter unten
// wechselt gleich, oben läuft die Ladeleiste. In der iOS-App kommt ein leichtes
// Haptik-Signal dazu (Brücke `cockpit`, `{type: 'haptik', art}`).
(() => {
  'use strict';

  const root = document.documentElement;
  const app = window.webkit?.messageHandlers?.cockpit;

  /** `art`: `auswahl` (Reiter, Menü), `leicht` (Tipp), `erfolg` (abgehakt), `fehler`. Ohne App nichts. */
  const haptik = (art) => {
    try {
      app?.postMessage({ type: 'haptik', art });
    } catch {
      /* Die Seite läuft auch ohne App. */
    }
  };
  window.cockpitHaptik = haptik;

  // Safari und WKWebView zeigen `:active` auf dem iPhone nur, wenn es einen Touch-Listener gibt.
  document.addEventListener('touchstart', () => {}, { passive: true });

  // --- Seitenwechsel ----------------------------------------------------------

  let pressed = null;
  let tabs = null;
  let fallback = 0;

  function navigating(el) {
    root.classList.add('navigating');
    pressed?.classList.remove('pressed');
    pressed = el;
    el?.classList.add('pressed');
    // Ohne Seitenwechsel (Download, abgebrochene Navigation) geht die Leiste von selbst wieder weg.
    clearTimeout(fallback);
    fallback = setTimeout(settle, 20000);
  }

  function settle() {
    clearTimeout(fallback);
    root.classList.remove('navigating');
    pressed?.classList.remove('pressed');
    pressed = null;
    // Zurück aus dem Verlauf (bfcache): Der Reiter zeigt wieder die Seite, auf der man ist.
    if (tabs) for (const [a, current] of tabs) current ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current');
    tabs = null;
  }

  /** Der getippte Reiter ist sofort der aktuelle, oben und unten. */
  function selectTab(a) {
    const nav = a.closest('.tabbar, .app-nav');
    if (!nav) return;
    const href = a.getAttribute('href');
    const all = [...document.querySelectorAll('.tabbar a, .app-nav a')];
    tabs = all.map((x) => [x, x.getAttribute('aria-current') === 'page']);
    for (const x of all) x.getAttribute('href') === href ? x.setAttribute('aria-current', 'page') : x.removeAttribute('aria-current');
    haptik('auswahl');
  }

  addEventListener('pageshow', settle);

  // Externe Links (andere Herkunft, http/https) öffnen in einem neuen Tab, auf jeder Seite
  // und auch in Texten aus Feeds oder dem Vault. Die iOS-App gibt sie an Safari weiter.
  document.addEventListener('click', (e) => {
    const a = e.target instanceof Element ? e.target.closest('a[href]') : null;
    if (!a || a.target || a.hasAttribute('download') || !/^https?:$/.test(a.protocol) || a.origin === location.origin) return;
    a.target = '_blank';
    a.relList.add('noopener', 'noreferrer');
  });

  /** Seitenwechsel aus einem Script (Weiterleitung nach einer Aktion, Graph) mit derselben Rückmeldung. */
  window.cockpitWechsel = (url) => {
    navigating(null);
    location.assign(url);
  };

  // Am `window` lauschen: Dort kommt der Klick erst nach den Handlern der Seite an, die ihn
  // vielleicht selbst übernehmen (`preventDefault`).
  addEventListener('click', (e) => {
    const a = e.target instanceof Element ? e.target.closest('a[href]') : null;
    if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if (a.target || a.hasAttribute('download') || a.origin !== location.origin) return;
    if (a.hash && a.pathname === location.pathname && a.search === location.search) return;
    selectTab(a);
    navigating(a);
  });

  addEventListener('submit', (e) => {
    const form = e.target;
    if (e.defaultPrevented || !(form instanceof HTMLFormElement) || form.target) return;
    // `/logout` wird in der App nativ abgefangen; die Leiste soll trotzdem kommen.
    navigating(e.submitter instanceof HTMLElement ? e.submitter : form.querySelector('button[type=submit], button:not([type])'));
  });
})();

// --- Befehlspalette ---------------------------------------------------------
//
// ⌘K (Mac) bzw. Strg+K öffnet auf jeder Seite eine Palette: zu einem Ziel
// springen, Notizen im Vault suchen, einen Gedanken festhalten. In der Kopfzeile
// öffnet sie `a[data-palette]` (ohne JavaScript ein Link zur Suche).
//
// - Die Zeilen sind Links, Enter klickt die gewählte: Der Seitenwechsel nimmt so
//   denselben Weg wie jeder Link (Ladeleiste oben, Rahmen des Players).
// - Welche Ziele es in dieser Installation gibt, sagt `/api/palette` beim ersten
//   Öffnen; die Antwort bleibt auf dem Gerät. Bis dahin und ohne Netz gelten die
//   Ziele, die es immer gibt.
// - Festhalten speichert nicht selbst: Der Text geht in die Schnelleingabe der
//   Woche (`form.capture`, cockpit.js); steht sie nicht auf der Seite, über
//   `sessionStorage` und `/?erfassen=1`. Dort gelten Vorschau, CSRF-Token und
//   Offline-Puffer wie bei jedem getippten Text.
(() => {
  'use strict';

  const root = document.documentElement;
  const mac = /Mac|iPhone|iPad/.test(navigator.platform ?? '');

  /**
   * Ziele in der Reihenfolge der Liste: `area` steht grau vor dem Namen, `hint`
   * daneben. Gefunden wird über Namen, Bereich und `words`; der Hinweis ist nur
   * Anzeige, sonst träfen seine Füllwörter („in die“, „statt“) alles Mögliche.
   * `optional`: gibt es nicht in jeder Installation und erscheint erst, wenn
   * `/api/palette` es nennt (`PALETTE_PAGES` in src/web/http.js führt dieselben
   * Adressen in derselben Reihenfolge).
   */
  const TARGETS = [
    { href: '/', label: 'Woche', hint: 'Heute, Feuer, Big Rocks', words: 'Heute Feuer Big Rocks Termine Kalender Aufgaben Inbox' },
    { href: '/planen', label: 'Planen', area: 'Woche', hint: 'Aufgaben in die Woche holen', words: 'Aufgaben Zunder Flammen Wochenplan', optional: true },
    { href: '/rueckblick', label: 'Rückblick', area: 'Woche', hint: 'Erledigt gegen geplant', words: 'Erledigt Geplant Review Bilanz Auswertung' },
    { href: '/lesen/weiter', label: 'Weiter', area: 'Lesen', hint: 'Was als Nächstes dran ist', words: 'Nächstes Überblick' },
    { href: '/lesen/eingang', label: 'Eingang', area: 'Lesen', hint: 'Neues aus den Feeds sortieren', words: 'Neues Feeds sortieren Inbox' },
    { href: '/lesen/stapel', label: 'Stapel', area: 'Lesen', hint: 'Texte zum Lesen', words: 'Lesestapel Texte Artikel' },
    { href: '/lesen/folgen', label: 'Folgen', area: 'Lesen', hint: 'Hören statt lesen', words: 'Hören Podcast Audio Episoden', optional: true },
    { href: '/lesen/ingest', label: 'Ingest', area: 'Lesen', hint: 'Entwürfe fürs Wiki abhaken', words: 'Entwürfe Wiki prüfen Claude', optional: true },
    { href: '/lesen/markiert', label: 'Markiert', area: 'Lesen', hint: 'Alle Markierungen', words: 'Markierungen Highlights Zitate' },
    { href: '/lesen/wiedersehen', label: 'Wiedersehen', area: 'Lesen', hint: 'Markierungen wiederholen', words: 'Markierungen wiederholen Karten' },
    { href: '/lesen/feeds', label: 'Feeds', area: 'Lesen', hint: 'Abos verwalten', words: 'Abos RSS Newsletter Quellen' },
    { href: '/graph', label: 'Suche', hint: 'Vault durchsuchen, Graph', words: 'Vault Graph Notizen finden' },
    { href: '/wissen', label: 'Wissen', area: 'Suche', hint: 'Synthesen', words: 'Synthesen Thesen' },
    { href: '/fragen', label: 'Fragen', area: 'Suche', hint: 'Gespräch mit Claude', words: 'Gespräch Claude Chat', optional: true },
    { href: '/einstellungen', label: 'Einstellungen', hint: 'Kalender, Zugänge, Sicherung', words: 'Kalender Zugänge Sicherung Token Backup Zunder Mail Sync Anzeige' },
    { href: '/zustand', label: 'Zustand', area: 'Einstellungen', hint: 'Dienste im Hintergrund', words: 'Dienste Hintergrunddienste Störung Status Fehler', optional: true },
  ];

  // MARK: Filtern (reine Funktionen, geprüft in test/palette.test.js)

  /**
   * Kleinbuchstaben ohne Umlaute und Akzente. „ue“ zählt wie „ü“ und wie „u“:
   * „rück“, „rueck“ und „ruck“ finden alle den Rückblick.
   */
  const fold = (s) =>
    String(s ?? '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/\p{Diacritic}/gu, '')
      .replace(/ß/g, 'ss')
      .replace(/([aou])e/g, '$1');
  const wordsOf = (s) => fold(s).split(/[^a-z0-9]+/).filter(Boolean);

  const indexes = new WeakMap();
  const indexOf = (t) => {
    if (!indexes.has(t)) indexes.set(t, { label: wordsOf(t.label), area: wordsOf(t.area), words: wordsOf(t.words) });
    return indexes.get(t);
  };

  /**
   * Wie gut ein Wort der Eingabe zu einem Ziel passt, 0 = gar nicht. Der Anfang
   * eines Wortes zählt mehr als die Mitte, der Name mehr als Bereich und
   * Suchwörter. Mitten im Wort zählt erst ab drei Zeichen, sonst träfe ein
   * einzelner Buchstabe fast alles.
   */
  function scoreWord(word, t) {
    const { label, area, words } = indexOf(t);
    if (label[0]?.startsWith(word)) return label[0] === word ? 110 : 100;
    if (label.some((w) => w.startsWith(word))) return 80;
    if (area.some((w) => w.startsWith(word))) return 60;
    if (words.some((w) => w.startsWith(word))) return 50;
    if (word.length < 3) return 0;
    if (label.some((w) => w.includes(word))) return 30;
    return [...area, ...words].some((w) => w.includes(word)) ? 10 : 0;
  }

  /**
   * Ziele, die zu jedem Wort der Eingabe passen, die besten zuerst; bei
   * Gleichstand in der Reihenfolge der Liste. Ohne Eingabe alle.
   */
  function rank(query, targets = TARGETS) {
    const words = wordsOf(query);
    if (!words.length) return [...targets];
    return targets
      .map((t, i) => {
        const scores = words.map((w) => scoreWord(w, t));
        return { t, i, score: scores.includes(0) ? 0 : scores.reduce((a, b) => a + b, 0) };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || a.i - b.i)
      .map((x) => x.t);
  }

  /** Ziele dieser Installation: was `/api/palette` nennt (`urls`), ohne Antwort alles außer den optionalen. */
  const available = (urls = null) => TARGETS.filter((t) => (urls ? urls.includes(t.href) : !t.optional));

  const CAPTURE_HREF = '/?erfassen=1';
  // Gespeichert wird erst dort, mit Enter: Die Zeile sagt, wohin es geht.
  const CAPTURE_HINT = 'weiter in der Schnelleingabe';
  const quoted = (s) => `„${s.length > 60 ? `${s.slice(0, 57).trimEnd()}…` : s}“`;

  /**
   * Gruppen und Zeilen zu einer Eingabe, in der Reihenfolge der Anzeige:
   * `[{ label, status?, items: [{ key, href, title, area?, hint?, stale?, capture? }] }]`.
   *
   * - Mit `!` oder `>` vorn ist die Eingabe ein Text für die Schnelleingabe
   *   (Aufgabe bzw. Adresse für den Lesestapel), sonst eine Suche: erst Ziele,
   *   dann Notizen (`found`, die letzte Antwort von `/api/suche`; gehört sie zu
   *   einer älteren Eingabe, sind ihre Zeilen `stale`) samt der Suche im ganzen
   *   Vault, zuletzt „Als Notiz festhalten“.
   * - `capture: false`: Die Woche hat keine Schnelleingabe, Festhalten fehlt.
   */
  function build(value, { urls = null, capture = true, found = null, failed = false } = {}) {
    const text = String(value ?? '').trim();
    if (/^[!>]/.test(text)) {
      const body = text.slice(1).trim();
      if (!capture) return [{ label: 'Festhalten', status: 'hier gibt es keine Schnelleingabe', items: [] }];
      if (!body) return [{ label: 'Festhalten', status: text[0] === '!' ? 'nach dem ! die Aufgabe' : 'nach dem > die Adresse für den Lesestapel', items: [] }];
      const article = text[0] === '>' && /^https?:\/\/\S+$/i.test(body);
      const title = text[0] === '!' ? `Als Aufgabe festhalten: ${quoted(body)}` : article ? `Für den Lesestapel festhalten: ${quoted(body)}` : `Als Notiz festhalten: ${quoted(text)}`;
      return [{ label: 'Festhalten', items: [{ key: 'capture', href: CAPTURE_HREF, title, hint: CAPTURE_HINT, capture: text }] }];
    }
    const groups = [];
    const targets = rank(text, available(urls));
    if (targets.length) groups.push({ label: 'Ziele', items: targets.map((t) => ({ key: t.href, href: t.href, title: t.label, area: t.area, hint: t.hint })) });
    if (!text) return groups;

    const fresh = found?.q === text;
    const hits = text.length >= 2 && found ? found.results : [];
    const status = text.length < 2 ? 'ab zwei Zeichen' : failed ? 'gerade nicht erreichbar' : !fresh ? 'sucht …' : found.degraded || (hits.length ? null : 'nichts gefunden');
    groups.push({
      label: 'Notizen',
      status,
      items: [
        // Mit Notizseite öffnet ein Treffer die Notiz, sonst ihren Graphen (wie die Live-Suche in graph.js).
        ...hits.map((r) => ({ key: `notiz:${r.path}`, href: `${found.notes ? '/notiz' : '/graph'}?pfad=${encodeURIComponent(r.path)}`, title: r.title ?? r.path, hint: r.path, stale: !fresh })),
        { key: 'suche', href: `/graph?q=${encodeURIComponent(text)}`, title: `Im ganzen Vault suchen: ${quoted(text)}`, hint: fresh && found.total > hits.length ? `${found.total} Treffer` : 'Suche' },
      ],
    });
    if (capture) groups.push({ label: 'Festhalten', items: [{ key: 'capture', href: CAPTURE_HREF, title: `Als Notiz festhalten: ${quoted(text)}`, hint: CAPTURE_HINT, capture: text }] });
    return groups;
  }

  // MARK: Festhalten

  const DRAFT = 'cockpit-palette-entwurf';
  const captureField = () => document.querySelector('form.capture textarea[name=text]');

  /** Text in die Schnelleingabe; steht dort schon etwas, kommt er in eine neue Zeile. */
  function put(field, text) {
    field.value = field.value.trim() ? `${field.value.trimEnd()}\n${text}` : text;
    // cockpit.js stellt daran Modus (Notiz/Aufgabe), Höhe und Vorschau ein.
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.focus();
    field.setSelectionRange?.(field.value.length, field.value.length);
  }

  // Ankunft auf der Woche: Der Text aus der Palette steht im Feld, bevor cockpit.js es einrichtet.
  // Zehn Minuten gilt er (der Weg kann über den Login führen), danach wäre er nur noch eine Überraschung.
  {
    const field = captureField();
    let draft = null;
    try {
      if (field) {
        draft = JSON.parse(sessionStorage.getItem(DRAFT) ?? 'null');
        sessionStorage.removeItem(DRAFT);
      }
    } catch {
      draft = null;
    }
    if (field && typeof draft?.text === 'string' && draft.text && Date.now() - draft.at < 10 * 60_000) put(field, draft.text);
  }

  // MARK: Dialog

  const el = (tag, attrs = {}, ...children) => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'text') node.textContent = v;
      else if (v != null && v !== false) node.setAttribute(k, v === true ? '' : v);
    }
    node.append(...children.filter(Boolean));
    return node;
  };

  const KNOWN = 'cockpit-palette';
  /** Letzte Antwort von `/api/palette` (`{ urls, capture }`), über Seitenwechsel hinweg auf dem Gerät. */
  let known = null;
  try {
    const v = JSON.parse(localStorage.getItem(KNOWN) ?? 'null');
    if (Array.isArray(v?.urls)) known = { urls: v.urls, capture: v.capture !== false };
  } catch {
    known = null;
  }
  let asked = false;

  let dialog = null;
  let input = null;
  let list = null;
  let captureHint = null;
  /** Zeilen der Liste: `{ node, item }`. */
  let rows = [];
  let active = -1;
  /** Hat man mit Pfeiltasten oder Maus gewählt, bleibt die Wahl, wenn Treffer nachkommen. */
  let moved = false;
  /** Letzte Antwort der Notizsuche: `{ q, results, total, notes, degraded }`. */
  let found = null;
  let failed = false;
  let timer = 0;
  let controller = null;
  /** Am Attribut abgelesen: Das gilt auch dort, wo `<dialog>` kein `showModal` kennt. */
  const isOpen = () => Boolean(dialog?.hasAttribute('open'));

  function mark(i, { scroll = true } = {}) {
    active = rows.length ? (i + rows.length) % rows.length : -1;
    rows.forEach((r, j) => r.node.setAttribute('aria-selected', String(j === active)));
    if (active < 0) return input.removeAttribute('aria-activedescendant');
    input.setAttribute('aria-activedescendant', rows[active].node.id);
    if (scroll) rows[active].node.scrollIntoView?.({ block: 'nearest' });
  }

  function render() {
    const keep = moved && active >= 0 ? rows[active].item.key : null;
    const groups = build(input.value, { ...known, found, failed });
    rows = [];
    list.replaceChildren(
      ...groups.map((g) =>
        el(
          'div',
          { class: 'palette-group', role: 'group', 'aria-label': g.label },
          el('div', { class: 'palette-label', 'aria-hidden': 'true', text: g.label }, g.status ? el('span', { class: 'hint', text: ` · ${g.status}` }) : null),
          ...g.items.map((item) => {
            const node = el(
              'a',
              { class: `palette-item${item.stale ? ' stale' : ''}`, role: 'option', id: `palette-zeile-${rows.length}`, href: item.href, tabindex: '-1', 'aria-selected': 'false' },
              el('span', { class: 'palette-main' }, item.area ? el('span', { class: 'palette-area', text: item.area }) : null, el('span', { class: 'palette-title', text: item.title })),
              item.hint ? el('span', { class: 'palette-hint', text: item.hint }) : null,
            );
            rows.push({ node, item });
            return node;
          }),
        ),
      ),
    );
    captureHint.hidden = known?.capture === false;
    // Vorgewählt ist die erste Zeile, aber nie ein Treffer zu einer älteren Eingabe: Enter soll nichts Veraltetes öffnen.
    const kept = keep ? rows.findIndex((r) => r.item.key === keep) : -1;
    mark(kept >= 0 ? kept : rows.findIndex((r) => !r.item.stale), { scroll: kept >= 0 });
    if (kept < 0) {
      moved = false;
      list.scrollTop = 0;
    }
  }

  /** Notizen im Vault suchen: ab zwei Zeichen, entprellt; eine neue Eingabe bricht die laufende Anfrage ab. */
  function search(q) {
    clearTimeout(timer);
    controller?.abort();
    failed = false;
    if (q.length < 2 || /^[!>]/.test(q)) {
      found = null;
      return;
    }
    if (found?.q === q) return;
    timer = setTimeout(async () => {
      const mine = (controller = new AbortController());
      try {
        const res = await fetch(`/api/suche?q=${encodeURIComponent(q)}`, { headers: { accept: 'application/json' }, credentials: 'same-origin', signal: mine.signal });
        if (!res.ok) throw new Error(String(res.status));
        const data = await res.json();
        if (mine.signal.aborted) return;
        found = { q, results: data.results ?? [], total: data.total ?? 0, notes: Boolean(data.notes), degraded: data.degraded ?? null };
      } catch {
        if (mine.signal.aborted) return;
        found = null;
        failed = true;
      }
      if (isOpen()) render();
    }, 180);
  }

  /** Einmal je Seite nachfragen, was es gibt; scheitert es (kein Netz, abgemeldet), bleibt der letzte Stand. */
  async function ask() {
    if (asked) return;
    asked = true;
    try {
      const res = await fetch('/api/palette', { headers: { accept: 'application/json' }, credentials: 'same-origin' });
      const data = res.ok ? await res.json() : null;
      if (!Array.isArray(data?.urls)) throw new Error('keine Ziele');
      known = { urls: data.urls, capture: data.capture !== false };
      try {
        localStorage.setItem(KNOWN, JSON.stringify(known));
      } catch {
        /* Dann fragt die nächste Seite eben wieder. */
      }
      if (isOpen()) render();
    } catch {
      asked = false;
    }
  }

  /** Klick (oder Enter) auf einer Zeile. Ziele und Notizen sind Links und gehen ihren Weg; Festhalten gibt vorher den Text ab. */
  function pick(e) {
    const row = rows.find((r) => r.node === (e.target instanceof Element ? e.target.closest('[role=option]') : null));
    if (!row) return;
    const text = row.item.capture;
    if (text) {
      const field = captureField();
      if (field) {
        e.preventDefault();
        close();
        put(field, text);
        return;
      }
      try {
        sessionStorage.setItem(DRAFT, JSON.stringify({ text, at: Date.now() }));
      } catch {
        // Ohne Speicher käme die Woche leer an: lieber hierbleiben, der Text steht noch im Feld.
        e.preventDefault();
        return;
      }
    }
    close();
  }

  function onKey(e) {
    // Offen gehören die Tasten der Palette: Die Kürzel der Seiten (J/K, `/`, `n`) lauschen am Dokument und bekommen nichts mit.
    e.stopPropagation();
    if (e.isComposing) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      moved = true;
      mark(active + (e.key === 'ArrowDown' ? 1 : -1));
    } else if (e.key === 'Enter' && e.target === input) {
      e.preventDefault();
      const row = rows[active];
      if (!row) return;
      // ⌘/Strg+Enter: Ziel in einem neuen Tab, wie ⌘/Strg+Klick auf einen Link.
      if ((e.metaKey || e.ctrlKey) && !row.item.capture) {
        window.open(row.node.href, '_blank', 'noopener');
        close();
      } else {
        row.node.click();
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  }

  function ensure() {
    if (dialog) return;
    input = el('input', { class: 'palette-input', type: 'text', role: 'combobox', 'aria-expanded': 'true', 'aria-controls': 'palette-liste', 'aria-autocomplete': 'list', 'aria-label': 'Springen, suchen, festhalten', placeholder: 'Springen, suchen, festhalten …', autocomplete: 'off', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false', enterkeyhint: 'go', autofocus: true });
    list = el('div', { class: 'palette-list', id: 'palette-liste', role: 'listbox', 'aria-label': 'Ergebnisse' });
    const shut = el('button', { type: 'button', class: 'palette-close', 'aria-label': 'Schließen' }, el('kbd', { text: 'Esc' }), el('span', { 'aria-hidden': 'true', text: '×' }));
    const key = (keys, text) => el('span', {}, ...keys.map((k) => el('kbd', { text: k })), ` ${text}`);
    captureHint = key(['!'], 'vorn: Aufgabe festhalten');
    dialog = el(
      'dialog',
      { class: 'palette', 'aria-label': 'Befehlspalette' },
      el('div', { class: 'palette-head' }, document.querySelector('a[data-palette] svg')?.cloneNode(true), input, shut),
      list,
      el('p', { class: 'palette-foot', 'aria-hidden': 'true' }, key(['↑', '↓'], 'wählen'), key(['↵'], 'öffnen'), captureHint),
    );
    input.addEventListener('input', () => {
      moved = false;
      search(input.value.trim());
      render();
    });
    dialog.addEventListener('keydown', onKey);
    list.addEventListener('click', pick);
    list.addEventListener('mousemove', (e) => {
      const i = rows.findIndex((r) => r.node === (e.target instanceof Element ? e.target.closest('[role=option]') : null));
      if (i < 0 || i === active) return;
      moved = true;
      mark(i, { scroll: false });
    });
    shut.addEventListener('click', close);
    // Klick daneben (auf den abgedunkelten Grund) schließt; ein Ziehen, das im Feld begann, nicht.
    let outside = false;
    dialog.addEventListener('pointerdown', (e) => (outside = e.target === dialog));
    dialog.addEventListener('click', (e) => {
      if (outside && e.target === dialog) close();
    });
    document.body.append(dialog);
  }

  /** Palette der Seite im Rahmen des Players (player.js): Die Hülle selbst ist nur Kulisse. */
  const framed = () => {
    try {
      return document.querySelector('iframe.player-frame')?.contentWindow?.cockpitPalette ?? null;
    } catch {
      return null;
    }
  };

  function open() {
    if (root.classList.contains('player-shell')) return framed()?.open();
    ensure();
    if (isOpen()) return;
    if (!dialog.isConnected) document.body.append(dialog);
    input.value = '';
    found = null;
    failed = false;
    moved = false;
    render();
    // Als Modal: Der Fokus bleibt in der Palette, der Rest der Seite ruht; Schließen gibt ihn zurück.
    if (dialog.showModal) dialog.showModal();
    else dialog.setAttribute('open', '');
    if (window.parent !== window) window.focus();
    input.focus();
    window.cockpitHaptik?.('auswahl');
    ask();
  }

  function close() {
    clearTimeout(timer);
    controller?.abort();
    if (!isOpen()) return;
    if (dialog.close) dialog.close();
    else dialog.removeAttribute('open');
  }

  const toggle = () => (root.classList.contains('player-shell') ? framed()?.toggle() : isOpen() ? close() : open());

  // In der Fangphase am `window`, vor allen anderen: ⌘K bzw. Strg+K gehört der Palette, auch wenn der Fokus in
  // einem Feld steht oder die Seite Hülle des Players ist. Auf dem Mac bleibt Strg+K, was es in Textfeldern ist.
  addEventListener(
    'keydown',
    (e) => {
      if (e.key?.toLowerCase() !== 'k' || e.altKey || e.shiftKey || e.isComposing) return;
      if (mac ? !e.metaKey || e.ctrlKey : !e.ctrlKey || e.metaKey) return;
      e.preventDefault();
      if (!e.repeat) toggle();
    },
    true,
  );

  for (const a of document.querySelectorAll('a[data-palette]')) {
    a.setAttribute('aria-haspopup', 'dialog');
    a.setAttribute('aria-keyshortcuts', mac ? 'Meta+K' : 'Control+K');
    a.title = 'Springen, suchen, festhalten';
    const kbd = a.querySelector('kbd');
    if (kbd) {
      kbd.textContent = mac ? '⌘K' : 'Strg K';
      kbd.hidden = false;
    }
  }
  document.addEventListener('click', (e) => {
    const a = e.target instanceof Element ? e.target.closest('a[data-palette]') : null;
    if (!a || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    open();
  });

  window.cockpitPalette = { open, close, toggle, fold, rank, available, build, targets: TARGETS };
})();
