import { randomUUID } from 'node:crypto';
import { createServer as createHttpServer, type Server as HttpServer, type ServerResponse } from 'node:http';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import type { Part } from '@vicoop-bridge/protocol';
import {
  createBoundedFileReader,
  inferMimeFromPath,
  SafeReadError,
} from './file-attach.js';
import { clientVersion } from '../version.js';

/**
 * What a registered active task exposes to the MCP server. Only `emit` is
 * called when a tool invocation lands; the rest is metadata so the server
 * can produce useful diagnostics if multiple tasks try to register.
 */
export interface SendFileTaskHandle {
  taskId: string;
  contextId: string;
  emit: (artifact: { artifactId: string; name: string; parts: Part[] }) => void;
}

export interface SendFileMcpOptions {
  /** Roots within which the agent may reference files. */
  allowedRoots: string[];
  /** Require a bridge-issued per-execution bearer token (host Claude). */
  requireExecutionBinding?: boolean;
  /** Per-attachment size cap. Default 20 MiB. */
  maxBytes?: number;
  /** TCP port; default 0 (OS-picked). */
  port?: number;
  /** Bind host; default 127.0.0.1. */
  host?: string;
  /**
   * Allow binding to a non-loopback host (any wildcard like `0.0.0.0`/`::`,
   * or a concrete external interface). The send_file tool exposes file
   * reads from `allowedRoots`. Legacy mode has no transport-level auth;
   * execution-bound mode uses bearer capabilities over plain HTTP. Neither
   * mode is intended for untrusted networks. Default: refuse and throw.
   *
   * Operators that need a non-loopback bind (sidecar in another container's
   * network namespace, etc.) opt in with this flag and accept that
   * legacy mode has only `allowedRoots` as access control.
   */
  dangerouslyAllowNonLoopback?: boolean;
  /**
   * Skip binding the HTTP listener. The MCP server, tool registry, and
   * routing are still built so tests can drive the tool path through
   * `invokeSendFileForTest` directly without opening a socket. Production
   * callers leave this unset.
   */
  skipHttp?: boolean;
}

export interface SendFileMcpServer {
  /**
   * URL the agent's MCP runtime should connect to. Backends register it
   * however their host CLI / config expects: OpenClaw via
   * `openclaw mcp set send-file`, claude via `--mcp-config` inline JSON,
   * other backends via their own equivalents. Execution-bound callers must
   * also supply the registration token in the Authorization: Bearer header.
   */
  url: string;
  /** Bind host as it was passed to `httpServer.listen()` (lowercased). */
  host: string;
  /** Bind port (after OS allocation when port:0). */
  port: number;
  /** Register an execution. A token supplied by the backend must be fresh
   * and randomly generated, never selected from model-controlled input. */
  registerActiveTask(handle: SendFileTaskHandle, token?: string): { token: string; release: () => void };
  /** How many tasks are currently registered (for diagnostics/tests). */
  activeTaskCount(): number;
  /**
   * Internal handler exposed for unit tests that drive the tool without
   * MCP transport. Performs the same routing + read + emit logic the real
   * tool handler uses.
   */
  invokeSendFileForTest(input: { path: string; name?: string }, token?: string): Promise<{
    ok: true;
    artifactId: string;
    size: number;
    realPath: string;
  } | { ok: false; code: string; message: string }>;
  close(): Promise<void>;
}

const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;
const DEFAULT_HOST = '127.0.0.1';
// Loopback IP literals only. `"localhost"` is intentionally excluded:
// `httpServer.listen(port, "localhost")` resolves through libc/DNS, and an
// environment with a non-standard `/etc/hosts` (or DNS poisoning) could
// map it to a routable interface — bypassing the safety check operators
// rely on. Forcing IP literals removes the resolver from the trust path.
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1']);
// Real wildcard bind addresses Node accepts in `httpServer.listen(port, host)`.
// `"*"` is intentionally excluded: Node treats it as a literal hostname and
// `.listen()` resolves it via DNS, typically failing ENOTFOUND. Operators
// who want all-interfaces use `0.0.0.0` (IPv4) or `::` (IPv6 / dual stack).
const WILDCARD_HOSTS = new Set(['0.0.0.0', '::']);

// Defensive stringification — `(e as Error).message` is unsafe when the
// thrown value is null/undefined or a non-Error primitive (common when
// rejection paths in foreign code throw raw strings or numbers). Always
// returns a string suitable for logs/structured-content without throwing.
function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  try {
    return String(e);
  } catch {
    return '<unrepresentable>';
  }
}

