---
'@vicoop-bridge/client': patch
---

codex backend: recover real token usage on OpenAI-compatible tool-call
turns by deferring `turn/interrupt` until codex's
`thread/tokenUsage/updated` lands (#351). Previously the bridge
interrupted the turn the moment the model invoked a caller tool, which
raced ahead of codex app-server's token accounting — the accounting only
runs after the bridge answers the `item/tool/call` request, and an
interrupt in flight at that point drops the turn's usage everywhere (no
notification, no `turn/completed` payload, `info: null` even in codex's
own rollout record), so the router billed the request as
`total_tokens=0`. The interrupt is now held until the usage notification
for the turn arrives (measured at 15–40ms on codex 0.139, well ahead of
the ~500ms a next model iteration needs to start) with a 1s backstop
timer, configurable via `toolCallUsageWaitMs`. When codex still reports
nothing, the `{0,0,0}` placeholder remains, and the bridge now logs a
`tokenUsage unavailable` diagnostic so zero-usage records are
explainable without `--openai-compat-trace`.
