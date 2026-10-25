// Ingest (src/lesen/ingest-page.js): Live-Stand und Prüfansicht.
//
// Live-Stand: Solange auf der Seite etwas entworfen wird (`[data-ingest-watch]`,
// in der Übersicht, im Stapel, in der Leseansicht, in der Prüfansicht), fragt
// die Seite alle paar Sekunden `/lesen/ingest/stand?ids=…`. Ändert sich ein
// Status, tauscht sie das Abzeichen aus (Stapel, Leseansicht), lädt die
// Übersicht neu (nur `main`) bzw. die Prüfansicht ganz. Die Zahl an „Ingest“ in
// der Unternavigation läuft mit.
//
// Prüfansicht: „alle/keine“ je Gruppe, die Zahl am Knopf „Ins Wiki übernehmen“,
// der Zähler der Summary (bis 80) und Nachfragen vor „Neu entwerfen“ und
// „Entwurf verwerfen“. Tasten: J/K nächster/voriger Entwurf, Enter zweimal =
// übernehmen (das erste macht den Knopf scharf), E = ohne Wiki erledigen,
// Escape nimmt das Scharfmachen zurück. Das Häkchen schaltet die Leertaste.
(() => {
  'use strict';

  const toast = (text, opts) => window.cockpit?.toast?.(text, opts);

  // MARK: Live-Stand

  const STAND = '/lesen/ingest/stand';
  const watched = () => [...document.querySelectorAll('[data-ingest-watch]')];
  let timer = null;

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(refresh, document.hidden ? 15000 : 4000);
  }

  function setCount(n) {
    for (const el of document.querySelectorAll('[data-ingest-count]')) {
      el.textContent = String(n);
      el.hidden = !n;
    }
  }

  async function swapMain() {
    try {
      const res = await fetch(location.href, { headers: { accept: 'text/html' }, credentials: 'same-origin', cache: 'no-store' });
      if (!res.ok) return;
      const fresh = new DOMParser().parseFromString(await res.text(), 'text/html').querySelector('main');
      const current = document.querySelector('main');
      if (fresh && current) current.replaceWith(document.adoptNode(fresh));
    } catch {
      /* beim nächsten Laden */
    }
  }

  async function refresh() {
    const els = watched();
    if (!els.length) return schedule();
    const ids = [...new Set(els.map((el) => el.dataset.ingestWatch))];
    // Mit Query: Die Leseansicht braucht ihr `?id=`, sonst führte „Ingest entwerfen“ ins Leere.
    const q = new URLSearchParams({ ids: ids.join(','), back: location.pathname + location.search });
    let data = null;
    try {
      const res = await fetch(`${STAND}?${q}`, { headers: { accept: 'application/json' }, credentials: 'same-origin', cache: 'no-store', redirect: 'manual' });
      if (res.type === 'opaqueredirect' || res.status === 401) return;
      data = res.ok ? await res.json() : null;
    } catch {
      /* kein Netz: später noch einmal */
    }
    if (data?.ok) {
      setCount(data.counts?.bereit ?? 0);
      let reloadMain = false;
      for (const item of data.items ?? []) {
        for (const el of document.querySelectorAll(`[data-ingest-watch="${CSS.escape(item.id)}"]`)) {
          if ((el.dataset.ingestStatus || '') === (item.status || '')) continue;
          if (item.status === 'bereit') toast(`Entwurf bereit: ${item.title}`);
          else if (item.status === 'fehler') toast(`Entwurf fehlgeschlagen: ${item.title}`, { kind: 'error' });
          if (el.hasAttribute('data-ingest-reload')) {
            location.reload();
            return;
          }
          if (el.matches('[data-ingest-badge]')) {
            const tpl = document.createElement('template');
            tpl.innerHTML = item.badge.trim();
            if (tpl.content.firstElementChild) el.replaceWith(tpl.content.firstElementChild);
            else el.remove();
          } else {
            reloadMain = true;
          }
        }
      }
      if (reloadMain) await swapMain();
    }
    schedule();
  }

  if (watched().length) schedule();
  // `.act`-Formulare (cockpit.js) bauen `main` neu; danach gibt es vielleicht etwas zu beobachten.
  new MutationObserver(() => {
    if (watched().length && !timer) schedule();
  }).observe(document.body, { childList: true, subtree: true });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && watched().length) refresh();
  });

  // MARK: Prüfansicht

  const form = document.querySelector('[data-ingest-form]');
  if (!form) return;

  const apply = form.querySelector('[data-ingest-apply]');
  const count = form.querySelector('[data-ingest-n]');
  const sum = form.querySelector('[data-ingest-sum]');
  const boxes = () => [...form.querySelectorAll('input[name=item]')];

  function update() {
    const n = boxes().filter((b) => b.checked).length;
    count.textContent = String(n + 1);
    sum.textContent = n ? `Source-Page und ${n} ${n === 1 ? 'Vorschlag' : 'Vorschläge'}` : 'Nur die Source-Page';
  }
  form.addEventListener('change', update);

  for (const all of form.querySelectorAll('[data-ingest-all]')) {
    all.hidden = false;
    const group = all.closest('[data-ingest-group]');
    all.addEventListener('click', (e) => {
      const b = e.target.closest('[data-select]');
      if (!b) return;
      for (const box of group.querySelectorAll('input[name=item]')) box.checked = b.dataset.select === 'all';
      update();
    });
  }

  const summary = form.querySelector('[data-ingest-summary]');
  const counter = form.querySelector('[data-ingest-count-for=summary]');
  if (summary && counter) {
    const max = Number(summary.maxLength) > 0 ? Number(summary.maxLength) : 80;
    const show = () => {
      counter.textContent = `${summary.value.length}/${max}`;
      counter.classList.toggle('is-near', summary.value.length >= max - 8);
    };
    summary.addEventListener('input', show);
    show();
  }

  form.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-confirm]');
    if (b && !window.confirm(b.dataset.confirm)) e.preventDefault();
  });

  // Doppeltes Absenden schriebe zweimal; nach dem ersten bleibt der Knopf aus.
  form.addEventListener('submit', (e) => {
    if (form.classList.contains('busy')) {
      e.preventDefault();
      return;
    }
    form.classList.add('busy');
    const by = e.submitter;
    setTimeout(() => {
      if (by) by.disabled = true;
    });
  });
  // Zurück aus dem Verlauf (bfcache): wieder bedienbar.
  addEventListener('pageshow', () => {
    form.classList.remove('busy');
    for (const b of form.querySelectorAll('button[type=submit]:not(.ingest-guard)')) b.disabled = false;
    disarm();
  });

  // Enter zweimal: das erste macht „Ins Wiki übernehmen“ scharf.
  let armed = null;
  const label = apply.innerHTML;
  function arm() {
    apply.classList.add('is-armed');
    apply.textContent = 'Enter: wirklich übernehmen';
    apply.focus({ preventScroll: false });
    armed = setTimeout(disarm, 4000);
  }
  function disarm() {
    if (!armed) return;
    clearTimeout(armed);
    armed = null;
    apply.classList.remove('is-armed');
    apply.innerHTML = label;
    update();
  }

  const go = (sel) => {
    const a = document.querySelector(sel);
    if (a) (window.cockpitWechsel ?? location.assign.bind(location))(a.href);
  };

  document.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey || e.isComposing || e.repeat) return;
    const t = e.target instanceof Element ? e.target : null;
    if (t?.closest('input:not([type=checkbox]), textarea, select, [contenteditable]')) return;
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (key === 'Escape') return disarm();
    if (key === 'Enter') {
      // Enter auf einem anderen Knopf, Link oder Aufklapper bleibt dessen Sache.
      if (t?.closest('a, summary') || (t?.closest('button') && t !== apply)) return;
      e.preventDefault();
      if (armed) {
        disarm();
        form.requestSubmit(apply);
      } else arm();
      return;
    }
    if (e.shiftKey) return;
    if (key === 'j') {
      e.preventDefault();
      go('[data-ingest-next]');
    } else if (key === 'k') {
      e.preventDefault();
      go('[data-ingest-prev]');
    } else if (key === 'e') {
      e.preventDefault();
      form.requestSubmit(form.querySelector('[data-ingest-done]'));
    }
  });

  update();
})();
