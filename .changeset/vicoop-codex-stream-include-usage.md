---
'@vicoop-bridge/client': patch
---

fix(client): force `stream_options.include_usage` on streamed vicoop-codex
calls so the terminal usage chunk is always emitted. Without it the runtime
could intermittently drop `usage` from the SSE stream, surfacing downstream
as a silently $0-billed 0-token call (#317).
