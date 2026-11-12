// Offline-Betrieb im Browser. Meldet den Service Worker (/sw.js) an, puffert
// die Schnelleingabe ohne Netz in IndexedDB und sendet sie nach, sperrt ohne
// Netz alle anderen schreibenden Formulare und zeigt, was noch wartet.
//
// Nachgesendet wird über dieselbe Route wie sonst (`/aktion/erfassen`), mit
// der ID des Eintrags als `cid`: Kommt eine Antwort nicht an und der Eintrag
// geht noch einmal raus, legt der Server nichts doppelt an. Ein Eintrag
// verlässt den Puffer erst, wenn der Server ihn angenommen hat.
//
// Die Leseansicht (lesen-doc.js) legt über `cockpitPuffer.queue` Aktionen in
// denselben Puffer (VCP-80): `{ id, action, fields, label, quiet? }`. Die ID
// ist der Schlüssel, ein neuer Eintrag mit derselben ID ersetzt den alten
// (Fortschritt, Status, Notiz: der letzte Stand gilt); neue Markierungen
// tragen ihre ID als `cid`, damit der Server sie nur einmal anlegt.
// Das CSRF-Token holt jeder Lauf frisch von `/api/sitzung`, nie ohne Netz.
//
// Abmelden leert den Puffer (VCP-87): Zitate und Notizen bleiben nicht auf
// einem Gerät liegen, das jemand bewusst verlässt. Vorher geht raus, was mit
// Netz noch rausgeht; wartet danach noch etwas, fragt die Seite nach.
//
// Einsortieren ohne Netz (VCP-144): Die Formulare in `ACTS` (Abhaken, Status,
// Fälligkeit, Zuordnen, Phönix, Ablegen, Tags, Checkbox, Eingang sortieren)
// bleiben ohne Netz bedienbar. cockpit.js gibt sie über `cockpitPuffer.act`
// in denselben Puffer, Schlüssel `akt:<Aktion>:<Aufgabe oder Notiz>`: Eine
// zweite Änderung derselben Sache ersetzt die erste. Relative Fälligkeiten
// gelten ab dem Tag des Erfassens. Die Ansicht zeigt wartende Aktionen sofort
// (`apply`), auch auf einer gespeicherten Seite, bis sie raus sind.
(() => {
  'use strict';

  const root = document.documentElement;
  // Vom Service Worker statt vom Server: die gespeicherte Woche (mit Zeitpunkt) oder die App-Hülle.
  const savedAt = root.dataset.offlineStand ?? null;
  const shellPage = document.body.classList.contains('page-offline');
  const stale = savedAt !== null || shellPage;
  // Erreicht die Seite das Cockpit? Ohne Netz ausgeliefert heißt: zunächst nein.
  let net = !stale && navigator.onLine !== false;
  let entries = [];
  let loginNeeded = false;

  // Muss zum Namen in sw.js passen.
  const PAGES = 'cockpit-seiten';
  /** Formulare, die ohne Netz in den Puffer dürfen (VCP-144): Aktion → Art in der Liste. Alle senden einen festen Zielzustand. */
  const ACTS = {
    '/aktion/status': 'Status',
    '/aktion/faellig': 'Fälligkeit',
    '/aktion/zuordnen': 'Zuordnen',
    '/aktion/phoenix': 'Phönix',
    '/aktion/notiz/ablegen': 'Ablegen',
    '/aktion/notiz/tags': 'Tags',
    '/aktion/notiz/checkbox': 'Checkbox',
    '/aktion/lesen/sortieren': 'Eingang',
  };
  const SORT = '/aktion/lesen/sortieren';
  const pathOf = (form) => new URL(form.getAttribute('action') ?? '', location.href).pathname;
  const accepts = (form) => form instanceof HTMLFormElement && Object.hasOwn(ACTS, pathOf(form));
  // So lange darf Nachsenden das Abmelden aufhalten.
  const LEAVE_WAIT = 4000;
  // Wann zuletzt Lesestoff angefordert wurde; Abmelden setzt es zurück.
  const FILLED = 'cockpit-lesen-offline';
  const forgetWeek = () => {
    try {
      localStorage.removeItem(FILLED);
    } catch {
      /* privater Modus */
    }
    return 'caches' in window ? caches.delete(PAGES).catch(() => {}) : Promise.resolve();
  };
  const toast = (message, opts) => window.cockpit?.toast(message, opts);
  const newId = () => {
    if (crypto.randomUUID) return crypto.randomUUID();
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return `${Date.now().toString(36)}-${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
  };
  const CID = /^[A-Za-z0-9_.:-]{1,128}$/;
  // Wie articleUrl in src/capture/syntax.js: `> https://…` allein wird ein Artikel.
  const kindOf = (text) => (text.trimStart().startsWith('!') ? 'Aufgabe' : /^\s*>\s*https?:\/\/\S+\s*$/i.test(text) ? 'Artikel' : 'Notiz');
  // Einträge der Leseansicht und zum Einsortieren tragen ihre Beschriftung selbst.
  const kind = (e) => (e.action ? (ACTS[e.action] ?? 'Lesen') : kindOf(e.text));
  const textOf = (e) => e.text ?? e.label ?? '';
  const when = (t) => {
    const d = new Date(t);
    return Number.isNaN(d.getTime()) ? 'unbekannt' : d.toLocaleString('de-DE', { weekday: 'short', day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' });
  };

  // --- Service Worker ---------------------------------------------------------

  if ('serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register('/sw.js').then(
      (reg) => {
        // Eine App vom Home-Bildschirm lädt oft tagelang nicht neu: beim Zurückholen nach einem Deploy sehen.
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible' && navigator.onLine) reg.update().catch(() => {});
        });
      },
      () => {},
    );
  }

  /** Bittet den Service Worker, Lesestoff für unterwegs zu speichern; mit Netz, höchstens alle zehn Minuten. */
  function fillReading() {
    const sw = navigator.serviceWorker?.controller;
    if (!sw || stale || navigator.onLine === false) return;
    try {
      if (Date.now() - Number(localStorage.getItem(FILLED) ?? 0) < 10 * 60_000) return;
      localStorage.setItem(FILLED, String(Date.now()));
    } catch {
      /* privater Modus: trotzdem, der Worker holt nur, was fehlt */
    }
    sw.postMessage({ type: 'lesen-offline' });
  }

  // Abmelden: Gespeicherte Seiten und Puffer verschwinden, bevor das Formular rausgeht.
  // Eine abgelaufene Sitzung (401 beim Nachsenden) ist kein Abmelden: Dann bleibt der Puffer.
  for (const form of document.querySelectorAll('form[action="/logout"]')) {
    form.addEventListener('submit', (e) => {
      if (form.dataset.cleared) return;
      e.preventDefault();
      if (form.dataset.busy) return;
      form.dataset.busy = '1';
      leave()
        .then((go) => {
          if (!go) return;
          form.dataset.cleared = '1';
          form.submit();
        })
        .finally(() => delete form.dataset.busy);
    });
  }

  /** Vor dem Abmelden: senden, was geht (höchstens ein paar Sekunden), Rest nur nach Rückfrage verwerfen. `false` = bleiben. */
  async function leave() {
    if (entries.length) await Promise.race([flush(), new Promise((r) => setTimeout(r, LEAVE_WAIT))]);
    await reload();
    const shown = entries.filter((e) => !e.quiet || e.error).length;
    if (shown && !window.confirm(`${shown === 1 ? 'Ein Eintrag wartet' : `${shown} Einträge warten`} noch auf Netz. Beim Abmelden ${shown === 1 ? 'wird er' : 'werden sie'} von diesem Gerät gelöscht und nicht gesendet. Trotzdem abmelden?`)) return false;
    // Ein Lauf, der noch unterwegs ist, sendet danach nichts mehr; was schon raus ist, ist raus.
    leaving = true;
    await Promise.all([forgetWeek(), clear().catch(() => {})]);
    entries = [];
    render();
    return true;
  }

  // --- Puffer (IndexedDB) ----------------------------------------------------

  let dbp = null;
  function db() {
    if (!dbp) {
      dbp = new Promise((resolve, reject) => {
        const req = indexedDB.open('cockpit-puffer', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('eintraege', { keyPath: 'id' });
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      dbp.catch(() => (dbp = null));
    }
    return dbp;
  }
  async function store(mode, fn) {
    const d = await db();
    return new Promise((resolve, reject) => {
      const tx = d.transaction('eintraege', mode);
      const req = fn(tx.objectStore('eintraege'));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = tx.onabort = () => reject(tx.error);
    });
  }
  const all = async () => ((await store('readonly', (s) => s.getAll())) ?? []).sort((a, b) => a.created - b.created);
  const save = (entry) => store('readwrite', (s) => s.put(entry));
  const drop = (id) => store('readwrite', (s) => s.delete(id));
  const stored = (id) => store('readonly', (s) => s.get(id));
  const clear = () => store('readwrite', (s) => s.clear());
  /**
   * Nach dem Senden: löschen bzw. ersetzen nur, wenn noch genau die gesendete
   * Fassung im Puffer liegt. Eine neuere (gleiche ID, anderer `rev`) bleibt stehen.
   */
  const settle = (entry, replacement = null) =>
    store('readwrite', (s) => {
      const req = s.get(entry.id);
      req.onsuccess = () => {
        const cur = req.result;
        if (!cur || (cur.rev ?? cur.created) !== (entry.rev ?? entry.created)) return;
        if (replacement) s.put(replacement);
        else s.delete(entry.id);
      };
      return req;
    });
  const reload = async () => {
    entries = await all().catch(() => entries);
  };

  /**
   * Nimmt den Text der Schnelleingabe in den Puffer, leert das Feld und
   * vergibt eine neue Erfassungs-ID. `false`, wenn das Gerät nichts speichern
   * kann; dann bleibt der Text im Feld.
   */
  async function take(form) {
    const field = form.elements.text;
    const text = field?.value ?? '';
    if (!text.trim()) return false;
    const cid = form.elements.cid;
    const entry = { id: cid && CID.test(cid.value) ? cid.value : newId(), text, created: Date.now(), error: null };
    try {
      await save(entry);
    } catch {
      return false;
    }
    field.value = '';
    field.dispatchEvent(new Event('input', { bubbles: true }));
    if (cid) cid.value = newId();
    if (!stale) setNet(false);
    await reload();
    render();
    toast(`${kindOf(text)} wartet auf Netz und geht automatisch raus.`);
    if (net) flush();
    return true;
  }

  // --- Nachsenden ------------------------------------------------------------

  /**
   * Aktion der Leseansicht in den Puffer (siehe oben); `false`, wenn das Gerät
   * nichts speichern kann. Mit Netz geht sie gleich raus.
   */
  async function queue({ id, action, fields, label, quiet = false }) {
    try {
      await save({ id, action, fields, label, quiet, created: Date.now(), rev: newId(), error: null });
    } catch {
      return false;
    }
    if (!stale && navigator.onLine === false) setNet(false);
    await reload();
    render();
    if (net) flush();
    return true;
  }

  let flushing = null;
  // Abmelden bestätigt: Der Puffer ist gelöscht, ein laufender Lauf hört auf.
  let leaving = false;
  /** Sendet, was wartet; `retry` nimmt auch Einträge mit Fehler noch einmal. Nie zwei Läufe gleichzeitig, auch nicht über Tabs. */
  function flush({ retry = false } = {}) {
    // Ohne Netz nicht einmal nach dem Token fragen (VCP-55).
    if (navigator.onLine === false) {
      setNet(false);
      return Promise.resolve();
    }
    if (!flushing) {
      const run = () => sendAll(retry);
      flushing = (navigator.locks?.request ? navigator.locks.request('cockpit-puffer', run) : run())
        .catch(() => {})
        .finally(() => (flushing = null));
    }
    return flushing;
  }

  /** Frisches CSRF-Token der Sitzung; `null` ohne Netz oder ohne gültige Sitzung. */
  async function sessionToken() {
    let res;
    try {
      res = await fetch('/api/sitzung', { headers: { accept: 'application/json' }, credentials: 'same-origin', cache: 'no-store' });
    } catch {
      setNet(false);
      return null;
    }
    if (res.status === 401) {
      // Sitzung abgelaufen: Einträge bleiben, die gespeicherte Woche nicht.
      loginNeeded = true;
      forgetWeek();
      setNet(true);
      return null;
    }
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.csrf) return null;
    loginNeeded = false;
    setNet(true);
    return data.csrf;
  }

  async function sendAll(retry) {
    await reload();
    const todo = entries.filter((e) => retry || !e.error);
    // Nichts zu senden: nur nachsehen, ob das Cockpit wieder erreichbar ist.
    if (!todo.length && net) return render();
    let csrf = await sessionToken();
    if (!csrf || !todo.length) return render();
    const sent = [];
    let failed = 0;
    for (const entry of todo) {
      if (leaving) break;
      // Inzwischen verworfen, auch in einem anderen Tab (Abmelden dort, „Verwerfen“): nicht mehr senden.
      if (!(await stored(entry.id).catch(() => null))) continue;
      let r = await sendOne(entry, csrf);
      // Token veraltet (Sitzung inzwischen erneuert): einmal frisch holen und noch einmal.
      if (r === 'csrf') {
        csrf = await sessionToken();
        if (leaving) break;
        r = csrf ? await sendOne(entry, csrf) : 'stop';
      }
      if (r === 'stop' || r === 'csrf') break;
      if (r === 'failed') failed += 1;
      else if (!entry.quiet) sent.push(r);
    }
    await reload();
    render();
    if (sent.length) toast(sent.length === 1 ? `Nachgesendet: ${sent[0]}` : `${sent.length} Einträge nachgesendet`);
    if (failed) toast(failed === 1 ? 'Ein Eintrag ließ sich nicht nachsenden. Er bleibt im Puffer, siehe Liste.' : `${failed} Einträge ließen sich nicht nachsenden. Sie bleiben im Puffer, siehe Liste.`, { kind: 'error' });
  }

  /**
   * Meldung des Servers, `'failed'` (abgelehnt, bleibt mit Fehler stehen),
   * `'csrf'` (Token veraltet) oder `'stop'` (später noch einmal).
   */
  async function sendOne(entry, csrf) {
    const [path, fields] = entry.action ? [entry.action, entry.fields] : ['/aktion/erfassen', { text: entry.text, cid: entry.id, back: '/' }];
    let res;
    try {
      res = await fetch(path, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ ...fields, csrf }),
        credentials: 'same-origin',
      });
    } catch {
      setNet(false);
      return 'stop';
    }
    const data = await res.json().catch(() => null);
    if (res.ok && data?.ok) {
      await settle(entry);
      return data.message || entry.label || `${kindOf(entry.text)} gesendet`;
    }
    if (res.status === 401) {
      loginNeeded = true;
      return 'stop';
    }
    if (res.status === 403 && data?.error === 'csrf') return 'csrf';
    // Keine Antwort vom Cockpit selbst (Proxy während eines Deploys): nichts ist passiert, später noch einmal.
    if (!data?.message && res.status >= 500) return 'stop';
    await settle(entry, { ...entry, error: data?.message || `Fehler ${res.status}`, failedAt: Date.now() });
    return 'failed';
  }

  // --- Anzeige ---------------------------------------------------------------

  const present = (children) => children.filter((c) => c !== null && c !== false && c !== undefined);
  function el(tag, props = {}, ...children) {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...present(children));
    return node;
  }
  const button = (label, run, cls = 'chip quiet') => {
    const b = el('button', { type: 'button', className: cls, textContent: label });
    b.addEventListener('click', run);
    return b;
  };
  const place = (node) => {
    const main = document.querySelector('main');
    const bar = document.querySelector('.offline-bar');
    if (node !== bar && bar?.parentElement) bar.after(node);
    else if (main) main.prepend(node);
    else document.body.prepend(node);
  };

  /** Hinweis oben: offline (mit Stand der gespeicherten Woche) oder wieder online. */
  function banner() {
    let text = null;
    let hint = document.querySelector('.lesen-reader')
      ? ' Markieren, Notizen, Fortschritt, Entfernen, In Inbox und die Entscheidungen warten auf dem Gerät und gehen raus, sobald wieder Netz da ist.'
      : ' Schnelleingabe und Einsortieren (Abhaken, Status, Fälligkeit, Zuordnen, Ablegen, Eingang) warten auf dem Gerät und gehen raus, sobald wieder Netz da ist.';
    if (stale && net) {
      text = 'Wieder online.';
      hint = ' Neu laden zeigt den aktuellen Stand.';
    } else if (!net && savedAt) text = `Offline, Stand von ${when(savedAt)}.`;
    else if (!net && !shellPage) text = 'Offline.';
    let bar = document.querySelector('.offline-bar');
    if (!text) return bar?.remove();
    if (!bar) {
      bar = el('p', { className: 'offline-bar', role: 'status' });
      place(bar);
    }
    bar.classList.toggle('back', stale && net);
    bar.replaceChildren(
      ...present([el('span', { className: 'offline-bar-text' }, el('strong', { textContent: text }), hint), stale && net ? button('Neu laden', () => location.reload(), 'btn') : null]),
    );
  }

  /** Zähler „n Einträge warten auf Netz“, darunter jeder Eintrag; Fehler bleiben stehen. */
  function render() {
    let box = document.querySelector('.puffer');
    // Stille Einträge (Lesefortschritt) gehen mit raus, stehen aber nur mit Fehler in der Liste.
    const shown = entries.filter((e) => !e.quiet || e.error);
    if (!shown.length) return box?.remove();
    const waiting = shown.filter((e) => !e.error).length;
    const failed = shown.length - waiting;
    if (!box) {
      box = el('details', { className: 'puffer' });
      place(box);
    }
    if (failed || loginNeeded) box.open = true;
    const capture = document.querySelector('form.capture');
    const parts = [];
    if (waiting) parts.push(el('span', { textContent: `${waiting} ${waiting === 1 ? 'Eintrag wartet' : 'Einträge warten'} auf Netz` }));
    if (failed) parts.push(el('span', { className: 'puffer-failed', textContent: `${waiting ? ' · ' : ''}${failed} nicht gesendet` }));
    const items = shown.map((e) => {
      const meta = `${kind(e)} · erfasst ${when(e.created)}${e.error ? ` · Nicht gesendet: ${e.error}` : ' · wartet'}`;
      const text = textOf(e);
      return el(
        'li',
        { className: e.error ? 'failed' : '' },
        el('span', { className: 'puffer-text', textContent: text.length > 280 ? `${text.slice(0, 279)}…` : text }),
        el(
          'span',
          { className: 'puffer-item-actions' },
          // Zurück ins Feld nur, was der Server abgelehnt hat: Das ist sicher nicht angekommen.
          e.error && capture && !e.action ? button('Ins Feld', () => backToField(e, capture)) : null,
          button('Verwerfen', () => discard(e), 'chip danger'),
        ),
        el('span', { className: 'meta', textContent: meta }),
      );
    });
    const login = loginNeeded
      ? el('p', { className: 'puffer-login' }, 'Die Anmeldung ist abgelaufen. ', el('a', { href: '/login?next=%2F', textContent: 'Neu anmelden' }), ', danach geht der Puffer von selbst raus. Nichts geht verloren.')
      : null;
    box.replaceChildren(
      ...present([
        el('summary', {}, ...parts),
        login,
        el('ul', {}, ...items),
        el('div', { className: 'puffer-actions' }, button(failed ? 'Erneut senden' : 'Jetzt senden', () => flush({ retry: true }), 'btn')),
      ]),
    );
  }

  async function discard(entry) {
    if (!window.confirm(`${kind(entry)} verwerfen? Der Eintrag wird nicht gesendet.`)) return;
    await drop(entry.id).catch(() => {});
    await reload();
    render();
  }

  async function backToField(entry, form) {
    const field = form.elements.text;
    if (field.value.trim() && !window.confirm('Im Feld steht schon Text. Ersetzen?')) return;
    field.value = entry.text;
    field.dispatchEvent(new Event('input', { bubbles: true }));
    await drop(entry.id).catch(() => {});
    await reload();
    render();
    field.focus();
  }

  // --- Offline sperren -------------------------------------------------------

  /** Ohne Netz (oder auf einer gespeicherten Seite) gehen nur Schnelleingabe, die Entscheidungen in der Leseansicht (puffert lesen-doc.js), Einsortieren (`ACTS`) und Abmelden. */
  function lock(blocked) {
    for (const form of document.forms) {
      if (form.method !== 'post' || form.matches('.capture, .logout, [data-decide]') || accepts(form)) continue;
      form.classList.toggle('offline-off', blocked);
      for (const field of form.elements) {
        if (blocked && !field.disabled) {
          field.disabled = true;
          field.dataset.offlineOff = '1';
        } else if (!blocked && field.dataset.offlineOff) {
          field.disabled = false;
          delete field.dataset.offlineOff;
        }
      }
    }
  }

  function setNet(value) {
    net = value;
    const blocked = stale || !net;
    root.classList.toggle('is-offline', blocked);
    lock(blocked);
    banner();
  }

  // Ohne Netz geht die Schnelleingabe direkt in den Puffer. Mit Netz schickt
  // cockpit.js wie gewohnt und reicht nur bei einem Verbindungsfehler weiter.
  document.addEventListener(
    'submit',
    (e) => {
      const form = e.target;
      if (!(form instanceof HTMLFormElement) || !form.classList.contains('capture')) return;
      if (!(stale || !net) || !form.elements.text?.value.trim()) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      take(form).then((ok) => {
        if (!ok) toast('Dieses Gerät kann gerade nichts zwischenspeichern. Der Text bleibt im Feld.', { kind: 'error' });
      });
    },
    true,
  );

  // Eine Erfassungs-ID gilt für genau einen Eintrag. Eine gespeicherte Seite
  // brächte sonst bei jedem Öffnen dieselbe ID mit.
  for (const input of document.querySelectorAll('form.capture input[name=cid]')) input.value = newId();
  // Meldungen von damals gehören nicht zum gespeicherten Stand.
  if (stale) for (const t of document.querySelectorAll('.toasts > .toast')) t.remove();

  addEventListener('online', () => {
    flush();
    fillReading();
  });
  addEventListener('offline', () => setNet(false));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      flush();
      fillReading();
    }
  });
  // Funkloch ohne `online`-Ereignis: alle 30 Sekunden nachsehen, solange etwas wartet.
  setInterval(() => {
    if (document.visibilityState === 'visible' && (!net || entries.some((e) => !e.error))) flush();
  }, 30_000);

  // --- Einsortieren ohne Netz (VCP-144) --------------------------------------

  const STATUS_LABELS = { open: 'Offen', in_progress: 'In Arbeit', blocked: 'Blockiert', done: 'Erledigt', dropped: 'Verworfen' };
  const SORT_LABELS = { weg: 'Weg', stapel: 'Auf den Stapel', lesen: 'Auf den Stapel', eingang: 'Zurück in den Eingang' };
  const pad = (n) => String(n).padStart(2, '0');
  const isoDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

  /** `heute`, `morgen`, `naechste-woche` (Montag) als Datum ab heute, wie `resolveDue` auf dem Server. */
  function fixedDue(value, today = new Date()) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    if (value === 'heute') return isoDay(d);
    if (value === 'morgen') return isoDay(new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1));
    if (value === 'naechste-woche') return isoDay(new Date(d.getFullYear(), d.getMonth(), d.getDate() + 7 - ((d.getDay() + 6) % 7)));
    return null;
  }

  /** Felder eines Formulars ohne CSRF-Token (das holt jeder Lauf frisch), dazu der gedrückte Knopf. */
  function fieldsOf(form, extra) {
    const fields = {};
    for (const [k, v] of new FormData(form)) if (k !== 'csrf' && typeof v === 'string') fields[k] = v;
    Object.assign(fields, extra);
    const day = fixedDue(fields.due);
    if (day) Object.assign(fields, { due: 'datum', date: day });
    return fields;
  }

  /** Worum es geht: Aufgabe, Karte im Eingang oder Notiz. */
  function subjectOf(form, path) {
    if (path === SORT) return document.querySelector(`.inbox-card[data-id="${CSS.escape(form.elements.id?.value ?? '')}"] .inbox-title`)?.textContent ?? '';
    return form.closest('li[data-title]')?.dataset.title ?? form.closest('.menu-panel')?.querySelector('.menu-title')?.textContent ?? document.querySelector('main h1')?.textContent ?? '';
  }

  function describe(path, fields, form) {
    if (path === '/aktion/status') return STATUS_LABELS[fields.status] ?? 'Status';
    if (path === '/aktion/faellig') return fields.due === 'datum' ? `Fällig ${new Date(`${fields.date}T12:00`).toLocaleDateString('de-DE', { weekday: 'short', day: 'numeric', month: 'numeric' })}` : 'Ohne Fälligkeit';
    if (path === '/aktion/zuordnen') return `Nach ${form.querySelector(`option[value="${CSS.escape(fields.ziel ?? '')}"]`)?.textContent ?? fields.ziel}`;
    if (path === '/aktion/phoenix') return fields.fire ? 'Phönix-Schritt' : 'Kein Phönix-Schritt';
    if (path === '/aktion/notiz/ablegen') return `Ablegen in ${fields.ordner}/${fields.name ? ` als ${fields.name}` : ''}`;
    if (path === '/aktion/notiz/tags') return fields.tags ? `Tags ${fields.tags}` : 'Tags entfernen';
    if (path === '/aktion/notiz/checkbox') return fields.erledigt === '1' ? 'Abgehakt' : 'Wieder offen';
    if (path === SORT) return SORT_LABELS[fields.ziel] ?? 'Eingang';
    return ACTS[path];
  }

  /**
   * Formular zum Einsortieren in den Puffer; `extra` ist der gedrückte Knopf.
   * `false`, wenn das Formular nicht dazugehört oder das Gerät nichts speichern kann.
   */
  async function act(form, extra = {}) {
    if (!accepts(form)) return false;
    const path = pathOf(form);
    const fields = fieldsOf(form, extra);
    const what = describe(path, fields, form);
    const subject = subjectOf(form, path).trim();
    const key = fields.id ?? fields.pfad ?? '';
    const id = `akt:${path}:${key}${path === '/aktion/notiz/checkbox' ? `:${fields.n}` : ''}`;
    if (!(await queue({ id, action: path, fields, label: subject ? `${what}: ${subject}` : what }))) return false;
    apply({ action: path, fields }, form);
    toast(`${what} wartet auf Netz und geht automatisch raus.`);
    // Die abgelegte Notiz ist nicht mehr in der Inbox: zurück dorthin, woher sie kam (die gespeicherte Woche).
    if (path === '/aktion/notiz/ablegen' && document.body.classList.contains('page-note')) {
      const back = new URL(location.href).searchParams.get('zurueck');
      location.assign(back && back.startsWith('/') && !back.startsWith('//') ? back : '/');
    }
    return true;
  }

  const tasksOf = (id) => document.querySelectorAll(`li.task[data-id="${CSS.escape(id ?? '')}"]`);
  const inboxCount = () => {
    const badge = document.querySelector('[data-inbox-count]');
    if (badge) badge.textContent = String(document.querySelectorAll('#inbox li:not([hidden])').length);
  };

  /** Zeigt eine wartende Aktion in der Ansicht. Mehrfach aufgerufen ändert sich nichts mehr. `form`: gerade abgeschickt. */
  function apply({ action, fields }, form = null) {
    if (action === '/aktion/status') {
      for (const li of tasksOf(fields.id)) {
        li.className = li.className.replace(/\bstatus-\S+/, `status-${fields.status}`);
        li.dataset.status = fields.status;
        const tick = li.querySelector('form.tick');
        if (tick) {
          const done = fields.status === 'done';
          tick.elements.status.value = done ? 'open' : 'done';
          tick.elements.prev.value = fields.status;
          tick.querySelector('button')?.setAttribute('aria-pressed', String(done));
        }
        // Erledigt oder verworfen ist nicht mehr in der Inbox.
        if (li.closest('[data-list="zunder-inbox"]') && (fields.status === 'done' || fields.status === 'dropped')) li.hidden = true;
      }
    } else if (action === '/aktion/zuordnen') {
      for (const li of tasksOf(fields.id)) if (li.closest('[data-list="zunder-inbox"]') && fields.ziel !== 'inbox') li.hidden = true;
    } else if (action === '/aktion/notiz/ablegen') {
      for (const a of document.querySelectorAll('[data-list="vault-inbox"] li.note a[href^="/notiz?"]')) {
        if (new URL(a.getAttribute('href'), location.href).searchParams.get('pfad') === fields.pfad) a.closest('li').hidden = true;
      }
    } else if (action === '/aktion/notiz/checkbox' && form) {
      const button = form.querySelector('button.box');
      button?.classList.toggle('on', fields.erledigt === '1');
      button?.setAttribute('aria-pressed', String(fields.erledigt === '1'));
      if (form.elements.erledigt) form.elements.erledigt.value = fields.erledigt === '1' ? '0' : '1';
    } else if (action === SORT && fields.ziel !== 'eingang') {
      advance(fields.id);
    }
    for (const li of document.querySelectorAll('details.menu[open]')) li.open = false;
    inboxCount();
  }

  /**
   * Eingang: Die entschiedene Karte geht, die nächste noch nicht entschiedene aus
   * `template.inbox-next` kommt (src/lesen/inbox.js). Rückgängig und Ablegen
   * gehören zur Karte von vorher bzw. brauchen Netz und verschwinden.
   */
  function advance(id) {
    const card = document.querySelector(`.inbox-card[data-id="${CSS.escape(id ?? '')}"]`);
    const form = document.querySelector('form.inbox-decide');
    if (!card || !form) return;
    const decided = new Set(entries.filter((e) => e.action === SORT && e.fields?.ziel !== 'eingang').map((e) => e.fields.id));
    decided.add(id);
    let next = null;
    for (const c of document.querySelector('template.inbox-next')?.content.querySelectorAll('.inbox-card') ?? []) {
      c.remove();
      if (!decided.has(c.dataset.id)) {
        next = c;
        break;
      }
    }
    const bar = document.querySelector('.inbox-progress progress');
    if (bar) {
      const max = Number(bar.getAttribute('max'));
      const seen = Math.min(max, Number(bar.getAttribute('value')) + 1);
      bar.setAttribute('value', String(seen));
      bar.textContent = `${seen} von ${max}`;
      const meta = bar.parentElement.querySelector('.meta');
      if (meta) meta.textContent = `Heute ${seen} von ${max} gesichtet`;
    }
    document.querySelector('.inbox-row')?.remove();
    if (next) {
      card.replaceWith(document.importNode(next, true));
      form.elements.id.value = next.dataset.id;
    } else {
      const empty = el('div', { className: 'inbox-empty' }, el('p', { className: 'inbox-empty-title', textContent: 'Eingang leer' }), el('p', { className: 'meta', textContent: 'Für mehr Karten braucht es wieder Netz.' }));
      card.replaceWith(empty);
      form.remove();
    }
  }

  /** Wartende Aktionen in die gerade geladene Seite übernehmen (etwa die gespeicherte Woche). */
  function applyPending() {
    for (const e of entries) if (!e.error && Object.hasOwn(ACTS, e.action ?? '')) apply(e);
  }

  // --- Gespeicherte Leseseite -------------------------------------------------

  /**
   * Seitenleiste und Stapel einer gespeicherten Seite: Artikel, die nicht im
   * Cache liegen, öffnen ohne Netz nur die Hülle; sie verschwinden aus der
   * Liste, ein Hinweis sagt, wie viele fehlen. Schlüssel wie `readingKey` in sw.js.
   */
  async function onlySaved() {
    if (!savedAt || !('caches' in window)) return;
    let cache;
    try {
      cache = await caches.open(PAGES);
    } catch {
      return;
    }
    const lists = new Map();
    for (const a of document.querySelectorAll('.lesen-stack li a[href], .lesen-list li a[href]')) {
      const url = new URL(a.getAttribute('href'), location.href);
      const id = url.pathname === '/lesen/doc' ? url.searchParams.get('id') : null;
      if (!id || (await cache.match(`/lesen/doc?id=${encodeURIComponent(id)}`))) continue;
      const li = a.closest('li');
      if (li.hidden) continue;
      li.hidden = true;
      const list = li.parentElement;
      lists.set(list, (lists.get(list) ?? 0) + 1);
    }
    for (const [list, n] of lists) {
      list.after(el('p', { className: 'meta offline-missing', textContent: `${n} ${n === 1 ? 'Artikel ist' : 'Artikel sind'} nicht offline gespeichert.` }));
    }
  }

  setNet(net);
  fillReading();
  onlySaved();
  reload().then(() => {
    render();
    applyPending();
    if (stale || entries.some((e) => !e.error)) flush();
  });

  // Für cockpit.js: Schnelleingabe bei Verbindungsfehler in den Puffer.
  // Für lesen-doc.js: Aktionen puffern, wartende ansehen, offline (oder gespeicherte Seite)?
  // Für cockpit.js: Einsortieren (`accepts`, `act`) ohne Netz in den Puffer (VCP-144).
  window.cockpitPuffer = { take, flush, queue, act, accepts, pending: () => reload().then(() => entries), offline: () => stale || !net };
})();
