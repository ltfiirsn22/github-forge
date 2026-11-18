// app.ts — the forge server: REST v3 (rest.ts) + the starter's lifecycle routes.
// Git smart HTTP, GraphQL and MCP arrive in later stages; unknown routes stay JSON 404.
//
// app.ts is deliberately separate from main.ts: this is the server, the file you grow; main.ts is the
// entry <-> env lifecycle and should stay as it is.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleRest } from './rest.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

/** Answer one request with a JSON body; `headers` go beside the JSON ones. */
function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

/** The path of a request URL, or '/' when it does not parse (never a throw from a request). */
function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

/** The login the bearer token names; one viewer, deterministic. */
const VIEWER = 'forge-user';

/** Read the whole body (the suite may PUT contents and issue bodies). */
function readBody(req: IncomingMessage, limit = 64 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const path = pathOf(req);
    const method = (req.method ?? 'GET').toUpperCase();
    const url = new URL(req.url ?? '/', 'http://entry');

    try {
      // The env's boot check calls this twice: 200 {"ok":true}. No auth.
      if (method === 'GET' && path === '/healthz') {
        sendJson(res, 200, { ok: true });
        return;
      }

      // REST v3: everything under /api/v3 goes to rest.ts.
      if (path === '/api/v3' || path.startsWith('/api/v3/')) {
        let body: unknown = null;
        const raw = await readBody(req);
        if (raw.length > 0) {
          const text = raw.toString('utf8');
          try {
            body = JSON.parse(text) as unknown;
          } catch {
            sendJson(res, 400, { message: 'Problems parsing JSON' });
            return;
          }
        }
        const auth = req.headers.authorization ?? '';
        const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : null;
        handleRest({ req, res, method, path, url: req.url ?? '/', query: url.searchParams, token, owner: VIEWER, body });
        return;
      }

      // Everything else (git smart HTTP / GraphQL / MCP land here in later stages): GitHub's 404.
      sendJson(res, 404, { message: 'Not Found' });
    } catch (err) {
      sendJson(res, 500, { message: err instanceof Error ? err.message : 'internal error' });
    }
  });
}
