---
"@vicoop-bridge/client": minor
---

Add `--openai-compat-history-cache` (claude backend, opt-in). Splits the
replayed `<chat_history>` into a cacheable frozen prefix plus a small tail so
stable conversation history reads from Anthropic's prompt cache instead of
re-billing at full price every turn. Off by default: it relies on claude's
stream-json input forwarding caller `cache_control` and shares the API's
4-breakpoint budget with claude's own system/tools markers, so validate
against the deployed claude version before enabling.
