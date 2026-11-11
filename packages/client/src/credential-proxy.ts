import { createServer, type IncomingHttpHeaders, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { connect } from 'node:net';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdtempSync, rmSync, openSync, readSync, fstatSync, closeSync, constants } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import type { Duplex } from 'node:stream';
import type { CredentialProxyOptions } from './credential-proxy-config.js';

const hopHeaders = ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade'];
function cleanHeaders(input: IncomingHttpHeaders): IncomingHttpHeaders {
  const headers = { ...input };
  const connection = String(headers.connection ?? '').split(',').map(v => v.trim().toLowerCase());
  for (const key of [...hopHeaders, ...connection, 'authorization', 'x-api-key', 'cookie', 'set-cookie',
    'x-fal-target-url', 'x-vicoop-target-url', 'x-vicoop-proxy-token', 'expect']) delete headers[key];
  return headers;
}

function readCredential(source: CredentialProxyOptions['services'][number]['credential']): string {
  let value: string | undefined;
  if ('env' in source) value = process.env[source.env];
  else {
    // Refuse devices, directories and symlinks; bounded read even if the file
    // grows after fstat. Operator files may be atomically replaced for rotation.
    const fd = openSync(source.file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || (stat.mode & 0o077) || stat.size > 16384) throw new Error('Invalid credential');
      const bytes = Buffer.alloc(16385);
      const n = readSync(fd, bytes, 0, bytes.length, null);
      value = bytes.subarray(0, n).toString('utf8').replace(/\r?\n$/, '');
    } finally { closeSync(fd); }
  }
  if (!value || value.length > 16384 || /[^\x21-\x7e]/.test(value)) throw new Error('Invalid credential');
  return value;
}

export interface ServiceProxy {
  name: string;
  token: string;
  origins: string[];
  attach(socket: Duplex): void;
  revoke(): void;
}

