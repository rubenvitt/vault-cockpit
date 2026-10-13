import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';
import { readNote, MAX_RESULT_CHARS } from './read.js';

const ok = (data) => ({
  content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
  structuredContent: data,
});

const fail = (message) => ({
  content: [{ type: 'text', text: message }],
  isError: true,
});

/** requestInfo.headers ist je nach Aufrufweg ein Headers-Objekt oder ein einfaches Objekt. */
function readHeader(headers, name) {
  if (!headers) return '';
  if (typeof headers.get === 'function') return headers.get(name) ?? '';
  return headers[name] ?? headers[name.toLowerCase()] ?? '';
}

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const EDITS = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };

const READ_SCOPE_MISSING = 'Für diese Aktion fehlt die Berechtigung "vault:read". Der Connector muss in Claude neu verbunden werden.';
const EDIT_SCOPE_MISSING = 'Für diese Aktion fehlt die Berechtigung "vault:edit". Der Connector muss in Claude neu verbunden werden.';

export function createVaultMcpHandler({
  index,
  capture,
  editor,
  sync = null,
  verifyToken,
  captureFolder = 'inbox',
  layoutHint = null,
}) {
  return createMcpHandler((ctx) => {
    // Die Factory läuft pro Request. Der Principal kommt aus dem Bearer-Token
    // des jeweiligen Requests, nicht aus geteiltem Zustand.
    const auth = readHeader(ctx?.requestInfo?.headers, 'authorization');
    const principal = auth.startsWith('Bearer ') ? verifyToken(auth.slice(7)) : null;
    const scopes = principal?.scopes ?? [];
    const server = new McpServer({ name: 'vault-cockpit', version: '1.0.0' });

    /** Gemeinsamer Rahmen der Lesewerkzeuge: ohne vault:read kein Zugriff. */
    const read = (run) => async (args) => (scopes.includes('vault:read') ? run(args) : fail(READ_SCOPE_MISSING));

    server.registerTool(
      'vault_search',
      {
        title: 'Vault durchsuchen',
        description:
          'Durchsucht den Obsidian-Vault des Nutzers per Volltextsuche und liefert die besten Treffer mit Textausschnitt. ' +
          'Das ist der Einstiegspunkt für fast jede Frage an den Vault — erst suchen, dann die interessanten Notizen mit vault_read lesen. ' +
          'Standardmäßig werden nur eigene Notizen durchsucht; importierte Readwise-Artikel bleiben außen vor, weil sie den Bestand sonst dominieren.',
        inputSchema: {
          query: z.string().describe('Suchbegriffe. Mehrere Wörter werden UND-verknüpft. Deutsche Umlaute werden toleriert.'),
          tag: z.string().optional().describe('Nur Notizen mit diesem Tag, ohne Raute, z.B. "projekt-x".'),
          folder: z.string().optional().describe('Nur unterhalb dieses Ordners, z.B. "wiki/concepts" oder "projects".'),
          type: z.string().optional().describe('Nur Notizen mit diesem Frontmatter-type, z.B. "concept", "entity", "daily-note".'),
          include_readwise: z.boolean().optional().describe('Importierte Readwise-Artikel mitdurchsuchen. Standard: false.'),
          include_sensitive: z.boolean().optional()
            .describe('Vertrauliche Ordner einbeziehen (in den Treffern am Feld sensitivity erkennbar). Standard: false. Nur auf ausdrücklichen Wunsch setzen.'),
          limit: z.number().int().min(1).max(50).optional().describe('Anzahl der Treffer, Standard 10.'),
          offset: z.number().int().min(0).optional().describe('Versatz zum Blättern in den Treffern.'),
        },
        annotations: READ_ONLY,
      },
      read(async (args) => {
        const res = index.search(args.query, {
          include: args.include_readwise ? ['core', 'readwise'] : ['core'],
          includeSensitive: args.include_sensitive === true,
          tag: args.tag ?? null,
          folder: args.folder ?? null,
          type: args.type ?? null,
          limit: args.limit ?? 10,
          offset: args.offset ?? 0,
        });
        return ok({
          total: res.total,
          has_more: res.hasMore,
          results: res.results.map((r) => ({
            path: r.path,
            title: r.title,
            type: r.type,
            status: r.status,
            updated: r.updated,
            sensitivity: r.sensitivity,
            snippet: r.snippet,
          })),
        });
      }),
    );

    server.registerTool(
      'vault_read',
      {
        title: 'Notiz lesen',
        description:
          'Liest eine Notiz vollständig, inklusive Frontmatter und Tags. Der Pfad stammt aus vault_search, vault_list oder vault_links. ' +
          `Sehr lange Notizen werden bei ${MAX_RESULT_CHARS} Zeichen abgeschnitten — dann "truncated": true und mit "offset" weiterlesen.`,
        inputSchema: {
          path: z.string().describe('Pfad relativ zur Vault-Wurzel, z.B. "wiki/concepts/contract-first.md".'),
          offset: z.number().int().min(0).optional().describe('Zeichenversatz, um bei gekürzten Notizen weiterzulesen.'),
          allow_sensitive: z.boolean().optional().describe('Nötig, um eine Notiz aus einem vertraulichen Ordner zu lesen. Standard: false.'),
        },
        annotations: READ_ONLY,
      },
      read(async (args) => {
        const note = readNote(index, args.path, {
          offset: args.offset ?? 0,
          allowSensitive: args.allow_sensitive === true,
        });
        if (!note) {
          return fail(
            `Notiz "${args.path}" wurde nicht gefunden. Entweder gibt es sie nicht, sie liegt in einem vertraulichen Ordner ` +
              '(dann allow_sensitive: true setzen) oder der Pfad ist falsch geschrieben. Mit vault_search den korrekten Pfad ermitteln.',
          );
        }
        return ok(note);
      }),
    );

    server.registerTool(
      'vault_list',
      {
        title: 'Ordner auflisten',
        description:
          'Listet Notizen unterhalb eines Ordners auf, um sich im Vault zu orientieren. Ohne Angabe wird die oberste Ebene gezeigt.' +
          (layoutHint ? ` ${layoutHint}` : ''),
        inputSchema: {
          folder: z.string().optional().describe('Ordnerpfad, z.B. "wiki/entities". Leer lassen für die Wurzel.'),
          limit: z.number().int().min(1).max(200).optional().describe('Maximale Anzahl Einträge, Standard 100.'),
        },
        annotations: READ_ONLY,
      },
      read(async (args) => ok({ folder: args.folder ?? '', entries: index.listFolder(args.folder ?? '', { limit: args.limit ?? 100 }) })),
    );

    server.registerTool(
      'vault_links',
      {
        title: 'Verknüpfungen einer Notiz',
        description:
          'Zeigt, welche Notizen auf eine Notiz verweisen (Backlinks) und wohin sie selbst verlinkt. ' +
          'Nützlich, um Zusammenhänge im Wiki zu erschließen, statt nur einzelne Notizen zu lesen.',
        inputSchema: { path: z.string().describe('Pfad der Notiz relativ zur Vault-Wurzel.') },
        annotations: READ_ONLY,
      },
      read(async (args) => {
        if (!index.getNote(args.path)) return fail(`Notiz "${args.path}" wurde nicht gefunden.`);
        return ok({ path: args.path, backlinks: index.backlinks(args.path), outgoing: index.outgoingLinks(args.path) });
      }),
    );

    server.registerTool(
      'vault_stats',
      {
        title: 'Vault-Überblick',
        description:
          'Kennzahlen des Vaults: Anzahl Notizen je Klasse, Tags, Verlinkungsgrad. Gut zur ersten Orientierung. ' +
          'Dazu der Zustand des Syncs (läuft, letzter Abgleich, letzter Fehler) und wann der Index zuletzt aktualisiert wurde.',
        inputSchema: {},
        annotations: READ_ONLY,
      },
      read(async () => {
        const iso = (ms) => (ms ? new Date(ms).toISOString() : null);
        return ok({
          ...index.stats(),
          index: { lastBuiltAt: iso(index.lastBuiltAt?.()), lastChangedAt: iso(index.lastChangedAt?.()) },
          sync: sync?.status() ?? { adapter: 'none', state: 'disabled' },
        });
      }),
    );

    server.registerTool(
      'vault_capture',
      {
        title: 'Notiz in den Posteingang legen',
        description:
          `Legt eine NEUE Notiz im Quick-Capture-Posteingang des Vaults ab (${captureFolder}/). ` +
          'Bestehende Notizen werden dabei nie verändert; der Nutzer arbeitet den Posteingang später selbst ab. ' +
          'Für Ideen, Erkenntnisse und Merkposten, die aus einem Gespräch heraus im Vault landen sollen.',
        inputSchema: {
          title: z.string().describe('Kurzer, sprechender Titel. Keine Schrägstriche, wird Teil des Dateinamens.'),
          text: z.string().describe('Der Inhalt der Notiz als Markdown.'),
          tags: z.array(z.string()).optional().describe('Zusätzliche Tags ohne Raute. "quick-capture" wird automatisch gesetzt.'),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      },
      async (args) => {
        if (!scopes.includes('vault:capture')) {
          return fail('Für diese Aktion fehlt die Berechtigung "vault:capture". Der Connector muss in Claude neu verbunden werden.');
        }
        try {
          return ok(capture.write({ title: args.title, text: args.text, tags: args.tags ?? [] }));
        } catch (err) {
          return fail(`Die Notiz konnte nicht angelegt werden: ${err.message}`);
        }
      },
    );

    /** Gemeinsamer Rahmen der Bearbeitungswerkzeuge: Scope prüfen, Fehler verständlich melden. */
    const edit = (run) => async (args) => {
      if (!scopes.includes('vault:edit')) return fail(EDIT_SCOPE_MISSING);
      try {
        return ok(run(args));
      } catch (err) {
        const message = err.code === 'EROFS' || err.code === 'EACCES'
          ? 'der Vault ist auf dem Server schreibgeschützt eingebunden'
          : err.message;
        return fail(`Die Notiz wurde nicht geändert: ${message}`);
      }
    };

    server.registerTool(
      'vault_edit',
      {
        title: 'Textstelle in einer Notiz ersetzen',
        description:
          'Ersetzt eine exakte Textstelle in einer bestehenden Notiz. Vorher die Notiz mit vault_read lesen und old_text ' +
          'zeichengenau übernehmen, inklusive Einrückung und Zeilenumbrüchen. old_text muss eindeutig sein — sonst mehr ' +
          'umgebenden Text mitnehmen. Zum Löschen new_text leer lassen. Vertrauliche Ordner und Readwise-Importe sind gesperrt.',
        inputSchema: {
          path: z.string().describe('Pfad relativ zur Vault-Wurzel, z.B. "projects/Alpha.md".'),
          old_text: z.string().describe('Der zu ersetzende Text, exakt wie in der Notiz.'),
          new_text: z.string().describe('Der neue Text. Leer, um old_text zu löschen.'),
          replace_all: z.boolean().optional().describe('Alle Vorkommen ersetzen statt eines eindeutigen. Standard: false.'),
        },
        annotations: EDITS,
      },
      edit((args) =>
        editor.replace({ path: args.path, oldText: args.old_text, newText: args.new_text, replaceAll: args.replace_all === true }),
      ),
    );

    server.registerTool(
      'vault_append',
      {
        title: 'Text an eine Notiz anhängen',
        description:
          'Fügt Text am Ende einer bestehenden Notiz ein oder am Ende des Abschnitts unter einer Überschrift. ' +
          'Der Text kommt direkt hinter die letzte nicht-leere Zeile, sodass Listen nahtlos weiterlaufen; ' +
          'für einen neuen Absatz den Text mit einer Leerzeile beginnen.',
        inputSchema: {
          path: z.string().describe('Pfad relativ zur Vault-Wurzel.'),
          text: z.string().describe('Der anzuhängende Markdown-Text.'),
          heading: z.string().optional()
            .describe('Überschrift, unter deren Abschnitt eingefügt wird, z.B. "Aufgaben" oder "## Aufgaben". Ohne Angabe: Ende der Notiz.'),
        },
        annotations: EDITS,
      },
      edit((args) => editor.append({ path: args.path, text: args.text, heading: args.heading ?? null })),
    );

    server.registerTool(
      'vault_set_frontmatter',
      {
        title: 'Frontmatter-Felder setzen',
        description:
          'Setzt oder entfernt einzelne Frontmatter-Felder einer bestehenden Notiz (z.B. status, tags, type). ' +
          'Nicht genannte Felder bleiben unverändert. Ein Wert ersetzt das Feld vollständig — um einen Tag zu ergänzen, ' +
          'die komplette neue Tag-Liste angeben. null entfernt das Feld.',
        inputSchema: {
          path: z.string().describe('Pfad relativ zur Vault-Wurzel.'),
          set: z
            .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.string()), z.null()]))
            .describe('Felder und neue Werte, z.B. {"status": "done", "tags": ["projekt", "ai"], "draft": null}.'),
        },
        annotations: EDITS,
      },
      edit((args) => editor.setFrontmatter({ path: args.path, set: args.set })),
    );

    return server;
  });
}
