import { spawn as nodeSpawn } from 'node:child_process';
import type { Logger } from '../logger.js';

// ─────────────────────────────────────────────────────────────────────────────
// child handle / spawn — same shape as codex.ts so tests can inject the same
// way. The runtime adds an `on('exit'|'error', …)` surface large enough for
// the dispatcher's lifecycle hooks; everything else (`once`, `removeListener`)
// is intentionally omitted to keep the test fake minimal.
// ─────────────────────────────────────────────────────────────────────────────

export interface AppServerChildHandle {
  readonly stdin: NodeJS.WritableStream | null;
  readonly stdout: NodeJS.ReadableStream | null;
  readonly stderr: NodeJS.ReadableStream | null;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  on(event: 'error', listener: (err: Error) => void): void;
}

export interface AppServerSpawnOptions {
  cwd?: string;
}

export type AppServerSpawnFn = (
  command: string,
  args: readonly string[],
  options: AppServerSpawnOptions,
) => AppServerChildHandle;

// Default spawn — node:child_process.spawn cast to our minimal surface.
// On Windows the `codex` bin lands as a `.cmd` shim; bare `spawn` without
// `shell:true` fails with ENOENT on the shim. Route through the shell on
// win32. `command`/`args` are module-internal — no operator-supplied
// tokens enter the argv.
export const defaultAppServerSpawn: AppServerSpawnFn = (command, args, options) =>
  nodeSpawn(command, args, {
    cwd: options.cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
  }) as unknown as AppServerChildHandle;

// ─────────────────────────────────────────────────────────────────────────────
// Narrow typed views of the app-server protocol. We do NOT pull in the 81
// types `codex app-server generate-ts` produces — instead we model only what
// our backend reads/writes, so schema drift in unrelated v2 methods cannot
// break our build. The trade-off is that field additions on the methods we
// DO use must be picked up here manually; the dispatcher passes unknown
// fields through unchanged via `params: unknown`.
// ─────────────────────────────────────────────────────────────────────────────

export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';

// Client-side capability opt-ins announced at initialize time. codex
// app-server gates a number of fields behind `experimentalApi` — the gate
// we care about is `thread/start.environments`, which we use to disable
// codex's built-in execution surfaces under openai-compat dispatch (#183).
// Other gated features (`thread/turns/list`, `process/spawn`, etc.) become
// reachable too, but we don't call them, so opting in is no-op for them.
// Safe to opt in unconditionally — codex marks individual fields stable
// independently of the capability, and any future graduation just makes
// the gate disappear.
export interface InitializeCapabilities {
  experimentalApi?: boolean;
}

export interface InitializeParams {
  clientInfo: { name: string; title: string; version: string };
  capabilities?: InitializeCapabilities;
}

export interface InitializeResult {
  userAgent?: string;
  codexHome?: string;
  platformFamily?: string;
  platformOs?: string;
}

// Open `config` passthrough on thread/start and thread/resume. The full
// codex schema treats this as a wide object (`additionalProperties: true`);
// we model only the nested keys we actually set so the codex schema can
// grow without forcing edits here. `features.<name>=false` is the seam we
// use to disable built-in shell/exec tools when caller-side tool dispatch
// is active (#175). Re-passed on every resume because feature flags do not
// persist across thread/resume in app-server.
export interface ThreadConfigOverride {
  features?: Record<string, boolean>;
  [key: string]: unknown;
}

// Subset of codex's `DynamicToolSpec` we send on `thread/start.dynamicTools`
// to expose caller-side openai-compat tools as first-class function tools in
// the model's tool registry. When the model invokes one, codex sends the
// client an `item/tool/call` server request (see `DynamicToolCallParams`).
// Gated behind the `experimentalApi` capability — which we already opt into
// for `thread/start.environments` (#183). `deferLoading` mirrors codex's
// legacy `exposeToContext = !defer_loading`: false (default) makes the tool
// visible in the model's prompt; true hides it but keeps it callable via
// `tool_search`. We always want visibility for the openai-compat path, so
// callers leave `deferLoading` unset.
export interface DynamicToolSpec {
  namespace?: string;
  name: string;
  description: string;
  // OpenAI parameters schema — codex calls this `inputSchema`. Modeled as
  // `unknown` because the structure is a JSON Schema object whose shape is
  // already enforced upstream (gateway side) and which codex itself only
  // forwards opaquely to the model provider.
  inputSchema: unknown;
  deferLoading?: boolean;
}

