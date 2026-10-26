import { esc } from '../web/layout.js';
import { renderMarkdown, noteHref } from '../web/markdown-render.js';
import { hidden } from '../web/render.js';

/**
 * Generative Oberfläche für „Fragen“ (src/fragen/chat.js): Claude antwortet
 * nicht mit HTML, sondern mit Bausteinen aus einem festen Vorrat (`SCHEMA`).
 * Das Cockpit prüft sie (`normalizeBlocks`) und zeichnet sie selbst
 * (`renderBlocks`): Kein Text von Claude landet ungeprüft als HTML auf der
 * Seite, Links auf Notizen gehen nur auf sichtbare Notizen, nach außen nur
 * http(s). `blocksText` macht aus denselben Bausteinen Markdown, für den
 * Verlauf, den Claude bei Nachfragen bekommt, und fürs Speichern als Notiz.
 *
 * Bausteine:
 * - `text`: Markdown, Wikilinks werden Links auf die Notiz.
 * - `notes`: Notizen als Karten mit einem Satz, warum sie passen.
 * - `table`: Spalten und Zeilen, etwa für Vergleiche.
 * - `checklist`: Schritte oder offene Punkte; lassen sich als Zunder-Aufgaben anlegen.
 * - `timeline`: Datum, Ereignis, Notiz.
 * - `stats`: Kennzahlen als Kacheln.
 * - `chart`: Balken mit Werten.
 * - `quote`: Zitat aus einer Notiz.
 * - `callout`: Hinweis, Warnung oder Tipp.
 * - `proposal`: Änderung an einer bestehenden Notiz (anhängen, ersetzen,
 *   Frontmatter) oder eine neue Notiz außerhalb der Inbox; erst nach
 *   „Übernehmen“ geschrieben. Neue Notizen in der Inbox legt Claude selbst an.
 */

const str = { type: 'string' };
const path = { type: 'string', description: 'Pfad der Notiz relativ zur Vault-Wurzel, genau wie im Vault (aus den Werkzeugen)' };
const obj = (required, properties) => ({ type: 'object', additionalProperties: false, required, properties });

export const ACTIONS = ['append', 'replace', 'frontmatter', 'create'];
export const TONES = ['hinweis', 'tipp', 'warnung'];

const BLOCK = {
  anyOf: [
    obj(['type', 'markdown'], { type: { type: 'string', enum: ['text'] }, markdown: { ...str, description: 'Markdown ohne Überschrift erster Ordnung; Notizen als [[pfad|titel]]' } }),
    obj(['type', 'items'], { type: { type: 'string', enum: ['notes'] }, title: str, items: { type: 'array', items: obj(['path', 'why'], { path, title: str, why: str }) } }),
    obj(['type', 'columns', 'rows'], { type: { type: 'string', enum: ['table'] }, title: str, columns: { type: 'array', items: str }, rows: { type: 'array', items: { type: 'array', items: str } } }),
    obj(['type', 'items'], { type: { type: 'string', enum: ['checklist'] }, title: str, items: { type: 'array', items: obj(['text'], { text: str, path }) } }),
    obj(['type', 'items'], { type: { type: 'string', enum: ['timeline'] }, title: str, items: { type: 'array', items: obj(['date', 'title'], { date: { ...str, description: 'JJJJ-MM-TT oder JJJJ-MM' }, title: str, text: str, path }) } }),
    obj(['type', 'items'], { type: { type: 'string', enum: ['stats'] }, items: { type: 'array', items: obj(['label', 'value'], { label: str, value: str, hint: str }) } }),
    obj(['type', 'title', 'bars'], { type: { type: 'string', enum: ['chart'] }, title: str, unit: str, bars: { type: 'array', items: obj(['label', 'value'], { label: str, value: { type: 'number' } }) } }),
    obj(['type', 'text'], { type: { type: 'string', enum: ['quote'] }, text: str, path, source: str }),
    obj(['type', 'tone', 'text'], { type: { type: 'string', enum: ['callout'] }, tone: { type: 'string', enum: TONES }, title: str, text: str }),
    obj(['type', 'action', 'why'], {
      type: { type: 'string', enum: ['proposal'] },
      action: { type: 'string', enum: ACTIONS, description: 'append: Text anhängen (optional unter heading); replace: old_text exakt durch new_text ersetzen; frontmatter: Felder setzen; create: neue Notiz in folder mit name' },
      path,
      heading: str,
      text: { ...str, description: 'Markdown zum Anhängen (append; kommt direkt hinter die letzte Zeile, Listen laufen weiter; für einen neuen Absatz mit einer Leerzeile beginnen) oder Inhalt der neuen Notiz (create)' },
      old_text: str,
      new_text: str,
      set: { type: 'array', items: obj(['key', 'value'], { key: str, value: { ...str, description: 'Wert; leer entfernt das Feld' } }) },
      folder: str,
      name: str,
      why: { ...str, description: 'Ein Satz, warum' },
    }),
  ],
};

