import http from 'node:http';

const MAX_BODY = 256 * 1024;

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('Body zu groß'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function send(res, status, body, headers = {}) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json',
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

/**
 * Der MCP-Server ist ein reiner OAuth Resource Server.
 *
 * Er stellt selbst keine Tokens aus — das macht Pocket ID. Wir veröffentlichen
 * nur die Protected Resource Metadata (RFC 9728), damit Claude den zuständigen
 * Authorization Server findet, und prüfen eingehende Bearer-Tokens.
 */
export function createApp({ config, verifyToken, mcpHandler, captureHttp = null, readingApi = null, searchHttp = null, syncHttp = null, webHttp = null, degraded = () => false, logger = console }) {
  const prmUrl = `${config.publicUrl}/.well-known/oauth-protected-resource/mcp`;

  const protectedResourceMetadata = () => ({
    resource: config.resource,
    authorization_servers: [config.issuer],
    scopes_supported: config.supportedScopes,
    bearer_methods_supported: ['header'],
    resource_name: 'Obsidian Vault',
    resource_documentation: 'https://github.com/rubenvitt/vault-cockpit',
  });

  const challenge = (error, description) =>
    `Bearer error="${error}", error_description="${description}", resource_metadata="${prmUrl}", scope="${config.supportedScopes.join(' ')}"`;

  async function handle(req, res, url) {
    const path = url.pathname;

    if (path === '/.well-known/oauth-protected-resource' || path === '/.well-known/oauth-protected-resource/mcp') {
      return send(res, 200, protectedResourceMetadata());
    }

    if (path === '/mcp') {
      const auth = req.headers.authorization ?? '';
      if (!auth.startsWith('Bearer ')) {
        return send(res, 401, { error: 'invalid_token', error_description: 'Bearer Token fehlt' }, {
          'www-authenticate': challenge('invalid_token', 'Bearer Token fehlt'),
        });
      }

      let principal;
      try {
        principal = await verifyToken(auth.slice(7));
      } catch (err) {
        logger.warn?.(`Token abgelehnt: ${err.message}`);
        return send(res, 401, { error: 'invalid_token', error_description: err.message }, {
          'www-authenticate': challenge('invalid_token', err.message),
        });
      }

      const body = req.method === 'GET' || req.method === 'HEAD' ? null : await readBody(req);
      return mcpHandler(req, res, principal, body);
    }

    // Capture-Endpunkte mit eigenem Token (Kurzbefehl, Funke), siehe capture/http.js.
    if (captureHttp?.matches(path)) {
      const body = req.method === 'POST' ? await readBody(req) : null;
      return captureHttp.handle(req, res, url, body);
    }

    // Lesestapel mit eigenem Token; liest den Body selbst (eigene Limits, PDFs), siehe lesen/api.js.
    if (readingApi?.matches(path)) return readingApi.handle(req, res, url);

    // Lesende Suche mit eigenem Token, siehe search/http.js.
    if (searchHttp?.matches(path)) return searchHttp.handle(req, res, url);

    // Eigener Sync mit Geräte-Token; liest den Body selbst (Dateien bis 100 MB), siehe sync/server/http.js.
    if (syncHttp?.matches(path)) return syncHttp.handle(req, res, url);

    // Web-Cockpit mit eigenem Browser-Login (Sitzungs-Cookie), siehe web/http.js.
    if (webHttp?.matches(path)) return webHttp.handle(req, res, url);

    return send(res, 404, { error: 'not_found' });
  }

  const server = http.createServer((req, res) => {
    // Der Docker-Health-Check ruft containerintern über 127.0.0.1 auf und kann
    // die Host-Prüfung nicht bestehen — er wird deshalb davor beantwortet.
    // `degraded` heißt: Der Dienst läuft, aber ein Hintergrunddienst (Sync,
    // Mail, Zunder …) meldet einen Fehler; Details nur auf /zustand mit Login.
    // Bewusst weiter 200, sonst startet Docker das Cockpit neu, obwohl der
    // Fehler draußen liegt. Wer bei `degraded` anschlagen will, prüft den Text
    // oder fragt `/health?strict=1`, das dann 503 liefert.
    if (req.url === '/health' || req.url.startsWith('/health?')) {
      let bad;
      try {
        bad = Boolean(degraded());
      } catch {
        bad = true;
      }
      const strict = new URLSearchParams(req.url.slice(8)).has('strict');
      return send(res, bad && strict ? 503 : 200, { status: bad ? 'degraded' : 'ok' });
    }

    // X-Forwarded-Host nur auswerten, wenn wir hinter einem vertrauenswürdigen
    // Proxy stehen — sonst könnte der Client die Host-Prüfung selbst aushebeln.
    const rawHost = config.trustProxy
      ? (req.headers['x-forwarded-host'] ?? req.headers.host ?? '')
      : (req.headers.host ?? '');
    const hostHeader = String(rawHost).split(',')[0].trim().split(':')[0];
    if (config.allowedHosts?.length && !config.allowedHosts.includes(hostHeader)) {
      return send(res, 403, { error: 'forbidden', error_description: 'ungültiger Host-Header' });
    }

    // Origin bewusst tolerant: claude.ai ruft serverseitig ohne Origin auf,
    // eine zu strenge Prüfung ist eine dokumentierte Fehlerquelle.
    const origin = req.headers.origin;
    res.setHeader('access-control-allow-origin', origin ?? '*');
    res.setHeader('access-control-expose-headers', 'WWW-Authenticate, MCP-Protocol-Version, X-Sync-Hash, X-Sync-Seq, X-Sync-Mtime');
    res.setHeader('access-control-allow-headers', 'Authorization, Content-Type, MCP-Protocol-Version, Mcp-Method, Mcp-Name, X-Sync-Client');
    res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }

    const url = new URL(req.url, config.publicUrl);
    handle(req, res, url).catch((err) => {
      logger.error?.('Unbehandelter Fehler:', err);
      if (!res.headersSent) send(res, 500, { error: 'server_error' });
    });
  });

  return server;
}
