// Player für das ganze Cockpit: Folgen (eine MP3, src/lesen/folgen-page.js) und
// „Unterwegs hören“ (Satz für Satz, src/lesen/listen.js). Steht auf jeder Seite
// vor den Seitenskripten und stellt `window.cockpitPlayer` bereit; die Seiten
// (/static/lesen-folgen.js, /static/lesen-hoeren.js) zeigen nur an und geben
// ihre Knöpfe weiter. Unten steht eine Leiste mit dem, was gerade läuft.
//
// Weiterhören beim Seitenwechsel: Solange etwas geladen ist, fängt das Script
// Links, Formulare und Wechsel aus Scripten (`cockpitWechsel`) im Cockpit ab und
// macht die Seite zur Hülle. Die Seiten laden dann in einem Rahmen
// (`<iframe name="cockpit-seite">`), Audio, Media Session und Leiste bleiben im
// obersten Dokument und spielen ohne Pause weiter. Im Rahmen nimmt dieses Script
// den Player der Hülle (gleiche Herkunft, `frame-ancestors 'self'`). Adresse und
// Titel der Hülle folgen dem Rahmen, Zurück geht über den Verlauf des Rahmens.
// Anmelden und Abmelden verlassen die Hülle (`_top`), Pocket ID lässt sich nicht
// einrahmen.
//
// In der iOS-App (Brücke `cockpit`) spielt der native Player, hier passiert nichts.
(() => {
  'use strict';

  if (window.webkit?.messageHandlers?.cockpit) return;

  const FRAME = 'cockpit-seite';
  const EXIT = /^\/(login|logout|auth\/)/;
  const root = document.documentElement;
  /** Adresse eines Links oder Formulars, aufgelöst gegen die Seite; ungültige als null. */
  const urlOf = (href) => {
    try {
      return new URL(href ?? '', location.href);
    } catch {
      return null;
    }
  };
  /** Bleibt im Cockpit und verlässt die Hülle nicht (Anmelden, Abmelden). */
  const inside = (url) => url && url.origin === location.origin && !EXIT.test(url.pathname);

  let host = null;
  try {
    const parent = window.parent;
    if (parent && parent !== window && parent.cockpitPlayer?.isShell) host = parent.cockpitPlayer;
  } catch {
    /* fremder Rahmen */
  }
  if (host) return inFrame(host);
  // Eingerahmt, aber nicht von einer Hülle des Cockpits: keinen zweiten Player aufmachen.
  if (window.parent && window.parent !== window) return;

  // MARK: Im Rahmen

  /** Seite im Rahmen der Hülle: Player der Hülle, Abos enden mit der Seite. */
  function inFrame(shell) {
    const offs = new Set();
    window.cockpitPlayer = {
      ...shell,
      on(fn) {
        const off = shell.on(fn);
        offs.add(off);
        return () => {
          offs.delete(off);
          off();
        };
      },
    };
    window.cockpitPlayer.on(makeRoom);
    window.addEventListener('pagehide', () => {
      for (const off of offs) off();
      offs.clear();
    });
    // Aus dem Verlauf zurück (bfcache): Die Abos sind weg, die Seite holt sie neu.
    window.addEventListener('pageshow', (e) => e.persisted && location.reload());
    document.addEventListener(
      'click',
      (e) => {
        const a = e.target instanceof Element ? e.target.closest('a[href]') : null;
        const url = a && !a.target ? urlOf(a.getAttribute('href')) : null;
        if (url?.origin === location.origin && EXIT.test(url.pathname)) a.target = '_top';
      },
      true,
    );
    document.addEventListener(
      'submit',
      (e) => {
        const form = e.target;
        if (!(form instanceof HTMLFormElement) || form.getAttribute('target')) return;
        const url = urlOf(form.getAttribute('action'));
        if (url?.origin === location.origin && EXIT.test(url.pathname)) form.target = '_top';
      },
      true,
    );
  }

  // MARK: Gemeinsames

  /** Platz für die Leiste: `--player` (cockpit.css) hält Toasts, Leisten und Seitenende darüber. */
  function makeRoom(s) {
    root.classList.toggle('mit-player', s.visible);
    root.style.setProperty('--player', `${s.visible ? s.space : 0}px`);
  }

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

  /** POST wie `send` in /static/cockpit.js: JSON zurück, Fehler mit der Meldung des Servers. */
  async function post(url, fields) {
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(fields),
        credentials: 'same-origin',
      });
    } catch {
      throw new Error('Keine Verbindung zum Cockpit. Nichts gespeichert.');
    }
    let data = null;
    try {
      data = await res.json();
    } catch {
      /* leer */
    }
    if (!res.ok || !data?.ok) throw new Error(data?.message || `Fehler ${res.status}. Nichts gespeichert.`);
    return data;
  }

  const SPOT = 'folgen-stelle:';
  const RATE_KEYS = { folge: 'folgen-tempo', hoeren: 'lesen-hoeren-tempo' };
  const SKIP_BACK = 15;
  const SKIP_FORWARD = 30;
  const CONTEXT = 32;
  const rates = { folge: Number(store.get(RATE_KEYS.folge)) || 1, hoeren: Number(store.get(RATE_KEYS.hoeren)) || 1 };
  const session = navigator.mediaSession ?? null;
  const listeners = new Set();

  /** Was läuft: `folge`, `hoeren` oder nichts. */
  let kind = null;
  let message = null;
  let messageAction = null;
  let messageTimer = 0;
  let messageId = 0;

  /** Meldung in der Leiste; Fehler bleiben stehen, bis man sie schließt. */
  function note(text, level = 'ok', action = null) {
    clearTimeout(messageTimer);
    message = { id: ++messageId, text, kind: level, action: action?.label ?? null };
    messageAction = action?.run ?? null;
    if (level !== 'error') messageTimer = setTimeout(dismiss, 6000);
    emit();
  }

  function dismiss() {
    clearTimeout(messageTimer);
    message = null;
    messageAction = null;
    emit();
  }

  // MARK: Folgen

  let audio = null;
  /** Geladene Folge: `id`, `src`, `title`, `art`, `seconds` (vom Server), `error`. */
  let folge = null;
  let lastSaved = 0;

  function folgeAudio() {
    if (audio) return audio;
    audio = new Audio();
    audio.preload = 'metadata';
    audio.addEventListener('play', emit);
    audio.addEventListener('pause', () => {
      rememberSpot(true);
      emit();
    });
    audio.addEventListener('loadedmetadata', () => {
      emit();
      position();
    });
    audio.addEventListener('timeupdate', () => {
      rememberSpot();
      emit();
    });
    audio.addEventListener('seeked', position);
    audio.addEventListener('ratechange', position);
    audio.addEventListener('ended', () => {
      if (folge) store.set(SPOT + folge.id, null);
      report(true);
      emit();
    });
    audio.addEventListener('error', () => {
      // Nach `close` (ohne Quelle) ist das kein Fehler.
      if (!folge) return;
      const code = audio.error?.code;
      folge.error = code === 4 ? 'Die MP3 ließ sich nicht laden. Seite neu laden und noch einmal versuchen.' : `Abspielen ging nicht (Fehler ${code ?? '?'}).`;
      emit();
    });
    // Vor dem Schließen der Seite die Stelle sichern.
    window.addEventListener('pagehide', () => rememberSpot(true));
    return audio;
  }

  /** Stelle merken, höchstens alle 5 Sekunden; am Ende vergessen. Dem Server höchstens alle 30 Sekunden. */
  function rememberSpot(force = false) {
    if (!folge || !audio) return;
    const now = Date.now();
    if (!force && now - lastSaved < 5000) return;
    lastSaved = now;
    const near = Number.isFinite(audio.duration) && audio.duration - audio.currentTime < 5;
    store.set(SPOT + folge.id, audio.currentTime > 3 && !near ? String(Math.floor(audio.currentTime)) : null);
    report(force);
  }

  /**
   * Stand an den Server (src/lesen/folgen.js `listened`): Er merkt „angefangen“
   * und vermerkt die Folge kurz vor Schluss als gehört. Still; ohne Netz oder
   * CSRF (Seite ohne Folgen-Liste) bleibt es beim Browser.
   */
  let lastReported = 0;
  let reportedHeard = null;
  function report(force = false) {
    if (!folge?.csrf || !audio || audio.currentTime < 3) return;
    const now = Date.now();
    if (!force && now - lastReported < 30000) return;
    lastReported = now;
    const mine = folge;
    const at = audio.ended ? folgeLength() : audio.currentTime;
    post('/aktion/lesen/folge/stelle', { id: mine.id, stelle: String(Math.floor(at)), dauer: String(Math.floor(folgeLength())), csrf: mine.csrf }).then(
      (data) => {
        if (data?.heard && reportedHeard !== mine.id) {
          reportedHeard = mine.id;
          note(`Gehört: ${mine.title}`);
        }
      },
      () => {},
    );
  }

  /** Länge: die des Browsers, mindestens die vom Server (feste Bitrate), falls der Browser sich verschätzt. */
  function folgeLength() {
    const known = Number(folge?.seconds) || 0;
    return Math.max(Number.isFinite(audio?.duration) ? audio.duration : 0, known);
  }

  function position() {
    if (kind !== 'folge' || !session?.setPositionState || !Number.isFinite(audio.duration)) return;
    try {
      session.setPositionState({ duration: audio.duration, playbackRate: audio.playbackRate, position: Math.min(audio.currentTime, audio.duration) });
    } catch {
      /* ältere Browser */
    }
  }

  const isFolge = (id) => kind === 'folge' && folge?.id === String(id);

  function loadFolge(meta) {
    if (isFolge(meta.id)) return;
    leave();
    const a = folgeAudio();
    const mine = { id: String(meta.id), src: meta.src, title: meta.title || 'Folge', art: meta.art || 'Folge', seconds: Number(meta.seconds) || 0, csrf: meta.csrf ? String(meta.csrf) : null, error: null };
    folge = mine;
    kind = 'folge';
    a.src = mine.src;
    a.playbackRate = rates.folge;
    const spot = Number(store.get(SPOT + mine.id));
    if (spot > 0) a.addEventListener('loadedmetadata', () => folge === mine && (a.currentTime = Math.min(spot, Math.max(0, a.duration - 1))), { once: true });
    actions();
    emit();
  }

  /** Abspielen; ohne Tipp (Sperrbildschirm nach Neuladen) verweigert Safari, der nächste Tipp klappt. */
  function startFolge() {
    folge.error = null;
    audio.play().catch(() => {});
  }

  /** Knopf an einer Folge: dieselbe Folge anhalten oder weiter, eine andere laden und abspielen. */
  function playFolge(meta) {
    if (isFolge(meta.id)) return toggle();
    loadFolge(meta);
    startFolge();
  }

  /** Regler an einer Folge; eine noch nicht geladene setzt an der gewählten Stelle an. */
  function seekFolge(meta, at) {
    if (!isFolge(meta.id)) {
      store.set(SPOT + meta.id, String(Math.floor(at)));
      loadFolge(meta);
    }
    if (Number.isFinite(audio.duration)) audio.currentTime = at;
    emit();
  }

  function skip(by) {
    if (kind !== 'folge') return;
    const end = Number.isFinite(audio.duration) ? audio.duration : Infinity;
    audio.currentTime = Math.min(end, Math.max(0, audio.currentTime + by));
    emit();
  }

  // MARK: Unterwegs hören

  const synth = window.speechSynthesis ?? null;
  let deviceVoice = null;
  function pickVoice() {
    const de = synth.getVoices().filter((v) => /^de([-_]|$)/i.test(v.lang));
    deviceVoice = de.find((v) => v.localService && /^de[-_]DE/i.test(v.lang)) ?? de.find((v) => /^de[-_]DE/i.test(v.lang)) ?? de[0] ?? null;
  }
  if (synth) {
    pickVoice();
    synth.addEventListener?.('voiceschanged', pickVoice);
  }

  // Ein Element für alle Sätze: iOS gibt es nach dem ersten Abspielen aus einem Tipp frei.
  let speechEl = null;
  function speechAudio() {
    if (speechEl) return speechEl;
    speechEl = new Audio();
    // Nur der Satz, der gerade dran ist; nach Pause oder Sprung kommt kein `ended` mehr durch.
    speechEl.addEventListener('ended', () => hoeren?.ended());
    return speechEl;
  }

  /** Aktives Hören und das einer Seite, die es nur vorbereitet (erster Satz geladen, noch nicht gestartet). */
  let hoeren = null;
  let prepared = null;

  /**
   * Wiedergabeliste aus `ids` (Texte der Seite /lesen/hoeren). Mit `voice` (Stimme vom Server)
   * kommt jeder Satz als MP3 von `/lesen/hoeren/audio`, der nächste schon vorab; fällt sie aus,
   * liest für den Rest die Sprachausgabe des Geräts. Text und Sätze von `/lesen/hoeren/text`,
   * in Zeichen des Lesetexts wie src/lesen/anchor.js.
   */
  function createHoeren(list) {
    const ids = [...list.ids].map(String);
    const self = { key: ids.join(','), zeit: Number(list.zeit) || 15 };
    const csrf = String(list.csrf ?? '');
    const voiced = Boolean(list.voice);
    let serverDown = !voiced;
    /** Satz-Audio als Blob-URL je `id:start`, nur aktueller und nächster Satz. */
    const clips = new Map();
    // `cur`: geladener Text mit `pos` (Satz) und `i` (Stelle in der Liste); `gen` verwirft
    // Rückmeldungen abgebrochener Sätze, manche Browser melden auch dann `end`.
    let cur = null;
    let playing = false;
    let gen = 0;
    let loaded = false;
    let dead = false;
    let lock = null;
    // Verweis halten: Sonst räumt Chrome den Satz weg, bevor `end` kommt.
    let utterance = null;
    const active = () => hoeren === self;
    const show = () => !dead && emit();

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
        const el = speechAudio();
        el.src = url;
        el.playbackRate = rates.hoeren;
        el.play().catch((err) => {
          if (mine !== gen) return;
          stop();
          // Ohne Tipp lässt iOS nicht abspielen, wenn der Satz zu spät kam.
          note(err.name === 'NotAllowedError' ? 'Noch einmal auf Abspielen tippen.' : `Wiedergabe: ${err.message}`, 'error');
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
            return note(err.message, 'error');
          }
          serverDown = true;
          note(`${err.message}. Die Gerätestimme liest weiter.`, 'error');
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
      if (deviceVoice) u.voice = deviceVoice;
      u.rate = rates.hoeren;
      u.onend = () => mine === gen && finished();
      u.onerror = (e) => {
        if (mine !== gen || e.error === 'interrupted' || e.error === 'canceled') return;
        stop();
        note(`Sprachausgabe: ${e.error}`, 'error');
      };
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
      const body = new URLSearchParams({ csrf, id, fortschritt: progress.toFixed(3), anker: String(anchor) });
      fetch('/aktion/lesen/doc/fortschritt', { method: 'POST', keepalive: true, credentials: 'same-origin', headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' }, body }).catch(() => {});
    }

    /** Hält jede Ausgabe an, aber nur als aktives Hören: Ein vorbereitetes hat nichts zu sagen. */
    function silence() {
      if (!active()) return;
      synth?.cancel();
      speechEl?.pause();
    }

    async function advance(i) {
      const mine = ++gen;
      silence();
      let next;
      try {
        next = await load(i);
      } catch (err) {
        if (mine === gen) stop();
        return !dead && note(err.message, 'error');
      }
      if (mine !== gen) return;
      cur = next;
      loaded = true;
      if (!cur) {
        stop();
        return active() && note('Alles gehört.');
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
      const fields = { id: cur.id, quote: t.slice(start, end), prefix: t.slice(Math.max(0, start - CONTEXT), start), suffix: t.slice(end, end + CONTEXT), start: String(start), csrf };
      try {
        const data = await post('/aktion/lesen/markierung/neu', fields);
        const undo = data.undo;
        note(data.message, 'ok', undo ? { label: 'Rückgängig', run: () => post(undo.action, { ...undo.fields, csrf }).then((r) => note(r.message), (err) => note(err.message, 'error')) } : null);
      } catch (err) {
        note(err.message, 'error');
      }
    }

    return Object.assign(self, {
      state: () => ({ key: self.key, zeit: self.zeit, docId: cur?.id ?? null, title: cur?.title ?? null, sentence: cur ? cur.text.slice(...cur.sentences[cur.pos]) : '', playing, finished: loaded && !cur }),
      isPlaying: () => playing,
      preload: () => advance(0),
      play,
      stop,
      toggle: () => (playing ? stop() : play()),
      next: () => cur && advance(cur.i + 1),
      remember,
      ended: () => playing && !serverDown && cur && finished(),
      // Zurück im Vordergrund: Hat das System den Satz abgebrochen, ihn neu sprechen; die Bildschirmsperre neu holen.
      resume() {
        if (!playing) return;
        keepAwake(true);
        if (!serverDown) {
          if (cur && speechEl?.paused) speak();
          return;
        }
        // `speaking` bleibt auch bei einer vom System angehaltenen Ausgabe wahr.
        if (cur && (!synth.speaking || synth.paused)) speak();
      },
      destroy() {
        playing = false;
        gen++;
        silence();
        keepAwake(false);
        dead = true;
        trimClips([]);
        utterance = null;
      },
    });
  }

  const keyOf = (list) => [...list.ids].map(String).join(',');
  /** Hören zu `key`: das aktive oder das vorbereitete; ohne `key` das aktive. */
  const hoerenFor = (key) => (key == null ? hoeren : hoeren?.key === key ? hoeren : prepared?.key === key ? prepared : null);

  /** Seite /lesen/hoeren geöffnet: ersten Text und Satz holen, ohne zu stören, was gerade läuft. */
  function prepareHoeren(list) {
    const key = keyOf(list);
    if (hoeren?.key === key || prepared?.key === key) return;
    prepared?.destroy();
    prepared = createHoeren(list);
    prepared.preload();
  }

  /** „Abspielen“ auf /lesen/hoeren: dieselbe Liste anhalten oder weiter, sonst sie starten. */
  function playHoeren(list) {
    const key = keyOf(list);
    if (kind === 'hoeren' && hoeren.key === key) return hoeren.toggle();
    const next = prepared?.key === key ? prepared : createHoeren(list);
    if (next === prepared) prepared = null;
    leave();
    hoeren = next;
    kind = 'hoeren';
    actions();
    hoeren.play();
  }

  // MARK: Steuerung

  /** Beendet, was läuft: Folge mit gemerkter Stelle anhalten, Hören abbrechen. */
  function leave() {
    const wasFolge = Boolean(folge && audio);
    if (wasFolge) rememberSpot(true);
    const old = hoeren;
    // Erst den Stand leeren: `pause` und `emit` dürfen keine halbe Wiedergabe sehen.
    folge = null;
    hoeren = null;
    kind = null;
    if (wasFolge) {
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
    }
    if (old) {
      // `destroy` hält nur das aktive Hören an; für einen Moment ist es das noch.
      hoeren = old;
      old.destroy();
      hoeren = null;
    }
  }

  function toggle() {
    if (kind === 'folge') {
      if (audio.paused) startFolge();
      else audio.pause();
    } else if (kind === 'hoeren') hoeren.toggle();
  }

  function close() {
    leave();
    clearTimeout(messageTimer);
    message = null;
    messageAction = null;
    emit();
  }

  function setRate(which, value) {
    if (!(which in rates) || !(value > 0)) return;
    rates[which] = value;
    store.set(RATE_KEYS[which], String(value));
    if (which === 'folge' && audio) audio.playbackRate = value;
    if (which === 'hoeren' && speechEl) speechEl.playbackRate = value;
    emit();
  }

  function playing() {
    if (kind === 'folge') return !audio.paused;
    if (kind === 'hoeren') return hoeren.isPlaying();
    return false;
  }

  /** Sperrbildschirm, Kontrollzentrum, Kopfhörer: je nach dem, was läuft. */
  function actions() {
    if (!session) return;
    const on = (action, handler) => {
      try {
        session.setActionHandler(action, handler);
      } catch {
        /* Aktion unbekannt */
      }
    };
    const isFolgeNow = kind === 'folge';
    on('play', () => !playing() && toggle());
    on('pause', () => playing() && toggle());
    on('stop', () => playing() && toggle());
    on('seekbackward', isFolgeNow ? (d) => skip(-(d?.seekOffset || SKIP_BACK)) : null);
    on('seekforward', isFolgeNow ? (d) => skip(d?.seekOffset || SKIP_FORWARD) : null);
    on(
      'seekto',
      isFolgeNow
        ? (d) => {
            if (kind !== 'folge' || !Number.isFinite(d?.seekTime)) return;
            if (d.fastSeek && 'fastSeek' in audio) audio.fastSeek(d.seekTime);
            else audio.currentTime = d.seekTime;
          }
        : null,
    );
    // Ohne vorige/nächste Folge zeigt iOS sonst Spulen statt ±Sekunden.
    on('previoustrack', null);
    on('nexttrack', isFolgeNow ? null : () => hoeren?.next());
  }

  let shownMeta = '';
  function syncSession(s) {
    if (!session) return;
    const meta = s.folge ? [s.folge.title, `Cockpit · ${s.folge.art}`, 'Folgen aus dem Lesestapel'] : s.hoeren?.title ? [s.hoeren.title, 'Cockpit', 'Unterwegs hören'] : null;
    const sig = meta ? meta.join('\n') : '';
    if (sig !== shownMeta) {
      shownMeta = sig;
      try {
        session.metadata =
          meta && 'MediaMetadata' in window
            ? new window.MediaMetadata({
                title: meta[0],
                artist: meta[1],
                album: meta[2],
                artwork: [
                  { src: '/static/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
                  { src: '/static/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
                ],
              })
            : null;
      } catch {
        /* ältere Browser */
      }
    }
    session.playbackState = s.kind ? (s.playing ? 'playing' : 'paused') : 'none';
  }

  function snapshot() {
    return {
      kind,
      visible: Boolean(kind || message),
      playing: playing(),
      folge: kind === 'folge' ? { id: folge.id, title: folge.title, art: folge.art, position: audio.ended ? 0 : audio.currentTime || 0, duration: folgeLength(), error: folge.error } : null,
      hoeren: kind === 'hoeren' ? hoeren.state() : null,
      vorbereitet: prepared?.state() ?? null,
      rates: { ...rates },
      message,
      /** Höhe der Leiste samt Abstand in Pixeln. */
      space: barSpace,
    };
  }

  function emit() {
    const s = snapshot();
    render(s);
    syncSession(s);
    for (const fn of [...listeners]) {
      try {
        fn(s);
      } catch {
        // Seite im Rahmen schon weg.
        listeners.delete(fn);
      }
    }
  }

  function on(fn) {
    listeners.add(fn);
    try {
      fn(snapshot());
    } catch {
      listeners.delete(fn);
    }
    return () => listeners.delete(fn);
  }

  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && hoeren?.resume());

  window.cockpitPlayer = {
    isShell: true,
    on,
    state: snapshot,
    toggle,
    close,
    setRate,
    playFolge,
    seekFolge,
    skip,
    prepareHoeren,
    playHoeren,
    nextText: (key) => hoerenFor(key)?.next(),
    remember: (key) => hoerenFor(key)?.remember(),
    /** Ob „Unterwegs hören“ hier gehen kann: Stimme vom Server oder Sprachausgabe im Browser. */
    canHoeren: (voice) => Boolean(voice) || Boolean(synth),
    clock,
  };

  // MARK: Leiste

  const ICON = {
    play: '<svg viewBox="0 0 24 24" class="player-icon-play" aria-hidden="true"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.6-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z"/></svg>',
    pause: '<svg viewBox="0 0 24 24" class="player-icon-pause" aria-hidden="true"><rect x="6.5" y="5" width="4" height="14" rx="1.2"/><rect x="13.5" y="5" width="4" height="14" rx="1.2"/></svg>',
    next: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 6.2v11.6a.8.8 0 0 0 1.2.7l8.6-5.8a.8.8 0 0 0 0-1.4L6.2 5.5a.8.8 0 0 0-1.2.7z"/><rect x="16.5" y="5.5" width="2.6" height="13" rx="1"/></svg>',
    mark: '<svg viewBox="0 0 24 24" aria-hidden="true" class="stroke"><path d="M14.5 4.5l5 5L10 19H5v-5z"/><path d="M4 21h16"/></svg>',
  };

  let bar = null;
  let barSpace = 0;
  const part = (name) => bar.querySelector(`[data-part=${name}]`);

  function buildBar() {
    const el = document.createElement('div');
    el.className = 'player-bar';
    el.setAttribute('role', 'region');
    el.setAttribute('aria-label', 'Wiedergabe');
    el.innerHTML = `<input type="range" class="player-seek" data-part="seek" min="0" max="0" step="1" value="0" aria-label="Stelle">
<div class="player-row">
  <button type="button" class="player-toggle" data-p="toggle" aria-pressed="false" aria-label="Abspielen">${ICON.play}${ICON.pause}</button>
  <a class="player-info" data-part="info" href="/lesen"><span class="player-title" data-part="title"></span><span class="player-sub" data-part="sub"></span></a>
  <button type="button" class="player-btn player-skip" data-p="back" data-part="back" aria-label="15 Sekunden zurück">−15</button>
  <button type="button" class="player-btn player-skip" data-p="fwd" data-part="fwd" aria-label="30 Sekunden vor">+30</button>
  <button type="button" class="player-btn" data-p="mark" data-part="mark" aria-label="Das hier merken">${ICON.mark}</button>
  <button type="button" class="player-btn" data-p="next" data-part="next" aria-label="Nächster Text">${ICON.next}</button>
  <button type="button" class="player-btn player-close" data-p="close" aria-label="Player schließen">×</button>
</div>
<p class="player-msg" data-part="msg" role="status" hidden><span data-part="msg-text"></span><button type="button" class="player-msg-action" data-p="action" data-part="msg-action"></button><button type="button" class="player-msg-close" data-p="dismiss" aria-label="Meldung schließen">×</button></p>`;
    el.addEventListener('click', (e) => {
      if (!(e.target instanceof Element)) return;
      // Titel: zur Seite des Players, aber nicht neu laden, wenn man schon dort ist.
      const info = e.target.closest('[data-part=info]');
      if (info) {
        const here = frame ? frame.contentWindow?.location.href : location.href;
        if (urlOf(info.getAttribute('href'))?.href === here) e.preventDefault();
        return;
      }
      const b = e.target.closest('[data-p]');
      if (!b) return;
      const cmd = b.dataset.p;
      if (cmd === 'toggle') toggle();
      else if (cmd === 'back') skip(-SKIP_BACK);
      else if (cmd === 'fwd') skip(SKIP_FORWARD);
      else if (cmd === 'next') hoeren?.next();
      else if (cmd === 'mark') hoeren?.remember();
      else if (cmd === 'close') close();
      else if (cmd === 'dismiss') dismiss();
      else if (cmd === 'action') {
        const run = messageAction;
        dismiss();
        run?.();
      }
    });
    el.querySelector('[data-part=seek]').addEventListener('input', (e) => {
      if (kind === 'folge' && Number.isFinite(audio.duration)) audio.currentTime = Number(e.target.value);
      emit();
    });
    document.body.append(el);
    // Die Leiste wächst mit Regler und Meldung; die Seiten (auch im Rahmen) rücken mit.
    if (typeof ResizeObserver === 'function')
      new ResizeObserver(() => {
        const space = el.hidden ? 0 : Math.ceil(el.getBoundingClientRect().height) + 8;
        if (space !== barSpace) {
          barSpace = space;
          emit();
        }
      }).observe(el);
    return el;
  }

  function render(s) {
    makeRoom(s);
    if (!bar && !s.visible) return;
    bar ??= buildBar();
    bar.hidden = !s.visible;
    bar.classList.toggle('is-playing', s.playing);
    bar.classList.toggle('is-empty', !s.kind);
    const toggleButton = bar.querySelector('[data-p=toggle]');
    toggleButton.setAttribute('aria-pressed', String(s.playing));
    toggleButton.setAttribute('aria-label', s.playing ? 'Pause' : 'Abspielen');
    toggleButton.disabled = !s.kind;
    const f = s.folge;
    const h = s.hoeren;
    part('title').textContent = f ? f.title : h ? h.title ?? (h.finished ? 'Alles gehört' : 'Lädt …') : '';
    part('sub').textContent = f ? (f.error ?? `${f.art} · ${clock(f.position)} / ${f.duration ? clock(f.duration) : '–'}`) : h ? h.sentence || 'Unterwegs hören' : '';
    part('info').href = f ? '/lesen/folgen' : h ? `/lesen/hoeren?zeit=${h.zeit}` : '/lesen';
    part('info').hidden = !s.kind;
    const seek = part('seek');
    seek.hidden = !f;
    if (f) {
      seek.max = String(Math.floor(f.duration));
      if (document.activeElement !== seek) seek.value = String(Math.floor(f.position));
      seek.setAttribute('aria-valuetext', `${clock(f.position)} von ${clock(f.duration)}`);
    }
    part('back').hidden = !f;
    part('fwd').hidden = !f;
    part('mark').hidden = !h?.title;
    part('next').hidden = !h || h.finished;
    const msg = part('msg');
    msg.hidden = !s.message;
    if (s.message) {
      msg.className = `player-msg ${s.message.kind}`;
      msg.setAttribute('role', s.message.kind === 'error' ? 'alert' : 'status');
      part('msg-text').textContent = s.message.text;
      part('msg-action').hidden = !s.message.action;
      part('msg-action').textContent = s.message.action ?? '';
    }
  }

  // MARK: Hülle

  let frame = null;

  /** Macht die Seite zur Hülle: Rahmen für die Seiten, die alte Seite verschwindet nach dem ersten Laden. */
  function ensureFrame() {
    if (frame) return frame;
    frame = document.createElement('iframe');
    frame.name = FRAME;
    frame.className = 'player-frame';
    frame.title = 'Cockpit';
    frame.addEventListener('load', framed);
    document.body.prepend(frame);
    root.classList.add('player-shell');
    // Ein Eintrag für die alte Seite: Zurück vom ersten Seitenwechsel landet wieder dort, im Rahmen.
    history.pushState({ cockpitRahmen: true }, '', location.href);
    // Die Seite der Hülle ist nur noch Kulisse: Ihre Abos und Tastenkürzel laufen sonst ins Leere.
    listeners.clear();
    for (const type of ['keydown', 'keyup', 'keypress']) window.addEventListener(type, (e) => e.stopImmediatePropagation(), true);
    return frame;
  }

  function openFrame(url) {
    ensureFrame().src = url;
  }

  let firstLoad = true;
  function framed() {
    let doc = null;
    let href = '';
    try {
      doc = frame.contentDocument;
      href = frame.contentWindow.location.href;
    } catch {
      doc = null;
    }
    // Fremde Seite im Rahmen (Anmeldung bei Pocket ID): im ganzen Fenster neu anmelden.
    if (!doc) return location.assign(`/login?next=${encodeURIComponent(location.pathname + location.search)}`);
    if (href === 'about:blank') return;
    if (firstLoad) {
      firstLoad = false;
      for (const el of [...document.body.children]) if (el !== frame && el !== bar) el.remove();
    }
    document.title = doc.title;
    if (href !== location.href) history.replaceState(history.state, '', href);
    root.classList.remove('navigating');
  }

  // Zurück bis vor den ersten Seitenwechsel: die alte Seite im Rahmen zeigen.
  window.addEventListener('popstate', (e) => {
    if (frame && !e.state?.cockpitRahmen) frame.contentWindow?.location.replace(location.href);
  });

  // Am `window` lauschen: Dort kommen Klick und Absenden erst nach den Handlern der Seite an,
  // die sie vielleicht selbst übernehmen (`preventDefault`).
  window.addEventListener('click', (e) => {
    if (!kind || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = e.target instanceof Element ? e.target.closest('a[href]') : null;
    const target = a?.getAttribute('target');
    if (!a || (target && target !== '_self') || a.hasAttribute('download')) return;
    const url = urlOf(a.getAttribute('href'));
    if (!inside(url)) return;
    // Sprung innerhalb der Seite, solange es noch keinen Rahmen gibt.
    if (!frame && url.hash && url.pathname === location.pathname && url.search === location.search) return;
    e.preventDefault();
    openFrame(url.href);
  });

  window.addEventListener('submit', (e) => {
    const form = e.target;
    if (!kind || e.defaultPrevented || !(form instanceof HTMLFormElement) || form.getAttribute('method')?.toLowerCase() === 'dialog') return;
    const target = e.submitter?.getAttribute('formtarget') ?? form.getAttribute('target');
    if (target && target !== '_self') return;
    if (!inside(urlOf(e.submitter?.getAttribute('formaction') ?? form.getAttribute('action')))) return;
    // Das Formular schickt der Browser selbst, nur eben in den Rahmen (`target` zählt erst nach dem Ereignis).
    ensureFrame();
    form.target = FRAME;
  });

  // Seitenwechsel aus Scripten (/static/ui.js): während der Wiedergabe in den Rahmen.
  const wechsel = window.cockpitWechsel;
  window.cockpitWechsel = (url) => {
    const to = urlOf(url);
    if (kind && inside(to)) return openFrame(to.href);
    return wechsel ? wechsel(url) : location.assign(url);
  };
})();
