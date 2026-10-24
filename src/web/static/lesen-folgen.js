// Folgen (src/lesen/folgen-page.js): eigener Player statt des eingebetteten
// <audio controls>. Ein Audio-Element für die ganze Seite, großer Knopf je
// Folge, Stelle, ±Sekunden und Tempo. Über die Media Session stehen Titel und
// Knöpfe auf dem Sperrbildschirm, im Kontrollzentrum und an Kopfhörern. Die
// Stelle je Folge bleibt im Browser, beim nächsten Abspielen geht es dort weiter.
//
// In der iOS-App schickt der Knopf nur `{type:'folge', id, titel, art}` an die
// App; dort spielt der native Player (Sperrbildschirm, AirPlay, Hintergrund).
//
// Auf `/lesen/folgen/neu` rechnet es den Satz am Knopf (Art, Texte, Dauer,
// Kosten) beim Umschalten neu, wie `newSummary` in src/lesen/folgen-page.js.
//
// Solange eine Folge entsteht, holt die Seite alle paar Sekunden
// `/lesen/folgen/stand` und tauscht die Karten der entstehenden Folgen aus.
(() => {
  'use strict';

  const form = document.querySelector('[data-folge-neu]');
  if (form) {
    const fmt = new Intl.NumberFormat('de-DE');
    const KINDS = { vorlesen: 'Vorlesen', podcast: 'Podcast', report: 'Report' };
    const summary = form.querySelector('[data-summary]');
    const costLine = form.querySelector('[data-cost]');
    const show = (main, cost) => {
      summary.textContent = main;
      costLine.textContent = cost;
    };
    const submit = form.querySelector('button[type=submit]');
    const update = () => {
      const kind = form.querySelector('input[name=art]:checked')?.value;
      const docs = [...form.querySelectorAll('input[name=doc]:checked')];
      const minutes = Number(form.querySelector('input[name=laenge]:checked')?.value) || 10;
      if (!kind) return;
      submit.disabled = !docs.length;
      if (!docs.length) return show('Bitte mindestens einen Text wählen', '');
      const n = `${docs.length} ${docs.length === 1 ? 'Text' : 'Texte'}`;
      if (kind === 'vorlesen') {
        const chars = docs.reduce((sum, d) => sum + (Number(d.dataset.chars) || 0), 0);
        show(`Vorlesen · ${n} · etwa ${Math.max(1, Math.round(chars / 900))} Min.`, chars ? `rund ${fmt.format(chars)} Zeichen bei ElevenLabs` : 'Schon alles gehört, kostet nichts');
      } else {
        show(`${KINDS[kind]} · ${n} · ${minutes} Min.`, `rund ${fmt.format(minutes * 900)} Zeichen bei ElevenLabs, dazu dein Claude-Abo`);
      }
    };
    form.addEventListener('change', update);
    // Doppeltes Absenden würde zwei Folgen bezahlen.
    form.addEventListener('submit', () => setTimeout(() => (submit.disabled = true)));
    update();
  }

  const list = document.querySelector('.folgen');
  if (!list) return;
  const app = window.webkit?.messageHandlers?.cockpit;
  const toast = (text) => window.cockpit?.toast?.(text);

  const SKIP_BACK = 15;
  const SKIP_FORWARD = 30;
  const RATE = 'folgen-tempo';
  const SPOT = 'folgen-stelle:';

  const store = {
    get(key) {
      try {
        return localStorage.getItem(key);
      } catch {
        return null;
      }
    },
    set(key, value) {
      try {
        if (value === null) localStorage.removeItem(key);
        else localStorage.setItem(key, value);
      } catch {
        /* privater Modus: ohne Merken */
      }
    },
  };

  function clock(seconds) {
    const t = Math.max(0, Math.floor(seconds || 0));
    const h = Math.floor(t / 3600);
    const m = Math.floor((t % 3600) / 60);
    const s = String(t % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
  }

  // MARK: Player

  const audio = app ? null : new Audio();
  if (audio) audio.preload = 'metadata';
  let current = null;
  let rate = Number(store.get(RATE)) || 1;
  let lastSaved = 0;

  const part = (li, name) => li.querySelector(`[data-${name}]`);

  function bind(li) {
    const play = part(li, 'play');
    if (!play) return;
    li.querySelector('.folge-nojs')?.remove();
    play.hidden = false;
    play.addEventListener('click', () => toggle(li));
    if (app) return;
    const seek = part(li, 'seek');
    seek.addEventListener('input', () => {
      if (current !== li) {
        // Noch nicht geladen: die gewählte Stelle übernimmt `load` nach den Metadaten.
        store.set(SPOT + li.dataset.folge, seek.value);
        load(li);
      }
      if (Number.isFinite(audio.duration)) audio.currentTime = Number(seek.value);
      showTime(li, Number(seek.value));
    });
    for (const b of li.querySelectorAll('[data-skip]')) b.addEventListener('click', () => skip(Number(b.dataset.skip)));
    const select = part(li, 'rate');
    if ([...select.options].some((o) => Number(o.value) === rate)) select.value = String(rate);
    select.addEventListener('change', () => setRate(Number(select.value) || 1));
    // Gemerkte Stelle schon vor dem Abspielen zeigen.
    const spot = Number(store.get(SPOT + li.dataset.folge));
    if (spot > 0) {
      part(li, 'player').hidden = false;
      seek.value = String(spot);
      showTime(li, spot);
    }
  }

  function toggle(li) {
    if (app) {
      app.postMessage({ type: 'folge', id: li.dataset.folge, titel: li.dataset.title, art: li.dataset.art });
      return;
    }
    if (current !== li) load(li);
    if (audio.paused) start();
    else audio.pause();
  }

  function start() {
    // Ohne Tipp (Sperrbildschirm nach Neuladen) verweigert Safari; der nächste Tipp klappt.
    // Ladefehler meldet das `error`-Ereignis des Elements auf Deutsch.
    audio.play().catch(() => {});
  }

  function load(li) {
    if (current) {
      remember(true);
      current.classList.remove('is-current', 'is-playing');
      setPressed(current, false);
    }
    current = li;
    li.classList.add('is-current');
    part(li, 'player').hidden = false;
    part(li, 'error').hidden = true;
    audio.src = li.dataset.src;
    audio.playbackRate = rate;
    const spot = Number(store.get(SPOT + li.dataset.folge));
    if (spot > 0) audio.addEventListener('loadedmetadata', () => (audio.currentTime = Math.min(spot, Math.max(0, audio.duration - 1))), { once: true });
    if ('mediaSession' in navigator && 'MediaMetadata' in window) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: li.dataset.title,
        artist: `Cockpit · ${li.dataset.art || 'Folge'}`,
        album: 'Folgen aus dem Lesestapel',
        artwork: [
          { src: '/static/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/static/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
        ],
      });
    }
  }

  function skip(by) {
    if (!current) return;
    const end = Number.isFinite(audio.duration) ? audio.duration : Infinity;
    audio.currentTime = Math.min(end, Math.max(0, audio.currentTime + by));
  }

  function setRate(value) {
    rate = value;
    store.set(RATE, String(value));
    if (audio) audio.playbackRate = value;
    for (const s of list.querySelectorAll('[data-rate]')) s.value = String(value);
    position();
  }

  function setPressed(li, playing) {
    const play = part(li, 'play');
    if (!play) return;
    play.setAttribute('aria-pressed', String(playing));
    play.setAttribute('aria-label', `${playing ? 'Pause' : 'Abspielen'}: ${li.dataset.title}`);
  }

  function showTime(li, at) {
    part(li, 'pos').textContent = clock(at);
  }

  function fail(text) {
    if (!current) return;
    const box = part(current, 'error');
    box.textContent = text;
    box.hidden = false;
  }

  /** Stelle merken, höchstens alle 5 Sekunden; am Ende vergessen. */
  function remember(force = false) {
    if (!current) return;
    const now = Date.now();
    if (!force && now - lastSaved < 5000) return;
    lastSaved = now;
    const key = SPOT + current.dataset.folge;
    const near = Number.isFinite(audio.duration) && audio.duration - audio.currentTime < 5;
    store.set(key, audio.currentTime > 3 && !near ? String(Math.floor(audio.currentTime)) : null);
  }

  function position() {
    const session = navigator.mediaSession;
    if (!audio || !session?.setPositionState || !Number.isFinite(audio.duration)) return;
    try {
      session.setPositionState({ duration: audio.duration, playbackRate: audio.playbackRate, position: Math.min(audio.currentTime, audio.duration) });
    } catch {
      /* ältere Browser */
    }
  }

  if (audio) {
    audio.addEventListener('play', () => {
      current?.classList.add('is-playing');
      if (current) setPressed(current, true);
      if (navigator.mediaSession) navigator.mediaSession.playbackState = 'playing';
    });
    audio.addEventListener('pause', () => {
      current?.classList.remove('is-playing');
      if (current) setPressed(current, false);
      if (navigator.mediaSession) navigator.mediaSession.playbackState = 'paused';
      remember(true);
    });
    audio.addEventListener('loadedmetadata', () => {
      if (!current) return;
      const seek = part(current, 'seek');
      seek.max = String(Math.floor(audio.duration));
      part(current, 'dur').textContent = clock(audio.duration);
      position();
    });
    audio.addEventListener('timeupdate', () => {
      if (!current) return;
      const seek = part(current, 'seek');
      if (document.activeElement !== seek) seek.value = String(Math.floor(audio.currentTime));
      showTime(current, audio.currentTime);
      remember();
    });
    audio.addEventListener('seeked', position);
    audio.addEventListener('ratechange', position);
    audio.addEventListener('ended', () => {
      store.set(SPOT + current?.dataset.folge, null);
      if (current) {
        part(current, 'seek').value = '0';
        showTime(current, 0);
      }
    });
    audio.addEventListener('error', () => {
      current?.classList.remove('is-playing');
      if (current) setPressed(current, false);
      const code = audio.error?.code;
      fail(code === 4 ? 'Die MP3 ließ sich nicht laden. Seite neu laden und noch einmal versuchen.' : `Abspielen ging nicht (Fehler ${code ?? '?'}).`);
    });
    // Vor dem Schließen der Seite die Stelle sichern.
    addEventListener('pagehide', () => remember(true));

    const session = navigator.mediaSession;
    if (session) {
      const on = (action, handler) => {
        try {
          session.setActionHandler(action, handler);
        } catch {
          /* Aktion unbekannt */
        }
      };
      on('play', () => current && start());
      on('pause', () => audio.pause());
      on('stop', () => audio.pause());
      on('seekbackward', (d) => skip(-(d?.seekOffset || SKIP_BACK)));
      on('seekforward', (d) => skip(d?.seekOffset || SKIP_FORWARD));
      on('seekto', (d) => {
        if (!current || !Number.isFinite(d?.seekTime)) return;
        if (d.fastSeek && 'fastSeek' in audio) audio.fastSeek(d.seekTime);
        else audio.currentTime = d.seekTime;
      });
      // Ohne vorige/nächste Folge zeigt iOS sonst Spulen statt ±Sekunden.
      on('previoustrack', null);
      on('nexttrack', null);
    }
  }

  // Leertaste: Abspielen/Pause der laufenden Folge, solange kein Feld den Fokus hat.
  document.addEventListener('keydown', (e) => {
    if (e.key !== ' ' || !current || !audio || e.target.closest?.('input, select, textarea, button, a')) return;
    e.preventDefault();
    toggle(current);
  });

  // MARK: Stand der entstehenden Folgen

  let polling = null;
  function poll() {
    clearTimeout(polling);
    if (!list.querySelector('.folge.is-busy')) return;
    polling = setTimeout(refresh, document.hidden ? 15000 : 3000);
  }

  async function refresh() {
    let data;
    try {
      const res = await fetch('/lesen/folgen/stand', { headers: { accept: 'application/json' }, credentials: 'same-origin', cache: 'no-store', redirect: 'manual' });
      if (res.type === 'opaqueredirect' || res.status === 401) return;
      data = res.ok ? await res.json() : null;
    } catch {
      /* kein Netz: später noch einmal */
    }
    for (const li of [...list.querySelectorAll('.folge.is-busy')]) {
      const item = data?.items?.find((i) => i.id === li.dataset.folge);
      if (!item) continue;
      const tpl = document.createElement('template');
      tpl.innerHTML = item.html.trim();
      const next = tpl.content.firstElementChild;
      li.replaceWith(next);
      bind(next);
      if (item.status === 'fertig') toast(`Fertig: ${next.dataset.title}`);
    }
    poll();
  }

  for (const li of list.querySelectorAll('.folge')) bind(li);
  poll();
  document.addEventListener('visibilitychange', () => !document.hidden && list.querySelector('.folge.is-busy') && refresh());
})();
