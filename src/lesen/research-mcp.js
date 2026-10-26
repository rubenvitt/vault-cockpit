import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';
import { readNote, MAX_RESULT_CHARS } from '../mcp/read.js';
import { hybridSearch } from '../semantic/search.js';
import { toWebRequest, writeWebResponse } from '../http/bridge.js';

/**
 * Vault-Zugang für Claudes Recherche (Themen-Folgen, src/lesen/folgen.js):
 * ein MCP-Server nur für einen Lauf, auf 127.0.0.1 mit zufälligem Port und
 * zufälligem Token, danach wieder zu. Nur lesen, und nie Vertrauliches: Die
 * Werkzeuge haben keinen Schalter für vertrauliche Ordner, Treffer, Links und
 * Ähnliches daraus fallen weg, `vault_read` lehnt sie ab. Ausgeschlossenes
 * steht ohnehin nicht im Index. Readwise-Artikel nur auf Wunsch in der Suche.
 *
 * `open()` liefert `mcp` für src/lesen/claude.js (`{ name, config }`),
 * `read()` die Pfade der Notizen, die Claude gelesen hat (für die Quellen),
 * und `close()`.
 */

const ok = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }], structuredContent: data });
const fail = (message) => ({ content: [{ type: 'text', text: message }], isError: true });
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const MAX_BODY = 1024 * 1024;

/** Die Werkzeuge; `seen` sammelt gelesene Pfade. `semantic` als Wert oder Funktion. */
export function researchServer({ index, semantic: semanticOrGetter = null, layoutHint = null, seen = new Set() }) {
  const semantic = typeof semanticOrGetter === 'function' ? semanticOrGetter() : semanticOrGetter;
  const server = new McpServer({ name: 'vault-recherche', version: '1.0.0' });
  const open = () => index.filterPaths({ include: ['core', 'readwise'], includeSensitive: false });
  const shown = (notes, allowed = open()) => notes.filter((n) => allowed.has(n.path));

  server.registerTool(
    'vault_search',
    {
      title: 'Vault durchsuchen',
      description:
        'Durchsucht den Obsidian-Vault und liefert die besten Treffer mit Textausschnitt. Hybrid (Standard): Volltext, Bedeutung und Link-Graph. ' +
        'mode "text" ist reine Volltextsuche (alle Wörter), "semantic" nur Bedeutung. Mehrere Formulierungen ausprobieren, dann mit vault_read lesen.',
      inputSchema: {
        query: z.string().describe('Suchbegriffe oder eine Frage in natürlicher Sprache.'),
        mode: z.enum(['hybrid', 'text', 'semantic']).optional(),
        tag: z.string().optional().describe('Nur Notizen mit diesem Tag, ohne Raute.'),
        folder: z.string().optional().describe('Nur unterhalb dieses Ordners.'),
        type: z.string().optional().describe('Nur Notizen mit diesem Frontmatter-type, z.B. "concept" oder "daily-note".'),
        include_readwise: z.boolean().optional().describe('Importierte Readwise-Artikel mitdurchsuchen (nur Volltext). Standard: false.'),
        limit: z.number().int().min(1).max(50).optional().describe('Anzahl der Treffer, Standard 10.'),
        offset: z.number().int().min(0).optional(),
      },
      annotations: READ_ONLY,
    },
    async (args) => {
      const filters = {
        include: args.include_readwise ? ['core', 'readwise'] : ['core'],
        includeSensitive: false,
        tag: args.tag ?? null,
        folder: args.folder ?? null,
        type: args.type ?? null,
        limit: args.limit ?? 10,
        offset: args.offset ?? 0,
      };
      const mode = args.mode ?? 'hybrid';
      if (mode === 'text') {
        const res = index.search(args.query, filters);
        return ok({ mode, total: res.total, has_more: res.hasMore, results: res.results.filter((r) => !r.sensitivity).map((r) => ({ path: r.path, title: r.title, type: r.type, updated: r.updated, snippet: r.snippet })) });
      }
      const res = await hybridSearch({ index, semantic, query: args.query, mode, ...filters });
      return ok({ mode, total: res.total, has_more: res.hasMore, ...(res.degraded ? { degraded: res.degraded } : {}), results: res.results.filter((r) => !r.sensitivity) });
    },
  );

  server.registerTool(
    'vault_read',
    {
      title: 'Notiz lesen',
      description: `Liest eine Notiz vollständig mit Frontmatter. Sehr lange Notizen enden bei ${MAX_RESULT_CHARS} Zeichen ("truncated": true), dann mit "offset" weiterlesen.`,
      inputSchema: {
        path: z.string().describe('Pfad relativ zur Vault-Wurzel, aus vault_search, vault_list oder vault_links.'),
        offset: z.number().int().min(0).optional(),
      },
      annotations: READ_ONLY,
    },
    async (args) => {
      const note = readNote(index, args.path, { offset: args.offset ?? 0, allowSensitive: false });
      if (!note) return fail(`Notiz "${args.path}" gibt es nicht (oder sie ist vertraulich). Den Pfad mit vault_search ermitteln.`);
      seen.add(note.path);
      return ok(note);
    },
  );

  server.registerTool(
    'vault_list',
    {
      title: 'Ordner auflisten',
      description: `Listet Notizen unterhalb eines Ordners, zur Orientierung. Ohne Angabe die oberste Ebene.${layoutHint ? ` ${layoutHint}` : ''}`,
      inputSchema: {
        folder: z.string().optional().describe('Ordnerpfad. Leer für die Wurzel.'),
        limit: z.number().int().min(1).max(200).optional(),
      },
      annotations: READ_ONLY,
    },
    async (args) => ok({ folder: args.folder ?? '', entries: index.listFolder(args.folder ?? '', { limit: args.limit ?? 100 }) }),
  );

  server.registerTool(
    'vault_links',
    {
      title: 'Verknüpfungen einer Notiz',
      description: 'Backlinks und ausgehende Links einer Notiz, um Zusammenhänge zu erschließen.',
      inputSchema: { path: z.string().describe('Pfad der Notiz relativ zur Vault-Wurzel.') },
      annotations: READ_ONLY,
    },
    async (args) => {
      const allowed = open();
      if (!allowed.has(args.path)) return fail(`Notiz "${args.path}" gibt es nicht (oder sie ist vertraulich).`);
      return ok({ path: args.path, backlinks: shown(index.backlinks(args.path), allowed), outgoing: shown(index.outgoingLinks(args.path), allowed) });
    },
  );

  server.registerTool(
    'vault_similar',
    {
      title: 'Ähnliche Notizen',
      description: 'Inhaltlich ähnliche Notizen (Embeddings), auch wenn sie nicht verlinkt sind.',
      inputSchema: {
        path: z.string().describe('Pfad der Notiz relativ zur Vault-Wurzel.'),
        limit: z.number().int().min(1).max(30).optional(),
      },
      annotations: READ_ONLY,
    },
    async (args) => {
      if (!semantic) return fail('Die Suche nach Bedeutung ist nicht eingerichtet; vault_search und vault_links gehen.');
      const allowed = index.filterPaths({ includeSensitive: false });
      if (!allowed.has(args.path)) return fail(`Notiz "${args.path}" gibt es nicht (oder sie ist vertraulich).`);
      const hits = semantic.similarTo(args.path, { limit: args.limit ?? 10, allow: (p) => allowed.has(p) });
      if (!hits) return fail(`Für "${args.path}" gibt es noch keine Embeddings.`);
      const meta = index.describe(hits.map((h) => h.path));
      return ok({ path: args.path, results: hits.map((h) => ({ path: h.path, title: meta.get(h.path)?.title ?? h.path, similarity: Math.round(h.score * 1000) / 1000 })) });
    },
  );

  return server;
}

