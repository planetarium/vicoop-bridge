import { OPENAI_COMPAT_EXTENSION_URI } from '@vicoop-bridge/protocol';

// Shape we emit verbatim under
// `Message.metadata[OPENAI_COMPAT_EXTENSION_URI].usage` on the final A2A
// message of a turn, per
// https://github.com/planetarium/oai2a2a/extensions/openai-compat/v1
// (response metadata payload).
//
// Required: prompt_tokens, completion_tokens, total_tokens. Optional fields
// (model, *_tokens_details) ride along when the underlying runtime exposes
// them. Sub-field semantics follow OpenAI: cached_tokens is a breakdown of
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

// Convenience wrapper that produces the exact object backends spread onto
// `Message.metadata`. Centralising the URI key keeps the wire shape
// consistent across backends and avoids stringly-typed metadata keys at the
// call site.
export function makeOpenAICompatUsageMetadata(usage: OpenAICompatUsage): Record<string, unknown> {
  return { [OPENAI_COMPAT_EXTENSION_URI]: { usage } };
}

// Build the `Message.metadata` payload to attach to the terminal A2A
// message under the openai-compat extension URI. Bundles the
// `chat_completion` envelope (envelope contract per oai2a2a#80 — the
// codec on the gateway unwraps this verbatim) with a transitional
// top-level `usage` sibling for back-compat with codecs that read it as a
// fallback when the envelope lacks `usage`.
//
// Both backends (codex.ts, vicoop-codex.ts) emit the same metadata shape;
// this helper exists so the wire stays consistent and neither backend
// silently drifts. Returns `undefined` when neither field has content so
// callers don't stamp an empty extension block onto the message.
//
// Spec: extensions/openai-compat/v1/README.md#response-metadata-payload-agent--gateway
export function buildOpenAICompatResponseMetadata(
  envelope: Record<string, unknown> | undefined,
  usage: OpenAICompatUsage | null,
): Record<string, unknown> | undefined {
  if (!envelope && !usage) return undefined;
  const payload: Record<string, unknown> = {};
  if (usage) payload.usage = usage;
  if (envelope) payload.chat_completion = envelope;
  return { [OPENAI_COMPAT_EXTENSION_URI]: payload };
}

function isCount(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 && Number.isInteger(n);
}
