// Querverbindungen in der Leseansicht (VCP-73, src/lesen/connections.js).
// Übernimmt „Verbinden“ (Ereignis `lesen:verbinden` aus /static/lesen-doc.js),
// holt ähnliche Stellen aus `/api/lesen/verbindungen` und zeigt sie in der
// Seitenleiste, auf schmalen Bildschirmen als Blatt von unten. „Verknüpfen“
// schreibt einen Wikilink in die Lesestapel-Notiz; eine Auswahl ohne Markierung
// wird vorher markiert. Ohne Script bleibt der Hinweis in der Seitenleiste.
(() => {
  'use strict';

  if (!window.cockpit || !document.querySelector('.lesen-reader')) return;
  const { toast, send, csrf } = window.cockpit;
  // `{ req, open, loading?, error?, data? }`; `req` ist das `detail` von `lesen:verbinden`.
  let state = null;
  // lesen-doc.js tauscht die Seitenleiste nach jeder Änderung aus: immer frisch holen.
  const box = () => document.querySelector('[data-verbindungen]');

  document.addEventListener('lesen:verbinden', (e) => {
    e.preventDefault();
    load(e.detail);
  });
  document.addEventListener('lesen:markierung', () => state && render());
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state?.open) close();
  });

  function close() {
    state.open = false;
    render();
  }

  async function load(req) {
    state = { req, open: true, loading: true };
    render(true);
    const query = req.highlightId ? { markierung: req.highlightId } : { doc: req.docId, text: (req.anchor?.quote ?? '').slice(0, 1000) };
    let next;
    try {
      const res = await fetch(`/api/lesen/verbindungen?${new URLSearchParams(query)}`, { headers: { accept: 'application/json' }, credentials: 'same-origin' });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data) throw new Error(data?.message ?? 'Querverbindungen nicht geladen');
      next = { req, open: true, data };
    } catch (err) {
      next = { req, open: true, error: err instanceof TypeError ? 'Ohne Netz keine Querverbindungen' : err.message };
    }
    // Inzwischen etwas anderes gewählt: diese Antwort verwerfen.
    if (state?.req !== req) return;
    state = next;
    render();
  }

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  const short = (s, n = 220) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

  function render(focus = false) {
    const section = box();
    if (!section || !state) return;
    section.classList.toggle('is-open', state.open);
    section.setAttribute('aria-busy', String(Boolean(state.loading)));
    const head = el('div', 'lesen-links-head');
    head.append(el('h2', null, 'Querverbindungen'));
    const closer = el('button', 'btn quiet lesen-links-close', 'Schließen');
    closer.type = 'button';
    closer.addEventListener('click', close);
    head.append(closer);
    const parts = [head];
    if (state.loading) parts.push(el('p', 'meta', 'Suche passende Stellen …'));
    else if (state.error) parts.push(el('p', 'empty', state.error));
    else parts.push(...results(state.data));
    section.replaceChildren(...parts);
    if (focus) {
      section.tabIndex = -1;
      // Nie scrollen: Das zählte in lesen-doc.js als Lesefortschritt.
      section.focus({ preventScroll: true });
    }
  }

  function results(data) {
    const out = [];
    if (data.problem) out.push(el('p', 'meta lesen-links-problem', data.problem));
    if (data.linked.length) {
      out.push(el('h3', null, 'Schon verknüpft'));
      const ul = el('ul', 'lesen-links-done');
      for (const l of data.linked) {
        const li = el('li');
        if (l.href) {
          const a = el('a', null, l.target);
          a.href = l.href;
          li.append(a);
        } else li.textContent = l.target;
        ul.append(li);
      }
      out.push(ul);
    }
    if (data.highlights.length) out.push(el('h3', null, 'Aus anderen Texten'), list(data.highlights, 'highlight'));
    if (data.notes.length) out.push(el('h3', null, data.source === 'semantic' ? 'Synthesen und Konzepte' : 'Aus dem Vault'), list(data.notes, 'note'));
    if (!data.highlights.length && !data.notes.length) out.push(el('p', 'empty', 'Nichts Passendes gefunden.'));
    return out;
  }

  function list(hits, kind) {
    const ul = el('ul', 'lesen-notes lesen-links-hits');
    for (const hit of hits) {
      const li = el('li');
      const a = el('a', null, hit.title);
      a.href = hit.href;
      const meta = el('span', 'meta');
      meta.append(a);
      if (hit.heading) meta.append(` · ${hit.heading}`);
      li.append(meta);
      if (hit.text) li.append(el('blockquote', 'lesen-quote', short(hit.text)));
      if (hit.linked) li.append(el('span', 'meta lesen-links-linked', 'Schon verknüpft'));
      else {
        const b = el('button', 'btn quiet', 'Verknüpfen');
        b.type = 'button';
        b.addEventListener('click', () => connect(hit, kind, b));
        li.append(b);
      }
      ul.append(li);
    }
    return ul;
  }

  async function connect(hit, kind, button) {
    const s = state;
    button.disabled = true;
    try {
      let id = s.req.highlightId ?? s.data.highlightId;
      if (!id) {
        // Auswahl ohne Markierung: erst markieren, dann verknüpfen.
        const marked = await send('/aktion/lesen/markierung/neu', new URLSearchParams({ id: s.req.docId, ...s.req.anchor, csrf: csrf() }));
        id = marked.highlight.id;
        s.data.highlightId = id;
        getSelection().removeAllRanges();
        await refresh();
        document.dispatchEvent(new CustomEvent('lesen:markierung', { detail: { action: '/aktion/lesen/markierung/neu', ...marked } }));
      }
      const fields = kind === 'note' ? { pfad: hit.path, abschnitt: hit.heading ?? '' } : { zu: hit.id };
      const data = await send('/aktion/lesen/verbinden', new URLSearchParams({ markierung: id, ...fields, csrf: csrf() }));
      toast(data.message, data.undo ? { action: { label: 'Rückgängig', run: () => unlink(data.undo) } } : {});
      // Neu laden, damit „Schon verknüpft“ oben und an den Treffern stimmt.
      if (state === s) return load({ ...s.req, highlightId: id, anchor: null });
    } catch (err) {
      toast(err.message, { kind: 'error' });
    }
    if (state === s) render();
  }

  /** Rückgängig nach „Verknüpfen“: Link wieder heraus, offene Liste neu laden (VCP-85). */
  async function unlink(undo) {
    try {
      const data = await send(undo.action, new URLSearchParams({ ...undo.fields, csrf: csrf() }));
      toast(data.message);
      // Nach dem Verknüpfen hat `load` einen neuen Stand angelegt; maßgeblich ist, ob noch dieselbe Markierung offen ist.
      const current = state?.req?.highlightId ?? state?.data?.highlightId;
      if (state?.open && current === undo.fields.markierung) await load({ ...state.req, highlightId: current, anchor: null });
    } catch (err) {
      toast(err.message, { kind: 'error' });
    }
  }

  /** Lesetext und Seitenleiste neu vom Server, damit die neue Markierung im Text steht (wie in lesen-doc.js). */
  async function refresh() {
    try {
      const res = await fetch(location.href, { headers: { accept: 'text/html' }, credentials: 'same-origin' });
      if (!res.ok) return;
      const fresh = new DOMParser().parseFromString(await res.text(), 'text/html');
      for (const sel of ['.lesen-text', '.lesen-side']) {
        const next = fresh.querySelector(sel);
        if (next) document.querySelector(sel)?.replaceWith(document.adoptNode(next));
      }
    } catch {
      /* Die Verknüpfung kommt trotzdem; beim nächsten Laden steht die Markierung im Text. */
    }
  }
})();