/** All brokers are private to one execution. No host TCP listener or mount. */
export function createCredentialProxies(config: CredentialProxyOptions, ttlMs: number,
  // Test-only upstream transport override, never supplied by runtime configuration.
  transport?: typeof httpsRequest,
): ServiceProxy[] {
  let admitted = 0;
  const active = new Set<() => void>();
  const proxies: ServiceProxy[] = [];
  try {
    for (const service of config.services) {
      const token = `vbc_service_${randomBytes(32).toString('hex')}`;
      const expected = Buffer.from(token);
      const connections = new Set<Duplex>();
      const ownRequests = new Set<() => void>();
      let revoked = false;
      const deadline = Date.now() + ttlMs;
      const directory = mkdtempSync(join(tmpdir(), 'vcp-'));
      const socketPath = join(directory, 'http.sock');
      const authorize = (req: IncomingMessage) => {
        const supplied = req.headers['x-vicoop-proxy-token'] ?? req.headers.authorization ?? req.headers['x-api-key'];
        if (typeof supplied !== 'string') return false;
        const bytes = Buffer.from(supplied.replace(/^(Bearer|token|Key) /, ''));
        return bytes.length === expected.length && timingSafeEqual(bytes, expected);
      };
      const server = createServer({ maxHeaderSize: 32 * 1024 }, async (req, res) => {
        const deny = (status: number) => {
          if (res.headersSent) { res.destroy(); return; }
          res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', connection: 'close' });
          res.end('{"error":"Host credential proxy rejected request"}');
        };
        if (revoked || Date.now() >= deadline || !authorize(req)) return deny(401);
        if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(req.method ?? '')) return deny(405);
        let target: URL;
        try {
          if (!req.url?.startsWith('/') || req.url.startsWith('//') || /[\\\x00-\x20\x7f]/.test(req.url)) throw new Error();
          const explicit = req.headers['x-vicoop-target-url'] ?? req.headers['x-fal-target-url'];
          if (req.headers['x-vicoop-target-url'] && req.headers['x-fal-target-url']) throw new Error();
          if (explicit !== undefined && typeof explicit !== 'string') throw new Error();
          // SDK base URL uses the first origin. gh retains the original Host
          // over its Unix socket, selecting another explicitly registered origin.
          const matched = service.origins.find(o => new URL(o).host === req.headers.host);
          if (!explicit && !matched && !/^127\.0\.0\.1:\d+$/.test(req.headers.host ?? '')) throw new Error();
          const origin = matched ?? service.origins[0];
          target = new URL(explicit ?? origin + req.url);
          if (target.protocol !== 'https:' || !service.origins.includes(target.origin) ||
              target.username || target.password || target.hash) throw new Error();
        } catch { return deny(403); }
        if (active.size >= config.maxConcurrent || admitted >= config.maxRequests) return deny(429);
        const length = req.headers['content-length'];
        if (length && (!/^\d+$/.test(length) || Number(length) > config.maxRequestBytes)) return deny(413);
        admitted++;
        let secret: string;
        try { secret = readCredential(service.credential); } catch { return deny(503); }
        const controller = new AbortController();
        let upstreamResponse: IncomingMessage | undefined;
        const headers = cleanHeaders(req.headers);
        delete headers.host;
        delete headers[service.header];
        headers[service.header] = service.prefix + secret;
        // Upstream responses are opaque. Registered upstreams are trusted not
        // to return credentials; do not pretend body redaction is a boundary.
        const request = (transport ?? httpsRequest)(target, { method: req.method, headers, agent: false, signal: controller.signal });
        const stopUpstream = () => {
          upstreamResponse?.socket?.destroy(); request.socket?.destroy();
          controller.abort(); upstreamResponse?.destroy(); request.destroy();
        };
        const stop = () => { stopUpstream(); req.destroy(); res.destroy(); };
        active.add(stop); ownRequests.add(stop);
        const timer = setTimeout(stop, config.timeoutMs);
        const disconnected = () => { if (!res.writableEnded) stop(); };
        res.on('close', disconnected);
        try {
          const response = new Promise<IncomingMessage>((resolve, reject) => {
            request.once('response', resolve); request.once('error', reject);
          });
          // Observe immediately while the request body is still being streamed.
          void response.catch(() => {});
          let sent = 0;
          const upload = (async () => {
            for await (const chunk of req) {
              sent += chunk.length;
              if (sent > config.maxRequestBytes) { deny(413); controller.abort(); return; }
              if (!request.write(chunk)) await once(request, 'drain', { signal: controller.signal });
            }
            request.end();
          })();
          void upload.catch(() => { if (!res.writableEnded) stop(); });
          const result = await response;
          upstreamResponse = result;
          const output = cleanHeaders(result.headers);
          delete output[service.header];
          // Do not expose known raw credentials even if reflected in a header.
          for (const [key, value] of Object.entries(output)) {
            if (String(value).includes(secret)) delete output[key];
          }
          res.writeHead(result.statusCode ?? 502, output);
          res.flushHeaders();
          let received = 0;
          for await (const chunk of result) {
            received += chunk.length;
            if (received > config.maxResponseBytes) throw new Error('Response too large');
            if (!res.write(chunk)) await once(res, 'drain', { signal: controller.signal });
          }
          res.end(() => { if (!req.complete) req.destroy(); });
          // An early upstream response need not wait for an unbounded client upload.
          controller.abort();
          await upload.catch(() => {});
        } catch { if (!res.destroyed) deny(502); }
        finally {
          clearTimeout(timer); res.off('close', disconnected);
          stopUpstream();
          active.delete(stop); ownRequests.delete(stop);
          if (!req.complete) {
            if (res.writableFinished || res.destroyed) req.destroy();
            else res.once('finish', () => req.destroy());
          }
        }
      });
      server.requestTimeout = config.timeoutMs;
      server.headersTimeout = Math.min(config.timeoutMs, 10000);
      server.maxHeadersCount = 100;
      server.on('connect', (_req, socket) => socket.destroy());
      server.on('upgrade', (_req, socket) => socket.destroy());
      server.on('clientError', (_error, socket) => socket.destroy());
      const ready = new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
      let expiry: ReturnType<typeof setTimeout>;
      const proxy: ServiceProxy = {
        name: service.name, token, origins: [...service.origins],
        revoke() {
          if (revoked) return;
          revoked = true; clearTimeout(expiry);
          for (const stop of ownRequests) stop();
          for (const socket of connections) socket.destroy();
          server.closeAllConnections();
          server.close(() => rmSync(directory, { recursive: true, force: true }));
        },
        attach(socket) {
          if (revoked || connections.size >= 16) { socket.destroy(); return; }
          connections.add(socket); socket.on('close', () => connections.delete(socket));
          void ready.then(() => {
            if (revoked || socket.destroyed) { socket.destroy(); return; }
            const peer = connect(socketPath);
            peer.on('error', () => socket.destroy());
            // The execution transport acknowledges bounded response chunks.
            // A local HTTP socket may close before those writes have drained.
            peer.on('close', () => {
              if (socket.writableFinished || socket.destroyed) socket.destroy();
              else socket.once('finish', () => socket.destroy());
            });
            socket.on('close', () => peer.destroy()); socket.pipe(peer).pipe(socket);
          }, () => socket.destroy());
        },
      };
      expiry = setTimeout(() => proxy.revoke(), ttlMs); expiry.unref();
      void ready.catch(() => proxy.revoke());
      proxies.push(proxy);
    }
    return proxies;
  } catch (error) { for (const proxy of proxies) proxy.revoke(); throw error; }
}
