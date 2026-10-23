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
  // Einträge der Leseansicht tragen ihre Beschriftung selbst.
  const kind = (e) => (e.action ? 'Lesen' : kindOf(e.text));
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

  // Abmelden: Die gespeicherte Woche verschwindet, bevor das Formular rausgeht.
  // Der Puffer bleibt; er geht nach der nächsten Anmeldung raus.
  for (const form of document.querySelectorAll('form[action="/logout"]')) {
    form.addEventListener('submit', (e) => {
      if (form.dataset.cleared) return;
      e.preventDefault();
      forgetWeek().finally(() => {
        form.dataset.cleared = '1';
        form.submit();
      });
    });
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
      let r = await sendOne(entry, csrf);
      // Token veraltet (Sitzung inzwischen erneuert): einmal frisch holen und noch einmal.
      if (r === 'csrf') {
        csrf = await sessionToken();
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
      ? ' Markieren, Notizen, Fortschritt und Archivieren warten auf dem Gerät und gehen raus, sobald wieder Netz da ist.'
      : ' Nur die Schnelleingabe geht; sie sendet nach, sobald wieder Netz da ist.';
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

  /** Ohne Netz (oder auf einer gespeicherten Seite) gehen nur Schnelleingabe, die Entscheidungen in der Leseansicht (puffert lesen-doc.js) und Abmelden. */
  function lock(blocked) {
    for (const form of document.forms) {
      if (form.method !== 'post' || form.matches('.capture, .logout, [data-decide]')) continue;
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

  setNet(net);
  fillReading();
  reload().then(() => {
    render();
    if (stale || entries.some((e) => !e.error)) flush();
  });

  // Für cockpit.js: Schnelleingabe bei Verbindungsfehler in den Puffer.
  // Für lesen-doc.js: Aktionen puffern, wartende ansehen, offline (oder gespeicherte Seite)?
  window.cockpitPuffer = { take, flush, queue, pending: () => reload().then(() => entries), offline: () => stale || !net };
})();
