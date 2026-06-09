---
"@vicoop-bridge/client": patch
---

fix(vicoop-codex): send a `prompt_cache_key` so prompt caching engages across
turns. The `vicoop-codex` backend now attaches a stable key on each
`/v1/chat/completions` request, pinning a conversation's successive turns to one
ChatGPT-codex-backend cache shard so the upstream prompt cache actually hits
instead of scattering — previously a genuine multi-turn A2A conversation
recorded `cached_tokens: 0` on every follow-up turn. The key is resolved as: a
caller-supplied key off the inbound envelope (read from BOTH the OpenAI wire
name `prompt_cache_key` and the camelCase `promptCacheKey` that the Vercel AI
SDK / opencode emit, normalised to snake_case for the binary), else the
conversation's `task.contextId`. Requires a `vicoop-codex` build that forwards
`prompt_cache_key` upstream (vicoop-codex-cli#12, shipped in 0.3.2); older
builds ignore the field harmlessly.
