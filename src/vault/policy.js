import { readFileSync } from 'node:fs';

/**
 * Welche Teile des Vaults wie behandelt werden.
 *
 * Die konkreten Ordner eines Vaults gehören nicht in den Code: sie verraten,
 * wo die vertraulichen Notizen liegen. Deshalb kommen sie aus einer JSON-Datei,
 * die nur auf dem Server liegt (`POLICY_FILE`, Vorlage: `policy.example.json`).
 *
 *   exclude    — Regex-Muster auf den relativen Pfad. Treffer kommen nie in den
 *                Index, weder Inhalt noch Metadaten.
 *   sensitive  — { "ordner": "label" }. Indexiert, aber nur auf ausdrückliche
 *                Anforderung ausgeliefert.
 *   readwise   — Ordner mit importierten Fremdtexten. Eigene Indexklasse, die
 *                standardmäßig nicht durchsucht wird.
 *   layoutHint — Freitext, der Claude im Werkzeug vault_list die Ordnerstruktur
 *                erklärt.
 */

/** Gilt immer, unabhängig von der Konfiguration. */
const BUILTIN_EXCLUDES = [/^\.obsidian\//, /^\.git\//, /^node_modules\//];

export function compilePolicy(raw = {}) {
  const sensitive = Object.entries(raw.sensitive ?? {}).map(([folder, label]) => [folder.replace(/\/+$/, ''), String(label)]);
  const readwise = raw.readwise ? String(raw.readwise).replace(/\/+$/, '') : null;
  const exclude = [...BUILTIN_EXCLUDES, ...(raw.exclude ?? []).map((p) => new RegExp(p, 'i'))];
  const under = (relPath, prefix) => relPath === prefix || relPath.startsWith(prefix + '/');

  return {
    layoutHint: raw.layoutHint ? String(raw.layoutHint) : null,
    isExcluded: (relPath) => exclude.some((re) => re.test(relPath)),
    classify: (relPath) => (readwise && under(relPath, readwise) ? 'readwise' : 'core'),
    sensitivityOf(relPath) {
      for (const [prefix, label] of sensitive) if (under(relPath, prefix)) return label;
      return null;
    },
  };
}

export const DEFAULT_POLICY = compilePolicy();

/** Ohne Datei gilt die leere Policy: alles indexiert, nichts vertraulich. */
export function loadPolicy(file, { logger = console } = {}) {
  if (!file) {
    logger.warn?.('POLICY_FILE nicht gesetzt — keine vertraulichen Ordner, keine Ausschlüsse');
    return DEFAULT_POLICY;
  }
  return compilePolicy(JSON.parse(readFileSync(file, 'utf8')));
}
