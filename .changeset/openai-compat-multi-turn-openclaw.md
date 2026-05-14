---
"@vicoop-bridge/client": minor
---

Extend the [openai-compat/v1 A2A extension](https://github.com/planetarium/oai2a2a/extensions/openai-compat/v1) handling on the `openclaw` backend with multi-turn `tool_call_history` support (per the [planetarium/oai2a2a#30](https://github.com/planetarium/oai2a2a/issues/30) consensus), mirroring the claude-side behaviour shipped in #152 and the codex-side behaviour shipped in #159. When the metadata payload carries a `tool_call_history` array, the bridge renders it as a `<tool_call_history>...</tool_call_history>` JSON block and inserts it between the `<system_instructions>` and `<user_message>` wrappers in `chat.send.message`, so the model reads the prior round before the current user turn.

The bridge replays the history unconditionally on every turn (stateless-gateway contract): even though `chat.send` against the same `sessionKey` resumes a session whose memory may already include the prior turn, the wire history is the source of truth. The shared anti-loop directive from `buildOpenAICompatSystemPrompt` keeps the model from re-emitting a call whose `tool_call_id` already appears in the history.