/** JSON Schema der Antwort. */
export const SCHEMA = obj(['title', 'blocks', 'followups'], {
  title: { ...str, description: 'Kurzer Titel des Gesprächs, höchstens 80 Zeichen' },
  blocks: { type: 'array', minItems: 1, items: BLOCK },
  followups: { type: 'array', items: str, description: 'Bis zu vier naheliegende Nachfragen, die ER als Nächstes stellen könnte, in seinen Worten (Ich-Form), z. B. „Wie viele Übungstage bleiben mir bis Dezember?“; keine Rückfragen von dir' },
  web: { type: 'array', items: obj(['title', 'url'], { title: str, url: str }), description: 'Webseiten, die du benutzt hast' },
});

const MAX_BLOCKS = 40;
const MAX_ITEMS = 60;
const MAX_TEXT = 20_000;
const MAX_CELL = 500;

const text = (v, max = MAX_TEXT) => String(v ?? '').replace(/\r\n?/g, '\n').trim().slice(0, max);
const cell = (v) => text(v, MAX_CELL).replace(/\s*\n\s*/g, ' ');
const list = (v) => (Array.isArray(v) ? v.slice(0, MAX_ITEMS) : []);
const notePath = (v) => {
  const p = text(v, 400).replace(/^\/+/, '');
  if (!p || p.includes('..')) return null;
  return /\.md$/i.test(p) ? p : `${p}.md`;
};
export const isWebUrl = (u) => /^https?:\/\/[^\s<>"]+$/i.test(String(u ?? ''));

/**
 * Bausteine in feste Form: unbekannte Arten fallen weg, Texte werden gekürzt,
 * Pfade bereinigt, Zahlen geprüft. Leere Bausteine fallen weg.
 */
export function normalizeBlocks(raw) {
  const out = [];
  for (const b of list(raw).slice(0, MAX_BLOCKS)) {
    const title = cell(b?.title) || null;
    switch (b?.type) {
      case 'text': {
        const markdown = text(b.markdown);
        if (markdown) out.push({ type: 'text', markdown });
        break;
      }
      case 'notes': {
        const items = list(b.items).map((i) => ({ path: notePath(i?.path), title: cell(i?.title) || null, why: cell(i?.why) })).filter((i) => i.path);
        if (items.length) out.push({ type: 'notes', title, items });
        break;
      }
      case 'table': {
        const columns = list(b.columns).map(cell).slice(0, 8);
        const rows = list(b.rows).map((r) => columns.map((_, k) => cell(list(r)[k])));
        if (columns.length && rows.length) out.push({ type: 'table', title, columns, rows });
        break;
      }
      case 'checklist': {
        const items = list(b.items).map((i) => ({ text: cell(i?.text), path: notePath(i?.path) })).filter((i) => i.text);
        if (items.length) out.push({ type: 'checklist', title, items });
        break;
      }
      case 'timeline': {
        const items = list(b.items).map((i) => ({ date: cell(i?.date).slice(0, 20), title: cell(i?.title), text: cell(i?.text) || null, path: notePath(i?.path) })).filter((i) => i.title);
        if (items.length) out.push({ type: 'timeline', title, items });
        break;
      }
      case 'stats': {
        const items = list(b.items).slice(0, 8).map((i) => ({ label: cell(i?.label), value: cell(i?.value).slice(0, 40), hint: cell(i?.hint) || null })).filter((i) => i.label && i.value);
        if (items.length) out.push({ type: 'stats', items });
        break;
      }
      case 'chart': {
        const bars = list(b.bars).slice(0, 30).map((i) => ({ label: cell(i?.label), value: Number(i?.value) })).filter((i) => i.label && Number.isFinite(i.value));
        if (bars.length) out.push({ type: 'chart', title, unit: cell(b.unit).slice(0, 20) || null, bars });
        break;
      }
      case 'quote': {
        const t = text(b.text, 3000);
        if (t) out.push({ type: 'quote', text: t, path: notePath(b.path), source: cell(b.source) || null });
        break;
      }
      case 'callout': {
        const t = text(b.text, 3000);
        if (t) out.push({ type: 'callout', tone: TONES.includes(b.tone) ? b.tone : 'hinweis', title, text: t });
        break;
      }
      case 'proposal': {
        const p = normalizeProposal(b);
        if (p) out.push(p);
        break;
      }
      default:
    }
  }
  return out;
}

/** Ein Änderungsvorschlag in fester Form oder null, wenn ihm etwas Nötiges fehlt. */
function normalizeProposal(b) {
  const action = ACTIONS.includes(b?.action) ? b.action : null;
  const why = cell(b?.why);
  if (!action) return null;
  if (action === 'create') {
    const folder = text(b.folder, 300).replace(/^\/+|\/+$/g, '');
    const name = cell(b.name).replace(/\.md$/i, '');
    const body = text(b.text);
    if (!folder || folder.includes('..') || !name || /[\\/]/.test(name) || !body) return null;
    return { type: 'proposal', action, folder, name, text: body, why };
  }
  const p = notePath(b.path);
  if (!p) return null;
  if (action === 'append') {
    const t = text(b.text);
    return t ? { type: 'proposal', action, path: p, heading: cell(b.heading) || null, text: t, why } : null;
  }
  if (action === 'replace') {
    const oldText = String(b.old_text ?? '').slice(0, MAX_TEXT);
    const newText = String(b.new_text ?? '').slice(0, MAX_TEXT);
    return oldText.trim() && oldText !== newText ? { type: 'proposal', action, path: p, old_text: oldText, new_text: newText, why } : null;
  }
  const set = list(b.set).slice(0, 20).map((s) => ({ key: cell(s?.key).slice(0, 60), value: cell(s?.value) })).filter((s) => /^[A-Za-z0-9_-]+$/.test(s.key));
  return set.length ? { type: 'proposal', action, path: p, set, why } : null;
}

const LABELS = { append: 'Anhängen', replace: 'Ersetzen', frontmatter: 'Frontmatter', create: 'Neue Notiz' };
const TONE_LABELS = { hinweis: 'Hinweis', tipp: 'Tipp', warnung: 'Achtung' };
const titleOf = (p) => p.split('/').pop().replace(/\.md$/i, '');

/**
 * Markdown aus den Bausteinen, ohne Vorschläge (die sind keine Antwort):
 * für den Verlauf bei Nachfragen und fürs Speichern als Notiz.
 */
export function blocksText(blocks) {
  const link = (p, t = null) => `[[${p.replace(/\.md$/i, '')}${t ? `|${t.replace(/[[\]|]/g, ' ')}` : ''}]]`;
  const head = (t) => (t ? `**${t}**\n\n` : '');
  return blocks
    .map((b) => {
      switch (b.type) {
        case 'text':
          return b.markdown;
        case 'notes':
          return head(b.title) + b.items.map((i) => `- ${link(i.path, i.title)}${i.why ? `: ${i.why}` : ''}`).join('\n');
        case 'table':
          return head(b.title) + [`| ${b.columns.join(' | ')} |`, `| ${b.columns.map(() => '---').join(' | ')} |`, ...b.rows.map((r) => `| ${r.map((c) => c.replace(/\|/g, '\\|')).join(' | ')} |`)].join('\n');
        case 'checklist':
          return head(b.title) + b.items.map((i) => `- [ ] ${i.text}${i.path ? ` (${link(i.path)})` : ''}`).join('\n');
        case 'timeline':
          return head(b.title) + b.items.map((i) => `- **${i.date}** ${i.title}${i.text ? `: ${i.text}` : ''}${i.path ? ` (${link(i.path)})` : ''}`).join('\n');
        case 'stats':
          return b.items.map((i) => `- ${i.label}: **${i.value}**${i.hint ? ` (${i.hint})` : ''}`).join('\n');
        case 'chart':
          return head(b.title) + b.bars.map((i) => `- ${i.label}: ${i.value}${b.unit ? ` ${b.unit}` : ''}`).join('\n');
        case 'quote':
          return `${b.text.split('\n').map((l) => `> ${l}`).join('\n')}${b.path || b.source ? `\n> — ${b.path ? link(b.path) : b.source}` : ''}`;
        case 'callout':
          return `> [!${b.tone === 'warnung' ? 'warning' : b.tone === 'tipp' ? 'tip' : 'note'}]${b.title ? ` ${b.title}` : ''}\n${b.text.split('\n').map((l) => `> ${l}`).join('\n')}`;
        default:
          return '';
      }
    })
    .filter(Boolean)
    .join('\n\n');
}

/**
 * HTML der Bausteine einer Antwort. `ctx`: `{ links, visible(path), write,
 * thread, turn, tasks }`. `links` löst Wikilinks im Markdown auf,
 * `visible(path)` liefert `{ path, title }` einer sichtbaren Notiz oder null
 * (dann bleibt der Name Text); `write` (`{ csrf }`) und die Nummern schalten
 * die Knöpfe ein (Übernehmen, als Aufgaben anlegen).
 */
export function renderBlocks(blocks, ctx) {
  return blocks.map((b, i) => renderBlock(b, i, ctx)).join('');
}

function noteLink(ctx, p, label = null) {
  const row = p ? ctx.visible(p) : null;
  const name = label || row?.title || (p ? titleOf(p) : '');
  return row ? `<a href="${esc(noteHref(row.path))}">${esc(name)}</a>` : `<span class="fragen-fehlt" title="Notiz nicht gefunden">${esc(name)}</span>`;
}

const md = (s, ctx) => renderMarkdown(s, { links: ctx.links });
const caption = (t) => (t ? `<h3 class="fragen-titel">${esc(t)}</h3>` : '');

function form(ctx, action, fields, label, cls = 'btn quiet') {
  if (!ctx.write) return '';
  return `<form method="post" action="${action}" class="inline">${hidden({ csrf: ctx.write.csrf, back: ctx.write.back, id: ctx.thread, turn: ctx.turn, ...fields })}<button type="submit" class="${cls}">${label}</button></form>`;
}

function renderBlock(b, i, ctx) {
  switch (b.type) {
    case 'text':
      return `<div class="fragen-text">${md(b.markdown, ctx)}</div>`;
    case 'notes':
      return `<section class="fragen-block">${caption(b.title)}<ul class="fragen-notizen">${b.items.map((n) => `<li>${noteLink(ctx, n.path, n.title)}${n.why ? `<span class="meta">${esc(n.why)}</span>` : ''}</li>`).join('')}</ul></section>`;
    case 'table':
      return `<section class="fragen-block">${caption(b.title)}<div class="fragen-tabelle"><table><thead><tr>${b.columns.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${b.rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div></section>`;
    case 'checklist': {
      const done = ctx.tasks?.[i];
      const button = done ? `<p class="meta">${esc(done)}</p>` : form(ctx, '/aktion/fragen/aufgaben', { block: i }, 'Als Zunder-Aufgaben anlegen');
      return `<section class="fragen-block">${caption(b.title)}<ul class="fragen-check">${b.items.map((t) => `<li><span class="fragen-box" aria-hidden="true"></span><span>${esc(t.text)}${t.path ? ` <span class="meta">${noteLink(ctx, t.path)}</span>` : ''}</span></li>`).join('')}</ul>${button}</section>`;
    }
    case 'timeline':
      return `<section class="fragen-block">${caption(b.title)}<ol class="fragen-zeit">${b.items.map((t) => `<li><time>${esc(t.date)}</time><div><b>${t.path ? noteLink(ctx, t.path, t.title) : esc(t.title)}</b>${t.text ? `<p>${esc(t.text)}</p>` : ''}</div></li>`).join('')}</ol></section>`;
    case 'stats':
      return `<section class="fragen-kacheln">${b.items.map((s) => `<div class="fragen-kachel"><span class="meta">${esc(s.label)}</span><b>${esc(s.value)}</b>${s.hint ? `<span class="meta">${esc(s.hint)}</span>` : ''}</div>`).join('')}</section>`;
    case 'chart': {
      const max = Math.max(...b.bars.map((x) => Math.abs(x.value)), 0) || 1;
      const fmt = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 2 });
      return `<section class="fragen-block">${caption(b.title)}<ul class="fragen-balken">${b.bars
        .map((x) => `<li><span class="fragen-balken-name">${esc(x.label)}</span><svg class="fragen-balken-spur" viewBox="0 0 100 10" preserveAspectRatio="none" aria-hidden="true"><rect width="${Math.max(0.5, Math.round((Math.abs(x.value) / max) * 1000) / 10)}" height="10" rx="2"/></svg><span class="fragen-balken-wert">${esc(fmt.format(x.value))}${b.unit ? ` ${esc(b.unit)}` : ''}</span></li>`)
        .join('')}</ul></section>`;
    }
    case 'quote':
      return `<figure class="fragen-zitat"><blockquote>${esc(b.text).replace(/\n/g, '<br>')}</blockquote>${b.path || b.source ? `<figcaption>${b.path ? noteLink(ctx, b.path) : esc(b.source)}</figcaption>` : ''}</figure>`;
    case 'callout':
      return `<aside class="fragen-callout is-${b.tone}"><b>${esc(b.title ?? TONE_LABELS[b.tone])}</b>${md(b.text, ctx)}</aside>`;
    case 'proposal':
      return renderProposal(b, i, ctx);
    default:
      return '';
  }
}

