import type { MerchantMeterableUsage } from '@a2x/sdk/x402';
import { OPENAI_COMPAT_EXTENSION_URI, type TaskUsage as WireTaskUsage } from '@vicoop-bridge/protocol';

// Token counts for one completed task, in the shape the SDK's `MerchantGate`
// meters.
//
// The canonical source is the protocol's own `TaskCompleteFrame.usage`, which
// the bridge owns end to end. The openai-compat metadata key is read only as a
// migration fallback: the same counts have long ridden there for that
// extension's consumers, and a client too old to send the frame field would
// otherwise become unpriceable — which bills the floor, silently, rather than
// failing. `source` says which one answered so the fallback is visible in the
// logs and can be retired once no old clients remain.
//
// A reported zero maps to detailed zero counts, which the SDK settles as a
// genuine `'0'` charge (basis `zero`) — agreed in a2x#206. Only a task with
// *no* usable report at all maps to `{ kind: 'unreported' }`, which under the
// bridge's `unreportedUsage: 'floor'` policy bills `minAmount`.

export type TaskUsageSource = 'protocol' | 'openai-compat';

export interface ReadTaskUsageResult {
  usage: MerchantMeterableUsage;
  source?: TaskUsageSource;
  /** The model the backend reported. Telemetry only — never priced on. */
  model?: string;
}

/** One source's counts, validated but not yet in the SDK's shape. */
interface ReportedCounts {
  prompt: number;
  completion: number;
  cached?: number;
  model?: string;
}

function count(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && Number.isInteger(v)
    ? v
    : undefined;
}

// Drop a cache figure larger than the prompt it claims to be a breakdown of —
// an incoherent value would otherwise discount tokens that were never cached.
// (The SDK would refuse to price it at all, which downgrades a merely broken
// cache count to the floor; charging the full input rate is the closer read.)
function build(
  prompt: number,
  completion: number,
  cached: number | undefined,
  model: string | undefined,
): ReportedCounts {
  const counts: ReportedCounts = { prompt, completion };
  if (cached !== undefined && cached <= prompt) counts.cached = cached;
  if (model !== undefined && model.length > 0) counts.model = model;
  return counts;
}

function fromProtocol(usage: WireTaskUsage | undefined): ReportedCounts | undefined {
  if (usage === undefined) return undefined;
  const prompt = count(usage.promptTokens);
  const completion = count(usage.completionTokens);
  if (prompt === undefined || completion === undefined) return undefined;
  return build(prompt, completion, count(usage.cachedInputTokens), usage.model);
}

function fromOpenAICompatPayload(raw: unknown): ReportedCounts | undefined {
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
function fromOpenAICompat(metadata: Record<string, unknown> | undefined): ReportedCounts | undefined {
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

function toMeterable(counts: ReportedCounts): MerchantMeterableUsage {
  return {
    kind: 'detailed',
    inputTokens: counts.prompt,
    outputTokens: counts.completion,
    ...(counts.cached !== undefined ? { cachedInputTokens: counts.cached } : {}),
  };
}

/**
 * Resolve the task's token usage, preferring the protocol field.
 *
 * `{ kind: 'unreported' }` means the runtime reported nothing, which the SDK
 * treats as "unpriceable" — under the bridge's `floor` policy that bills
 * `minAmount`, never the ceiling. A reported `{0,0}` is NOT unreported: it is
 * a trusted zero and settles `'0'` (a2x#206).
 */
export function readTaskUsage(
  reported: WireTaskUsage | undefined,
  metadata: Record<string, unknown> | undefined,
): ReadTaskUsageResult {
  const protocolCounts = fromProtocol(reported);
  if (protocolCounts) {
    return {
      usage: toMeterable(protocolCounts),
      source: 'protocol',
      ...(protocolCounts.model !== undefined ? { model: protocolCounts.model } : {}),
    };
  }

  const legacy = fromOpenAICompat(metadata);
  if (legacy) {
    return {
      usage: toMeterable(legacy),
      source: 'openai-compat',
      ...(legacy.model !== undefined ? { model: legacy.model } : {}),
    };
  }

  return { usage: { kind: 'unreported' } };
}