export interface ThreadStartParams {
  cwd?: string | null;
  sandbox?: SandboxMode | null;
  developerInstructions?: string | null;
  baseInstructions?: string | null;
  config?: ThreadConfigOverride | null;
  // Per-thread environment specs. Empty array = no execution environment,
  // which structurally removes shell / unified_exec / apply_patch / view_image
  // handlers from the tool registry for this thread (sticky across resumes).
  // We model as opaque `unknown[]` because the only value we ever send is `[]`.
  environments?: unknown[] | null;
  // Caller-provided function tools exposed natively to the model. Sticky on
  // `thread/start` — codex persists them with `SessionMeta` and re-hydrates
  // them on `thread/resume`, so `ThreadResumeParams` does not accept the
  // field.
  dynamicTools?: DynamicToolSpec[] | null;
}

export interface ThreadResumeParams {
  threadId: string;
  cwd?: string | null;
  sandbox?: SandboxMode | null;
  config?: ThreadConfigOverride | null;
}

export interface ThreadStartOrResumeResult {
  thread: { id: string };
}

// Subset of codex's `model/list` response entry we read. The full schema is
// wider (display name, description, NUX message, service tiers, input
// modalities, …), but `resolveCapabilities` only needs:
//   - `id`: the model identifier we advertise + that lands in `usage.model`
//   - `isDefault`: codex's recommended default (used when the operator
//     hasn't pinned a different one via `config.toml`)
//   - `hidden`: codex hides legacy / deprecated models from pickers; we
//     skip them in the advertise too
//   - `supportedReasoningEfforts`: presence (length > 0) is codex's own
//     signal that the model emits `completion_tokens_details.reasoning_tokens`,
//     so we can set the openai-compat/v1 `reasoning` flag without the
//     `model_reasoning_effort` heuristic the config.toml path used.
//   - `context_window`: codex's effective per-model context window in tokens
//     (the runtime value, as opposed to `max_context_window` which is the
//     model ceiling). Advertised on the openai-compat/v1 `contextWindow`
//     hint. codex's `model/list` carries no output-token ceiling, so
//     `maxOutputTokens` is left unadvertised for this backend.
export interface ModelListEntry {
  id: string;
  isDefault?: boolean;
  hidden?: boolean;
  supportedReasoningEfforts?: Array<{ reasoningEffort?: string }>;
  context_window?: number;
}

export interface ModelListResult {
  data: ModelListEntry[];
}

export type UserInputItem =
  | { type: 'text'; text: string; text_elements: never[] }
  | { type: 'localImage'; path: string };

export interface TurnStartParams {
  threadId: string;
  input: UserInputItem[];
}

export interface TurnStartResult {
  turn: { id: string; status: string };
}

export interface TurnInterruptParams {
  threadId: string;
  turnId: string;
}

// Native function-call history items appended to a thread's model-visible
// context via `thread/inject_items`. These are OpenAI Responses API items;
// codex's session builder includes them in the model prompt as proper
// prior tool dispatch rather than as JSON text the model has to be
// instructed to interpret. We model the two variants we use here
// (function_call + function_call_output) and pass anything else through
// as opaque so the schema can grow without forcing edits.
export interface FunctionCallItem {
  type: 'function_call';
  call_id: string;
  name: string;
  /** OpenAI spec: arguments is a JSON-encoded string. */
  arguments: string;
}

export interface FunctionCallOutputItem {
  type: 'function_call_output';
  call_id: string;
  output: string;
}

export type ResponsesApiItem =
  | FunctionCallItem
  | FunctionCallOutputItem
  | { type: string; [key: string]: unknown };

export interface ThreadInjectItemsParams {
  threadId: string;
  items: ResponsesApiItem[];
}

export interface ApprovalResponse {
  decision: 'accept' | 'acceptForSession' | 'decline';
}

