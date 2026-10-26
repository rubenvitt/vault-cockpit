// Fragen (src/fragen/page.js): Solange Claude antwortet, holt die Seite alle
// paar Sekunden `/fragen/stand` und zeigt, wie viele Notizen gelesen sind; ist
// die Antwort da, lädt sie neu. Ohne JavaScript gibt es „Stand aktualisieren“.
// Dazu: Absenden mit Cmd/Strg+Enter und kein doppeltes Absenden.
(() => {
  'use strict';

  for (const form of document.querySelectorAll('form[action="/aktion/fragen/frage"], form[action="/aktion/fragen/uebernehmen"], form[action="/aktion/fragen/aufgaben"]')) {
    form.addEventListener('submit', () => setTimeout(() => form.querySelectorAll('button').forEach((b) => (b.disabled = true))));
  }
  for (const area of document.querySelectorAll('[data-fragen-form] textarea')) {
    area.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        area.form.requestSubmit();
      }
    });
  }

  const busy = document.querySelector('[data-busy]');
  if (!busy) return;
  const id = busy.dataset.busy;
  async function poll() {
    try {
      const res = await fetch(`/fragen/stand?id=${encodeURIComponent(id)}`, { headers: { accept: 'application/json' } });
      const data = await res.json();
      if (!data.busy) return location.reload();
      const label = new DOMParser().parseFromString(data.html, 'text/html').querySelector('[data-label]');
      const mine = busy.querySelector('[data-label]');
      if (label && mine) mine.textContent = label.textContent;
    } catch {
      /* Netz kurz weg: beim nächsten Mal */
    }
    setTimeout(poll, 2500);
  }
  setTimeout(poll, 2500);
  busy.scrollIntoView({ block: 'center' });
})();
