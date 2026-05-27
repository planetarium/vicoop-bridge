import { randomUUID } from 'node:crypto';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { Server as McpProtocolServer } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { clientVersion } from '../version.js';

// MCP impersonation server for openai-compat caller-supplied tools. One
// instance per task that carries `tools` in its openai-compat metadata; the
// bridge spawns claude with `--mcp-config` pointing at this server's URL and
// claude discovers the caller's tools via the standard MCP `tools/list` →
// `tools/call` flow.
//
// Lifecycle: per-task. Each `handle()` invocation that has caller tools
// stands one up before spawning claude, tears it down in the matching
// finally. send-file-mcp.ts is per-backend (long-lived) because its tool
// set is static; caller tools are per-task by definition, so a fresh server
// per task is the natural fit. The cost (one HTTP bind on a random port)
// is a few ms and well under the spawn-claude overhead the same task pays
// anyway.
//
// Why not `McpServer.registerTool`: that path takes a Zod input schema and
// converts it to JSON Schema for the wire. Caller-supplied tools arrive as
// raw JSON Schema (OpenAI's `function.parameters` shape) and we want to
// forward them verbatim — round-tripping through Zod would either reject
// valid OpenAI-shaped schemas or silently transform them. We drop one
// level to the low-level `Server` class and register
// `ListToolsRequestSchema` / `CallToolRequestSchema` handlers directly.

/**
 * One caller-declared tool to expose. The `inputSchema` is the OpenAI
 * `function.parameters` JSON Schema verbatim — the bridge does not parse
 * or transform it. Forwarded as the MCP tool's `inputSchema` in
 * `tools/list` responses; claude sees the same shape the caller declared.
 */
export interface CallerToolDefinition {
  name: string;
  description: string;
  // OpenAI's `function.parameters` (JSON Schema object). Modeled as
  // `unknown` because the structure is enforced upstream (gateway side)
  // and the bridge forwards opaquely.
  inputSchema: unknown;
}

/**
 * What the bridge wants to know when the model invokes a tool. `callId`
 * is the MCP request id (a stable handle for pairing with the eventual
 * `chat_history` entry the caller sends on the next A2A turn).
 */
export interface CallerToolInvocation {
  callId: string;
  toolName: string;
  arguments: unknown;
}

/**
 * What the bridge tells claude in response to a `tools/call`. The actual
 * tool result lives on the caller side and arrives on the next A2A turn
 * via `chat_history`; this response just unblocks claude's MCP
 * request so its turn can wind down.
 *
 * `text` becomes the body of a single `text` content item in the MCP
 * result. Keep it short — claude may include it in its assistant context
 * before the turn ends.
 */
export interface CallerToolInvocationAck {
  text: string;
  // When true, the MCP result is marked `isError`. Useful if the bridge
  // wants claude to terminate the turn quickly rather than synthesize
  // a wrap-up message; some prompt regimes treat any tool-side error as
  // "stop and surface the failure," which is the behaviour we want when
  // we've already captured the call upstream.
  isError?: boolean;
}

export interface StartCallerToolsMcpOptions {
  /** Tools to expose. Order is preserved in `tools/list` responses. */
  tools: readonly CallerToolDefinition[];
  /**
   * Called when claude invokes one of the registered tools. The bridge
   * should emit the `tool_calls` artifact upstream from inside this
   * callback (synchronous emit is fine) and return an ack that unblocks
   * claude.
   */
  onInvoke: (
    invocation: CallerToolInvocation,
  ) => Promise<CallerToolInvocationAck> | CallerToolInvocationAck;
  /** TCP port; default 0 (OS-picked). */
  port?: number;
  /** Bind host; default 127.0.0.1. */
  host?: string;
  /**
   * Skip binding the HTTP listener. The McpServer + transport are still
   * built so tests can drive the tool path through `invokeForTest`
   * without opening a socket. Production callers leave this unset.
   */
  skipHttp?: boolean;
  /**
   * Allow binding to a non-loopback host. Mirrors send-file-mcp's
   * `dangerouslyAllowNonLoopback`; off by default so the in-process
   * impersonation surface is never network-reachable by accident.
   */
  dangerouslyAllowNonLoopback?: boolean;
}

export interface CallerToolsMcpServer {
  /** URL claude's MCP runtime should connect to. */
  url: string;
  host: string;
  port: number;
  /**
   * Drive a tool invocation without going through the MCP transport.
   * Used in unit tests so the bridge's routing can be verified without
   * standing up a real MCP client.
   */
  invokeForTest(invocation: CallerToolInvocation): Promise<CallerToolInvocationAck>;
  close(): Promise<void>;
}

const DEFAULT_HOST = '127.0.0.1';
// Same loopback / wildcard policy as send-file-mcp. The MCP tool here
// proxies caller-provided tool calls (which may carry arbitrary
// arguments) to whoever holds the bridge's emit handle; binding off
// loopback would let any reachable client trigger an artifact emission
// on the active task, so it's off by default.
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1']);
const WILDCARD_HOSTS = new Set(['0.0.0.0', '::']);

