/**
 * Abweichungsbericht des Schattenbetriebs (VCP-133): Geräte vergleichen ihren
 * Vault mit dem Stand im Cockpit, während noch Obsidian Sync abgleicht, und
 * melden, was abweicht (journal.report). Kurze Abweichungen sind normal, weil
 * Obsidian Sync etwas hinterherläuft; als Problem gilt erst, was länger als
 * `GRACE_MS` offen ist.
 *
 * Hier: die Teile für die Zustandsseite und der Export für die Auswertung
 * (Markdown für Mensch und KI, dazu JSON).
 */

export const GRACE_MS = 10 * 60_000;
/** Ohne Bericht seit so langer Zeit gilt ein Gerät als verstummt. */
export const STALE_MS = 24 * 3_600_000;

export const KIND_LABELS = { only_local: 'nur auf dem Gerät', only_server: 'nur im Cockpit', different: 'Inhalt verschieden' };

const age = (iso, now) => now - Date.parse(iso);
const minutes = (ms) => {
  const m = Math.round(ms / 60_000);
  return m < 60 ? `${m} min` : m < 48 * 60 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} Tage`;
};

/** Offene Abweichungen eines Geräts, aufgeteilt in noch normale und Probleme. */
export function openDiffs(device, now = Date.now()) {
  const open = device.diffs.filter((d) => !d.resolvedAt);
  return { open, problems: open.filter((d) => age(d.since, now) > GRACE_MS) };
}

/** Je Gerät ein Teil für die Karte „Sync“ auf der Zustandsseite. */
export function shadowItems(shadow, now = Date.now()) {
  return (shadow ?? []).map((dev) => {
    const { open, problems } = openDiffs(dev, now);
    const stale = age(dev.at, now) > STALE_MS;
    const sample = problems
      .slice(0, 5)
      .map((d) => `${d.path} (${KIND_LABELS[d.kind] ?? d.kind}, seit ${minutes(age(d.since, now))})`)
      .join('; ');
    const summary = problems.length
      ? `${problems.length} Abweichung${problems.length === 1 ? '' : 'en'} länger als ${minutes(GRACE_MS)}: ${sample}${problems.length > 5 ? ' …' : ''}`
      : stale
        ? 'kein Vergleich seit über einem Tag'
        : open.length
          ? `${open.length} frische Abweichung${open.length === 1 ? '' : 'en'} (Obsidian Sync läuft vermutlich noch), ${dev.compared} Dateien verglichen`
          : `keine Abweichungen, ${dev.compared} Dateien verglichen`;
    return {
      id: `sync-shadow-${dev.device}`,
      name: `Vergleich ${dev.name ?? dev.device}`,
      state: problems.length ? 'error' : stale ? 'unknown' : 'ok',
      summary,
      lastOkAt: problems.length ? null : dev.at,
      lastErrorAt: problems.length ? dev.at : null,
      lastError: null,
    };
  });
}

/**
 * Bericht als Markdown zum Weitergeben, etwa an Claude: was ist offen, was
 * hat sich nach wie langer Zeit aufgelöst, mit einer kurzen Anleitung.
 */
export function shadowMarkdown(shadow, { now = Date.now(), adapter = null } = {}) {
  const lines = [
    '# Abweichungsbericht Schattenbetrieb (Cockpit Sync)',
    '',
    `Stand: ${new Date(now).toISOString()}${adapter ? ` · Sync im Cockpit: ${adapter}` : ''}`,
    '',
    'Während Obsidian Sync den Vault abgleicht, vergleicht das Plugin „Cockpit Sync“ auf jedem Gerät den lokalen Vault mit dem Stand im Cockpit (SHA-256 je Datei) und meldet Abweichungen.',
    `Kurze Abweichungen sind normal (Obsidian Sync läuft hinterher); länger als ${minutes(GRACE_MS)} offen gilt als Problem.`,
    'Arten: `only_local` = nur auf dem Gerät, `only_server` = nur im Cockpit, `different` = Inhalt verschieden.',
    '',
    'Für die Auswertung: Welche Abweichungen deuten auf Fehler im eigenen Sync hin (Pfade, Unicode-Normalisierung NFC/NFD, Groß-/Kleinschreibung, Anhänge, iOS-Eigenheiten), welche nur auf Verzug von Obsidian Sync? Ist der Umstieg vertretbar?',
  ];
  if (!shadow?.length) lines.push('', 'Noch kein Gerät hat einen Vergleich gemeldet.');
  for (const dev of shadow ?? []) {
    const { open, problems } = openDiffs(dev, now);
    const resolved = dev.diffs.filter((d) => d.resolvedAt);
    lines.push('', `## ${dev.name ?? dev.device}`, '', `- Client: ${dev.client ?? 'unbekannt'}`, `- Letzter Vergleich: ${dev.at} (${dev.compared} Dateien)`, `- Offen: ${open.length}, davon Probleme: ${problems.length}`, `- In 30 Tagen aufgelöst: ${resolved.length}`);
    if (open.length) {
      lines.push('', '### Offen', '', '| Pfad | Art | seit | Dauer |', '|---|---|---|---|');
      for (const d of open) lines.push(`| ${cell(d.path)} | ${d.kind} | ${d.since} | ${minutes(age(d.since, now))} |`);
    }
    if (resolved.length) {
      const sorted = [...resolved].sort((a, b) => Date.parse(b.resolvedAt) - Date.parse(b.since) - (Date.parse(a.resolvedAt) - Date.parse(a.since)));
      lines.push('', '### Aufgelöst (längste zuerst)', '', '| Pfad | Art | seit | aufgelöst | Dauer |', '|---|---|---|---|---|');
      for (const d of sorted.slice(0, 500)) lines.push(`| ${cell(d.path)} | ${d.kind} | ${d.since} | ${d.resolvedAt} | ${minutes(Date.parse(d.resolvedAt) - Date.parse(d.since))} |`);
      if (sorted.length > 500) lines.push('', `… und ${sorted.length - 500} weitere (vollständig im JSON-Export).`);
    }
  }
  return `${lines.join('\n')}\n`;
}

const cell = (text) => `\`${String(text).replace(/[|`]/g, (c) => `\\${c}`)}\``;