export async function startSendFileMcpServer(
  opts: SendFileMcpOptions,
): Promise<SendFileMcpServer> {
  const allowedRoots = opts.allowedRoots;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  // Hostnames are case-insensitive per RFC 1035 §2.3.3; IPv6 hex digits
  // likewise have no case. Lowercase once so allowlist comparisons and
  // wildcard checks aren't tripped by `Localhost` / `LOCALHOST` / mixed
  // IPv6 hex like `::1` vs `::1`.
  const host = (opts.host ?? DEFAULT_HOST).toLowerCase();
  if (!LOOPBACK_HOSTS.has(host) && !opts.dangerouslyAllowNonLoopback) {
    throw new Error(
      `send_file MCP refuses to bind to non-loopback host "${host}" — the tool reads files from allowedRoots without transport-level auth. Set dangerouslyAllowNonLoopback:true to override.`,
    );
  }
  // Cached reader: canonicalize roots once per server instance instead of
  // on every tool call. This server is long-lived (one per backend), so
  // every send_file tool invocation reuses the same canonical roots.
  const readBounded = createBoundedFileReader({ allowedRoots, maxBytes });

  // Legacy backends retain single-task routing. Claude instead supplies a
  // random capability per child execution, outside model-controlled tool args.
  const activeTasks = new Map<string, SendFileTaskHandle>();

  function registerActiveTask(handle: SendFileTaskHandle, token = randomUUID()) {
    if (closing) throw new Error('send_file MCP server is closed');
    if (activeTasks.has(token)) throw new Error('duplicate send_file execution binding');
    activeTasks.set(token, handle);
    return { token, release: () => { activeTasks.delete(token); } };
  }

  async function performSendFile(input: { path: string; name?: string }, token?: string): Promise<
    | { ok: true; artifactId: string; size: number; realPath: string }
    | { ok: false; code: string; message: string }
  > {
    const stale = { ok: false as const, code: 'inactive-execution', message: 'The file-delivery execution binding is missing or no longer active.' };
    if (closing) return stale;
    if (opts.requireExecutionBinding && (!token || !activeTasks.has(token))) return stale;
    if (!token && activeTasks.size === 0) {
      return { ok: false, code: 'no-active-task', message: 'No A2A task is active on this backend.' };
    }
    if (!token && activeTasks.size > 1) {
      return { ok: false, code: 'ambiguous-task', message: 'Multiple tasks are active without an execution binding.' };
    }
    const binding = token ?? activeTasks.keys().next().value!;
    const task = activeTasks.get(binding);
    if (!task) return stale;
    try {
      const read = await readBounded(input.path);
      // Cancellation/exit/shutdown can revoke a binding while the read awaits.
      if (closing || activeTasks.get(binding) !== task) return stale;
      // Treat empty / whitespace-only `name` as missing — falling back to
      // the basename gives the caller a useful filename instead of the
      // empty string the model accidentally passed in.
      const trimmedName = input.name?.trim();
      const fileName =
        trimmedName && trimmedName.length > 0 ? trimmedName : path.basename(read.realPath);
      const artifactId = randomUUID();
      const parts: Part[] = [
        {
          kind: 'file',
          file: {
            name: fileName,
            mimeType: inferMimeFromPath(read.realPath),
            bytes: read.buffer.toString('base64'),
          },
        },
      ];
      task.emit({ artifactId, name: 'send-file', parts });
      return { ok: true, artifactId, size: read.size, realPath: read.realPath };
    } catch (err) {
      if (err instanceof SafeReadError) {
        return { ok: false, code: err.code, message: err.message };
      }
      return {
        ok: false,
        code: 'unexpected-error',
        message: errorMessage(err),
      };
    }
  }

  function createMcp(token?: string): McpServer {
    const mcp = new McpServer({
      name: 'vicoop-bridge-send-file',
      version: clientVersion,
    });

    mcp.registerTool(
      'send_file',
      {
        description:
          'Deliver a local file to the A2A caller as an attachment. Use this when you want to send a file (PDF, image, csv, etc.) you produced or read earlier alongside your text response. The file is delivered via the bridge as an A2A FilePart artifact. Returns once the file has been queued for transfer.',
        inputSchema: {
          path: z
            .string()
            .min(1)
            .describe(
              'Path to the file on the local filesystem. Absolute paths are preferred; a relative path resolves against the first operator-configured allowed root. After resolution the file must canonicalize (realpath) into one of the allowed roots, otherwise the call is rejected.',
            ),
          name: z
            .string()
            .optional()
            .describe(
              'Optional display name shown to the caller. Defaults to the file basename.',
            ),
        },
      },
      async ({ path: filePath, name }) => {
        const result = await performSendFile({ path: filePath, name }, token);
        if (result.ok) {
          return {
            content: [
              {
                type: 'text',
                text: `File queued for transfer (artifactId=${result.artifactId}, size=${result.size} bytes, path=${result.realPath}).`,
              },
            ],
            structuredContent: result,
          };
        }
        // Surface as an error result so the model sees it failed and can
        // adjust (try a different path, ask the user, etc.) instead of
        // silently moving on.
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `send_file failed (${result.code}): ${result.message}`,
            },
          ],
          structuredContent: result,
        };
      },
    );

    return mcp;
  }

  // Claude starts a fresh MCP client on every turn, including resumed contexts.
  // Each HTTP request gets a fresh stateless transport/server. Reusing one
  // initialized stateful transport rejects the next process's initialize.
  const requests = new Map<McpServer, ServerResponse>();
  let closing: Promise<void> | undefined;

  let httpServer: HttpServer | null = null;
  let actualPort = 0;
  // Wildcard bind addresses are not routable for clients — they tell the OS
  // "listen on all interfaces" but a client connecting to `http://0.0.0.0/`
  // gets a connection refused on most platforms. Advertise the matching
  // loopback (IPv4 → 127.0.0.1, IPv6 → ::1) so a `::`-bound listener on a
  // host with IPV6_V6ONLY set still resolves to a reachable URL.
  const advertiseHost = host === '::'
    ? '::1'
    : WILDCARD_HOSTS.has(host)
      ? '127.0.0.1'
      : host;
  // IPv6 literals must be bracketed in URLs (RFC 3986).
  const urlHost = advertiseHost.includes(':') ? `[${advertiseHost}]` : advertiseHost;
  let url = `http://${urlHost}:0/mcp`;

  if (!opts.skipHttp) {
    httpServer = createHttpServer(async (req, res) => {
      if (closing) {
        res.statusCode = 503;
        res.end('shutting down');
        return;
      }
      // Single MCP endpoint. Reject anything else fast so we don't expose
      // unintended surfaces. Strict pathname match (`/mcp` exactly, with
      // an optional querystring) — the previous `startsWith('/mcp')` also
      // matched `/mcp2`, `/mcp-anything`, etc.
      const pathname = req.url ? req.url.split('?', 1)[0] : '';
      if (pathname !== '/mcp') {
        res.statusCode = 404;
        res.end('not found');
        return;
      }
      const authorization = req.headers.authorization;
      const token = authorization?.startsWith('Bearer ') ? authorization.slice(7) : undefined;
      if (opts.requireExecutionBinding && (!token || !activeTasks.has(token))) {
        res.statusCode = 401;
        res.end('inactive execution');
        return;
      }
      const mcp = createMcp(token);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      requests.set(mcp, res);
      res.on('close', () => {
        requests.delete(mcp);
        void mcp.close().catch(() => {});
      });
      try {
        await mcp.connect(transport);
        await transport.handleRequest(req, res);
      } catch (err) {
        console.error('[send-file-mcp] handleRequest threw:', errorMessage(err));
        await mcp.close().catch(() => {});
        if (!res.headersSent) {
          res.statusCode = 500;
          res.end('internal error');
        } else res.end();
      }
    });

    try {
      await new Promise<void>((resolve, reject) => {
        // Named so we can detach it on success. A `once('error', reject)`
        // that never fires stays attached forever and would swallow
        // post-start error events by resolving an already-settled
        // Promise (and counting as "handled" to Node's process-crash
        // logic) instead of surfacing them.
        const onStartupError = (err: unknown): void => reject(err);
        httpServer!.once('error', onStartupError);
        httpServer!.listen(opts.port ?? 0, host, () => {
          httpServer!.removeListener('error', onStartupError);
          // Long-lived listener so post-start failures (e.g. fd exhaustion)
          // surface in logs instead of silently disappearing.
          httpServer!.on('error', (err: unknown) => {
            console.error('[send-file-mcp] httpServer error:', errorMessage(err));
          });
          const addr = httpServer!.address();
          if (addr && typeof addr === 'object') {
            actualPort = addr.port;
          }
          resolve();
        });
      });
    } catch (err) {
      // No MCP transports exist until a request arrives. Bind failure only
      // requires closing the HTTP server.
      try {
        httpServer.close();
      } catch {
        /* ignore */
      }
      throw err;
    }
    url = `http://${urlHost}:${actualPort}/mcp`;
  }

  return {
    url,
    host,
    port: actualPort,
    registerActiveTask,
    activeTaskCount: () => activeTasks.size,
    invokeSendFileForTest: performSendFile,
    async close() {
      activeTasks.clear();
      closing ??= (async () => {
        // Stop accepting connections before awaiting transport cleanup.
        const httpClosed = httpServer
          ? new Promise<void>(resolve => httpServer!.close(() => resolve()))
          : Promise.resolve();
        const pending = [...requests];
        // Closing a JSON-response transport clears its pending response mapping
        // without ending the Node response. Explicitly interrupt those responses
        // so HTTP shutdown cannot wait forever on an in-flight file read.
        for (const [, res] of pending) res.destroy();
        await Promise.all(pending.map(([mcp]) => mcp.close().catch(() => {})));
        requests.clear();
        await httpClosed;
      })();
      await closing;
    },
  };
}
