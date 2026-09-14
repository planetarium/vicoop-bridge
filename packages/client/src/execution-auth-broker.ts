// One execution, one private Unix socket, no host TCP listener. Only the
// owning Docker stdio transport can attach sockets; no host path is mounted.
// A real socket (rather than Server.emit(connection, Duplex)) is necessary
// for the native HTTP parser in Bun-compiled clients.
import { createServer, ServerResponse, request as httpRequest, type IncomingMessage, type ClientRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import type { Duplex } from 'node:stream';
import { connect } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
export class BrokerRejection extends Error {
  constructor(readonly status: number) { super('Request rejected by authentication broker'); }
}
export interface ExecutionBrokerOptions {
  upstream: string;
  origins: readonly string[];
  pathPrefix?: string;
  /** True permits a route; false rejects with 403, or return a protocol status. */
  allow(req: IncomingMessage): boolean | number;
  prepare(req: IncomingMessage, body: any): Promise<Record<string,string>>;
  ttlMs?: number;
  timeoutMs?: number;
  maxRequests?: number;
  maxConcurrent?: number;
  onCredentialFailure?: () => void;
}

export function createExecutionAuthBroker(opts: ExecutionBrokerOptions) {
  const origin = new URL(opts.upstream);
  if (origin.pathname !== '/' || origin.search || origin.hash || origin.username || origin.password ||
      !(opts.origins.includes(origin.origin) || (origin.protocol === 'http:' && origin.hostname === '127.0.0.1'))) {
    throw new Error('Invalid broker upstream');
  }
  // A bridge execution grant, deliberately distinct from provider credentials.
  const token = `vbc_exec_${randomBytes(32).toString('hex')}`;
  const active = new Set<() => void>();
  const sockets = new Set<Duplex>();
  const stats = { forwarded: 0, rejected: 0, lastRejectedStatus: undefined as number | undefined };
  let revoked = false;
  let admitted = 0;
  const timeoutMs = opts.timeoutMs ?? 300_000;
  const deadline = Date.now() + (opts.ttlMs ?? 60 * 60_000);
  const authorized = (req: IncomingMessage) => {
    const supplied = Buffer.from(req.headers.authorization?.replace(/^Bearer /, '') ?? String(req.headers['x-api-key'] ?? ''));
    const expected = Buffer.from(token);
    return !revoked && Date.now() < deadline && supplied.length === expected.length && timingSafeEqual(supplied, expected);
  };
  // Bun creates a ServerResponse even for upgrades, and its upgrade socket
  // cannot write raw HTTP. Capture that response through the public hook.
  const upgradeResponses = new WeakMap<IncomingMessage, ServerResponse>();
  // Preserve Bun's constructor options, which Node's typings do not declare.
  const ResponseWithOptions = ServerResponse as typeof ServerResponse & (new (req: IncomingMessage, options?: unknown) => ServerResponse);
  class BrokerResponse extends ResponseWithOptions {
    constructor(req: IncomingMessage, options?: unknown) {
      super(req, options);
      upgradeResponses.set(req, this);
    }
  }
  const server = createServer({ maxHeaderSize: 16 * 1024, ServerResponse: BrokerResponse }, async (req, res) => {
    const deny = (status: number) => {
      stats.rejected++;
      stats.lastRejectedStatus=status;
      res.writeHead(status, { 'content-type': 'application/json', connection: 'close', 'cache-control': 'no-store' });
      res.end('{"error":{"type":"authentication_broker_error","message":"Request rejected by host authentication broker"}}');
    };
    if (!authorized(req)) return deny(401);
    const allowed = opts.allow(req);
    if (allowed !== true) return deny(typeof allowed === 'number' ? allowed : 403);
    if (active.size >= (opts.maxConcurrent ?? 4) || admitted >= (opts.maxRequests ?? 256)) return deny(429);
    admitted++;
    const controller = new AbortController();
    let upstreamRequest: ClientRequest | undefined;
    let upstreamResponse: IncomingMessage | undefined;
    const stopUpstream = () => {
      upstreamResponse?.socket?.destroy();
      upstreamRequest?.socket?.destroy();
      upstreamResponse?.destroy();
      upstreamRequest?.destroy(new Error('Cancelled'));
    };
    const abort = () => { controller.abort(); req.destroy(); res.destroy(); };
    active.add(abort);
    const timer = setTimeout(abort, timeoutMs);
    controller.signal.addEventListener('abort', stopUpstream, { once: true });
    const disconnected = () => { if (!res.writableEnded) controller.abort(); };
    res.on('close', disconnected);
    try {
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 16 * 1024 * 1024) { deny(413); return; }
        chunks.push(Buffer.from(chunk));
      }
      const body = Buffer.concat(chunks);
      let data;
      try { data = JSON.parse(body.toString('utf8')); } catch { deny(400); return; }
      let headers: Record<string,string>;
      try { headers = await opts.prepare(req, data); }
      catch (error) { deny(error instanceof BrokerRejection ? error.status : 503); return; }
      if (controller.signal.aborted || revoked) return;
      stats.forwarded++;
      const result = await new Promise<IncomingMessage>((resolve, reject) => {
        upstreamRequest = (origin.protocol === 'https:' ? httpsRequest : httpRequest)(
          `${origin.origin}${opts.pathPrefix ?? ""}${req.url}`, { method: 'POST', headers, agent: false }, resolve);
        upstreamRequest.on('error', reject);
        upstreamRequest.end(body);
      });
      upstreamResponse = result;
      if (controller.signal.aborted) { result.destroy(); return; }
      const status = result.statusCode ?? 502;
      if (status < 200 || status >= 300) {
        result.destroy();
        if (status === 401 || status === 403) opts.onCredentialFailure?.();
        deny(status >= 300 && status < 400 ? 502 : status); return;
      }
      res.writeHead(status, { 'content-type': result.headers['content-type'] ?? 'application/json', 'cache-control': 'no-store' });
      let received = 0;
      for await (const chunk of result) {
        received += chunk.length;
        if (received > 64 * 1024 * 1024) { abort(); return; }
        if (!res.write(chunk)) await once(res, 'drain', { signal: controller.signal });
      }
      res.end();
    } catch {
      if (!res.destroyed) {
        if (res.headersSent) res.destroy(); else deny(502);
      }
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener('abort', stopUpstream);
      stopUpstream();
      active.delete(abort);
      res.off('close', disconnected);
    }
  });
  server.requestTimeout = timeoutMs;
  server.headersTimeout = Math.min(timeoutMs, 10_000);
  server.maxHeadersCount = 32;
  // Handle upgrade explicitly: Bun does not deliver an unsupported handshake
  // to the normal request handler. Never tunnel or accept an upgraded socket.
  server.on('upgrade', (req, socket) => {
    const allowed = authorized(req) ? opts.allow(req) : 401;
    const status = typeof allowed === 'number' ? allowed : 403;
    stats.rejected++;
    stats.lastRejectedStatus = status;
    const response = upgradeResponses.get(req);
    if (response) {
      response.writeHead(status, {connection: 'close', 'content-length': '0'});
      response.end();
      return;
    }
    socket.write(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    socket.end();
  });
  server.on('clientError', (_err, socket) => socket.destroy());
  const directory = mkdtempSync(join(tmpdir(), 'vab-'));
  const socketPath = join(directory, 'http.sock');
  const ready = new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => resolve());
  });
  // Observe startup errors even if the workload never opens a connection.
  ready.catch(() => revoke());
  const revoke = () => {
    if (revoked) return;
    revoked = true;
    clearTimeout(expiry);
    for (const abort of active) abort();
    for (const socket of sockets) socket.destroy();
    server.closeAllConnections();
    server.close(() => rmSync(directory, { recursive: true, force: true }));
  };
  const expiry = setTimeout(revoke, Math.max(1, deadline - Date.now()));
  expiry.unref();
  return { token, stats, revoke, ready,
    attach(socket: Duplex) {
      if (revoked || sockets.size >= 16) { socket.destroy(); return; }
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      void ready.then(() => {
        if (revoked || socket.destroyed) { socket.destroy(); return; }
        const peer = connect(socketPath);
        peer.on('error', () => socket.destroy());
        peer.on('close', () => socket.destroy());
        socket.on('close', () => peer.destroy());
        socket.pipe(peer).pipe(socket);
      }, () => socket.destroy());
    },
  };
}