// Server-initiated method name for the model invoking a `DynamicToolSpec`.
// codex sends a JSON-RPC request with this method and `DynamicToolCallParams`;
// the client must respond with `DynamicToolCallResponse` or codex will block
// the turn waiting for an answer.
export const DYNAMIC_TOOL_CALL_METHOD = 'item/tool/call';

export interface DynamicToolCallParams {
  threadId: string;
  turnId: string;
  callId: string;
  namespace: string | null;
  tool: string;
  // Model-produced arguments. codex parses the model's JSON output before
  // forwarding, so this is a parsed JSON value (object, in practice, but
  // typed `unknown` to reflect what's on the wire).
  arguments: unknown;
}

export type DynamicToolCallOutputContentItem =
  | { type: 'inputText'; text: string }
  | { type: 'inputImage'; imageUrl: string };

export interface DynamicToolCallResponse {
  contentItems: DynamicToolCallOutputContentItem[];
  success: boolean;
}

// Subset of `ThreadItem` we observe — others fall through to `{ type: string }`.
export type ThreadItem =
  | { type: 'agentMessage'; id: string; text: string }
  | { type: 'commandExecution'; id: string; command?: string; status?: string; exitCode?: number | null }
  | { type: string; [key: string]: unknown };

// ─────────────────────────────────────────────────────────────────────────────
// JSON-RPC wire types. Codex uses a "JSON-RPC 2.0 lite" — the `"jsonrpc": "2.0"`
// header is omitted on the wire. We tolerate either form on input.
// ─────────────────────────────────────────────────────────────────────────────

interface JsonRpcResponse {
  id: number | string;
  result?: unknown;
  error?: { code?: number; message?: string };
}

interface JsonRpcRequest {
  id: number | string;
  method: string;
  params?: unknown;
}

interface JsonRpcNotification {
  method: string;
  params?: unknown;
}

type IncomingMessage = JsonRpcResponse | JsonRpcRequest | JsonRpcNotification;

// ─────────────────────────────────────────────────────────────────────────────
// Client
// ─────────────────────────────────────────────────────────────────────────────

export type NotificationHandler = (method: string, params: unknown) => void;
export type ServerRequestHandler = (id: number | string, method: string, params: unknown) => Promise<unknown> | unknown;

export interface AppServerRpcClientOptions {
  readonly command?: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly spawn?: AppServerSpawnFn;
  readonly logger?: Logger;
  // Cap stderr we retain for crash diagnostics. Default 8KB — same scale as
  // the stderr cap in the existing codex/claude backends.
  readonly stderrCaptureBytes?: number;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
  method: string;
}

// Reasons a pending request can be rejected without a server response.
// `transport_closed` covers any path where the child went away
// (close / error / kill) — the surface is uniform so callers don't have
// to discriminate between SIGPIPE-vs-exit-vs-crash.
export const TRANSPORT_CLOSED = 'transport_closed';

export class AppServerRpcError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    readonly rpcMethod?: string,
  ) {
    super(message);
    this.name = 'AppServerRpcError';
  }
}

// Drives one `codex app-server` subprocess. The class is intentionally
// agnostic to backend semantics (threads, turns, approvals) — those live
// in `codex.ts` and consume `request` / `notify` /
// `onNotification` / `onServerRequest` here.
export class AppServerRpcClient {
  private readonly command: string;
  private readonly args: readonly string[];
  private readonly cwd?: string;
  private readonly spawnFn: AppServerSpawnFn;
  private readonly logger?: Logger;
  private readonly stderrCaptureBytes: number;

  private child: AppServerChildHandle | null = null;
  private stdoutBuf = '';
  private stderrTail = '';
  private nextId = 0;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly notificationHandlers = new Set<NotificationHandler>();
  private serverRequestHandler: ServerRequestHandler | null = null;
  private closed = false;
  private closeReason: { code?: number | null; signal?: NodeJS.Signals | null; error?: unknown } | null = null;
  private readonly closeWaiters = new Set<(reason: { code?: number | null; signal?: NodeJS.Signals | null; error?: unknown }) => void>();

