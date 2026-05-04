import { randomUUID } from 'node:crypto';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
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
  /** Per-attachment size cap. Default 20 MiB. */
  maxBytes?: number;
  /** TCP port; default 0 (OS-picked). */
  port?: number;
  /** Bind host; default 127.0.0.1. */
  host?: string;
  /**
   * Allow binding to a non-loopback host (any wildcard like `0.0.0.0`/`::`,
   * or a concrete external interface). The send_file tool exposes file
   * reads from `allowedRoots` to anything that can reach the listener and
   * has no transport-level auth, so binding off loopback exposes the tool
   * to other machines on the network. Default: refuse and throw.
   *
   * Operators that need a non-loopback bind (sidecar in another container's
   * network namespace, etc.) opt in with this flag and accept that
   * `allowedRoots` is the only access control.
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
  /** URL operators register in OpenClaw's `mcp.servers` config. */
  url: string;
  /** Bind host (after resolution). */
  host: string;
  /** Bind port (after OS allocation when port:0). */
  port: number;
  /** Register the task that should receive emitted artifacts. */
  registerActiveTask(handle: SendFileTaskHandle): { release: () => void };
  /** How many tasks are currently registered (for diagnostics/tests). */
  activeTaskCount(): number;
  /**
   * Internal handler exposed for unit tests that drive the tool without
   * MCP transport. Performs the same routing + read + emit logic the real
   * tool handler uses.
   */
  invokeSendFileForTest(input: { path: string; name?: string }): Promise<{
    ok: true;
    artifactId: string;
    size: number;
    realPath: string;
  } | { ok: false; code: string; message: string }>;
  close(): Promise<void>;
}

const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;
const DEFAULT_HOST = '127.0.0.1';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
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

  // Routing strategy R1: a single in-flight task at a time. Bridge's
  // typical caller-per-context pattern keeps this true; the alternative
  // (carrying sessionKey through the tool args) would push the routing
  // problem onto the model and reintroduce the prompt-fragility we are
  // moving away from. Concurrent registrations are detected and the tool
  // call is rejected with a structured error so the model doesn't silently
  // emit a file to the wrong caller.
  const activeTasks = new Set<SendFileTaskHandle>();

  function registerActiveTask(handle: SendFileTaskHandle): { release: () => void } {
    activeTasks.add(handle);
    return {
      release: () => {
        activeTasks.delete(handle);
      },
    };
  }

  async function performSendFile(input: { path: string; name?: string }): Promise<
    | { ok: true; artifactId: string; size: number; realPath: string }
    | { ok: false; code: string; message: string }
  > {
    if (activeTasks.size === 0) {
      return {
        ok: false,
        code: 'no-active-task',
        message:
          'send_file was invoked while no A2A task is in flight on this backend. The model should only call this tool while responding to a caller.',
      };
    }
    if (activeTasks.size > 1) {
      return {
        ok: false,
        code: 'ambiguous-task',
        message: `send_file was invoked while ${activeTasks.size} tasks are in flight; bridge-client cannot route the artifact unambiguously. Concurrent send_file is not supported.`,
      };
    }
    const [task] = activeTasks;
    try {
      const read = await readBounded(input.path);
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
      const result = await performSendFile({ path: filePath, name });
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

  // Stateful transport: the MCP client (OpenClaw bundle-mcp runtime) sends
  // initialize -> tools/list -> tools/call as a sequence and expects the
  // server to remember the negotiated session. The SDK's stateless mode
  // accepts initialize but rejects subsequent calls because the McpServer's
  // tool registrations are bound to the post-initialize session state. We
  // generate a fresh session ID per initialize and route subsequent
  // requests via the `mcp-session-id` header.
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });
  await mcp.connect(transport);

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
    httpServer = createHttpServer((req, res) => {
      // Single MCP endpoint. Reject anything else fast so we don't expose
      // unintended surfaces (e.g. /).
      if (!req.url || !req.url.startsWith('/mcp')) {
        res.statusCode = 404;
        res.end('not found');
        return;
      }
      transport.handleRequest(req, res).catch((err) => {
        console.error('[send-file-mcp] handleRequest threw:', errorMessage(err));
        if (!res.headersSent) {
          res.statusCode = 500;
          res.end('internal error');
        }
      });
    });

    try {
      await new Promise<void>((resolve, reject) => {
        httpServer!.once('error', reject);
        httpServer!.listen(opts.port ?? 0, host, () => {
          const addr = httpServer!.address();
          if (addr && typeof addr === 'object') {
            actualPort = addr.port;
          }
          resolve();
        });
      });
    } catch (err) {
      // Bind failed (port in use, permission denied, host unresolvable).
      // The McpServer + transport were already wired up before the bind
      // attempt; close them so a retry doesn't leak handles. httpServer
      // itself never finished listening so closing is best-effort.
      try {
        await mcp.close();
      } catch {
        /* ignore secondary failure */
      }
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
      try {
        await mcp.close();
      } catch {
        /* ignore */
      }
      if (httpServer) {
        await new Promise<void>((resolve) => httpServer!.close(() => resolve()));
      }
    },
  };
}
