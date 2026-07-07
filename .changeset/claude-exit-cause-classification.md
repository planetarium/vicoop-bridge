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
`context_length_exceeded` is also preserved verbatim through normalization
so backends that tag it directly survive.

Two supporting fixes:

- `claude.ts` captures the run's last `terminal_reason` and passes it (plus
  the terminal result text) as a classification hint, so an overflow
  classifies even when the result text is absent — while the caller-facing
  message stays the verbatim reason (or the diagnostic dump on a real crash).
- `isQuotaExceeded`'s `usage limit` pattern is guarded so the explicit
  server-throttle disclaimer "Server is temporarily limiting requests (not
  your usage limit) · Rate limited" classifies as `rate_limited`, not quota
  exhaustion.
