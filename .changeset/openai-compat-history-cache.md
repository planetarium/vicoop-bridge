---
"@vicoop-bridge/client": patch
---

Cache openai-compat `chat_history` on the claude backend (on by default).
Splits the replayed `<chat_history>` into a frozen prefix carrying a
`cache_control` breakpoint plus a small tail, so stable conversation history
reads from Anthropic's prompt cache instead of re-billing at full price every
turn. The split is byte-identical to the previous single block, so the model
reads the same history.

It relies on claude's stream-json input forwarding caller `cache_control`
(undocumented) and shares the API's 4-breakpoint budget with claude's own
system/tools markers. If claude ever rejects the breakpoint (e.g. a future CLI
build whose own markers exhaust the budget), a process-wide latch auto-disables
the split — that task fails, every later task falls back to the unsplit block,
and a daemon restart re-arms it. Hard-disable with
`VICOOP_DISABLE_OAI_HISTORY_CACHE=1`.