function renderProposal(b, i, ctx) {
  const where = b.action === 'create' ? `${esc(b.folder)}/${esc(b.name)}.md` : noteLink(ctx, b.path);
  let preview;
  if (b.action === 'append') preview = `<pre class="fragen-plus">${esc(b.text)}</pre>${b.heading ? `<p class="meta">unter „${esc(b.heading)}“</p>` : '<p class="meta">am Ende der Notiz</p>'}`;
  else if (b.action === 'replace') preview = `<pre class="fragen-minus">${esc(b.old_text)}</pre><pre class="fragen-plus">${esc(b.new_text) || '<i>(entfernen)</i>'}</pre>`;
  else if (b.action === 'frontmatter') preview = `<pre class="fragen-plus">${b.set.map((s) => esc(s.value ? `${s.key}: ${s.value}` : `${s.key}: (entfernen)`)).join('\n')}</pre>`;
  else preview = `<pre class="fragen-plus">${esc(b.text)}</pre>`;
  const state = b.applied
    ? `<p class="fragen-erledigt">Übernommen${b.applied.path ? `: ${noteLink(ctx, b.applied.path)}` : ''}</p>`
    : b.dismissed
      ? '<p class="meta">Verworfen</p>'
      : `<div class="fragen-vorschlag-knoepfe">${form(ctx, '/aktion/fragen/uebernehmen', { block: i }, 'Übernehmen', 'btn primary')}${form(ctx, '/aktion/fragen/verwerfen', { block: i }, 'Verwerfen')}</div>`;
  return `<section class="fragen-vorschlag${b.applied ? ' is-done' : ''}"><div class="fragen-vorschlag-kopf"><span class="folge-art">${LABELS[b.action]}</span><span>${where}</span></div>${b.why ? `<p>${esc(b.why)}</p>` : ''}${preview}${state}</section>`;
}

/** Webquellen einer Antwort, nur http(s). */
export function normalizeWeb(raw) {
  return list(raw)
    .slice(0, 30)
    .map((w) => ({ title: cell(w?.title) || String(w?.url ?? ''), url: String(w?.url ?? '').trim() }))
    .filter((w) => isWebUrl(w.url));
}
