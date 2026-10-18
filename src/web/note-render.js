import { esc, formHead, flashToast, obsidianLink } from './render.js';
import { renderMarkdown, inlineMd } from './markdown-render.js';
import { head, appHeader } from './layout.js';

const noteHref = (path) => `/notiz?pfad=${encodeURIComponent(path)}`;
const graphHref = (path) => `/graph?pfad=${encodeURIComponent(path)}`;
const fmText = (v) => (Array.isArray(v) ? v.join(', ') : typeof v === 'object' && v ? JSON.stringify(v) : String(v ?? ''));
const plain = (s) => s.replace(/!?\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, t, l) => l ?? t);

/**
 * Frontmatter kompakt: eine Zeile mit den ersten Feldern, aufgeklappt alle.
 * Werte mit Wikilinks (`"[[Feuersturm]]"`) werden Links wie im Text.
 */
function frontmatter(fm, links) {
  if (!fm.length) return '';
  const short = fm.slice(0, 3).map(([k, v]) => {
    const t = plain(fmText(v));
    return `${esc(k)}: ${esc(t.length > 40 ? `${t.slice(0, 39)}…` : t)}`;
  });
  const more = fm.length > 3 ? ` <span class="hint">+${fm.length - 3}</span>` : '';
  return `<details class="fm"><summary>${short.join(' · ')}${more}</summary><dl>${fm.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${inlineMd(fmText(v), links)}</dd>`).join('')}</dl></details>`;
}

/** „Verweist hierher“ und „Ähnlich“ unter der Notiz. */
function relatedSection(related) {
  if (!related) return '';
  const { backlinks, similar } = related;
  const li = (n, extra = '') => `<li><a href="${esc(noteHref(n.path))}">${esc(n.title)}</a>${extra}<span class="meta">${esc(n.path)}</span></li>`;
  const score = (h) => (h.score == null ? '' : ` <span class="score">${Math.round(h.score * 100)} %</span>`);
  const linked = (h) => (h.linked ? ' <span class="hint">verlinkt</span>' : '');
  const hits = similar.hits.slice(0, 6);
  return `<section class="note-related">
    <div><h2>Verweist hierher</h2>${backlinks.length ? `<ul>${backlinks.map((b) => li(b)).join('')}</ul>` : '<p class="empty">Keine Backlinks.</p>'}</div>
    <div><h2>Ähnlich</h2>${hits.length ? `<ul>${hits.map((h) => li(h, `${score(h)}${linked(h)}`)).join('')}</ul>` : '<p class="empty">Keine ähnlichen Notizen.</p>'}${similar.problem ? `<p class="hint">${esc(similar.problem)}</p>` : ''}</div>
  </section>`;
}

/**
 * Notizseite: Vorschau links, Verarbeiten rechts (auf dem iPhone darunter).
 * Jede Aktion ist ein Formular; `/static/cockpit.js` schickt sie ohne
 * Seitenwechsel. Checkboxen in der Vorschau sind Knöpfe zum Abhaken.
 * Wikilinks und Backlinks führen zu weiteren Notizseiten, so lässt sich im
 * Vault lesen, ohne Obsidian zu öffnen. `related` kommt von `notes.related`,
 * `graph` verlinkt den Graphen der Notiz.
 */
export function renderNote(note, { user = null, write = null, back = '/', flash = null, draft = null, targets = [], archive = null, vaultName = null, related = null, graph = false } = {}) {
  const ctx = { write, back };
  const obsidian = obsidianLink(note.path, vaultName);
  const checkbox = write
    ? (n, line, done) =>
        `${formHead(ctx, '/aktion/notiz/checkbox', { pfad: note.path, n, line: line.trim(), erledigt: done ? '0' : '1' }).replace('class="act"', 'class="act box-form"')}<button type="submit" class="box${done ? ' on' : ''}" aria-pressed="${done}" aria-label="${done ? 'Wieder öffnen' : 'Abhaken'}"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7"/></svg></button></form>`
    : null;
  const fm = Object.entries(note.frontmatter ?? {}).filter(([k]) => k !== 'tags' && k !== 'tag');
  const panel = write
    ? `<aside class="note-actions">
    <section>
      <h2>Ablegen</h2>
      ${formHead(ctx, '/aktion/notiz/ablegen', { pfad: note.path })}
        <div class="assign-row"><label><span class="sr-only">Zielordner</span><input name="ordner" list="ordner" required placeholder="Zielordner …" autocomplete="off"></label><button type="submit" class="chip">Ablegen</button></div>
        <datalist id="ordner">${targets.map((f) => `<option value="${esc(f)}">`).join('')}</datalist>
      </form>
      ${archive && note.folder !== archive && !note.folder.startsWith(`${archive}/`) ? `${formHead(ctx, '/aktion/notiz/ablegen', { pfad: note.path, ordner: archive })}<button type="submit" class="chip quiet archive">Ins Archiv <span class="hint">${esc(archive)}/</span></button></form>` : ''}
    </section>
    <section>
      <h2>Tags</h2>
      ${formHead(ctx, '/aktion/notiz/tags', { pfad: note.path })}
        <div class="assign-row"><label><span class="sr-only">Tags</span><input name="tags" value="${esc(note.tags.join(', '))}" placeholder="z. B. idee, hund" autocomplete="off" autocapitalize="off"></label><button type="submit" class="chip">Setzen</button></div>
      </form>
    </section>
    <section>
      <h2>Anhängen</h2>
      ${formHead(ctx, '/aktion/notiz/anhaengen', { pfad: note.path })}
        <textarea name="text" rows="3" maxlength="20000" placeholder="Text ans Ende der Notiz">${esc(draft ?? '')}</textarea>
        <p><button type="submit" class="chip">Anhängen</button></p>
      </form>
    </section>
  </aside>`
    : '';
  return `<!doctype html>
<html lang="de">
${head(note.title, { script: Boolean(write) })}
<body class="page-note">
${appHeader({ user })}
<div class="page-head">
  <div><h1>${esc(note.title)}</h1><p class="meta">${esc(note.path)}${graph ? ` · <a href="${esc(graphHref(note.path))}">Graph</a>` : ''}${obsidian ? ` · <a href="${esc(obsidian)}">In Obsidian öffnen</a>` : ''}</p></div>
  <a href="/" class="btn quiet">← Zur Woche</a>
</div>
<main class="note-page">
  <div class="note-main">
  <article class="note-preview">
    ${note.tags.length ? `<p class="tags">${note.tags.map((t) => `<span class="tag">#${esc(t)}</span>`).join(' ')}</p>` : ''}
    ${frontmatter(fm, note.links ?? null)}
    <div class="md">${renderMarkdown(note.body, { checkbox, links: note.links ?? null }) || '<p class="empty">Die Notiz ist leer.</p>'}</div>
  </article>
  ${relatedSection(related)}
  </div>
  ${panel}
</main>
<div class="toasts" aria-live="polite">${flashToast(flash, ctx)}</div>
</body>
</html>`;
}

