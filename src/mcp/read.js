/**
 * Claude.ai kappt Tool-Ergebnisse bei rund 150.000 Zeichen. Wir bleiben bewusst
 * darunter und melden die Kuerzung, statt den Rest stillschweigend zu verlieren.
 */
export const MAX_RESULT_CHARS = 120_000;

export function readNote(index, path, { offset = 0, allowSensitive = false } = {}) {
  const note = index.getNote(String(path ?? ''));
  if (!note || note.content === null) return null;
  if (note.sensitivity && !allowSensitive) return null;

  const total = note.content.length;
  const start = Math.max(0, Math.min(offset, total));
  const slice = note.content.slice(start, start + MAX_RESULT_CHARS);

  return {
    path: note.path,
    title: note.title,
    type: note.type,
    status: note.status,
    tags: note.tags,
    frontmatter: note.frontmatter,
    sensitivity: note.sensitivity,
    created: note.created,
    updated: note.updated,
    content: slice,
    offset: start,
    total_chars: total,
    truncated: start + slice.length < total,
  };
}
