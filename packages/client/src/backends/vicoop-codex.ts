import { randomUUID } from 'node:crypto';
import {
  OPENAI_COMPAT_EXTENSION_URI,
  type Part,
} from '@vicoop-bridge/protocol';
import type { Backend } from '../backend.js';
import { createLogger, type Logger } from '../logger.js';
import {
  dumpOpenAICompatTaskWire,
  parseOpenAICompatMetadata,
  type OpenAICompatHistoryEntry,
  type OpenAICompatMessageContent,
  type OpenAICompatMetadata,
} from './openai-compat.js';
import {
  buildOpenAICompatUsage,
  type OpenAICompatUsage,
} from './openai-compat-usage.js';
import {
  ServeSupervisor,
  type ServeSupervisorOptions,
  type VicoopCodexChildHandle,
  type VicoopCodexSpawnFn,
  type VicoopCodexSpawnOptions,
} from './vicoop-codex-supervisor.js';

export type {
  VicoopCodexChildHandle,
  VicoopCodexSpawnFn,
  VicoopCodexSpawnOptions,
};

export interface VicoopCodexBackendOptions {
  // Test seams only — the production CLI calls `createVicoopCodexBackend()`
  // with no arguments. The supervisor accepts a `spawn` override for tests
  // and a `fetchImpl` override for tests that script HTTP/SSE responses;
  // both default to Node's host implementations.
  command?: string;
  cwd?: string;
  extraArgs?: readonly string[];
  spawn?: VicoopCodexSpawnFn;
  fetchImpl?: typeof fetch;
  stderrCaptureBytes?: number;
  startupTimeoutMs?: number;
  logger?: Logger;
  // When true, dump A2A `parts` shape + metadata keys + raw
  // `chat_history` to stderr on every task. Operator diagnostic exposed
  // via `--openai-compat-trace`.
  openaiCompatTrace?: boolean;
}

// `vicoop-codex serve`'s `/v1/chat/completions` request body. Same shape the
// previous subprocess-per-call code built — `serve` reuses the exact same
// `chatCompletionsToUpstream` translator the `call` subcommand did.
export interface VicoopCodexCallBody {
  messages: ChatCompletionMessage[];
  tools?: unknown[];
  tool_choice?: unknown;
  stream: true;
  stream_options?: { include_usage?: boolean };
}

export interface ChatCompletionMessage {
  role: 'system' | 'developer' | 'user' | 'assistant' | 'tool' | 'function';
  content?: string | null;
  tool_calls?: unknown[];
  tool_call_id?: string;
  name?: string;
}

// Reconstructed equivalent of the previous non-streaming
// ChatCompletionResponse, assembled from streamed deltas. Kept exported
// because `buildResponseMetadata` and `parseChatCompletionUsage` consume it.
export interface ChatCompletionResponse {
  id?: string;
  object?: string;
  created?: number;
  model?: string;
  choices?: Array<{
    index?: number;
    message?: {
      role?: string;
      content?: string | null;
      tool_calls?: Array<{
        id?: string;
        type?: string;
        function?: {
          name?: string;
          arguments?: string;
        };
      }>;
    };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_tokens_details?: {
      cached_tokens?: number;
    };
    completion_tokens_details?: {
      reasoning_tokens?: number;
    };
  };
}

function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  try {
    return String(e);
  } catch {
    return '<unrepresentable>';
  }
}

