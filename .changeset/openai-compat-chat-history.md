---
'@vicoop-bridge/client': minor
---

Migrate the openai-compat A2A extension reader from `tool_call_history`
to `chat_history` (planetarium/oai2a2a#74). The new field carries every
prior conversation turn except the trailing user turn (which rides A2A
`parts` as before), so backends now replay the full multi-turn context
rather than just the tool round-trips. Plain prior user/assistant text
turns ride each backend's native conversation channel where one exists
(claude stream-json envelopes, vicoop-codex Chat Completions `messages[]`,
codex Responses API `message` items); openclaw folds them into its
single-channel `<chat_history>` block. Backends also tolerate the
spec's tool-continuation edge case where A2A `parts` is the placeholder
`[{ "text": "" }]` and the conversation lives entirely in `chat_history`.