function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  try {
    return String(e);
  } catch {
    return '<unrepresentable>';
  }
}

export async function startCallerToolsMcpServer(
  opts: StartCallerToolsMcpOptions,
): Promise<CallerToolsMcpServer> {
  const host = (opts.host ?? DEFAULT_HOST).toLowerCase();
  if (!LOOPBACK_HOSTS.has(host) && !opts.dangerouslyAllowNonLoopback) {
    throw new Error(
      `caller-tools MCP refuses to bind to non-loopback host "${host}" — the tool surface proxies arbitrary tool invocations into the active task's artifact stream. Set dangerouslyAllowNonLoopback:true to override.`,
    );
  }

  // Snapshot the tool list once at startup. Per-task lifecycle means the
  // tools never change for this server instance — a follow-up task gets
  // its own server with its own list. No `notifications/tools/list_changed`
  // plumbing needed.
  const toolDefs: readonly CallerToolDefinition[] = opts.tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }));

  async function performInvoke(
    invocation: CallerToolInvocation,
  ): Promise<CallerToolInvocationAck> {
    try {
      return await opts.onInvoke(invocation);
    } catch (err) {
      // The bridge's onInvoke shouldn't throw under normal conditions
      // (it emits to the task's artifact channel, which is best-effort).
      // Convert any throw into an isError ack so claude sees a structured
      // failure rather than the MCP server going silent.
      return {
        text: `caller-tools onInvoke threw: ${errorMessage(err)}`,
        isError: true,
      };
    }
  }

  const server = new McpProtocolServer(
    { name: 'vicoop-bridge-caller-tools', version: clientVersion },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: toolDefs.map((t) => ({
      name: t.name,
      description: t.description,
      // JSON Schema forwarded verbatim. The MCP spec types it as
      // `{ type: "object", properties?, required? }`; OpenAI's tools
      // schema produces compatible shapes, so the cast is safe in
      // practice for any caller that's gone through the gateway's
      // request validator.
      inputSchema: (t.inputSchema as Record<string, unknown>) ?? {
        type: 'object',
        properties: {},
      },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    const name = req.params.name;
    const argsRaw = req.params.arguments;
    // MCP's wire-level call id (request id from the JSON-RPC envelope) is
    // the most stable handle for round-tripping back to the caller. Fall
    // back to a fresh UUID only if `requestId` is missing — which would
    // be unusual for a real client but keeps the path total.
    const callId =
      typeof extra?.requestId === 'string' || typeof extra?.requestId === 'number'
        ? String(extra.requestId)
        : `call_${randomUUID()}`;
    const ack = await performInvoke({
      callId,
      toolName: name,
      arguments: argsRaw,
    });
    return {
      content: [{ type: 'text' as const, text: ack.text }],
      ...(ack.isError ? { isError: true } : {}),
    };
  });

  // Stateful transport: claude's MCP runtime does the standard
  // initialize → tools/list → tools/call sequence and expects the server
  // to remember the negotiated session. Same setup send-file-mcp uses.
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });
  await server.connect(transport);

  let httpServer: HttpServer | null = null;
  let actualPort = 0;
  const advertiseHost =
    host === '::'
      ? '::1'
      : WILDCARD_HOSTS.has(host)
        ? '127.0.0.1'
        : host;
  const urlHost = advertiseHost.includes(':') ? `[${advertiseHost}]` : advertiseHost;
  let url = `http://${urlHost}:0/mcp`;

  if (!opts.skipHttp) {
    httpServer = createHttpServer((req, res) => {
      const pathname = req.url ? req.url.split('?', 1)[0] : '';
      if (pathname !== '/mcp') {
        res.statusCode = 404;
        res.end('not found');
        return;
      }
      transport.handleRequest(req, res).catch((err) => {
        console.error('[caller-tools-mcp] handleRequest threw:', errorMessage(err));
        if (!res.headersSent) {
          res.statusCode = 500;
          res.end('internal error');
        }
      });
    });

    try {
      await new Promise<void>((resolve, reject) => {
        const onStartupError = (err: unknown): void => reject(err);
        httpServer!.once('error', onStartupError);
        httpServer!.listen(opts.port ?? 0, host, () => {
          httpServer!.removeListener('error', onStartupError);
          httpServer!.on('error', (err: unknown) => {
            console.error('[caller-tools-mcp] httpServer error:', errorMessage(err));
          });
          const addr = httpServer!.address();
          if (addr && typeof addr === 'object') {
            actualPort = addr.port;
          }
          resolve();
        });
      });
    } catch (err) {
      // Bind failed: close the McpServer/transport we already wired up
      // so a retry doesn't leak handles.
      try {
        await server.close();
      } catch {
        /* secondary failure — ignore */
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
    invokeForTest: performInvoke,
    async close() {
      try {
        await server.close();
      } catch {
        /* ignore */
      }
      if (httpServer) {
        await new Promise<void>((resolve) => httpServer!.close(() => resolve()));
      }
    },
  };
}
