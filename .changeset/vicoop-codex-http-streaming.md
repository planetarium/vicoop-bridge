---
"@vicoop-bridge/client": minor
---

Replace the `vicoop-codex` backend's subprocess-per-task model with a long-running `vicoop-codex serve --port 0` child supervised on the bridge side. Each A2A task POSTs `/v1/chat/completions` with `stream: true` and emits token-level artifact deltas, plus a terminal `chat_completion` echo on `task.complete` for OpenAI-compat callers. Requires the `vicoop-codex` CLI release that ships `--port 0` support and the JSON listening banner (planetarium/vicoop-codex-cli#5).
