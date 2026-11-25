import { JournalError } from './journal.js';

/**
 * `POST /journal` für den Journal-Mod in Claude Code im Web: hängt einen
 * Eintrag ans Tagesjournal an (siehe journal.js). Geschützt mit API-Tokens mit
 * dem Recht „Journal“ (Einstellungen → API-Tokens). Ein solcher Token kann nur
 * Journal-Einträge schreiben, weder lesen noch suchen noch anderes anlegen.
 *
 * - `POST /journal` — JSON wie das MCP-Werkzeug `vault_journal`.
 *   201 `{written:true, path, heading}`, 200 `{written:false, reason:'duplicate'}`,
 *   400 `{error, field}`, 401 ohne gültigen Token.
 * - `GET /journal` — Verbindungstest.
 */
export function createJournalHttp({ tokens, journal }) {
  const authorized = (req) => {
    const m = /^Bearer (\S+)$/.exec(String(req.headers.authorization ?? ''));
    return Boolean(m && tokens?.verify(m[1], 'journal'));
  };
  const json = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };

  return {
    matches: (path) => path === '/journal',

    async handle(req, res, url, body) {
      if (!authorized(req)) return json(res, 401, { error: 'Token fehlt oder hat nicht das Recht Journal' });
      if (req.method === 'GET') return json(res, 200, { ok: true });
      if (req.method !== 'POST') return json(res, 405, { error: 'Nur GET und POST' });
      let input;
      try {
        input = JSON.parse(body || '{}');
      } catch {
        return json(res, 400, { error: 'Body ist kein gültiges JSON', field: null });
      }
      try {
        const result = journal.write(input);
        return json(res, result.written ? 201 : 200, result);
      } catch (err) {
        if (err instanceof JournalError) return json(res, 400, { error: err.message, field: err.field });
        return json(res, 500, { error: err.message });
      }
    },
  };
}
