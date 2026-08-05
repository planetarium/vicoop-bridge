import { OPENAI_COMPAT_EXTENSION_URI } from '@vicoop-bridge/protocol';

// Token counts for one completed task, read off the terminal status message.
//
// No protocol change was needed to get these: the claude, codex, and
// vicoop-codex backends already stamp per-turn usage onto the `task.complete`
// frame, and `wireMessageToA2X` carries the metadata through untouched. This
// module is just the reader.
export interface TaskUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cached_tokens?: number;
  model?: string;
}

function count(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && Number.isInteger(v)
    ? v
    : undefined;
}

function readUsageObject(raw: unknown): TaskUsage | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const u = raw as Record<string, unknown>;

  const prompt = count(u.prompt_tokens);
  const completion = count(u.completion_tokens);
  if (prompt === undefined || completion === undefined) return undefined;

  // Recompute rather than trust the reported total: the invariant
  // `total === prompt + completion` is what the price is derived from, and a
  // backend that got it wrong should not be able to move the charge.
  const usage: TaskUsage = {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
  };

  const details = u.prompt_tokens_details;
  if (typeof details === 'object' && details !== null) {
    const cached = count((details as Record<string, unknown>).cached_tokens);
    // A cache figure larger than the prompt it is a breakdown of is
    // incoherent; dropping it prices the whole prompt at the full rate,
    // which errs toward not silently discounting on bad data.
    if (cached !== undefined && cached <= prompt) usage.cached_tokens = cached;
  }
  if (typeof u.model === 'string' && u.model.length > 0) usage.model = u.model;

  return usage;
}

/**
 * Extract token usage from a terminal status message's metadata.
 *
 * The backends publish it under the openai-compat extension URI in one of two
 * shapes, depending on whether the caller activated that extension:
 *
 *   { usage: {...} }                        — plain A2A callers
 *   { chat_completion: { usage: {...} } }   — openai-compat envelope
 *
 * Both are read here. Returns `undefined` when nothing usable is present,
 * which callers must treat as "the runtime did not report" rather than
 * "zero" — see `meterUsage`.
 */
export function readTaskUsage(metadata: Record<string, unknown> | undefined): TaskUsage | undefined {
  const ext = metadata?.[OPENAI_COMPAT_EXTENSION_URI];
  if (typeof ext !== 'object' || ext === null) return undefined;
  const payload = ext as Record<string, unknown>;

  const direct = readUsageObject(payload.usage);
  if (direct) return direct;

  const envelope = payload.chat_completion;
  if (typeof envelope === 'object' && envelope !== null) {
    return readUsageObject((envelope as Record<string, unknown>).usage);
  }
  return undefined;
}
