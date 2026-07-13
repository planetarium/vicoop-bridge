---
"@vicoop-bridge/client": minor
---

Advertise per-model `contextWindow` / `maxOutputTokens` on the openai-compat/v1 `params.models[]` block so gateways can budget and display token limits. The codex backend reads its `model/list` `context_window`; the claude backend looks the limits up from the Anthropic Models API (`max_input_tokens` / `max_tokens`) using the host subscription OAuth token already read for `usage()`, and tier-corrects the window against the `[1m]` marker (the 1M ceiling only when the tier is advertised, else the 200k base). Best-effort and advisory — when the lookup is unavailable the advertise simply omits the hints.