const same = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};

/** `index`, `semantic` (Wert oder Funktion), `layoutHint` wie beim MCP-Server des Cockpits. */
export function createResearchVault({ index, semantic = null, layoutHint = null, logger = console }) {
  return {
    async open() {
      const token = randomBytes(24).toString('base64url');
      const seen = new Set();
      const handler = createMcpHandler(() => researchServer({ index, semantic, layoutHint, seen }));
      const http = createServer(async (req, res) => {
        try {
          if (!same(req.headers.authorization ?? '', `Bearer ${token}`)) {
            res.writeHead(401).end();
            return;
          }
          const chunks = [];
          let size = 0;
          for await (const c of req) {
            size += c.length;
            if (size > MAX_BODY) {
              res.writeHead(413).end();
              return;
            }
            chunks.push(c);
          }
          const body = req.method === 'GET' || req.method === 'HEAD' ? null : Buffer.concat(chunks);
          await writeWebResponse(res, await handler.fetch(toWebRequest(req, body, 'http://127.0.0.1')));
        } catch (err) {
          logger.warn?.(`Recherche-Vault: ${err.message}`);
          if (!res.headersSent) res.writeHead(500);
          res.end();
        }
      });
      await new Promise((resolve, reject) => {
        http.once('error', reject);
        http.listen(0, '127.0.0.1', resolve);
      });
      const url = `http://127.0.0.1:${http.address().port}/mcp`;
      return {
        mcp: { name: 'vault', config: { type: 'http', url, headers: { Authorization: `Bearer ${token}` } } },
        read: () => [...seen],
        close: () => new Promise((resolve) => {
          http.closeAllConnections?.();
          http.close(() => resolve());
        }),
      };
    },
  };
}
