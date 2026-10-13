import { hybridSearch } from '../semantic/search.js';

const MODES = ['hybrid', 'semantic'];
const MAX_LIMIT = 50;

/**
 * Lesender Such-Endpunkt für Clients ohne OAuth.
 *
 * Geschützt mit API-Tokens, die unter Einstellungen → API-Tokens im
 * Web-Cockpit angelegt werden (`tokens`, siehe `cockpit/tokens.js`), getrennt
 * vom Capture-Token. Ein Token kann nur suchen, und zwar nur in eigenen Notizen
 * (`core`) ohne vertrauliche Ordner. Notizen lesen oder ändern geht damit nicht.
 *
 * - `GET /api/search?q=…` — `mode` (`hybrid` Standard oder `semantic`),
 *   `folder`, `limit` (Standard 10, höchstens 50), `offset`. Die Antwort ist das
 *   Ergebnis von `hybridSearch` unverändert: `{results, total, hasMore, degraded}`.
 */
export function createSearchHttp({ tokens, index, semantic = null }) {
  const authorized = (req) => {
    const m = /^Bearer (\S+)$/.exec(String(req.headers.authorization ?? ''));
    return Boolean(m) && tokens.verify(m[1]);
  };

  const json = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };

  /** Ganze Zahl ≥ min oder `fallback`, wenn der Parameter fehlt; sonst `null`. */
  const intParam = (value, fallback, min) => {
    if (value === null || value === '') return fallback;
    const n = Number(value);
    return Number.isInteger(n) && n >= min ? n : null;
  };

  return {
    matches: (path) => path === '/api/search',

    async handle(req, res, url) {
      if (!authorized(req)) return json(res, 401, { error: 'unauthorized' });
      if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' });

      const params = url.searchParams;
      const query = (params.get('q') ?? '').trim();
      if (!query) return json(res, 400, { error: 'Parameter "q" fehlt' });
      const mode = params.get('mode') || 'hybrid';
      if (!MODES.includes(mode)) return json(res, 400, { error: `Unbekannter Modus "${mode}" (möglich: ${MODES.join(', ')})` });
      const limit = intParam(params.get('limit'), 10, 1);
      if (limit === null) return json(res, 400, { error: 'Parameter "limit" muss eine ganze Zahl ab 1 sein' });
      const offset = intParam(params.get('offset'), 0, 0);
      if (offset === null) return json(res, 400, { error: 'Parameter "offset" muss eine ganze Zahl ab 0 sein' });

      const result = await hybridSearch({
        index,
        semantic,
        query,
        mode,
        include: ['core'],
        includeSensitive: false,
        folder: params.get('folder') || null,
        limit: Math.min(limit, MAX_LIMIT),
        offset,
      });
      return json(res, 200, result);
    },
  };
}
