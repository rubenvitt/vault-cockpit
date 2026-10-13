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
export function createApp({ config, verifyToken, mcpHandler, logger = console }) {
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

    return send(res, 404, { error: 'not_found' });
  }

  const server = http.createServer((req, res) => {
    // Der Docker-Health-Check ruft containerintern über 127.0.0.1 auf und kann
    // die Host-Prüfung nicht bestehen — er wird deshalb davor beantwortet.
    if (req.url === '/health') return send(res, 200, { status: 'ok' });

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
    res.setHeader('access-control-expose-headers', 'WWW-Authenticate, MCP-Protocol-Version');
    res.setHeader('access-control-allow-headers', 'Authorization, Content-Type, MCP-Protocol-Version, Mcp-Method, Mcp-Name');
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
