// One execution, one private Unix socket, no host TCP listener. Only the
// owning Docker stdio transport can attach sockets; no host path is mounted.
// A real socket (rather than Server.emit(connection, Duplex)) is necessary
// for the native HTTP parser in Bun-compiled clients.
import { createServer, request as httpRequest, type IncomingMessage, type ClientRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import type { Duplex } from 'node:stream';
import { connect } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPinnedClaudeOAuthReader } from './backends/claude-usage.js';

export type ClaudeProviderCredential = { kind: 'oauth' | 'api-key'; secret: string };
export type CredentialReader = () => ClaudeProviderCredential | Promise<ClaudeProviderCredential>;

// Pin the source at daemon startup. Reread it on every request, without
// falling back to a different credential type after expiry or removal.
export function createClaudeCredentialReader(env: NodeJS.ProcessEnv = process.env): CredentialReader {
  for (const key of ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY']) {
    if (env[key] && env[key] !== '0') throw new Error(`${key} is unsupported by Claude container authentication`);
  }
  if (env.ANTHROPIC_BASE_URL && env.ANTHROPIC_BASE_URL !== 'https://api.anthropic.com') {
    throw new Error('Claude container authentication requires the direct Anthropic API');
  }
  const sources = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'].filter(k => env[k]);
  if (sources.length > 1) throw new Error('Set only one Claude host credential environment variable');
  if (env.ANTHROPIC_AUTH_TOKEN) throw new Error('Use ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN for Claude container authentication');
  const source = sources[0];
  const readOAuth = source ? undefined : createPinnedClaudeOAuthReader({ configDir: env.CLAUDE_CONFIG_DIR });
  return () => {
    if (source) {
      const secret = env[source];
      if (!secret || /\s/.test(secret)) throw new Error('Claude host credential is unavailable; restore it and restart the daemon');
      return { kind: source === 'ANTHROPIC_API_KEY' ? 'api-key' : 'oauth', secret };
    }
    const creds = readOAuth!();
    if (!creds || /\s/.test(creds.accessToken) || (creds.expiresAt !== undefined && creds.expiresAt <= Date.now() + 30_000)) {
      throw new Error('Claude host login is missing or expired; log in with Claude on the host and retry. The bridge does not refresh OAuth tokens.');
    }
    return { kind: 'oauth', secret: creds.accessToken };
  };
}

export function assertClaudeBrokerSettings(settings: Record<string, unknown> | undefined): void {
  if (!settings) return;
  if (['apiKeyHelper', 'awsAuthRefresh', 'awsCredentialExport'].some(k => k in settings)) {
    throw new Error('Claude container authentication helpers are unsupported; use host login or a host API key');
  }
  if (settings.env && typeof settings.env === 'object' && Object.keys(settings.env).some(k =>
    /^(ANTHROPIC_|CLAUDE_CODE_OAUTH|CLAUDE_CODE_USE_|AWS_|AZURE_|GOOGLE_APPLICATION_CREDENTIALS$)/.test(k))) {
    throw new Error('Claude container provider environment must be configured on the host, not in agent settings');
  }
}

export interface BrokerOptions {
  credential: CredentialReader;
  authentication?: ClaudeProviderCredential['kind'];
  // Trusted test seam; production never supplies a destination.
  upstream?: string;
  ttlMs?: number;
  timeoutMs?: number;
  maxRequests?: number;
  maxConcurrent?: number;
  models?: readonly string[];
  onCredentialFailure?: () => void;
}

export function createClaudeAuthBroker(opts: BrokerOptions) {
  const origin = new URL(opts.upstream ?? 'https://api.anthropic.com');
  if (origin.pathname !== '/' || origin.search || origin.hash || origin.username || origin.password ||
      !(origin.origin === 'https://api.anthropic.com' || (origin.protocol === 'http:' && origin.hostname === '127.0.0.1'))) {
    throw new Error('Invalid broker upstream');
  }
  const token = `sk-ant-${opts.authentication === 'api-key' ? 'api03' : 'oat01'}-bridge-${randomBytes(32).toString('hex')}`;
  const active = new Set<() => void>();
  const sockets = new Set<Duplex>();
  const stats = { forwarded: 0, rejected: 0 };
  let revoked = false;
  let admitted = 0;
  const timeoutMs = opts.timeoutMs ?? 300_000;
  const deadline = Date.now() + (opts.ttlMs ?? 60 * 60_000);
  const server = createServer({ maxHeaderSize: 16 * 1024 }, async (req, res) => {
    const deny = (status: number) => {
      stats.rejected++;
      res.writeHead(status, { 'content-type': 'application/json', connection: 'close', 'cache-control': 'no-store' });
      res.end('{"error":{"type":"authentication_broker_error","message":"Request rejected by host authentication broker"}}');
    };
    const supplied = Buffer.from(req.headers.authorization?.replace(/^Bearer /, '') ?? String(req.headers['x-api-key'] ?? ''));
    const expected = Buffer.from(token);
    if (revoked || Date.now() >= deadline || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return deny(401);
    if (req.method !== 'POST' || !['/v1/messages', '/v1/messages?beta=true', '/v1/messages/count_tokens', '/v1/messages/count_tokens?beta=true'].includes(req.url ?? '')) return deny(403);
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
      if (!data || typeof data !== 'object' || typeof data.model !== 'string' ||
          !/^claude-(?:haiku|sonnet|opus)-[a-zA-Z0-9.-]+$/.test(data.model) ||
          (opts.models && !opts.models.includes(data.model)) ||
          (!req.url!.includes('count_tokens') && (!Number.isInteger(data.max_tokens) || data.max_tokens < 1 || data.max_tokens > 128_000))) {
        deny(403); return;
      }
      let credential: ClaudeProviderCredential;
      try { credential = await opts.credential(); } catch {
        opts.onCredentialFailure?.();
        deny(503); return;
      }
      if (controller.signal.aborted || revoked) return;
      if (!credential.secret || /\s/.test(credential.secret)) { deny(503); return; }
      const headers: Record<string, string> = { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' };
      headers[credential.kind === 'oauth' ? 'authorization' : 'x-api-key'] = credential.kind === 'oauth' ? `Bearer ${credential.secret}` : credential.secret;
      const beta = String(req.headers['anthropic-beta'] ?? '');
      if (!/^[a-zA-Z0-9,._-]*$/.test(beta)) { deny(400); return; }
      const betas = beta.split(',').filter(v => v && (credential.kind === 'oauth' || v !== 'oauth-2025-04-20'));
      if (credential.kind === 'oauth') betas.push('oauth-2025-04-20');
      if (betas.length) headers['anthropic-beta'] = [...new Set(betas)].join(',');
      for (const name of ['user-agent', 'x-app']) if (typeof req.headers[name] === 'string') headers[name] = req.headers[name];
      stats.forwarded++;
      const result = await new Promise<IncomingMessage>((resolve, reject) => {
        upstreamRequest = (origin.protocol === 'https:' ? httpsRequest : httpRequest)(
          `${origin.origin}${req.url}`, { method: 'POST', headers, agent: false }, resolve);
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
