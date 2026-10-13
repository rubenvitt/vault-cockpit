const CTRL = /[\u0000-\u001f]/;
import { writeFileSync, mkdirSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Anlegen neuer Notizen im Posteingang.
 *
 * Es werden ausschliesslich NEUE Dateien im Capture-Ordner angelegt.
 * Bestehende Notizen veraendert nur edit.js, mit eigenem Scope.
 *
 * `source` landet im Frontmatter (woher die Notiz kam: claude-mcp, ios-kurzbefehl,
 * sprachmemo, mail, funke). Eine optionale `captureId` macht das Anlegen
 * idempotent: Kommt dieselbe ID noch einmal (Offline-Queue, erneuter Abruf),
 * wird die vorhandene Notiz gemeldet statt eine zweite angelegt.
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

  function findByCaptureId(captureId) {
    let names;
    try {
      names = readdirSync(baseDir);
    } catch {
      return null;
    }
    const marker = `\ncapture_id: ${captureId}\n`;
    for (const name of names) {
      if (!name.endsWith('.md')) continue;
      let head;
      try {
        head = readFileSync(join(baseDir, name), 'utf8').slice(0, 2000);
      } catch {
        continue;
      }
      if (head.includes(marker)) return name;
    }
    return null;
  }

  return {
    write({ title, text, tags = [], source = 'claude-mcp', captureId = null, created = null }) {
      const cleanTitle = safeTitle(title);
      const body = String(text ?? '').trim();
      if (!body) throw new Error('Text darf nicht leer sein');
      if (!/^[a-z0-9-]{1,40}$/.test(source)) throw new Error('Ungültige Quelle');
      if (captureId !== null && !/^[A-Za-z0-9_.:-]{1,128}$/.test(String(captureId))) {
        throw new Error('Ungültige Capture-ID');
      }

      if (captureId !== null) {
        const existing = findByCaptureId(captureId);
        if (existing) return { path: `${folder}/${existing}`, absolute: join(baseDir, existing), title: cleanTitle, duplicate: true };
      }

      const d = created instanceof Date && !Number.isNaN(created.getTime()) ? created : now();
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
        `source: ${source}`,
        ...(captureId !== null ? [`capture_id: ${captureId}`] : []),
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
