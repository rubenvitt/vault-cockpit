// Feeds (src/lesen/feeds-page.js, VCP-110): viele Feeds auf einmal bearbeiten.
// Suche und „Nur mit Fehlern“ blenden Feeds aus, „Alle auswählen“ hakt die
// sichtbaren eines Abschnitts (oder der ganzen Seite) ab, Umschalt-Klick einen
// Bereich. Die Leiste unten erscheint erst, wenn etwas abgehakt ist, und zählt
// mit. Entfernen fragt im Dialog nach; ohne dieses Script fragt die Seite
// `/lesen/feeds/entfernen`.
(() => {
  'use strict';

  const bulk = document.querySelector('[data-feed-bulk]');
  if (!bulk) return;
  const picks = () => [...document.querySelectorAll('.feed-pick')];
  const visible = (el) => !el.closest('[hidden]');
  const count = bulk.querySelector('[data-zahl]');
  const apply = bulk.querySelector('button[type=submit]');
  const words = (n) => `${n} ${n === 1 ? 'Feed' : 'Feeds'}`;

  // Suche und Filter gibt es nur mit Script.
  const filter = document.querySelector('[data-feed-filter]');
  const search = filter?.querySelector('[data-suche]');
  const onlyFailing = filter?.querySelector('[data-nur-fehler]');
  const hits = document.querySelector('[data-treffer]');
  if (filter) filter.hidden = false;
  for (const el of document.querySelectorAll('.feed-pick-all')) el.hidden = false;

  /** Häkchen „Alle“ zeigt, ob alle, einige oder keine sichtbaren Feeds seines Abschnitts abgehakt sind. */
  function syncAll() {
    for (const box of document.querySelectorAll('[data-alle]')) {
      const scope = box.closest('[data-gruppe]') ?? document;
      const shown = [...scope.querySelectorAll('.feed-pick')].filter(visible);
      const on = shown.filter((p) => p.checked).length;
      box.checked = shown.length > 0 && on === shown.length;
      box.indeterminate = on > 0 && on < shown.length;
      box.disabled = !shown.length;
    }
  }

  function update() {
    const n = picks().filter((p) => p.checked).length;
    bulk.hidden = n === 0;
    count.textContent = `${words(n)} ausgewählt`;
    apply.disabled = n === 0;
    syncAll();
  }

  function runFilter() {
    const q = (search?.value ?? '').trim().toLocaleLowerCase('de');
    const failing = Boolean(onlyFailing?.checked);
    let shown = 0;
    for (const li of document.querySelectorAll('li.feed[data-suche]')) {
      const ok = (!q || li.dataset.suche.includes(q)) && (!failing || 'fehler' in li.dataset);
      li.hidden = !ok;
      if (ok) shown += 1;
    }
    // Gruppen ohne Treffer weg, solange gefiltert wird.
    for (const g of document.querySelectorAll('[data-gruppe]')) g.hidden = Boolean(q || failing) && !g.querySelector('li.feed:not([hidden])');
    if (hits) {
      hits.hidden = !(q || failing);
      hits.textContent = shown ? `${words(shown)} gefunden` : 'Kein Feed passt.';
    }
    syncAll();
  }

  search?.addEventListener('input', runFilter);
  onlyFailing?.addEventListener('change', runFilter);

  let last = null;
  document.addEventListener('click', (e) => {
    const box = e.target;
    if (!(box instanceof HTMLInputElement)) return;
    if (box.matches('[data-alle]')) {
      const scope = box.closest('[data-gruppe]') ?? document;
      for (const p of scope.querySelectorAll('.feed-pick')) if (visible(p)) p.checked = box.checked;
      last = null;
      update();
      return;
    }
    if (!box.classList.contains('feed-pick')) return;
    // Umschalt: alles Sichtbare zwischen dem letzten und diesem Häkchen gleich setzen.
    if (e.shiftKey && last && last !== box) {
      const list = picks().filter(visible);
      const [a, b] = [list.indexOf(last), list.indexOf(box)].sort((x, y) => x - y);
      if (a >= 0) for (const p of list.slice(a, b + 1)) p.checked = box.checked;
    }
    last = box;
    update();
  });

  // Entfernen fragt nach; die Antwort geht als `bestaetigt` mit, dann keine zweite Rückfrage.
  bulk.addEventListener('submit', (e) => {
    const confirmed = bulk.querySelector('input[name=bestaetigt]');
    confirmed?.remove();
    if (bulk.elements.tun.value !== 'entfernen') return;
    const n = picks().filter((p) => p.checked).length;
    if (!window.confirm(`${words(n)} entfernen? Gespeicherte Artikel bleiben, es kommen nur keine neuen mehr.`)) {
      e.preventDefault();
      return;
    }
    const field = document.createElement('input');
    field.type = 'hidden';
    field.name = 'bestaetigt';
    field.value = '1';
    bulk.append(field);
  });

  // Einzelnes Entfernen (Feed, Gruppe) fragt ebenfalls nach.
  document.addEventListener('submit', (e) => {
    const form = e.target;
    if (!(form instanceof HTMLFormElement) || !form.dataset.confirm || form.classList.contains('act')) return;
    if (!window.confirm(form.dataset.confirm)) e.preventDefault();
  });

  // Zurück aus dem Verlauf: abgehakte Felder stellt der Browser wieder her.
  addEventListener('pageshow', () => {
    runFilter();
    update();
  });
  update();
})();
