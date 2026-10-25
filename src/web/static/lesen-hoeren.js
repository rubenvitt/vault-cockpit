// Unterwegs hören (VCP-79, src/lesen/listen.js): Die Texte der Seite werden zur
// Wiedergabeliste und satzweise vorgelesen, mit der Stimme vom Server (`data-voice`
// am Player, z. B. ElevenLabs) oder der Sprachausgabe des Geräts. Nach jedem Satz
// geht die Stelle als Lesefortschritt an den Server, die Leseansicht steht danach
// an derselben Stelle.
//
// Vorgelesen wird im Player des Cockpits (/static/player.js, `window.cockpitPlayer`):
// Er läuft beim Wechsel auf andere Seiten weiter und steht als Leiste unten. Diese
// Seite zeigt nur an, was er sagt, und gibt die Knöpfe weiter. Beim Öffnen holt er
// schon den ersten Satz, damit „Abspielen“ ihn noch im Tipp startet (sonst bleibt
// iOS stumm), ohne zu stören, was gerade läuft.
//
// In der iOS-App schickt „Abspielen“ nur `{type:'hoeren', zeit}` an die App.
(() => {
  'use strict';

  const player = document.querySelector('.hoeren-player');
  const zeit = Number(new URLSearchParams(location.search).get('zeit')) || 15;
  // In der iOS-App (WKWebView mit Brücke `cockpit`) spielt der native Player (VCP-92/94) statt der Sprachausgabe.
  const app = window.webkit?.messageHandlers?.cockpit;
  if (player && app) {
    for (const b of player.querySelectorAll('[data-cmd=next], [data-cmd=mark], .hoeren-rate')) b.hidden = true;
    player.querySelector('[data-cmd=play]').addEventListener('click', () => app.postMessage({ type: 'hoeren', zeit }));
    player.hidden = false;
    document.querySelector('.hoeren-nojs')?.setAttribute('hidden', '');
    return;
  }
  const engine = window.cockpitPlayer;
  const voice = player?.dataset.voice ?? null;
  if (!player || !engine || !engine.canHoeren(voice)) return;

  const ids = [...document.querySelectorAll('.hoeren-list [data-doc]')].map((li) => li.dataset.doc);
  const csrf = window.cockpit?.csrf?.() ?? player.querySelector('input[name=csrf]')?.value ?? '';
  const list = { ids, voice, zeit, csrf };
  const key = ids.join(',');
  const playButton = player.querySelector('[data-cmd=play]');
  const rateSelect = player.querySelector('[data-rate]');
  player.hidden = false;
  document.querySelector('.hoeren-nojs')?.setAttribute('hidden', '');

  const rate = String(engine.state().rates.hoeren);
  if (rateSelect.value !== rate && [...rateSelect.options].some((o) => o.value === rate)) rateSelect.value = rate;
  rateSelect.addEventListener('change', () => engine.setRate('hoeren', Number(rateSelect.value) || 1));

  function show(s) {
    const mine = s.hoeren?.key === key;
    const h = mine ? s.hoeren : s.vorbereitet?.key === key ? s.vorbereitet : null;
    player.querySelector('[data-title]').textContent = h?.title ?? (h?.finished ? 'Fertig' : 'Bereit');
    player.querySelector('[data-sentence]').textContent = h?.sentence ?? '';
    playButton.textContent = mine && s.playing ? 'Pause' : 'Abspielen';
    for (const li of document.querySelectorAll('.hoeren-list [data-doc]')) li.classList.toggle('is-playing', li.dataset.doc === h?.docId);
  }

  player.addEventListener('click', (e) => {
    const b = e.target instanceof Element ? e.target.closest('button[data-cmd]') : null;
    if (!b) return;
    if (b.dataset.cmd === 'play') return engine.playHoeren(list);
    if (b.dataset.cmd === 'next') return engine.nextText(key);
    if (b.dataset.cmd === 'mark') engine.remember(key);
  });

  engine.on(show);
  if (ids.length) engine.prepareHoeren(list);
})();
