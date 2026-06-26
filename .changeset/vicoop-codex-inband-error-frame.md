---
"@vicoop-bridge/client": patch
---

fix(vicoop-codex): surface in-band SSE error frames as task failures

`vicoop-codex serve` relays an upstream `/responses` error (e.g. "input
exceeds the context window") as a `{"error":{...}}` frame on an otherwise-200
SSE stream. The stream consumer only understood `choices`-bearing chunks, so
it silently dropped the error frame, accumulated nothing, and synthesized an
empty `finish_reason:"stop"` completion with no usage — the silent
"Response Generated" with an empty body (and a `$0`-billed turn).

Detect an in-band error frame and fail the task with `upstream_error`
carrying the upstream message, instead of completing empty.
