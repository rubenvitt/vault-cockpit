// Unterwegs hören (VCP-79, src/lesen/listen.js): liest die Texte der Seite
// satzweise mit der Sprachausgabe des Geräts vor (Web Speech API, deutsche
// Stimme bevorzugt). Nach jedem Satz geht die Stelle als Lesefortschritt an den
// Server, die Leseansicht steht danach an derselben Stelle. Braucht
// /static/cockpit.js (window.cockpit) davor.
//
// In der iOS-App schickt „Abspielen“ nur `{type:'hoeren', zeit}` an die App.
//
// Mit Stimme vom Server (`data-voice` am Player, z. B. ElevenLabs) kommt jeder
// Satz als MP3 von `/lesen/hoeren/audio` und läuft über ein `<audio>`-Element,
// der nächste Satz wird schon geladen. Fällt die Stimme aus, liest für den Rest
// der Sitzung die Sprachausgabe des Geräts.
//
// Text und Sätze kommen von `/lesen/hoeren/text`, in Zeichen des Lesetexts wie
// src/lesen/anchor.js; „Das hier merken“ bildet den Anker wie `anchorAt`.
(() => {
  'use strict';

  const player = document.querySelector('.hoeren-player');
  // In der iOS-App (WKWebView mit Brücke `cockpit`) spielt der native Player (VCP-92/94) statt der Sprachausgabe.
  const app = window.webkit?.messageHandlers?.cockpit;
  if (player && app) {
    const zeit = Number(new URLSearchParams(location.search).get('zeit')) || 15;
    for (const b of player.querySelectorAll('[data-cmd=next], [data-cmd=mark], .hoeren-rate')) b.hidden = true;
    player.querySelector('[data-cmd=play]').addEventListener('click', () => app.postMessage({ type: 'hoeren', zeit }));
    player.hidden = false;
    document.querySelector('.hoeren-nojs')?.setAttribute('hidden', '');
    return;
  }
  const serverVoice = player?.dataset.voice ?? null;
  if (!player || !window.cockpit || (!serverVoice && !('speechSynthesis' in window))) return;
  const { toast, send, csrf } = window.cockpit;
  const synth = window.speechSynthesis ?? null;
  // Ein Element für alle Sätze: iOS gibt es nach dem ersten Abspielen aus einem Tipp frei.
  const audio = serverVoice ? new Audio() : null;
  let serverDown = !serverVoice;
  /** Satz-Audio als Blob-URL je `id:start`, nur aktueller und nächster Satz. */
  const clips = new Map();
  const CONTEXT = 32;
  const ids = [...document.querySelectorAll('.hoeren-list [data-doc]')].map((li) => li.dataset.doc);
  const playButton = player.querySelector('[data-cmd=play]');
  const rateSelect = player.querySelector('[data-rate]');
  player.hidden = false;
  document.querySelector('.hoeren-nojs')?.setAttribute('hidden', '');

  // `cur`: geladener Text mit `pos` (Satz) und `i` (Stelle in der Liste); `gen` verwirft
  // Rückmeldungen abgebrochener Sätze, manche Browser melden auch dann `end`.
  let cur = null;
  let playing = false;
  let gen = 0;
  let utterance = null;
  let voice = null;
  let lock = null;

  function pickVoice() {
    const de = synth.getVoices().filter((v) => /^de([-_]|$)/i.test(v.lang));
    voice = de.find((v) => v.localService && /^de[-_]DE/i.test(v.lang)) ?? de.find((v) => /^de[-_]DE/i.test(v.lang)) ?? de[0] ?? null;
  }
  if (synth) {
    pickVoice();
    synth.addEventListener?.('voiceschanged', pickVoice);
  }

  const RATE = 'lesen-hoeren-tempo';
  try {
    const saved = localStorage.getItem(RATE);
    if (saved && [...rateSelect.options].some((o) => o.value === saved)) rateSelect.value = saved;
  } catch {
    /* privater Modus: Standard */
  }
  rateSelect.addEventListener('change', () => {
    if (audio) audio.playbackRate = Number(rateSelect.value) || 1;
    try {
      localStorage.setItem(RATE, rateSelect.value);
    } catch {
      /* egal */
    }
  });

  // Hält den Bildschirm an, solange vorgelesen wird: Bei gesperrtem Gerät hört die Sprachausgabe auf iOS wohl auf (README).
  async function keepAwake(on) {
    try {
      if (on && !lock) {
        lock = await navigator.wakeLock?.request('screen');
        lock?.addEventListener('release', () => (lock = null));
      } else if (!on && lock) await lock.release();
    } catch {
      /* nicht unterstützt oder abgelehnt */
    }
  }

  function show() {
    player.querySelector('[data-title]').textContent = cur ? cur.title : 'Fertig';
    player.querySelector('[data-sentence]').textContent = cur ? cur.text.slice(...cur.sentences[cur.pos]) : '';
    playButton.textContent = playing ? 'Pause' : 'Abspielen';
    for (const li of document.querySelectorAll('.hoeren-list [data-doc]')) li.classList.toggle('is-playing', li.dataset.doc === cur?.id);
    if (audio && navigator.mediaSession) {
      if (cur && 'MediaMetadata' in window) navigator.mediaSession.metadata = new MediaMetadata({ title: cur.title, artist: 'Cockpit' });
      navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
    }
  }

  /** Erster Text ab Stelle `i` mit Sätzen, ab der gespeicherten Lesestelle. */
  async function load(i) {
    for (; i < ids.length; i++) {
      const res = await fetch(`/lesen/hoeren/text?id=${encodeURIComponent(ids[i])}`, { credentials: 'same-origin', headers: { accept: 'application/json' } });
      // Abgelaufene Sitzung: Der Abruf landet auf der Anmeldeseite statt bei JSON.
      if (!res.ok || res.redirected) throw new Error('Text ließ sich nicht laden. Noch angemeldet?');
      const d = await res.json();
      if (!d.sentences.length) continue;
      const pos = d.sentences.findIndex(([start]) => start >= d.anchor);
      return { ...d, i, pos: pos === -1 ? 0 : pos };
    }
    return null;
  }

  const clipKey = (d, pos) => `${d.id}:${d.sentences[pos][0]}`;

  /** Lädt Satz `pos` von `d` als Blob-URL (einmal je Satz); wirft mit der Meldung des Servers. */
  function clip(d, pos) {
    const key = clipKey(d, pos);
    if (!clips.has(key)) {
      const [von, bis] = d.sentences[pos];
      const entry = { url: null };
      entry.ready = fetch(`/lesen/hoeren/audio?${new URLSearchParams({ id: d.id, von: String(von), bis: String(bis) })}`, { credentials: 'same-origin' })
        .then(async (res) => {
          if (res.redirected) throw new Error('Nicht mehr angemeldet.');
          if (!res.ok) throw new Error((await res.json().catch(() => null))?.message ?? `HTTP ${res.status}`);
          entry.url = URL.createObjectURL(await res.blob());
          return entry.url;
        })
        .catch((err) => {
          if (clips.get(key) === entry) clips.delete(key);
          throw err;
        });
      clips.set(key, entry);
    }
    return clips.get(key);
  }

  /** Behält nur die Sätze `keep` (Schlüssel), gibt den Rest frei. */
  function trimClips(keep) {
    for (const [key, entry] of clips) {
      if (keep.includes(key)) continue;
      if (entry.url) URL.revokeObjectURL(entry.url);
      clips.delete(key);
    }
  }

  /** Satz über die Stimme vom Server; liegt er schon da, startet er noch im selben Tipp (iOS). */
  function speakServer(mine) {
    const next = cur.pos + 1 < cur.sentences.length ? clipKey(cur, cur.pos + 1) : null;
    trimClips([clipKey(cur, cur.pos), next].filter(Boolean));
    const entry = clip(cur, cur.pos);
    const start = (url) => {
      if (mine !== gen) return;
      audio.src = url;
      audio.playbackRate = Number(rateSelect.value) || 1;
      audio.play().catch((err) => {
        if (mine !== gen) return;
        stop();
        // Ohne Tipp lässt iOS nicht abspielen, wenn der Satz zu spät kam.
        toast(err.name === 'NotAllowedError' ? 'Noch einmal auf Abspielen tippen.' : `Wiedergabe: ${err.message}`, { kind: 'error' });
      });
      // Den nächsten schon holen, damit zwischen den Sätzen keine Pause entsteht.
      if (cur.pos + 1 < cur.sentences.length) clip(cur, cur.pos + 1).ready.catch(() => {});
    };
    if (entry.url) start(entry.url);
    else
      entry.ready.then(start, (err) => {
        if (mine !== gen) return;
        trimClips([]);
        if (!synth) {
          stop();
          return toast(err.message, { kind: 'error' });
        }
        serverDown = true;
        toast(`${err.message}. Die Gerätestimme liest weiter.`, { kind: 'error' });
        speak();
      });
    show();
  }

  function speak() {
    const mine = ++gen;
    if (!serverDown) return speakServer(mine);
    // Nur abbrechen, wenn noch etwas läuft: Nach `end` wäre das nur ein Anlass für Eigenheiten der Sprachausgabe.
    if (synth.speaking || synth.pending) synth.cancel();
    const u = new SpeechSynthesisUtterance(cur.text.slice(...cur.sentences[cur.pos]));
    u.lang = 'de-DE';
    if (voice) u.voice = voice;
    u.rate = Number(rateSelect.value) || 1;
    u.onend = () => mine === gen && finished();
    u.onerror = (e) => {
      if (mine !== gen || e.error === 'interrupted' || e.error === 'canceled') return;
      stop();
      toast(`Sprachausgabe: ${e.error}`, { kind: 'error' });
    };
    // Verweis halten: Sonst räumt Chrome den Satz weg, bevor `end` kommt.
    utterance = u;
    synth.speak(u);
    show();
  }

  /** Satz zu Ende: Stelle speichern (Anfang des nächsten Satzes), dann weiter. */
  function finished() {
    const next = cur.sentences[cur.pos + 1];
    cur.progress = next ? Math.max(cur.progress, cur.sentences[cur.pos][1] / cur.text.length) : 1;
    save(cur.id, next ? next[0] : cur.sentences[cur.pos][0], cur.progress);
    if (!next) return advance(cur.i + 1);
    cur.pos++;
    speak();
  }

  function save(id, anchor, progress) {
    const body = new URLSearchParams({ csrf: csrf(), id, fortschritt: progress.toFixed(3), anker: String(anchor) });
    fetch('/aktion/lesen/doc/fortschritt', { method: 'POST', keepalive: true, credentials: 'same-origin', headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' }, body }).catch(() => {});
  }

  /** Hält jede Ausgabe an: Sprachausgabe und Audio. */
  function silence() {
    synth?.cancel();
    audio?.pause();
  }

  async function advance(i) {
    const mine = ++gen;
    silence();
    let next;
    try {
      next = await load(i);
    } catch (err) {
      if (mine === gen) stop();
      return toast(err.message, { kind: 'error' });
    }
    if (mine !== gen) return;
    cur = next;
    if (!cur) {
      stop();
      return toast('Alles gehört.');
    }
    if (playing) speak();
    else {
      // Ersten Satz schon holen, damit „Abspielen“ ihn noch im Tipp starten kann (sonst bleibt iOS stumm).
      if (!serverDown) clip(cur, cur.pos).ready.catch(() => {});
      show();
    }
  }

  // Pause bricht den Satz ab und spielt ihn beim Weiterhören neu: `pause()`/`resume()` sind auf Mobilgeräten unzuverlässig.
  function stop() {
    playing = false;
    gen++;
    silence();
    keepAwake(false);
    show();
  }

  function play() {
    playing = true;
    keepAwake(true);
    // Der erste Satz muss direkt aus dem Tipp kommen, sonst bleibt iOS stumm; deshalb ist der erste Text vorgeladen.
    if (cur) speak();
    else advance(0);
  }

  // shortcut: merkt den Satz, der gerade läuft; wer kurz nach einem Satzwechsel tippt, bekommt den neuen. Den vorigen anbieten, wenn das stört.
  async function remember() {
    if (!cur) return;
    const [start, end] = cur.sentences[cur.pos];
    const t = cur.text;
    const fields = { id: cur.id, quote: t.slice(start, end), prefix: t.slice(Math.max(0, start - CONTEXT), start), suffix: t.slice(end, end + CONTEXT), start: String(start) };
    try {
      const data = await send('/aktion/lesen/markierung/neu', new URLSearchParams({ ...fields, csrf: csrf() }));
      toast(data.message, data.undo ? { action: { label: 'Rückgängig', run: () => send(data.undo.action, new URLSearchParams({ ...data.undo.fields, csrf: csrf() })).then((r) => toast(r.message), (err) => toast(err.message, { kind: 'error' })) } } : {});
    } catch (err) {
      toast(err.message, { kind: 'error' });
    }
  }

  player.addEventListener('click', (e) => {
    const b = e.target instanceof Element ? e.target.closest('button[data-cmd]') : null;
    if (!b) return;
    if (b.dataset.cmd === 'play') return playing ? stop() : play();
    if (b.dataset.cmd === 'next' && cur) return advance(cur.i + 1);
    if (b.dataset.cmd === 'mark') remember();
  });

  if (audio) {
    audio.addEventListener('ended', () => {
      // Nur der Satz, der gerade dran ist; nach Pause oder Sprung kommt kein `ended` mehr durch.
      if (playing && !serverDown && cur) finished();
    });
    // Sperrbildschirm und Kopfhörer: Abspielen, Pause, nächster Text.
    const session = navigator.mediaSession;
    session?.setActionHandler?.('play', () => !playing && play());
    session?.setActionHandler?.('pause', () => playing && stop());
    session?.setActionHandler?.('nexttrack', () => cur && advance(cur.i + 1));
  }

  // Zurück im Vordergrund: Hat das System den Satz abgebrochen, ihn neu sprechen; die Bildschirmsperre neu holen.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || !playing) return;
    keepAwake(true);
    if (!serverDown) {
      if (cur && audio.paused) speak();
      return;
    }
    // `speaking` bleibt auch bei einer vom System angehaltenen Ausgabe wahr.
    if (cur && (!synth.speaking || synth.paused)) speak();
  });

  if (ids.length) advance(0);
})();