  constructor(opts: AppServerRpcClientOptions = {}) {
    this.command = opts.command ?? 'codex';
    this.args = opts.args ?? ['app-server'];
    this.cwd = opts.cwd;
    this.spawnFn = opts.spawn ?? defaultAppServerSpawn;
    this.logger = opts.logger;
    this.stderrCaptureBytes = opts.stderrCaptureBytes ?? 8192;
  }

  // Spawn the child and wire stdio. Throws synchronously on `spawn(2)`
  // failure — callers handle that as the first-task `task.fail` path so
  // operators see `code=app_server_unavailable` rather than a swallowed
  // crash on the very first turn.
  start(): void {
    if (this.child) throw new Error('AppServerRpcClient.start called twice');
    if (this.closed) throw new Error('AppServerRpcClient.start called after close');
    const child = this.spawnFn(this.command, this.args, { cwd: this.cwd });
    this.child = child;
    child.stdout?.on('data', (chunk: Buffer | string) => {
      this.stdoutBuf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      this.drainStdout();
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      const s = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      this.stderrTail += s;
      if (this.stderrTail.length > this.stderrCaptureBytes) {
        this.stderrTail = this.stderrTail.slice(-this.stderrCaptureBytes);
      }
    });
    child.on('error', (err) => this.handleTransportEnd({ error: err }));
    child.on('close', (code, signal) => this.handleTransportEnd({ code, signal }));
  }

  // Test-only convenience: surface the buffered stderr so failures can
  // include the child's last words. Production paths log it on close.
  getStderrTail(): string {
    return this.stderrTail;
  }

  isClosed(): boolean {
    return this.closed;
  }

  // Resolves when the child has exited (close/error). Used by the backend
  // to detect crashes without polling.
  waitForClose(): Promise<{ code?: number | null; signal?: NodeJS.Signals | null; error?: unknown }> {
    if (this.closed) return Promise.resolve(this.closeReason ?? {});
    return new Promise((resolve) => {
      this.closeWaiters.add(resolve);
    });
  }

