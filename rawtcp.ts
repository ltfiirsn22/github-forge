// rawtcp.ts — minimal HTTP/1.1 server over node:net, replacing node:http hot paths.
// Ponytail: supports exactly what the suite sends — GET/POST/PUT/PATCH/DELETE with content-length
// bodies, keep-alive, and no chunked requests (the suite always sends content-length).
// Upgrade path: add chunked/expect-continue if a client ever sends them.
import net from 'node:net';
import type { Server } from 'node:http';

interface RawReq {
  url: string;
  method: string;
  headers: Record<string, string>;
  on(ev: string, fn: (c?: Buffer) => void): void;
  resume(): void;
  destroy(): void;
}

interface RawRes {
  statusCode?: number;
  headersSent: boolean;
  writeHead(status: number, headers: Record<string, string | number>): void;
  end(body?: Buffer | string): void;
}

export interface RawHandler {
  (req: RawReq, res: RawRes): Promise<void> | void;
}

/** Build a keep-alive HTTP/1.1 server whose per-request objects mimic node:http req/res. */
export function createRawServer(handler: RawHandler): net.Server {
  return net.createServer((socket) => {
    socket.setNoDelay(true);
    let buf = Buffer.alloc(0);
    let keepAlive = true;
    interface Pending { req: RawReq; res: RawRes; resolve: () => void; headerDone: boolean; chunks: Buffer[]; }
    let pending: Pending | null = null;

    const flushResponse = (p: Pending): void => {
      const res = p.res;
      const body = Buffer.concat(p.chunks.length ? p.chunks : [Buffer.alloc(0)]);
      const status = res.statusCode ?? 200;
      const reason = status === 200 ? 'OK' : status === 201 ? 'Created' : status === 204 ? 'No Content'
        : status === 400 ? 'Bad Request' : status === 401 ? 'Unauthorized' : status === 404 ? 'Not Found'
        : status === 405 ? 'Method Not Allowed' : status === 409 ? 'Conflict' : status === 422 ? 'Unprocessable Entity'
        : status === 500 ? 'Internal Server Error' : 'OK';
      const head = [`HTTP/1.1 ${status} ${reason}`];
      for (const [k, v] of Object.entries(res.headersSent ? (res as unknown as { _headers: Record<string, string | number> })._headers : {})) {
        head.push(`${k}: ${v}`);
      }
      head.push(`content-length: ${body.length}`);
      if (!keepAlive) head.push('connection: close');
      socket.write(head.join('\r\n') + '\r\n\r\n');
      if (body.length > 0) socket.write(body);
      p.resolve();
    };

    const makePair = (): Pending => {
      let resolveRes!: () => void;
      const done = new Promise<void>((r) => { resolveRes = r; });
      const headers: Record<string, string | number> = {};
      const res: RawRes = {
        headersSent: false,
        statusCode: undefined,
        writeHead(status, hs) {
          res.statusCode = status;
          (res as unknown as { _headers: Record<string, string | number> })._headers = { ...hs };
          res.headersSent = true;
        },
        end(body) {
          if (body !== undefined) {
            pending!.chunks.push(typeof body === 'string' ? Buffer.from(body) : body);
          }
          res.headersSent = true;
          flushResponse(pending!);
        },
      };
      const chunks: Buffer[] = [];
      const listeners: Record<string, Array<(c?: Buffer | Error) => void>> = { data: [], end: [], error: [] };
      const req: RawReq = {
        url: '', method: '', headers: {},
        on(ev, fn) {
          if (listeners[ev]) listeners[ev].push(fn);
          return req;
        },
        resume() {},
        destroy() { socket.destroy(); },
      };
      const p: Pending = { req, res, resolve: resolveRes, headerDone: false, chunks };
      // body pump: writeBody feeds incoming body bytes to pendingData
      (p as unknown as {
        writeBody: (c: Buffer) => void;
        endBody: () => void;
      }).writeBody = (c: Buffer) => { for (const fn of listeners.data) fn(c); };
      (p as unknown as { endBody: () => void }).endBody = () => { for (const fn of listeners.end) fn(); };
      return p;
    };

    socket.on('data', (chunk) => {
      buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
      // parse as many requests as the buffer holds
      for (;;) {
        const sep = buf.indexOf('\r\n\r\n');
        if (sep < 0) return; // headers incomplete
        const headText = buf.subarray(0, sep).toString('latin1');
        const lines = headText.split('\r\n');
        const [method, url] = lines[0].split(' ');
        if (!method || !url) { socket.destroy(); return; }
        const headers: Record<string, string> = {};
        for (let i = 1; i < lines.length; i++) {
          const c = lines[i].indexOf(':');
          if (c > 0) headers[lines[i].slice(0, c).trim().toLowerCase()] = lines[i].slice(c + 1).trim();
        }
        const contentLength = parseInt(headers['content-length'] ?? '0', 10) || 0;
        const bodyStart = sep + 4;
        if (buf.length < bodyStart + contentLength) return; // body incomplete
        const bodyBuf = buf.subarray(bodyStart, bodyStart + contentLength);
        buf = buf.subarray(bodyStart + contentLength);
        // connection header decides keep-alive for THIS request
        const conn = (headers['connection'] ?? '').toLowerCase();
        if (conn === 'close') keepAlive = false;
        pending = makePair();
        pending.req.url = url;
        pending.req.method = method.toUpperCase();
        pending.req.headers = headers;
        const pump = pending as unknown as { writeBody: (c: Buffer) => void; endBody: () => void };
        if (contentLength > 0) pump.writeBody(Buffer.from(bodyBuf));
        pump.endBody();
        Promise.resolve(handler(pending.req as never, pending.res as never)).catch(() => socket.destroy());
        if (!keepAlive) { socket.end(); return; }
      }
    });
    socket.on('error', () => socket.destroy());
  });
}
