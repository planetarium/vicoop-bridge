---
"@vicoop-bridge/client": minor
---

Extend the [openai-compat/v1 A2A extension](https://github.com/planetarium/oai2a2a/extensions/openai-compat/v1) handling on the `claude` backend with multi-turn `tool_call_history` support (per the consensus on [planetarium/oai2a2a#30](https://github.com/planetarium/oai2a2a/issues/30)). When the metadata payload carries a `tool_call_history` array — an OpenAI-shaped record of prior `assistant.tool_calls` and `role:"tool"` returns — the bridge renders it as a `<tool_call_history>...</tool_call_history>` JSON block and prepends it to the user content sent to `claude`, so the model can pick up the conversation where it left off after the gateway executed a tool externally.

The bridge replays the history unconditionally on every turn (stateless-gateway contract): even when `--resume` brings the model's own prior turn into session memory, the wire history is the source of truth and gets injected. The SYSTEM_INSTRUCTION grows by one paragraph explaining the block format and pinning an anti-loop directive — the model must NOT repeat any call whose `tool_call_id` already appears in the history, otherwise tool turns chain forever. Whole-array validation: a malformed entry drops the entire history rather than leaving a hole, since `tool_call_id` pairings depend on order.
