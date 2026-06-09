---
"@vicoop-bridge/client": patch
---

fix(vicoop-codex): send a `prompt_cache_key` so prompt caching engages across
turns. The `vicoop-codex` backend now attaches the conversation's
`task.contextId` as `prompt_cache_key` on each `/v1/chat/completions` request
(a caller-supplied `prompt_cache_key` on the inbound envelope still wins). This
pins a conversation's successive turns to one ChatGPT-codex-backend cache shard,
so the upstream prompt cache actually hits instead of scattering — previously a
genuine multi-turn A2A conversation recorded `cached_tokens: 0` on every
follow-up turn. Requires a `vicoop-codex` build that forwards `prompt_cache_key`
upstream (vicoop-codex-cli#12); older builds ignore the field harmlessly.