  // Send a JSON-RPC request and resolve with the `result` field. Rejects
  // with `AppServerRpcError` on protocol error or `Error("transport_closed")`
  // if the child exits before responding.
  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (this.closed) {
      return Promise.reject(new Error(TRANSPORT_CLOSED));
    }
    if (!this.child?.stdin) {
      return Promise.reject(new Error('AppServerRpcClient.request before start (no stdin)'));
    }
    const id = this.nextId++;
    const msg: Record<string, unknown> = { method, id };
    if (params !== undefined) msg.params = params;
    const line = JSON.stringify(msg) + '\n';
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        method,
      });
      try {
        this.child!.stdin!.write(line);
      } catch (err) {
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  // Fire-and-forget notification (no `id`). Used for `initialized` and
  // any future client-side notifications. Silently no-ops after close —
  // the lifecycle log already covered why the transport went away.
  notify(method: string, params?: unknown): void {
    if (this.closed || !this.child?.stdin) return;
    const msg: Record<string, unknown> = { method };
    if (params !== undefined) msg.params = params;
    try {
      this.child.stdin.write(JSON.stringify(msg) + '\n');
    } catch {
      // best effort — pending requests will surface the real error
    }
  }

  // Respond to a server-initiated request (e.g. approval prompts).
  // The dispatcher routes server requests to the registered handler;
  // the handler's return value flows back here as the `result`. Errors
  // (sync throw or promise rejection) become JSON-RPC errors.
  private respond(id: number | string, result: unknown): void {
    if (this.closed || !this.child?.stdin) return;
    try {
      this.child.stdin.write(JSON.stringify({ id, result }) + '\n');
    } catch {
      // best effort
    }
  }

  private respondError(id: number | string, message: string): void {
    if (this.closed || !this.child?.stdin) return;
    try {
      this.child.stdin.write(JSON.stringify({ id, error: { message } }) + '\n');
    } catch {
      // best effort
    }
  }

  onNotification(handler: NotificationHandler): () => void {
    this.notificationHandlers.add(handler);
    return () => this.notificationHandlers.delete(handler);
  }

  setServerRequestHandler(handler: ServerRequestHandler | null): void {
    this.serverRequestHandler = handler;
  }

  // SIGTERM the child. Pending requests are rejected via the close
  // handler, so callers don't need a separate teardown step.
  kill(signal: NodeJS.Signals = 'SIGTERM'): void {
    if (!this.child || this.closed) return;
    try {
      this.child.kill(signal);
    } catch {
      // best effort
    }
  }

  // ─── internals ─────────────────────────────────────────────────────────

  private drainStdout(): void {
    let nl: number;
    while ((nl = this.stdoutBuf.indexOf('\n')) !== -1) {
      const line = this.stdoutBuf.slice(0, nl).trim();
      this.stdoutBuf = this.stdoutBuf.slice(nl + 1);
      if (!line) continue;
      let msg: IncomingMessage;
      try {
        msg = JSON.parse(line) as IncomingMessage;
      } catch {
        this.logger?.warn(`[codex-rpc] bad json line: ${line.slice(0, 200)}`);
        continue;
      }
      this.dispatch(msg);
    }
  }

  private dispatch(msg: IncomingMessage): void {
    // Response to a client-initiated request.
    if (
      'id' in msg &&
      msg.id !== undefined &&
      !('method' in msg)
    ) {
      const resp = msg as JsonRpcResponse;
      const id = typeof resp.id === 'number' ? resp.id : Number(resp.id);
      const p = this.pending.get(id);
      if (!p) return;
      this.pending.delete(id);
      if (resp.error) {
        p.reject(
          new AppServerRpcError(
            resp.error.message ?? `rpc error (${resp.error.code ?? 'unknown'})`,
            resp.error.code,
            p.method,
          ),
        );
      } else {
        p.resolve(resp.result);
      }
      return;
    }
    // Server-initiated request — has both `id` and `method`. Route to
    // the handler, then ship the response back.
    if ('id' in msg && msg.id !== undefined && 'method' in msg) {
      const req = msg as JsonRpcRequest;
      const handler = this.serverRequestHandler;
      if (!handler) {
        // No handler means we have no opinion — but silence here would
        // hang the agent's turn (codex blocks on approval requests).
        // Decline by default so a misconfigured backend fails closed
        // rather than hanging.
        this.logger?.warn(
          `[codex-rpc] no handler for server request ${req.method}; declining`,
        );
        this.respond(req.id, { decision: 'decline' });
        return;
      }
      Promise.resolve()
        .then(() => handler(req.id, req.method, req.params))
        .then(
          (result) => this.respond(req.id, result),
          (err) => {
            this.logger?.warn(
              `[codex-rpc] server request handler failed for ${req.method}: ${err instanceof Error ? err.message : String(err)}`,
            );
            this.respondError(req.id, err instanceof Error ? err.message : String(err));
          },
        );
      return;
    }
    // Notification.
    if ('method' in msg) {
      const note = msg as JsonRpcNotification;
      for (const h of this.notificationHandlers) {
        try {
          h(note.method, note.params);
        } catch (err) {
          this.logger?.warn(
            `[codex-rpc] notification handler threw on ${note.method}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
  }

  private handleTransportEnd(reason: { code?: number | null; signal?: NodeJS.Signals | null; error?: unknown }): void {
    if (this.closed) return;
    this.closed = true;
    this.closeReason = reason;
    // Reject every pending request with a uniform sentinel so callers
    // can branch on `err.message === TRANSPORT_CLOSED` rather than
    // inspecting child exit details.
    const detail = reason.error
      ? `: ${reason.error instanceof Error ? reason.error.message : String(reason.error)}`
      : reason.signal
        ? ` (signal ${reason.signal})`
        : reason.code != null
          ? ` (code ${reason.code})`
          : '';
    for (const [, p] of this.pending) {
      p.reject(new Error(`${TRANSPORT_CLOSED}${detail}`));
    }
    this.pending.clear();
    for (const w of this.closeWaiters) {
      try {
        w(reason);
      } catch {
        // best effort
      }
    }
    this.closeWaiters.clear();
  }
}
