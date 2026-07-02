---
'@vicoop-bridge/client': patch
---

Canonicalize `rate_limited` failure messages so post-content OpenAI-compatible
clients auto-retry.

Once a stream has committed content, a downstream OpenAI-compatible client
(e.g. opencode) can no longer see the machine `code` — `@ai-sdk/openai-compatible`
collapses an in-band `{error:{...}}` chunk to just its message string — so its
retry heuristic classifies on the message text alone. That heuristic keys on the
literal phrases "rate limit" / "too many requests", but `normalizeTaskFailError`
classifies rate limits more broadly (a bare `429`, `rate-limited` with a hyphen,
or `rate_limit` with an underscore). A genuine rate limit whose upstream text
lacked the exact phrase therefore would not trigger the client's auto-retry.

`normalizeTaskFailError` now prefixes such messages with `rate limit:` when the
final code is `rate_limited` and the phrase is absent. This is an honest
translation, not a failure-mode change — the branch is only reached for errors
already classified as rate limits — and the original upstream detail is preserved
after the prefix. Messages that already carry the phrase are left untouched.
