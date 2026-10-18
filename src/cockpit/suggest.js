const TAG = /^[\p{L}\p{N}_/-]+$/u;

/**
 * Vorschläge zum Verarbeiten einer Inbox-Notiz, abgeleitet aus ihren
 * ähnlichsten Notizen (der „Inbox-Agent“ der Roadmap, ohne LLM):
 *
 * - `folders`: die wahrscheinlichsten Zielordner, nach Mehrheit der Nachbarn
 *   (gewichtet mit der Ähnlichkeit), ohne Inbox, eigenen Ordner und Ordner,
 *   in die das Cockpit nicht ablegen darf
 * - `tags`: Tags, die bei den Nachbarn häufig sind und der Notiz noch fehlen
 *   (ohne den Tag der Zunder-Brücke, der eine Aktion auslöst)
 * - `unlinked`: ähnlich, aber noch nicht verlinkt
 *
 * `similar` ist `related.of(…).similar` (Embeddings oder Volltext). Ohne
 * Nachbarn bleiben alle Listen leer; `source` und `problem` sagen, warum.
 */
export function suggestFiling({ index, policy, inboxFolder, bridgeTag = null }, note, similar, { neighbours = 10, folders = 3, tags = 5, links = 3 } = {}) {
  const hits = (similar?.hits ?? []).slice(0, neighbours);
  // Embeddings liefern eine Ähnlichkeit; beim Volltext zählt nur der Rang.
  const weight = (h, i) => (h.score == null ? 1 - i / (hits.length + 1) : Math.max(h.score, 0));
  const inInbox = (f) => Boolean(inboxFolder) && (f === inboxFolder || f.startsWith(`${inboxFolder}/`));
  const forbidden = (f) => policy.isExcluded(`${f}/_.md`) || Boolean(policy.sensitivityOf(`${f}/_.md`));

  const byFolder = new Map();
  hits.forEach((h, i) => {
    const f = h.folder;
    if (!f || f === note.folder || inInbox(f) || forbidden(f)) return;
    const e = byFolder.get(f) ?? { folder: f, count: 0, weight: 0 };
    e.count += 1;
    e.weight += weight(h, i);
    byFolder.set(f, e);
  });

  const tagsOf = index.tagsOf([note.path, ...hits.map((h) => h.path)]);
  // Auch Tags im Text zählen als vorhanden.
  const have = new Set([...note.tags, ...(tagsOf.get(note.path) ?? [])].map((t) => t.toLowerCase()));
  const byTag = new Map();
  hits.forEach((h, i) => {
    for (const t of tagsOf.get(h.path) ?? []) {
      if (have.has(t.toLowerCase()) || t === bridgeTag || !TAG.test(t)) continue;
      const e = byTag.get(t) ?? { tag: t, count: 0, weight: 0 };
      e.count += 1;
      e.weight += weight(h, i);
      byTag.set(t, e);
    }
  });
  // Ein Tag, den nur eine von vielen Nachbarinnen trägt, ist Zufall.
  const minTag = hits.length >= 4 ? 2 : 1;
  const rank = (a, b) => b.weight - a.weight || b.count - a.count;

  return {
    source: similar?.source ?? null,
    problem: similar?.problem ?? null,
    of: hits.length,
    folders: [...byFolder.values()].sort(rank).slice(0, folders).map(({ folder, count }) => ({ folder, count })),
    tags: [...byTag.values()].filter((e) => e.count >= minTag).sort(rank).slice(0, tags).map(({ tag, count }) => ({ tag, count })),
    unlinked: hits.filter((h) => !h.linked).slice(0, links),
  };
}
