// Rückmeldung beim Tippen, auf jeder Seite (auch ohne Schreibrechte). Ein Tipp
// soll sofort etwas sichtbar ändern, auch wenn die nächste Seite noch beim
// Server ist: Der getippte Link bleibt gedrückt, der Reiter unten wechselt
// gleich, oben läuft die Ladeleiste. In der iOS-App kommt ein leichtes Haptik-
// Signal dazu (Brücke `cockpit`, `{type: 'haptik', art}`).
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
