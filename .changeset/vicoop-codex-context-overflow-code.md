---
"@vicoop-bridge/client": patch
---

fix(vicoop-codex): tag context-window overflows with `context_length_exceeded`

When `vicoop-codex serve` relays an upstream "input exceeds the context window"
error, the bridge now tags the resulting `task.fail` with the standard
`context_length_exceeded` code instead of the generic `upstream_error`. The
codec passes this terminal code through verbatim into the OpenAI error
envelope, so OpenAI-SDK callers can recognise it as a context overflow (e.g.
non-streaming opencode classifies it via `parseAPICallError` and can
compact-and-retry) rather than treating it as an opaque upstream failure. Any
other in-band error stays `upstream_error`.