export const NOTE_CSS = `
/* --- Notizseite --- */
.note-page { grid-template-columns: minmax(0, 1fr) 320px; align-items: start; max-width: 1100px; }
.note-preview { background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-lg); box-shadow: var(--shadow-1); padding: 20px 24px; min-width: 0; }
.note-actions { display: grid; gap: 16px; position: sticky; top: 16px; }
.note-actions section { padding: 14px 16px; }
.note-actions h2 { margin-bottom: 8px; }
.note-actions form { margin: 0; }
.note-actions textarea, .note-actions input { width: 100%; font: inherit; font-size: 15px; color: var(--text); background: var(--bg);
  border: 1px solid var(--line); border-radius: var(--r-sm); padding: 6px 8px; min-height: 34px; }
.note-actions textarea { resize: vertical; }
.note-actions p { margin: 8px 0 0; }
.note-actions .archive { margin-top: 10px; }
header .meta a { color: inherit; }
.tags { margin: 0 0 10px; }
.tag { color: var(--accent); font-size: 14px; }
.fm { margin: 0 0 16px; padding: 6px 12px; font-size: 13px; color: var(--muted); background: var(--bg); border-radius: var(--r-md); }
.fm summary { cursor: pointer; overflow-wrap: anywhere; }
.fm dl { display: grid; grid-template-columns: max-content 1fr; gap: 2px 12px; margin: 8px 0 2px; }
.fm dt { font-weight: 600; }
.fm dd { margin: 0; overflow-wrap: anywhere; }
.md { line-height: 1.6; overflow-wrap: anywhere; }
.md h2, .md h3, .md h4, .md h5, .md h6 { text-transform: none; letter-spacing: 0; color: var(--text); margin: 18px 0 6px; }
.md h2 { font-size: 20px; } .md h3 { font-size: 17px; } .md h4, .md h5, .md h6 { font-size: 15px; }
.md p { margin: 0 0 10px; }
.md ul, .md ol { margin: 0 0 10px; padding-left: 22px; }
.md ul { list-style: disc; }
.md li.d1 { margin-left: 20px; } .md li.d2 { margin-left: 40px; } .md li.d3, .md li.d4 { margin-left: 60px; }
.md li.todo { list-style: none; margin-left: -22px; display: flex; gap: 8px; align-items: flex-start; padding: 2px 0; }
.md li.todo.d1 { margin-left: -2px; } .md li.todo.d2 { margin-left: 18px; }
.md li.todo.done > span:last-child { text-decoration: line-through; color: var(--muted); }
.md blockquote { margin: 0 0 10px; padding: 4px 12px; border-left: 3px solid var(--line); color: var(--muted); }
.md pre { background: var(--bg); border: 1px solid var(--line); border-radius: var(--r-md); padding: 10px 12px; overflow-x: auto; }
.md pre code { background: none; padding: 0; }
.md hr { border: 0; border-top: 1px solid var(--line); margin: 16px 0; }
.md .wikilink, .fm .wikilink { color: var(--accent); }
.md a.wikilink { text-decoration: none; border-bottom: 1px solid var(--accent-soft); }
.md a.wikilink:hover { border-bottom-color: var(--accent); }
.wikilink.missing { color: var(--muted); border-bottom: 1px dashed var(--line); }
.wikilink.missing .missing-mark { font-size: 12px; }
.wikilink.file { color: var(--muted); }
.md img { max-width: 100%; height: auto; border-radius: var(--r-md); vertical-align: middle; }
.md mark { background: var(--accent-soft); color: inherit; padding: 0 2px; border-radius: 3px; }
.md .table-wrap { overflow-x: auto; margin: 0 0 12px; }
.md table { border-collapse: collapse; font-size: 14px; min-width: 50%; }
.md th, .md td { border: 1px solid var(--line); padding: 4px 8px; text-align: left; vertical-align: top; }
.md th { background: var(--bg); font-weight: 600; }
.md .al-c { text-align: center; } .md .al-r { text-align: right; }
.md .callout { margin: 0 0 12px; padding: 8px 12px; border-left: 3px solid var(--accent); border-radius: var(--r-md); background: var(--bg); }
.md .callout-title { margin: 0; font-weight: 600; }
.md details.callout > summary { cursor: pointer; }
.md .callout-body { margin-top: 6px; }
.md .callout-body > :last-child { margin-bottom: 0; }
.md .callout-ok { border-left-color: var(--ok); }
.md .callout-warn { border-left-color: var(--warn); }
.md .callout-bad { border-left-color: var(--danger); }
.md .callout-plain { border-left-color: var(--line); }
.note-main { display: grid; gap: 16px; min-width: 0; }
.note-related { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 8px 24px; padding: 14px 16px; }
.note-related h2 { margin: 0 0 6px; }
.note-related ul { margin: 0; padding: 0; list-style: none; }
.note-related li { padding: 3px 0; }
.note-related li .meta { display: block; font-size: 12px; overflow-wrap: anywhere; }
.box-form { margin: 0; display: flex; flex: none; }
.box { width: 20px; height: 20px; margin-top: 3px; padding: 0; display: grid; place-items: center; cursor: pointer;
  border: 1.5px solid var(--muted); border-radius: 5px; background: var(--surface); color: #fff; position: relative; }
.box::before { content: ''; position: absolute; inset: -10px; }
.box svg { width: 12px; height: 12px; fill: none; stroke: currentColor; stroke-width: 2.4; stroke-linecap: round; stroke-linejoin: round; opacity: 0; }
.box.on { background: var(--ok); border-color: var(--ok); }
.box.on svg { opacity: 1; }
.box:hover { border-color: var(--ok); }
@media (max-width: 900px) {
  .note-page { grid-template-columns: 1fr; }
  .note-actions { position: static; }
  .note-preview { padding: 16px; }
}
@media (max-width: 600px) { .box { width: 24px; height: 24px; } }
`;
