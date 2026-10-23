import { esc, formHead } from './render.js';
import { inlineMd } from './markdown-render.js';

/** Frontmatter-`type` der Synthesen in `wiki/synthesis`. */
export const SYNTHESIS = 'synthesis';

const FENCE = /^\s*(```|~~~)/;
const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const ITEM = /^\s*(?:[-*+]|\d+[.)])\s+(?:\[([ xX-])\]\s*)?(.+)$/;
// `[TODO …]` oder `[TODO: …]`, aber nicht in einem Wikilink `[[TODO …]]`.
const TODO = /(?<!\[)\[TODO(?::\s*|\s+)([^\]]+)\]/g;
const plain = (s) => s.replace(/!?\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, t, l) => l ?? t).replace(/\s+/g, ' ').trim();

/**
 * Offene Punkte einer Synthese: jedes `[TODO …]` im Text und die offenen
 * Listeneinträge unter einer Überschrift „Offene Punkte“ (bis zur nächsten
 * Überschrift gleicher oder höherer Ebene). Abgehakte (`[x]`, `[-]`) zählen
 * nicht, Codeblöcke auch nicht. Ohne Doppelte, in der Reihenfolge im Text.
 */
export function openPoints(body) {
  const points = [];
  let fence = null;
  let section = 0; // Ebene der Überschrift „Offene Punkte“, 0 = außerhalb
  for (const line of String(body ?? '').split(/\r?\n/)) {
    const f = FENCE.exec(line);
    if (f) {
      if (fence === null) fence = f[1];
      else if (fence === f[1]) fence = null;
      continue;
    }
    if (fence) continue;
    const h = HEADING.exec(line);
    if (h) {
      if (section && h[1].length <= section) section = 0;
      if (/^offene punkte:?$/i.test(h[2].trim())) section = h[1].length;
      continue;
    }
    const item = section ? ITEM.exec(line) : null;
    if (item) {
      if (!item[1] || item[1] === ' ') points.push(item[2]);
      continue;
    }
    for (const m of line.matchAll(TODO)) points.push(m[1]);
  }
  return [...new Set(points.map(plain).filter(Boolean))];
}

/** Frontmatter-Wert als Text (Listen mit Komma), sonst null. */
export const fmValue = (v) => (Array.isArray(v) ? v.join(', ') : v == null || typeof v === 'object' ? null : String(v)) || null;

/** Chips für Querverbindung (`art`), Status und Vertrauen. */
export function synthesisChips({ art = null, status = null, confidence = null }) {
  const chips = [
    ['Art', art],
    ['Status', status],
    ['Vertrauen', confidence],
  ].filter(([, v]) => v);
  return chips.length ? `<p class="synth-chips">${chips.map(([k, v]) => `<span class="synth-chip"><span class="hint">${k}</span> ${esc(v)}</span>`).join('')}</p>` : '';
}

/**
 * Kopf einer Synthese auf der Notizseite: Zusammenfassung groß, Chips, Thesen
 * (die H2-Überschriften als Sprungmarken) und offene Punkte. `html` ist der
 * schon gerenderte Text: Seine `<h3 id>` (H2 der Notiz, eine Ebene tiefer)
 * liefern die Anker, so passen sie genau. „Als Aufgaben nach Zunder“ gibt es
 * nur mit Schreibrecht und Zunder-Zugang (`zunder`).
 */
export function synthesisHead(note, html, { ctx, zunder = false }) {
  const fm = note.frontmatter ?? {};
  const summary = fmValue(fm.summary);
  // Der Bereich mit Belegen aus dem Lesestapel (src/lesen/synthesis-evidence.js) ist keine These.
  const theses = [...html.matchAll(/<h3 id="([^"]+)">(.*?)<\/h3>/g)].filter(([, , label]) => label !== 'Aus dem Lesestapel').map(([, id, label]) => `<li><a href="#${id}">${label.replace(/<[^>]*>/g, '')}</a></li>`);
  const points = openPoints(note.body);
  const button = points.length && zunder && ctx.write ? `${formHead(ctx, '/aktion/synthese/aufgaben', { pfad: note.path })}<button type="submit" class="chip">Als Aufgaben nach Zunder</button></form>` : '';
  return `<section class="synth-head">
    ${summary ? `<p class="synth-summary">${inlineMd(summary, note.links ?? null)}</p>` : ''}
    ${synthesisChips({ art: fmValue(fm.art), status: fmValue(fm.status), confidence: fmValue(fm.confidence) })}
    ${theses.length ? `<nav class="synth-outline" aria-label="Thesen"><h2>Thesen</h2><ol>${theses.join('')}</ol></nav>` : ''}
    <div class="synth-open"><h2>Offene Punkte</h2>${points.length ? `<ul>${points.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>${button}` : '<p class="empty">Keine offenen Punkte.</p>'}</div>
  </section>`;
}