function serializeDataPart(data: Record<string, unknown>): string {
  let body: string;
  try {
    body = JSON.stringify(data, null, 2);
  } catch {
    return '';
  }
  return `<context kind="application/json">\n${body}\n</context>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers — unchanged from the prior subprocess-per-call implementation.
// The translation surface (A2A parts ↔ OpenAI Chat Completions messages) is
// independent of how we deliver the request to the CLI.
// ─────────────────────────────────────────────────────────────────────────────

export function flattenA2AUserContent(parts: readonly Part[]): string | null {
  const sections: string[] = [];
  for (const p of parts) {
    if (p.kind === 'text') {
      if (p.text) sections.push(p.text);
      continue;
    }
    if (p.kind === 'data') {
      const serialized = serializeDataPart(p.data);
      if (serialized) sections.push(serialized);
      continue;
    }
  }
  if (sections.length === 0) return null;
  return sections.join('\n\n');
}

export function historyToChatCompletionMessages(
  history: OpenAICompatHistoryEntry[],
): ChatCompletionMessage[] {
  const out: ChatCompletionMessage[] = [];
  for (const entry of history) {
    if (entry.role === 'user') {
      out.push({
        role: 'user',
        content: openAIMessageContentToString(entry.content),
      });
      continue;
    }
    if (entry.role === 'assistant') {
      if ('tool_calls' in entry) {
        out.push({
          role: 'assistant',
          content:
            entry.content === null
              ? null
              : openAIMessageContentToString(entry.content),
          tool_calls: entry.tool_calls,
        });
        continue;
      }
      out.push({
        role: 'assistant',
        content: openAIMessageContentToString(entry.content),
      });
      continue;
    }
    const tool: ChatCompletionMessage = {
      role: 'tool',
      tool_call_id: entry.tool_call_id,
      content: entry.content,
    };
    if (entry.name) tool.name = entry.name;
    out.push(tool);
  }
  return out;
}

function openAIMessageContentToString(
  content: OpenAICompatMessageContent,
): string {
  if (typeof content === 'string') return content;
  const sections: string[] = [];
  for (const part of content) {
    if (part.type === 'text') {
      const text = (part as { text?: unknown }).text;
      if (typeof text === 'string' && text.length > 0) sections.push(text);
    }
  }
  return sections.join('\n\n');
}

export function buildMessages(
  meta: OpenAICompatMetadata | null,
  userContent: string | null,
): ChatCompletionMessage[] {
  const messages: ChatCompletionMessage[] = [];
  if (meta?.system) {
    messages.push({ role: 'system', content: meta.system });
  }
  if (meta?.chat_history) {
    for (const m of historyToChatCompletionMessages(meta.chat_history)) {
      messages.push(m);
    }
  }
  if (userContent !== null) {
    messages.push({ role: 'user', content: userContent });
  }
  return messages;
}

export function buildCallBody(
  meta: OpenAICompatMetadata | null,
  messages: ChatCompletionMessage[],
): VicoopCodexCallBody {
  const body: VicoopCodexCallBody = {
    messages,
    stream: true,
    // Always request usage in the terminal chunk — the openai-compat
    // extension's `usage` metadata depends on it.
    stream_options: { include_usage: true },
  };
  if (meta?.tools) body.tools = meta.tools;
  if (meta?.tool_choice !== undefined) body.tool_choice = meta.tool_choice;
  return body;
}

export function parseChatCompletionUsage(
  raw: ChatCompletionResponse['usage'],
  model: string | undefined,
): OpenAICompatUsage | null {
  if (!raw) return null;
  const prompt = typeof raw.prompt_tokens === 'number' ? raw.prompt_tokens : null;
  const completion =
    typeof raw.completion_tokens === 'number' ? raw.completion_tokens : null;
  if (prompt === null || completion === null) return null;
  const cached =
    typeof raw.prompt_tokens_details?.cached_tokens === 'number'
      ? raw.prompt_tokens_details.cached_tokens
      : undefined;
  const reasoning =
    typeof raw.completion_tokens_details?.reasoning_tokens === 'number'
      ? raw.completion_tokens_details.reasoning_tokens
      : undefined;
  return buildOpenAICompatUsage({
    prompt_tokens: prompt,
    completion_tokens: completion,
    cached_tokens: cached,
    reasoning_tokens: reasoning,
    model,
  });
}

export function buildResponseMetadata(
  response: ChatCompletionResponse,
  usage: OpenAICompatUsage | null,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  if (usage) payload.usage = usage;
  const echo: Record<string, unknown> = {};
  if (response.id) echo.id = response.id;
  if (response.object) echo.object = response.object;
  if (typeof response.created === 'number') echo.created = response.created;
  if (response.model) echo.model = response.model;
  if (Array.isArray(response.choices)) echo.choices = response.choices;
  if (response.usage) echo.usage = response.usage;
  if (Object.keys(echo).length > 0) payload.chat_completion = echo;
  return { [OPENAI_COMPAT_EXTENSION_URI]: payload };
}

// ─────────────────────────────────────────────────────────────────────────────
// SSE consumption + chunk → A2A artifact translation.
// ─────────────────────────────────────────────────────────────────────────────

interface AccumulatedToolCall {
  id?: string;
  name?: string;
  arguments: string;
}

// Walk a fetch ReadableStream of `text/event-stream` bytes and yield each
// event's `data:` payload as a string. Stops on stream end. Tolerates `\r\n`
// line endings and multi-line data fields (joined with `\n`).
async function* parseSseStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = findEventBoundary(buf)) >= 0) {
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx).replace(/^\r?\n\r?\n/, '');
      const data = extractDataField(raw);
      if (data !== null) yield data;
    }
  }
  buf += decoder.decode();
  if (buf.length > 0) {
    const data = extractDataField(buf);
    if (data !== null) yield data;
  }
}

function findEventBoundary(buf: string): number {
  const a = buf.indexOf('\n\n');
  const b = buf.indexOf('\r\n\r\n');
  if (a < 0) return b;
  if (b < 0) return a;
  return Math.min(a, b);
}

function extractDataField(raw: string): string | null {
  const lines = raw.split(/\r?\n/);
  const data: string[] = [];
  for (const line of lines) {
    if (line.length === 0) continue;
    if (line.charAt(0) === ':') continue;
    if (line.startsWith('data:')) {
      const v = line.slice(5);
      data.push(v.startsWith(' ') ? v.slice(1) : v);
    }
  }
  if (data.length === 0) return null;
  return data.join('\n');
}

function httpStatusToA2ACode(status: number): string {
  if (status === 401 || status === 403) return 'login_required';
  if (status === 429) return 'rate_limited';
  if (status >= 400) return `upstream_http_${status}`;
  return 'upstream_error';
}

// ─────────────────────────────────────────────────────────────────────────────
// Backend factory.
// ─────────────────────────────────────────────────────────────────────────────

export interface VicoopCodexBackendBundle {
  backend: Backend;
  // Bridge cli.ts unwraps this and calls it on shutdown so the long-running
  // `vicoop-codex serve` child gets reaped along with the daemon.
  shutdown: () => Promise<void>;
}

export function createVicoopCodexBackend(
  opts: VicoopCodexBackendOptions = {},
): VicoopCodexBackendBundle {
  const supervisorOpts: ServeSupervisorOptions = {
    command: opts.command,
    cwd: opts.cwd,
    extraArgs: opts.extraArgs,
    spawn: opts.spawn,
    stderrCaptureBytes: opts.stderrCaptureBytes,
    startupTimeoutMs: opts.startupTimeoutMs,
    logger: opts.logger ?? createLogger(),
  };
  const fetchImpl: typeof fetch = opts.fetchImpl ?? fetch;
  const logger = opts.logger ?? createLogger();
  const openaiCompatTrace = opts.openaiCompatTrace === true;

  let supervisor: ServeSupervisor | null = null;
  let initInFlight: Promise<ServeSupervisor> | null = null;

  async function ensureSupervisor(): Promise<ServeSupervisor> {
    if (supervisor && !supervisor.isClosed()) return supervisor;
    if (initInFlight) return initInFlight;
    initInFlight = (async () => {
      const s = new ServeSupervisor(supervisorOpts);
      try {
        s.start();
      } catch (err) {
        initInFlight = null;
        throw err;
      }
      void s.waitForClose().then(() => {
        if (supervisor === s) supervisor = null;
      });
      try {
        await s.ready();
      } catch (err) {
        initInFlight = null;
        throw err;
      }
      supervisor = s;
      initInFlight = null;
      return s;
    })();
    return initInFlight;
  }

  const backend: Backend = {
    name: 'vicoop-codex',

    async handle(task, emit, signal) {
      if (signal.aborted) {
        emit({
          type: 'task.complete',
          taskId: task.taskId,
          status: { state: 'canceled', timestamp: new Date().toISOString() },
        });
        return;
      }

      const openaiCompat = parseOpenAICompatMetadata(task.message.metadata);
      if (openaiCompatTrace) {
        dumpOpenAICompatTaskWire(
          'vicoop-codex',
          task.taskId,
          task.message.parts,
          task.message.metadata,
          openaiCompat,
        );
      }

      const userContent = flattenA2AUserContent(task.message.parts);
      const hasHistory = (openaiCompat?.chat_history?.length ?? 0) > 0;
      if (userContent === null && !hasHistory) {
        emit({
          type: 'task.fail',
          taskId: task.taskId,
          error: {
            code: 'empty_prompt',
            message:
              'vicoop-codex backend received no text or data content in the user message',
          },
        });
        return;
      }

      const messages = buildMessages(openaiCompat, userContent);
      const body = buildCallBody(openaiCompat, messages);
      let serialized: string;
      try {
        serialized = JSON.stringify(body);
      } catch (err) {
        emit({
          type: 'task.fail',
          taskId: task.taskId,
          error: {
            code: 'serialize_failed',
            message: `failed to serialize call body: ${errorMessage(err)}`,
          },
        });
        return;
      }

      emit({
        type: 'task.status',
        taskId: task.taskId,
        status: { state: 'working', timestamp: new Date().toISOString() },
      });

      let sv: ServeSupervisor;
      try {
        sv = await ensureSupervisor();
      } catch (err) {
        emit({
          type: 'task.fail',
          taskId: task.taskId,
          error: {
            code: 'cli_unavailable',
            message: `vicoop-codex serve failed to start: ${errorMessage(err)}`,
          },
        });
        return;
      }

      const listening = sv.getListening();
      if (!listening) {
        emit({
          type: 'task.fail',
          taskId: task.taskId,
          error: {
            code: 'cli_unavailable',
            message: 'vicoop-codex serve became ready without a listening port',
          },
        });
        return;
      }

      const controller = new AbortController();
      const onAbort = (): void => controller.abort();
      if (signal.aborted) controller.abort();
      else signal.addEventListener('abort', onAbort, { once: true });

      let res: Response;
      try {
        res = await fetchImpl(`${listening.url}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: serialized,
          signal: controller.signal,
        });
      } catch (err) {
        signal.removeEventListener('abort', onAbort);
        if (signal.aborted) {
          emit({
            type: 'task.complete',
            taskId: task.taskId,
            status: { state: 'canceled', timestamp: new Date().toISOString() },
          });
          return;
        }
        emit({
          type: 'task.fail',
          taskId: task.taskId,
          error: {
            code: 'cli_unavailable',
            message: `failed to reach vicoop-codex serve at ${listening.url}: ${errorMessage(err)}`,
          },
        });
        return;
      }

      if (!res.ok || !res.body) {
        signal.removeEventListener('abort', onAbort);
        let detail = '';
        try {
          detail = await res.text();
        } catch {
          // ignore
        }
        let message = detail || `vicoop-codex serve returned HTTP ${res.status}`;
        try {
          const parsed = JSON.parse(detail) as {
            error?: { message?: string };
            detail?: string;
          };
          message = parsed.error?.message ?? parsed.detail ?? message;
        } catch {
          // not JSON
        }
        emit({
          type: 'task.fail',
          taskId: task.taskId,
          error: { code: httpStatusToA2ACode(res.status), message },
        });
        return;
      }

      // Streaming state.
      let chatcmplId: string | undefined;
      let model: string | undefined;
      let created: number | undefined;
      let accumulatedText = '';
      const toolCallsByIndex = new Map<number, AccumulatedToolCall>();
      let finishReason: string | undefined;
      let usage: ChatCompletionResponse['usage'];
      let responseArtifactId: string | null = null;
      let emittedTextDelta = false;

      const emitTextDelta = (delta: string, lastChunk: boolean): void => {
        if (delta.length === 0 && !lastChunk) return;
        responseArtifactId ??= randomUUID();
        emit({
          type: 'task.artifact',
          taskId: task.taskId,
          artifact: {
            artifactId: responseArtifactId,
            name: 'vicoop-codex-message',
            parts: [{ kind: 'text', text: delta }],
          },
          ...(emittedTextDelta ? { append: true } : {}),
          lastChunk,
        });
        emittedTextDelta = true;
      };

      try {
        for await (const data of parseSseStream(res.body)) {
          if (data === '[DONE]') continue;
          let chunk: ChatCompletionStreamChunk;
          try {
            chunk = JSON.parse(data) as ChatCompletionStreamChunk;
          } catch {
            continue;
          }
          if (chunk.error) {
            throw new Error(chunk.error.message ?? 'vicoop-codex stream error');
          }
          if (typeof chunk.id === 'string') chatcmplId = chunk.id;
          if (typeof chunk.model === 'string') model = chunk.model;
          if (typeof chunk.created === 'number') created = chunk.created;
          if (chunk.usage) usage = chunk.usage;
          const choice = chunk.choices?.[0];
          if (!choice) continue;
          const delta = choice.delta;
          if (delta?.content && typeof delta.content === 'string') {
            accumulatedText += delta.content;
            emitTextDelta(delta.content, false);
          }
          if (Array.isArray(delta?.tool_calls)) {
            for (const tc of delta.tool_calls) {
              if (!tc || typeof tc.index !== 'number') continue;
              const slot = toolCallsByIndex.get(tc.index) ?? { arguments: '' };
              if (typeof tc.id === 'string' && tc.id.length > 0) slot.id = tc.id;
              if (tc.function) {
                if (
                  typeof tc.function.name === 'string' &&
                  tc.function.name.length > 0
                ) {
                  slot.name = tc.function.name;
                }
                if (typeof tc.function.arguments === 'string') {
                  slot.arguments += tc.function.arguments;
                }
              }
              toolCallsByIndex.set(tc.index, slot);
            }
          }
          if (typeof choice.finish_reason === 'string') {
            finishReason = choice.finish_reason;
          }
        }
      } catch (err) {
        signal.removeEventListener('abort', onAbort);
        if (signal.aborted) {
          emit({
            type: 'task.complete',
            taskId: task.taskId,
            status: { state: 'canceled', timestamp: new Date().toISOString() },
          });
          return;
        }
        emit({
          type: 'task.fail',
          taskId: task.taskId,
          error: {
            code: 'stream_error',
            message: `vicoop-codex stream failed: ${errorMessage(err)}`,
          },
        });
        return;
      }
      signal.removeEventListener('abort', onAbort);

      // Materialize a ChatCompletionResponse equivalent for buildResponseMetadata
      // so the openai-compat extension's `chat_completion` echo carries the
      // same fields callers see from the non-streaming path.
      const toolCalls = [...toolCallsByIndex.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, slot]) => ({
          id: slot.id ?? `call_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
          type: 'function' as const,
          function: { name: slot.name ?? '', arguments: slot.arguments },
        }));

      const messagePayload =
        toolCalls.length > 0
          ? {
              role: 'assistant',
              content: accumulatedText.length > 0 ? accumulatedText : null,
              tool_calls: toolCalls,
            }
          : { role: 'assistant', content: accumulatedText };

      const reconstructed: ChatCompletionResponse = {
        id: chatcmplId,
        object: 'chat.completion',
        created,
        model,
        choices: [
          {
            index: 0,
            message: messagePayload,
            finish_reason:
              finishReason ?? (toolCalls.length > 0 ? 'tool_calls' : 'stop'),
          },
        ],
        usage,
      };

      if (toolCalls.length > 0) {
        // Mirror the legacy backend: surface the tool_calls envelope as a
        // dedicated `data` artifact so the oai2a2a gateway can recover the
        // OpenAI wire shape. If we also streamed text earlier (rare but
        // possible — hybrid response), close the text artifact first.
        if (emittedTextDelta) emitTextDelta('', true);
        emit({
          type: 'task.artifact',
          taskId: task.taskId,
          artifact: {
            artifactId: randomUUID(),
            name: 'vicoop-codex-message',
            parts: [{ kind: 'data', data: { tool_calls: toolCalls } }],
            extensions: [OPENAI_COMPAT_EXTENSION_URI],
          },
          lastChunk: true,
        });
      } else if (emittedTextDelta) {
        // Terminal empty chunk so consumers know the text artifact is final.
        emitTextDelta('', true);
      } else if (accumulatedText.length > 0) {
        // No deltas observed (e.g. upstream concatenated everything in the
        // final chunk) — emit a single artifact.
        responseArtifactId ??= randomUUID();
        emit({
          type: 'task.artifact',
          taskId: task.taskId,
          artifact: {
            artifactId: responseArtifactId,
            name: 'vicoop-codex-message',
            parts: [{ kind: 'text', text: accumulatedText }],
          },
          lastChunk: true,
        });
      }

      const parsedUsage = parseChatCompletionUsage(
        reconstructed.usage,
        reconstructed.model,
      );
      const responseMetadata = buildResponseMetadata(reconstructed, parsedUsage);

      const finalParts: Part[] =
        toolCalls.length === 0 && accumulatedText.length > 0
          ? [{ kind: 'text', text: accumulatedText }]
          : [];
      emit({
        type: 'task.complete',
        taskId: task.taskId,
        status: {
          state: 'completed',
          timestamp: new Date().toISOString(),
          message: {
            role: 'agent',
            messageId: randomUUID(),
            parts: finalParts,
            metadata: responseMetadata,
            extensions: [OPENAI_COMPAT_EXTENSION_URI],
          },
        },
      });
    },
  };

  const shutdown = async (): Promise<void> => {
    const s = supervisor;
    if (!s) return;
    s.kill();
    try {
      await s.waitForClose();
    } catch {
      // best-effort
    }
    logger.info?.('[vicoop-codex] serve child reaped on shutdown');
  };

  return { backend, shutdown };
}

// Minimal projection of an OpenAI Chat Completions streaming chunk — only the
// fields this backend consumes. Tolerates unknown/missing fields rather than
// asserting a schema, so a future upstream version bump doesn't crash us.
interface ChatCompletionStreamChunk {
  id?: string;
  model?: string;
  created?: number;
  usage?: ChatCompletionResponse['usage'];
  error?: { message?: string };
  choices?: Array<{
    index?: number;
    delta?: {
      role?: string;
      content?: string | null;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
}
