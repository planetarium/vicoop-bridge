import { OPENAI_COMPAT_EXTENSION_URI, type TaskUsage } from '@vicoop-bridge/protocol';

// Spec-compliant `usage` shape carried inside `chat_completion.usage`
// (envelope contract, oai2a2a#80). Required: prompt_tokens,
// completion_tokens, total_tokens. Optional fields (model,
// *_tokens_details) ride along when the underlying runtime exposes them.
// Sub-field semantics follow OpenAI: cached_tokens is a breakdown of
// prompt_tokens, reasoning_tokens is a breakdown of completion_tokens —
// never additive.
export interface OpenAICompatUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  model?: string;
  prompt_tokens_details?: { cached_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
}

export interface OpenAICompatUsageInput {
  prompt_tokens: number;
  completion_tokens: number;
  model?: string;
  cached_tokens?: number;
  reasoning_tokens?: number;
}

// Build a spec-compliant `OpenAICompatUsage` from a backend's native counts.
// total_tokens is computed here rather than taken from the caller so the
// `total === prompt + completion` invariant (MUST per spec) holds regardless
// of how the runtime reports it. Returns null if either required count is not
// a finite non-negative integer — better to omit `usage` than to forward a
// shape that breaks consumer accounting.
export function buildOpenAICompatUsage(input: OpenAICompatUsageInput): OpenAICompatUsage | null {
  if (!isCount(input.prompt_tokens) || !isCount(input.completion_tokens)) return null;
  const usage: OpenAICompatUsage = {
    prompt_tokens: input.prompt_tokens,
    completion_tokens: input.completion_tokens,
    total_tokens: input.prompt_tokens + input.completion_tokens,
  };
  if (typeof input.model === 'string' && input.model.length > 0) usage.model = input.model;
  if (isCount(input.cached_tokens)) {
    usage.prompt_tokens_details = { cached_tokens: input.cached_tokens };
  }
  if (isCount(input.reasoning_tokens)) {
    usage.completion_tokens_details = { reasoning_tokens: input.reasoning_tokens };
  }
  return usage;
}

// Build the `Message.metadata` payload to attach to the terminal A2A
// message under the openai-compat extension URI.
//
//   - When the request carried the openai-compat extension and the backend
//     synthesised a `chat_completion` envelope, return
//     `{ chat_completion: envelope }`. Per the envelope contract
//     (oai2a2a#80) usage lives inside `chat_completion.usage`; the codec
//     on the gateway reads it from there. No duplicate top-level sibling.
//
//   - When the request did NOT carry the openai-compat extension
//     (`envelope` is undefined) and the backend still has usage to report,
//     emit a bare `{ usage }` payload so plain A2A consumers — admin UI,
//     billing telemetry — that read the URI key still get token counts.
//     This is the only path that emits a top-level usage today; the
//     transitional sibling that used to ride alongside `chat_completion`
//     for v1-era codecs has been retired now that the codec is on the
//     envelope contract.
//
// Returns `undefined` when there's nothing to stamp.
//
// Spec: extensions/openai-compat/v1/README.md#response-metadata-payload-agent--gateway
export function buildOpenAICompatResponseMetadata(
  envelope: Record<string, unknown> | undefined,
  usage: OpenAICompatUsage | null,
): Record<string, unknown> | undefined {
  if (envelope) {
    return { [OPENAI_COMPAT_EXTENSION_URI]: { chat_completion: envelope } };
  }
  if (usage) {
    return { [OPENAI_COMPAT_EXTENSION_URI]: { usage } };
  }
  return undefined;
}

// Project the openai-compat usage onto the protocol's own `TaskUsage`, which
// rides as a first-class field on `task.complete`.
//
// Both carry the same counts, but they answer to different owners: the
// openai-compat payload exists for that extension's consumers, while the
// frame field is what the bridge bills on (the x402 `upto` scheme settles the
// metered charge from it). Deriving billing input from an unrelated
// extension's namespace would tie revenue to that extension's URI staying
// put — rename or version it and the counts silently read as "unreported",
// which bills the floor. So both are emitted, from this one conversion.
//
// Returns `undefined` when there is nothing to report, which the server must
// read as "the runtime did not report" rather than as zero.
export function toProtocolTaskUsage(usage: OpenAICompatUsage | null): TaskUsage | undefined {
  if (!usage) return undefined;
  const cached = usage.prompt_tokens_details?.cached_tokens;
  return {
    promptTokens: usage.prompt_tokens,
    completionTokens: usage.completion_tokens,
    ...(isCount(cached) ? { cachedInputTokens: cached } : {}),
    ...(usage.model !== undefined && usage.model.length > 0 ? { model: usage.model } : {}),
  };
}

function isCount(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 && Number.isInteger(n);
}
