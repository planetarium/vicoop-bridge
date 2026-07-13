// Claude model-catalog lookup for the openai-compat/v1 `contextWindow` /
// `maxOutputTokens` advertise hints (planetarium/oai2a2a#63 additive revision).
//
// Source: authenticated GET https://api.anthropic.com/v1/models — the standard
// Models API. Each entry carries `max_input_tokens` (the model's context-window
// ceiling in tokens) and `max_tokens` (its single-completion output ceiling),
// which map to the spec's `contextWindow` / `maxOutputTokens`. It authenticates
// with the SAME subscription OAuth access token the `claude` CLI stores on the
// host — verified: the token returns 200 with the `oauth-2025-04-20` beta
// header the usage path already sends, so no separate ANTHROPIC_API_KEY is
// needed. Best-effort throughout: any failure yields an empty map and the
// advertise simply omits the hints (spec-valid — absence means "unspecified").
//
// NOTE: `max_input_tokens` is the model's *ceiling* (e.g. 1,000,000 for a
// 1M-capable model). The effective window is only that large when the 1M tier
// is active; the caller (claude.ts) tier-corrects against the advertised
// `[1m]` marker before emitting `contextWindow`. `max_tokens` is tier-agnostic.

import {
  readClaudeOAuthCreds,
  CLAUDE_CODE_UA_FALLBACK_VERSION,
  type ClaudeCredEnv,
} from './claude-usage.js';

export const CLAUDE_MODELS_URL = 'https://api.anthropic.com/v1/models';

// The catalog fetch runs at daemon startup on `resolveCapabilities`, ahead of
// the model probe and under the client's ~12s hello deadline (client.ts). A
// hung `api.anthropic.com` must NOT eat that budget — a slow catalog would else
// suppress the ENTIRE advertise (not just these hints) and push `hello` past
// the server's window. Bound it with an AbortSignal so a slow fetch degrades to
// "no hints" quickly instead. 4s leaves ample room under the deadline.
const CLAUDE_MODELS_FETCH_TIMEOUT_MS = 4_000;

export interface ClaudeModelLimits {
  // `max_input_tokens`: the model's context-window ceiling in tokens.
  maxInputTokens: number;
  // `max_tokens`: the model's single-completion output ceiling in tokens.
  maxTokens: number;
}

// Fetch the model catalog and index it by canonical model id (as `/v1/models`
// returns it, e.g. "claude-sonnet-4-5" — no `[1m]` tier suffix). `limit=1000`
// (the API max) pulls the whole small list in one page, so we don't paginate.
// Entries with a missing / non-positive / non-integer limit are skipped so a
// placeholder `0` (seen in the API docs' example) never reaches the advertise.
export async function fetchClaudeModelCatalog(
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
  userAgent?: string,
  timeoutMs: number = CLAUDE_MODELS_FETCH_TIMEOUT_MS,
): Promise<Map<string, ClaudeModelLimits>> {
  const out = new Map<string, ClaudeModelLimits>();
  try {
    const res = await fetchImpl(`${CLAUDE_MODELS_URL}?limit=1000`, {
      method: 'GET',
      // Time-bound the request so a hung endpoint can't stall daemon startup;
      // an abort surfaces as a rejection caught below → empty map (no hints).
      signal: AbortSignal.timeout(timeoutMs),
      // Header set mirrors the usage path (Authorization, anthropic-beta,
      // anthropic-version, User-Agent): the subscription OAuth token is
      // accepted here only when the request is shaped like the official client.
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
        accept: 'application/json',
        ...(userAgent ? { 'User-Agent': userAgent } : {}),
      },
    });
    if (!res.ok) return out;
    const json = (await res.json()) as { data?: unknown };
    const data = Array.isArray(json?.data) ? json.data : [];
    for (const raw of data) {
      if (!raw || typeof raw !== 'object') continue;
      const m = raw as {
        id?: unknown;
        max_input_tokens?: unknown;
        max_tokens?: unknown;
      };
      if (typeof m.id !== 'string' || m.id.length === 0) continue;
      const maxInputTokens = m.max_input_tokens;
      const maxTokens = m.max_tokens;
      if (
        typeof maxInputTokens !== 'number' ||
        !Number.isInteger(maxInputTokens) ||
        maxInputTokens <= 0 ||
        typeof maxTokens !== 'number' ||
        !Number.isInteger(maxTokens) ||
        maxTokens <= 0
      ) {
        continue;
      }
      out.set(m.id, { maxInputTokens, maxTokens });
    }
  } catch {
    // Network / parse failure → empty map; the advertise omits the hints.
  }
  return out;
}

// Production convenience wired from cli.ts: read the host OAuth creds and fetch
// the catalog, shaping the User-Agent like the official client. Returns an
// empty map (never throws) when no usable token is present or the fetch fails,
// so `resolveCapabilities` can call it unconditionally and simply skip
// enrichment on a miss.
export async function loadClaudeModelCatalog(opts?: {
  credEnv?: ClaudeCredEnv;
  fetchImpl?: typeof fetch;
}): Promise<Map<string, ClaudeModelLimits>> {
  const creds = readClaudeOAuthCreds(opts?.credEnv);
  if (!creds?.accessToken) return new Map();
  // Use a static `claude-code/<fallback>` User-Agent rather than discovering the
  // installed CLI version: version discovery is a synchronous `claude --version`
  // spawn (up to 10s) and this runs on the startup hello path, so paying a
  // subprocess for a cosmetic header would reintroduce the very latency the
  // fetch timeout guards against. /v1/models accepts the OAuth token without a
  // version-exact UA (verified), so a plausible static UA suffices.
  return fetchClaudeModelCatalog(
    creds.accessToken,
    opts?.fetchImpl ?? fetch,
    `claude-code/${CLAUDE_CODE_UA_FALLBACK_VERSION}`,
  );
}
