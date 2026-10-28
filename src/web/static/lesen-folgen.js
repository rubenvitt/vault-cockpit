// Folgen (src/lesen/folgen-page.js): großer Knopf je Folge, Stelle, ±Sekunden
// und Tempo statt des eingebetteten <audio controls>. Abgespielt wird im Player
// des Cockpits (/static/player.js, `window.cockpitPlayer`): Er läuft beim Wechsel
// auf andere Seiten weiter, steht als Leiste unten und über die Media Session auf
// dem Sperrbildschirm, im Kontrollzentrum und an Kopfhörern. Die Karten zeigen
// nur seinen Stand. Die Stelle je Folge bleibt im Browser, beim nächsten
// Abspielen geht es dort weiter.
//
// In der iOS-App schickt der Knopf nur `{type:'folge', id, titel, art}` an die
// App; dort spielt der native Player (Sperrbildschirm, AirPlay, Hintergrund).
//
// Auf `/lesen/folgen/neu` rechnet es den Satz am Knopf (Art, Texte, Dauer,
// Kosten, erst nur Transkript) beim Umschalten neu, wie `newSummary` in
// src/lesen/folgen-page.js, zeigt die Erklärung zum gewählten Ton und lässt
// höchstens `MAX_TOPICS` Themen wählen; auf `/lesen/folgen/thema` wie `topicSummary`.
//
// Solange eine Folge entsteht, holt die Seite alle paar Sekunden
// `/lesen/folgen/stand` und tauscht die Karten der entstehenden Folgen aus
// (ein aufgeklappter Worklog bleibt dabei offen).
//
// Der Player meldet die Stelle dem Server (`data-csrf` der Karte); kurz vor
// Schluss gilt die Folge dort als gehört und rückt beim nächsten Laden nach
// unten unter „Gehört“.
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
    const styleHint = form.querySelector('[data-style-hint]');
    const MAX_TOPICS = 5;
    const update = () => {
      const kind = form.querySelector('input[name=art]:checked')?.value;
      const docs = [...form.querySelectorAll('input[name=doc]:checked')];
      const minutes = Number(form.querySelector('input[name=laenge]:checked')?.value) || 10;
      const audio = form.querySelector('input[name=audio]:checked')?.value !== '0';
      const style = form.querySelector('input[name=stil]:checked');
      if (styleHint && style) styleHint.textContent = style.dataset.hint ?? '';
      const topics = [...form.querySelectorAll('input[name=thema]')];
      const full = topics.filter((t) => t.checked).length >= MAX_TOPICS;
      for (const t of topics) t.disabled = full && !t.checked;
      if (!kind) return;
      submit.disabled = !docs.length;
      if (!docs.length) return show('Bitte mindestens einen Text wählen', '');
      const maxDocs = Number(form.dataset.maxDocs) || Infinity;
      submit.disabled = docs.length > maxDocs;
      if (docs.length > maxDocs) return show(`Höchstens ${maxDocs} Texte je Folge`, `${docs.length} gewählt`);
      const n = `${docs.length} ${docs.length === 1 ? 'Text' : 'Texte'}`;
      if (kind === 'vorlesen') {
        const chars = docs.reduce((sum, d) => sum + (Number(d.dataset.chars) || 0), 0);
        show(`Vorlesen · ${n} · etwa ${Math.max(1, Math.round(chars / 900))} Min.`, chars ? `rund ${fmt.format(chars)} Zeichen bei ElevenLabs` : 'Schon alles gehört, kostet nichts');
      } else if (!audio) {
        show(`${KINDS[kind]} · ${n} · ${minutes} Min. · erst Transkript`, 'Nur dein Claude-Abo; Audio später auf Knopfdruck');
      } else {
        show(`${KINDS[kind]} · ${n} · ${minutes} Min.`, `rund ${fmt.format(minutes * 900)} Zeichen bei ElevenLabs, dazu dein Claude-Abo`);
      }
    };
    form.addEventListener('change', update);
    // Doppeltes Absenden würde zwei Folgen bezahlen.
    form.addEventListener('submit', () => setTimeout(() => (submit.disabled = true)));
    update();
  }

  // Zu einem Thema: Vorschläge setzen die Minuten, eigene Minuten heben den Vorschlag auf.
  const topic = document.querySelector('[data-folge-thema]');
  if (topic) {
    const fmt = new Intl.NumberFormat('de-DE');
    const KINDS = { podcast: 'Podcast', report: 'Report' };
    const minutes = topic.querySelector('input[name=minuten]');
    const submit = topic.querySelector('button[type=submit]');
    const min = Number(minutes.min);
    const max = Number(minutes.max);
    const update = () => {
      const kind = topic.querySelector('input[name=art]:checked')?.value ?? 'report';
      const web = topic.querySelector('input[name=internet]')?.checked;
      const audio = topic.querySelector('input[name=audio]:checked')?.value !== '0';
      const m = Number(minutes.value);
      for (const r of topic.querySelectorAll('input[name=vorschlag]')) r.checked = Number(r.value) === m;
      const okay = Number.isInteger(m) && m >= min && m <= max;
      if (!submit.hasAttribute('data-off')) submit.disabled = !okay;
      const h = m >= 60 ? ` (${m % 60 ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}` : m / 60} Std.)` : '';
      topic.querySelector('[data-summary]').textContent = okay ? `${KINDS[kind]} zum Thema · ${m} Min.${h} · Vault${web ? ' und Internet' : ''}${audio ? '' : ' · erst Transkript'}` : `Länge: ${min} bis ${max} Minuten`;
      topic.querySelector('[data-cost]').textContent = !okay ? '' : audio ? `rund ${fmt.format(m * 900)} Zeichen bei ElevenLabs, dazu dein Claude-Abo` : 'Nur dein Claude-Abo; Audio später auf Knopfdruck';
    };
    if (submit.disabled) submit.setAttribute('data-off', '');
    topic.addEventListener('change', (e) => {
      if (e.target.name === 'vorschlag') minutes.value = e.target.value;
      update();
    });
    minutes.addEventListener('input', update);
    topic.addEventListener('submit', () => setTimeout(() => (submit.disabled = true)));
    update();
  }

  // Mehrere Listen (Zum Hören, Entsteht, Gehört …); `list` meint alle zusammen.
  const list = document.querySelector('.folgen-gruppen') ?? document.querySelector('.folgen');
  if (!list) return;
  const app = window.webkit?.messageHandlers?.cockpit;
  const engine = window.cockpitPlayer;
  const toast = (text) => window.cockpit?.toast?.(text);
  const SPOT = 'folgen-stelle:';
  const clock = (seconds) => engine?.clock(seconds) ?? '';

  // MARK: Player

  const part = (li, name) => li.querySelector(`[data-${name}]`);
  const meta = (li) => ({ id: li.dataset.folge, src: li.dataset.src, title: li.dataset.title, art: li.dataset.art, seconds: Number(li.dataset.seconds) || 0, csrf: li.dataset.csrf || null });
  const isCurrent = (li, s) => s.folge?.id === li.dataset.folge;

  function spotOf(li) {
    try {
      return Number(localStorage.getItem(SPOT + li.dataset.folge)) || 0;
    } catch {
      return 0;
    }
  }

  function bind(li) {
    const play = part(li, 'play');
    if (!play || (!app && !engine)) return;
    li.querySelector('.folge-nojs')?.remove();
    play.hidden = false;
    play.addEventListener('click', () => toggle(li));
    if (app) return;
    const seek = part(li, 'seek');
    seek.addEventListener('input', () => {
      engine.seekFolge(meta(li), Number(seek.value));
      showTime(li, Number(seek.value));
    });
    for (const b of li.querySelectorAll('[data-skip]')) b.addEventListener('click', () => isCurrent(li, engine.state()) && engine.skip(Number(b.dataset.skip)));
    const select = part(li, 'rate');
    const rate = String(engine.state().rates.folge);
    if (select.value !== rate && [...select.options].some((o) => o.value === rate)) select.value = rate;
    select.addEventListener('change', () => engine.setRate('folge', Number(select.value) || 1));
    // Gemerkte Stelle schon vor dem Abspielen zeigen.
    const spot = spotOf(li);
    if (spot > 0) {
      part(li, 'player').hidden = false;
      seek.value = String(spot);
      showTime(li, spot);
    }
    show(engine.state());
  }

  function toggle(li) {
    if (app) {
      // Länge und Größe vom Server: Die App erkennt daran eine erneuerte MP3 im Cache.
      app.postMessage({ type: 'folge', id: li.dataset.folge, titel: li.dataset.title, art: li.dataset.art, dauer: Number(li.dataset.seconds) || 0, groesse: Number(li.dataset.bytes) || 0 });
      return;
    }
    engine.playFolge(meta(li));
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

  /** Karten nach dem Stand des Players: laufende Folge mit Stelle, Länge und Fehler. */
  function show(s) {
    for (const li of list.querySelectorAll('.folge[data-src]')) {
      const current = isCurrent(li, s);
      const playing = current && s.playing;
      li.classList.toggle('is-current', current);
      li.classList.toggle('is-playing', playing);
      setPressed(li, playing);
      const rate = part(li, 'rate');
      const want = String(s.rates.folge);
      if (rate && rate.value !== want && [...rate.options].some((o) => o.value === want)) rate.value = want;
      if (!current) continue;
      const f = s.folge;
      part(li, 'player').hidden = false;
      const seek = part(li, 'seek');
      seek.max = String(Math.floor(f.duration));
      if (document.activeElement !== seek) seek.value = String(Math.floor(f.position));
      showTime(li, f.position);
      if (f.duration) part(li, 'dur').textContent = clock(f.duration);
      const box = part(li, 'error');
      box.textContent = f.error ?? '';
      box.hidden = !f.error;
    }
  }

  // Leertaste: Abspielen/Pause der laufenden Folge, solange kein Feld den Fokus hat.
  document.addEventListener('keydown', (e) => {
    if (e.key !== ' ' || !engine || app || !engine.state().folge || e.target.closest?.('input, select, textarea, button, a')) return;
    e.preventDefault();
    engine.toggle();
  });

  // MARK: Transkript kopieren und teilen

  // Safari kopiert nur im Klick selbst: Der Text darf als Promise nachkommen
  // (ClipboardItem), `writeText` nach einem `await` lehnt es ab.
  async function copyFrom(src) {
    const load = async () => {
      const res = await fetch(src, { credentials: 'same-origin', cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.text();
    };
    if (window.ClipboardItem && navigator.clipboard?.write) {
      try {
        const blob = load().then((text) => new Blob([text], { type: 'text/plain' }));
        await navigator.clipboard.write([new ClipboardItem({ 'text/plain': blob })]);
        return;
      } catch {
        /* weiter mit writeText */
      }
    }
    await navigator.clipboard.writeText(await load());
  }

  async function copyText(text, field) {
    try {
      await navigator.clipboard.writeText(text);
      toast('Link kopiert');
    } catch {
      field?.select();
      toast('Link markiert, bitte kopieren');
    }
  }

  list.addEventListener('click', async (e) => {
    const copy = e.target.closest('[data-copy]');
    if (copy) {
      e.preventDefault();
      try {
        await copyFrom(copy.getAttribute('href'));
        toast('Text kopiert');
      } catch {
        // Ohne Zugriff auf die Zwischenablage: das Markdown öffnen, dort lässt es sich markieren.
        location.href = copy.getAttribute('href');
      }
      return;
    }
    const again = e.target.closest('[data-share-copy]');
    if (again) copyText(again.dataset.shareCopy, again.parentElement.querySelector('input'));
  });

  list.addEventListener('submit', async (e) => {
    const form = e.target.closest('[data-share]');
    if (!form) return;
    e.preventDefault();
    const out = form.closest('.folge')?.querySelector('[data-share-out]');
    let data;
    try {
      const res = await fetch(form.action, { method: 'POST', body: new URLSearchParams(new FormData(form)), headers: { accept: 'application/json' }, credentials: 'same-origin' });
      data = await res.json();
      if (!res.ok) throw new Error(data.message);
    } catch (err) {
      toast(err.message || 'Kein Link, bitte noch einmal versuchen');
      return;
    }
    if (!out) return toast(data.message);
    const until = new Date(data.expiresAt).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
    out.replaceChildren();
    const field = Object.assign(document.createElement('input'), { type: 'text', readOnly: true, value: data.url, className: 'folge-link-url' });
    field.setAttribute('aria-label', 'Einmal-Link');
    field.addEventListener('focus', () => field.select());
    const button = Object.assign(document.createElement('button'), { type: 'button', className: 'btn quiet', textContent: 'Link kopieren' });
    button.dataset.shareCopy = data.url;
    const note = Object.assign(document.createElement('p'), { className: 'meta', textContent: `Gilt bis ${until} Uhr und nur für einen Abruf, liefert reines Markdown.` });
    out.append(field, button, note);
    out.hidden = false;
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
      // Ein aufgeklappter Worklog bleibt offen.
      if (li.querySelector('[data-worklog]')?.open) next.querySelector('[data-worklog]')?.setAttribute('open', '');
      li.replaceWith(next);
      bind(next);
      if (item.status === 'fertig') toast(`Fertig: ${next.dataset.title}`);
      else if (item.status === 'transkript') toast('Transkript fertig, liegt im Vault');
    }
    poll();
  }

  for (const li of list.querySelectorAll('.folge')) bind(li);
  if (engine && !app) engine.on(show);
  poll();
  document.addEventListener('visibilitychange', () => !document.hidden && list.querySelector('.folge.is-busy') && refresh());
})();
