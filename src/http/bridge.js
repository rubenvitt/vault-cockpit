import { Readable } from 'node:stream';

/** Wandelt eine node:http-Anfrage in eine Web-Standard-Request um. */
export function toWebRequest(req, body, publicUrl) {
  const url = new URL(req.url, publicUrl);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (Array.isArray(v)) v.forEach((x) => headers.append(k, x));
    else if (v !== undefined) headers.set(k, v);
  }
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  return new Request(url, { method: req.method, headers, body: hasBody ? body : undefined });
}

/** Schreibt eine Web-Standard-Response zurück auf die node:http-Antwort. */
export async function writeWebResponse(res, response) {
  const headers = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });

  // Streaming-Antworten dürfen von Reverse Proxies nicht gepuffert werden.
  if ((headers['content-type'] ?? '').includes('text/event-stream')) {
    headers['x-accel-buffering'] = 'no';
    headers['cache-control'] = 'no-cache, no-transform';
  }

  res.writeHead(response.status, headers);
  if (!response.body) return res.end();
  await Readable.fromWeb(response.body).pipe(res);
}
