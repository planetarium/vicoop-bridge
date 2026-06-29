---
"@vicoop-bridge/client": patch
---

fix(claude): classify claude's terminal reason into a structured failure code

When claude exits non-zero with zero usage it first emits a terminal `result`
event whose `result` field carries the human-readable cause — "You've hit your
session limit · resets 3pm (UTC)", "... · Rate limited", "529 Overloaded",
"Prompt is too long". The bridge captured this in `finalText` but dropped it,
so the only thing reaching the router was an opaque `claude exited with code 1
[stdout: <raw JSON tail>]`, forcing the router to scrape keywords out of a
truncated stdout dump.

Now that reason is used as the failure `message` verbatim (when present) and
run through `normalizeTaskFailError`, so it maps onto a structured terminal
code — `quota_exceeded` / `rate_limited` / `upstream_error` / `login_required`
/ … — which the router consumes directly via `reasonForTerminalCode` (it
prefers the code over message-pattern matching). The cause travels as
structured data in the `terminal_error.code` channel, not a string baked into
the diagnostic. When claude emits no such reason (a real crash) the message
falls back to the exit/stdout diagnostic dump so triage data is preserved
(#119).

Also teaches `normalizeTaskFailError` two claude-specific phrasings: the
subscription "session limit" cap → `quota_exceeded`, and server-side
"Overloaded" (with or without the `529`) → `upstream_error`.
