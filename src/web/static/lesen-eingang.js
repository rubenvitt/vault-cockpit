// Eingang sortieren (/lesen/eingang, src/lesen/inbox.js) und Wiedersehen
// (/lesen/wiedersehen, src/lesen/review-page.js): Wischen und Tasten sind nur
// Abkürzungen für die Knöpfe. Abschicken, Meldung mit Rückgängig und das
// Nachladen von `main` übernimmt cockpit.js (Formular `.act`); deshalb hängt
// alles am Dokument und sucht Karte und Formular jedes Mal neu.
//
// Das Formular `form.wisch` nennt die Ziele je Richtung (`data-links`,
// `data-rechts`, `data-unten`); die Tasten stehen an den Knöpfen
// (`aria-keyshortcuts`), auch an anderen Formularen wie „Rückgängig“ (Z) und
// an einem `summary` (öffnet es und setzt den Fokus ins Textfeld).
(() => {
  'use strict';

  const EDGE = 24; // Berührungen am Bildschirmrand gehören der Zurück-Geste von iOS.
  const LOCK = 32; // Erst ab dieser Strecke steht die Richtung fest.
  const COMMIT = 0.3; // Anteil der Kartenbreite (seitlich) bzw. -höhe (nach unten) zum Auslösen.

  const decideForm = () => document.querySelector('form.wisch');
  /** Richtung (`links`, `rechts`, `unten`) oder null; nur Richtungen mit Ziel zählen. */
  function toward(card, dx, dy) {
    const form = decideForm();
    const dir = dx < -card.offsetWidth * COMMIT ? 'links' : dx > card.offsetWidth * COMMIT ? 'rechts' : dy > card.offsetHeight * COMMIT ? 'unten' : null;
    return dir && form?.dataset[dir] ? dir : null;
  }
  const directionOf = (form, ziel) => ['links', 'rechts', 'unten'].find((d) => form.dataset[d] === ziel) ?? null;

  /** Schickt die Entscheidung über den passenden Knopf ab; die Karte fliegt in ihre Richtung. */
  function decide(ziel) {
    const form = decideForm();
    const button = form?.querySelector(`button[value="${ziel}"]`);
    if (!button || form.classList.contains('busy')) return;
    const card = document.querySelector('.inbox-card');
    const fly = `fly-${directionOf(form, ziel) ?? 'rechts'}`;
    card?.classList.add(fly);
    if (card) card.style.transform = '';
    const toasts = document.querySelector('.toasts');
    const before = toasts?.lastElementChild;
    form.requestSubmit(button);
    if (!card) return;
    // Nur eine neue Fehlermeldung von cockpit.js heißt „nicht gespeichert“: Karte zurück.
    // (Nach „Jetzt lesen“ ist das Formular bis zum Seitenwechsel noch da.)
    new MutationObserver((_, watcher) => {
      if (form.classList.contains('busy')) return;
      watcher.disconnect();
      const last = toasts?.lastElementChild;
      if (last && last !== before && last.classList.contains('error')) card.classList.remove(fly);
    }).observe(form, { attributes: true, attributeFilter: ['class'] });
  }

  // Zurück aus der Leseansicht (bfcache): Die Karte von damals ist schon entschieden.
  addEventListener('pageshow', (e) => {
    if (e.persisted) location.reload();
  });

  // --- Wischen: Ziele aus `form.wisch` (Eingang: ← weg, ↓ Stapel, → lesen) ---

  let drag = null;
  let swallowClick = false;

  document.addEventListener('pointerdown', (e) => {
    const card = e.target instanceof Element ? e.target.closest('.inbox-card') : null;
    if (!card || e.pointerType === 'mouse' || !e.isPrimary || decideForm()?.classList.contains('busy')) return;
    if (e.clientX < EDGE || e.clientX > innerWidth - EDGE) return;
    drag = { card, id: e.pointerId, x: e.clientX, y: e.clientY, axis: null, dx: 0, dy: 0 };
  });

  document.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (!drag.axis) {
      if (Math.hypot(dx, dy) < LOCK) return;
      // Nur eine klar überwiegende Richtung zählt; schräg bleibt die Karte liegen.
      // Nach unten nur, wo es ein Ziel gibt (im Wiedersehen scrollt die Seite).
      drag.axis = Math.abs(dx) > 1.5 * Math.abs(dy) ? 'x' : dy > 1.5 * Math.abs(dx) && decideForm()?.dataset.unten ? 'y' : null;
      if (!drag.axis) {
        drag = null;
        return;
      }
      drag.card.classList.add('dragging');
    }
    drag.dx = drag.axis === 'x' ? dx : 0;
    drag.dy = drag.axis === 'y' ? Math.max(0, dy) : 0;
    drag.card.style.transform = `translate(${drag.dx}px, ${drag.dy}px) rotate(${drag.dx / 30}deg)`;
    const next = toward(drag.card, drag.dx, drag.dy);
    if (next) drag.card.dataset.toward = next;
    else delete drag.card.dataset.toward;
  });

  const end = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const { card, axis, dx, dy } = drag;
    drag = null;
    card.classList.remove('dragging');
    delete card.dataset.toward;
    if (!axis) return;
    // Ein Wischen, das auf dem Quellen-Link beginnt, soll ihn nicht öffnen.
    swallowClick = true;
    setTimeout(() => (swallowClick = false), 400);
    const dir = e.type === 'pointerup' ? toward(card, dx, dy) : null;
    if (dir) decide(decideForm().dataset[dir]);
    else card.style.transform = '';
  };
  document.addEventListener('pointerup', end);
  document.addEventListener('pointercancel', end);
  document.addEventListener('click', (e) => {
    if (swallowClick && e.target instanceof Element && e.target.closest('.inbox-card')) e.preventDefault();
  }, true);

  // --- Tasten: aus `aria-keyshortcuts` der Knöpfe (Eingang: ← / X weg, ↓ / S Stapel, → / Enter lesen, Z rückgängig, A ablegen) ---

  /** Element zur Taste: Knopf eines `.act`-Formulars oder ein `summary`. */
  function target(key) {
    for (const el of document.querySelectorAll('main form.act button[aria-keyshortcuts], main summary[aria-keyshortcuts]')) {
      const keys = el.getAttribute('aria-keyshortcuts').split(/\s+/).map((k) => (k.length === 1 ? k.toLowerCase() : k));
      if (keys.includes(key)) return el;
    }
    return null;
  }

  document.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || e.isComposing || e.repeat) return;
    const t = e.target instanceof Element ? e.target : null;
    if (t?.closest('input, textarea, select, [contenteditable]')) return;
    // Enter auf einem Knopf oder Link bleibt dessen Sache.
    if (e.key === 'Enter' && t?.closest('a, button, summary')) return;
    const el = target(e.key.length === 1 ? e.key.toLowerCase() : e.key);
    if (!el) return;
    e.preventDefault();
    if (el instanceof HTMLElement && el.tagName === 'SUMMARY') {
      const details = el.closest('details');
      if (details) details.open = true;
      details?.querySelector('textarea, input:not([type=hidden])')?.focus();
      return;
    }
    const form = el.closest('form');
    if (form.classList.contains('busy')) return;
    if (form === decideForm()) decide(el.value);
    else form.requestSubmit(el);
  });
})();
