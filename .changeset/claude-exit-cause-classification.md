---
'@vicoop-bridge/client': patch
---

fix(client): classify context overflows as `context_length_exceeded`
and guard the "not your usage limit" server throttle

A context-window overflow previously collapsed into an opaque generic code
(claude: `Prompt is too long` / `terminal_reason: blocking_limit` →
`claude_exit_nonzero`; codex: the relayed in-band "input exceeds the context
window" → `upstream_error`), so the gateway surfaced a generic 502 and the
router cooled the agent down and fanned out a doomed failover that could
empty the pool. Overflow is a non-retryable caller error: the shared
`normalizeTaskFailError` matcher now classifies it — for every backend —
as the canonical OpenAI `context_length_exceeded`, which the gateway maps
to `400` (oai2a2a#114) so OpenAI-compatible clients can compact-and-retry.
`context_length_exceeded` is also preserved verbatim through normalization.

Scope details:

- The overflow matcher uses provider-evidenced phrasings only (Anthropic,
  OpenAI, codex-relayed, Gemini) — no generic fragments like "context
  length" or "too many tokens", which would reclassify TPM rate limits or
  assistant prose quoted in crash diagnostics as caller errors.
- claude's `terminal_reason: "blocking_limit"` (an overflow signal that can
  arrive with no result text) is handled in `claude.ts` as a post-
  classification override: it tags `context_length_exceeded` only when the
  failure message classified nothing more specific, so explicit quota/rate
  text always wins over the bare enum token.
- `isQuotaExceeded`'s `usage limit` pattern is guarded against the explicit
  server-throttle disclaimer "Server is temporarily limiting requests (not
  your usage limit)", which now classifies as `rate_limited` (with or
  without the "· Rate limited" suffix).
