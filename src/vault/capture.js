const CTRL = /[\u0000-\u001f]/;
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Anlegen neuer Notizen im Posteingang.
 *
 * Es werden ausschliesslich NEUE Dateien im Capture-Ordner angelegt.
 * Bestehende Notizen veraendert nur edit.js, mit eigenem Scope.
 */
export function createCapture({ vaultPath, folder = 'inbox', now = () => new Date() }) {
  const baseDir = resolve(vaultPath, folder);

  function safeTitle(title) {
    const t = String(title ?? '').trim();
    if (!t) throw new Error('Titel darf nicht leer sein');
    if (t.length > 120) throw new Error('Titel ist zu lang (max. 120 Zeichen)');
    // Alles, was einen Pfad aufspannen koennte, ist im Titel verboten.
    if (/[\\/]|\.\./.test(t)) throw new Error('Titel darf keine Pfadtrenner oder .. enthalten');
    if (CTRL.test(t)) throw new Error('Titel enthaelt Steuerzeichen');
    return t;
  }

  return {
    write({ title, text, tags = [] }) {
      const cleanTitle = safeTitle(title);
      const body = String(text ?? '').trim();
      if (!body) throw new Error('Text darf nicht leer sein');

      const d = now();
      const pad = (n) => String(n).padStart(2, '0');
      const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
      const stamp = `${date} ${pad(d.getHours())}${pad(d.getMinutes())}`;

      mkdirSync(baseDir, { recursive: true });

      let filename = `${stamp} - ${cleanTitle}.md`;
      let absolute = join(baseDir, filename);
      let counter = 2;
      while (existsSync(absolute)) {
        filename = `${stamp} - ${cleanTitle} (${counter}).md`;
        absolute = join(baseDir, filename);
        counter += 1;
      }

      // Doppelte Absicherung: selbst bei einem Fehler oben darf nichts ausserhalb landen.
      if (!resolve(absolute).startsWith(baseDir + '/')) {
        throw new Error('Zielpfad laege ausserhalb des Quick-Capture-Ordners');
      }

      const tagList = ['quick-capture', ...tags.map((t) => String(t).replace(/^#/, '').trim()).filter(Boolean)];
      const frontmatter = [
        '---',
        `title: ${cleanTitle}`,
        `created: ${date}`,
        'source: claude-mcp',
        'status: inbox',
        'tags:',
        ...tagList.map((t) => `  - ${t}`),
        '---',
        '',
      ].join('\n');

      writeFileSync(absolute, `${frontmatter}${body}\n`, { flag: 'wx' });
      return { path: `${folder}/${filename}`, absolute, title: cleanTitle, created: date };
    },
  };
}
