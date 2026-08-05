import { OPENAI_COMPAT_EXTENSION_URI, type TaskUsage as WireTaskUsage } from '@vicoop-bridge/protocol';

// Token counts for one completed task, in the shape the pricing math wants.
//
// The canonical source is the protocol's own `TaskCompleteFrame.usage`, which
// the bridge owns end to end. The openai-compat metadata key is read only as a
// migration fallback: the same counts have long ridden there for that
// extension's consumers, and a client too old to send the frame field would
// otherwise become unpriceable — which bills the floor, silently, rather than
// failing. `source` says which one answered so the fallback is visible in the
// logs and can be retired once no old clients remain.
export interface TaskUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cached_tokens?: number;
  model?: string;
}

export type TaskUsageSource = 'protocol' | 'openai-compat';

export interface ReadTaskUsageResult {
  usage: TaskUsage | undefined;
  source?: TaskUsageSource;
}

function count(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && Number.isInteger(v)
    ? v
    : undefined;
}

// Recompute the total rather than trust a reported one, and drop a cache
// figure larger than the prompt it claims to be a breakdown of — an incoherent
// value would otherwise discount tokens that were never cached.
function build(
  prompt: number,
  completion: number,
  cached: number | undefined,
  model: string | undefined,
): TaskUsage {
  const usage: TaskUsage = {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
  };
  if (cached !== undefined && cached <= prompt) usage.cached_tokens = cached;
  if (model !== undefined && model.length > 0) usage.model = model;
  return usage;
}

function fromProtocol(usage: WireTaskUsage | undefined): TaskUsage | undefined {
  if (usage === undefined) return undefined;
  const prompt = count(usage.promptTokens);
  const completion = count(usage.completionTokens);
  if (prompt === undefined || completion === undefined) return undefined;
  return build(prompt, completion, count(usage.cachedInputTokens), usage.model);
}

function fromOpenAICompatPayload(raw: unknown): TaskUsage | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const u = raw as Record<string, unknown>;
  const prompt = count(u.prompt_tokens);
  const completion = count(u.completion_tokens);
  if (prompt === undefined || completion === undefined) return undefined;

  const details = u.prompt_tokens_details;
  const cached =
    typeof details === 'object' && details !== null
      ? count((details as Record<string, unknown>).cached_tokens)
      : undefined;
  return build(prompt, completion, cached, typeof u.model === 'string' ? u.model : undefined);
}

/**
 * The openai-compat extension publishes the counts in one of two shapes,
 * depending on whether the caller activated it. Both are read here.
 *
 *   { usage: {...} }                        plain A2A callers
 *   { chat_completion: { usage: {...} } }   openai-compat envelope
 */
function fromOpenAICompat(metadata: Record<string, unknown> | undefined): TaskUsage | undefined {
  const ext = metadata?.[OPENAI_COMPAT_EXTENSION_URI];
  if (typeof ext !== 'object' || ext === null) return undefined;
  const payload = ext as Record<string, unknown>;

  const direct = fromOpenAICompatPayload(payload.usage);
  if (direct) return direct;

  const envelope = payload.chat_completion;
  if (typeof envelope === 'object' && envelope !== null) {
    return fromOpenAICompatPayload((envelope as Record<string, unknown>).usage);
  }
  return undefined;
}

/**
 * Resolve the task's token usage, preferring the protocol field.
 *
 * A `usage` of `undefined` means the runtime reported nothing, which callers
 * must treat as "unpriceable" rather than "zero" — see `meterUsage`.
 */
export function readTaskUsage(
  reported: WireTaskUsage | undefined,
  metadata: Record<string, unknown> | undefined,
): ReadTaskUsageResult {
  const protocolUsage = fromProtocol(reported);
  if (protocolUsage) return { usage: protocolUsage, source: 'protocol' };

  const legacy = fromOpenAICompat(metadata);
  if (legacy) return { usage: legacy, source: 'openai-compat' };

  return { usage: undefined };
}
