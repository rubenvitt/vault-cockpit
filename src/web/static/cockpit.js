// Progressive Enhancement für das Web-Cockpit. Ohne dieses Script funktioniert
// alles über normale Formulare mit Weiterleitung; mit ihm passieren Abhaken,
// Erfassen und die Aktionen in den Menüs ohne Seitenwechsel, mit Rückmeldung
// und Rückgängig.
(() => {
  'use strict';

  const toasts = document.querySelector('.toasts');

  // Notizseite: Die Herkunft (Inbox, Graph …) kommt in die Adresse, damit das Neuladen nach einer Aktion sie behält.
  const zurueck = document.querySelector('[data-zurueck]')?.dataset.zurueck;
  if (zurueck) {
    const here = new URL(location.href);
    if (!here.searchParams.has('zurueck')) {
      here.searchParams.set('zurueck', zurueck);
      history.replaceState(history.state, '', here);
    }
  }
  // Rückmeldung bei Seitenwechseln und Haptik in der App: `/static/ui.js` auf jeder Seite.
  const haptik = (art) => window.cockpitHaptik?.(art);
  const go = (url) => (window.cockpitWechsel ? window.cockpitWechsel(url) : location.assign(url));

  function post(form, extra = {}) {
    const body = new URLSearchParams(new FormData(form));
    for (const [k, v] of Object.entries(extra)) body.set(k, v);
    return send(form.action, body);
  }

  async function send(url, body) {
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
        body,
        credentials: 'same-origin',
      });
    } catch {
      // `offline`: Die Anfrage kam nicht durch; die Schnelleingabe gibt dann an den Puffer ab (offline.js).
      throw Object.assign(new Error('Keine Verbindung zum Cockpit. Nichts gespeichert.'), { offline: true });
    }
    let data = null;
    try {
      data = await res.json();
    } catch {
      /* leer */
    }
    if (!res.ok || !data?.ok) {
      // `expired`: Sitzung abgelaufen; Textformulare gehen dann den Weg ohne JavaScript (fallBack).
      throw Object.assign(new Error(data?.message || `Fehler ${res.status}. Nichts gespeichert.`), { expired: res.status === 401 });
    }
    return data;
  }

  /** Aktionen, deren Text der Server über den Login rettet (wie `DRAFT_ACTIONS` in http.js). */
  const DRAFT_ACTIONS = new Set(['/aktion/erfassen', '/aktion/notiz/anhaengen']);

  /**
   * Abgelaufene Sitzung bei einem Formular mit Text: noch einmal als normales
   * Formular absenden. Der Server legt den Text verschlüsselt ab, schickt über
   * den Login und stellt ihn danach wieder ins Feld (VCP-57). `false`, wenn
   * das Formular keinen Text trägt und die Meldung reicht.
   */
  function fallBack(form, err) {
    const text = form.elements.text;
    if (!err.expired || !DRAFT_ACTIONS.has(new URL(form.action, location.href).pathname)) return false;
    if (!(text instanceof HTMLTextAreaElement) || !text.value.trim()) return false;
    toast('Die Anmeldung ist abgelaufen. Der Text kommt mit über den Login.');
    // Die Methode des Formulars selbst: löst kein `submit` aus, also auch nicht diesen Weg noch einmal.
    HTMLFormElement.prototype.submit.call(form);
    return true;
  }

  // --- Meldungen ------------------------------------------------------------

  function toast(message, { kind = 'ok', action = null } = {}) {
    if (!toasts) return;
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    const text = document.createElement('span');
    text.className = 'toast-text';
    text.textContent = message;
    el.append(text);
    if (action) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'toast-action';
      b.textContent = action.label;
      b.addEventListener('click', () => {
        dismiss(el);
        action.run();
      });
      el.append(b);
    }
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'toast-close';
    close.setAttribute('aria-label', 'Schließen');
    close.textContent = '×';
    close.addEventListener('click', () => dismiss(el));
    el.append(close);
    toasts.append(el);
    // Fehler bleiben stehen, bis man sie schließt: nichts soll still verschwinden.
    if (kind !== 'error') autoDismiss(el);
    while (toasts.children.length > 4) toasts.firstElementChild.remove();
  }

  function autoDismiss(el, ms = 6000) {
    let timer = setTimeout(() => dismiss(el), ms);
    el.addEventListener('mouseenter', () => clearTimeout(timer));
    el.addEventListener('mouseleave', () => (timer = setTimeout(() => dismiss(el), 2500)));
  }

  function dismiss(el) {
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 200);
  }

  // Meldungen vom Server (Weg ohne JavaScript) verschwinden genauso.
  for (const el of document.querySelectorAll('.toast.ok')) autoDismiss(el);
  for (const b of document.querySelectorAll('.toast-close')) b.addEventListener('click', () => dismiss(b.closest('.toast')));

  // --- Abhaken --------------------------------------------------------------

  function recount(li) {
    const rock = li.closest('.rock');
    const count = rock?.querySelector('[data-count]');
    if (!count) return;
    const items = rock.querySelectorAll('li.task');
    const done = rock.querySelectorAll('li.task.status-done').length;
    count.textContent = `${done}/${items.length}`;
    const bar = rock.querySelector('progress');
    if (bar) {
      bar.max = items.length;
      bar.value = done;
    }
    rock.classList.toggle('all-done', items.length > 0 && done === items.length);
  }

  // Dieselbe Aufgabe kann zweimal auf der Seite stehen (Heute und Big Rocks): beide folgen.
  function copiesOf(li) {
    const id = li.dataset.id;
    const all = id ? [...document.querySelectorAll(`li.task[data-id="${CSS.escape(id)}"]`)].filter((c) => c.querySelector('form.tick')) : [];
    return all.includes(li) ? all : [li, ...all];
  }

  function show(li, status) {
    for (const copy of copiesOf(li)) showOne(copy, status);
  }

  function showOne(li, status) {
    li.className = li.className.replace(/\bstatus-\S+/, `status-${status}`);
    li.dataset.status = status;
    const form = li.querySelector('form.tick');
    const button = form.querySelector('button');
    const done = status === 'done';
    form.elements.status.value = done ? 'open' : 'done';
    form.elements.prev.value = status;
    button.setAttribute('aria-pressed', String(done));
    button.setAttribute('aria-label', `${done ? 'Wieder öffnen' : 'Abhaken'}: ${li.dataset.title}`);
    // Das Statusmenü der Kopie mitziehen, sonst schickt es ein veraltetes prev.
    const menu = li.querySelector('form[action="/aktion/status"]:not(.tick)');
    if (menu) {
      menu.elements.prev.value = status;
      for (const chip of menu.querySelectorAll('button[name="status"]')) {
        const current = chip.value === status;
        chip.disabled = current;
        if (current) chip.setAttribute('aria-current', 'true');
        else chip.removeAttribute('aria-current');
      }
    }
    recount(li);
  }

  async function setStatus(li, status) {
    const form = li.querySelector('form.tick');
    const before = li.dataset.status;
    // Eine Änderung je Aufgabe auf einmal, auch über ihre Kopien hinweg.
    const copies = copiesOf(li);
    if (copies.some((c) => c.classList.contains('busy'))) return;
    for (const c of copies) c.classList.add('busy');
    show(li, status);
    if (status === 'done') li.classList.add('just-done');
    try {
      if (status === 'done') haptik('erfolg');
      const data = await post(form, { status, prev: before });
      show(li, data.task.status);
      const undo = data.undo;
      toast(data.message, undo ? { action: { label: 'Rückgängig', run: () => (li.isConnected ? setStatus(li, undo.fields.status) : replay(undo)) } } : {});
    } catch (err) {
      show(li, before);
      haptik('fehler');
      toast(err.message, { kind: 'error' });
    } finally {
      for (const c of copies) c.classList.remove('busy');
      setTimeout(() => li.classList.remove('just-done'), 700);
    }
  }

  document.addEventListener('submit', (e) => {
    const form = e.target;
    if (!(form instanceof HTMLFormElement) || !form.classList.contains('tick')) return;
    e.preventDefault();
    setStatus(form.closest('li'), form.elements.status.value);
  });

  // --- Menüs: Status, Fälligkeit und weitere Aktionen ----------------------

  const csrf = () => document.querySelector('input[name=csrf]')?.value ?? '';

  function closeMenus(except = null) {
    for (const d of document.querySelectorAll('details.menu[open]')) if (d !== except) d.open = false;
  }

  // Immer nur ein Menü offen; Klick daneben oder Escape schließt.
  document.addEventListener('toggle', (e) => {
    if (!(e.target instanceof HTMLDetailsElement && e.target.classList.contains('menu') && e.target.open)) return;
    closeMenus(e.target);
    haptik('auswahl');
  }, true);
  document.addEventListener('click', (e) => {
    if (!(e.target instanceof Element) || !e.target.closest('details.menu')) closeMenus();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const open = document.querySelector('details.menu[open]');
    if (!open) return;
    open.open = false;
    open.querySelector('summary')?.focus();
  });

  /**
   * Holt die Seite neu und tauscht `main` aus, damit eine geänderte Aufgabe
   * dort steht, wo sie jetzt hingehört (z. B. nicht mehr überfällig).
   */
  async function refresh() {
    try {
      const res = await fetch(location.href, { headers: { accept: 'text/html' }, credentials: 'same-origin' });
      if (!res.ok) return;
      const fresh = new DOMParser().parseFromString(await res.text(), 'text/html').querySelector('main');
      const current = document.querySelector('main');
      if (fresh && current) current.replaceWith(document.adoptNode(fresh));
    } catch {
      /* Die Meldung ist schon da; die Ansicht holt beim nächsten Laden auf. */
    }
  }

  /** Rückgängig: schickt das Formular, das den alten Stand wiederherstellt. */
  async function replay(undo) {
    try {
      const data = await send(undo.action, new URLSearchParams({ ...undo.fields, csrf: csrf() }));
      if (data.redirect) {
        go(data.redirect);
        return;
      }
      toast(data.message);
      await refresh();
    } catch (err) {
      toast(err.message, { kind: 'error' });
    }
  }

  document.addEventListener('submit', async (e) => {
    const form = e.target;
    if (!(form instanceof HTMLFormElement) || !form.classList.contains('act')) return;
    e.preventDefault();
    if (form.classList.contains('busy')) return;
    const extra = {};
    if (e.submitter?.name) extra[e.submitter.name] = e.submitter.value;
    if (form.dataset.confirm && !window.confirm(form.dataset.confirm)) return;
    form.classList.add('busy');
    const fromToast = form.closest('.toast');
    try {
      const data = await post(form, extra);
      // Die Notiz liegt jetzt woanders: dorthin, die Meldung kommt vom Server mit.
      if (data.redirect) {
        go(data.redirect);
        return;
      }
      if (fromToast) dismiss(fromToast);
      if (form.elements.text instanceof HTMLTextAreaElement) form.elements.text.value = '';
      closeMenus();
      toast(data.message, data.undo ? { action: { label: 'Rückgängig', run: () => replay(data.undo) } } : {});
      await refresh();
      tick();
    } catch (err) {
      if (fallBack(form, err)) return;
      // Funkloch in der Leseansicht: Die Entscheidung geht in den Offline-Puffer (lesen-doc.js), statt verloren.
      if (!(err.offline && (await window.cockpitLesen?.decision(form)))) toast(err.message, { kind: 'error' });
    } finally {
      form.classList.remove('busy');
    }
  });

  // --- Laufende Flamme: Timer ----------------------------------------------

  const pad = (n) => String(n).padStart(2, '0');
  function tick() {
    for (const el of document.querySelectorAll('[data-since]')) {
      const s = Math.max(0, Math.floor((Date.now() - Date.parse(el.dataset.since)) / 1000));
      if (Number.isNaN(s)) continue;
      const h = Math.floor(s / 3600);
      el.textContent = `${h ? `${h}:` : ''}${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`;
    }
  }
  tick();
  setInterval(tick, 1000);

  // --- Schnelleingabe -------------------------------------------------------

  const capture = document.querySelector('form.capture');
  if (capture) {
    const field = capture.elements.text;
    const button = capture.querySelector('button[type=submit]');
    const newId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);

    const mode = () => {
      const task = field.value.trimStart().startsWith('!');
      capture.dataset.mode = task ? 'task' : 'note';
      (button.querySelector('.capture-label') ?? button).textContent = task ? 'Aufgabe anlegen' : 'Notiz anlegen';
    };
    const grow = () => {
      // Leer bleibt das Feld einzeilig, auch wenn der Platzhalter auf dem iPhone länger ist.
      if (!field.value) {
        field.style.height = '';
        return;
      }
      field.style.height = 'auto';
      field.style.height = `${Math.min(field.scrollHeight, 240)}px`;
    };
    field.addEventListener('input', () => {
      mode();
      grow();
    });
    mode();
    grow();

    field.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        capture.requestSubmit();
      } else if (e.key === 'Escape') {
        field.blur();
      }
    });

    capture.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!field.value.trim()) {
        capture.classList.remove('nudge');
        void capture.offsetWidth;
        capture.classList.add('nudge');
        field.focus();
        return;
      }
      if (capture.classList.contains('busy')) return;
      capture.classList.add('busy');
      button.disabled = true;
      try {
        const sent = field.value;
        const data = await post(capture);
        field.value = '';
        capture.elements.cid.value = newId();
        mode();
        grow();
        prepend(data.result, sent);
        toast(data.message, data.result.kind === 'task' && data.result.url ? { action: { label: 'Öffnen', run: () => window.open(data.result.url, '_blank', 'noopener') } } : {});
      } catch (err) {
        // Ohne Verbindung nimmt der Offline-Puffer den Text mit derselben Erfassungs-ID und sendet ihn später.
        // Sonst bleibt der Text im Feld; dieselbe Erfassungs-ID verhindert Doppelte beim erneuten Senden.
        // Abgelaufene Sitzung: der Text geht als Formular über den Login und steht danach wieder im Feld.
        if (fallBack(capture, err)) return;
        if (!(err.offline && (await window.cockpitPuffer?.take(capture)))) toast(err.message, { kind: 'error' });
      } finally {
        capture.classList.remove('busy');
        button.disabled = false;
      }
    });

    // `/` oder `n` springt in die Schnelleingabe, wenn nicht gerade getippt wird.
    document.addEventListener('keydown', (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target;
      if (t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      if (e.key === '/' || e.key === 'n') {
        e.preventDefault();
        field.focus();
      }
    });
  }

  // --- Vorschau der Schnelleingabe ------------------------------------------

  // Zeigt unter dem Feld, wo eine Aufgabe landet („Aufgabe · morgen ·
  // Gesundheit“), bevor Enter sie anlegt, und dass `> https://…` ein Artikel
  // für den Lesestapel wird. Gerechnet wird auf dem Server, mit derselben Logik
  // wie beim Anlegen; Notizen bekommen keine Vorschau.
  const preview = document.querySelector('[data-capture-preview]');
  const previewForm = preview && document.querySelector('form.capture');
  if (preview && previewForm) {
    const field = previewForm.elements.text;
    let timer = null;
    let seq = 0;
    const hide = () => {
      seq++;
      preview.hidden = true;
      preview.textContent = '';
    };
    const update = async () => {
      const text = field.value.trimStart();
      if (!/^[!>]/.test(text) || !text.slice(1).trim()) return hide();
      // Ohne Netz rechnet niemand die Vorschau; der Puffer wertet den Text später aus.
      if (!navigator.onLine) return hide();
      const mine = ++seq;
      let data;
      try {
        const res = await fetch(`/api/erfassen/vorschau?text=${encodeURIComponent(text.slice(0, 500))}`, { headers: { accept: 'application/json' }, credentials: 'same-origin' });
        if (!res.ok) throw new Error();
        data = await res.json();
      } catch {
        if (mine === seq) hide();
        return;
      }
      if (mine !== seq) return;
      if (data.kind !== 'task' && data.kind !== 'article') return hide();
      const line = document.createElement('span');
      line.textContent = data.summary;
      preview.replaceChildren(line);
      if (data.notes?.length) {
        const hint = document.createElement('span');
        hint.className = 'hint';
        hint.textContent = ` · ${data.notes.join(' ')}`;
        preview.append(hint);
      }
      preview.hidden = false;
    };
    field.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(update, 250);
    });
    // Nach dem Absenden ist das Feld leer (oder hat bei einem Fehler noch den Text).
    new MutationObserver(() => {
      if (!previewForm.classList.contains('busy')) update();
    }).observe(previewForm, { attributes: true, attributeFilter: ['class'] });
    update();
  }

  // Für `/static/graph.js`: Meldungen und Aktionen im gleichen Stil.
  window.cockpit = { toast, send, csrf };

  function prepend(result, sent) {
    // Eine Aufgabe mit Ziel (`#gesundheit`) liegt nicht in der Inbox, ein Artikel im Lesestapel.
    if (!result || result.duplicate || result.kind === 'article' || (result.kind === 'task' && result.location && result.location.kind !== 'inbox')) return;
    const list = document.querySelector(`ul[data-list="${result.kind === 'task' ? 'zunder-inbox' : 'vault-inbox'}"]`);
    if (!list) return;
    list.parentElement.querySelector(`[data-empty="${list.dataset.list}"]`)?.remove();
    list.hidden = false;
    const count = document.querySelector('[data-inbox-count]');
    if (count) count.textContent = String(Number(count.textContent) + 1);
    const li = document.createElement('li');
    li.className = result.kind === 'task' ? 'task status-open fresh' : 'note fresh';
    const firstLine = sent.trim().replace(/^!\s*/, '').split(/\r?\n/)[0].trim();
    const label = result.kind === 'task' ? result.title || firstLine || 'Neue Aufgabe' : result.path.split('/').pop().replace(/\.md$/i, '').replace(/^\d{4}-\d{2}-\d{2} \d{4} - /, '');
    if (result.kind === 'task') {
      const mark = document.createElement('span');
      mark.className = 'mark';
      mark.textContent = '○';
      li.append(mark);
    }
    const body = document.createElement('span');
    body.className = 'body';
    if (result.url) {
      const a = document.createElement('a');
      a.href = result.url;
      a.textContent = label;
      body.append(a);
    } else {
      body.append(document.createTextNode(label));
    }
    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = result.kind === 'task' ? (result.ref ?? 'Zunder-Inbox') : result.path;
    body.append(meta);
    li.append(body);
    list.prepend(li);
  }
})();
