---
'@vicoop-bridge/client': minor
---

codex backend: dispatch openai-compat caller tools natively via
`thread/start.dynamicTools` + `item/tool/call` server requests instead of the
PR #208 JSON-text envelope (#209).

When the openai-compat extension carries `tools`, the codex backend now
maps each tool to a `DynamicToolSpec` and registers it natively in the
model's tool registry. When the model invokes one, codex sends the client
an `item/tool/call` JSON-RPC server request and the bridge:

- emits a `tool_calls` data artifact on the A2A task (byte-equivalent wire
  shape to the legacy envelope path — callers see no difference)
- issues `turn/interrupt` so codex unwinds the turn
- surfaces the task as `completed` (not `canceled`), matching OpenAI Chat
  Completions' `finish_reason: "tool_calls"` semantics

The follow-up A2A turn carrying `tool_call_history` flows through the
existing `historyToInjectItems` path unchanged. `environments: []` and the
`config.features.*: false` wall are kept (they prevent codex from
satisfying the caller's request via built-in shell instead of routing
through the caller's tools).

Eliminates the failure modes the envelope text path exhibited under
batched / long tool calls: prose-prefixed envelopes, malformed JSON
across multiple calls, "step-2 narration without follow-through" where
the model declared a write and ended the turn.

claude / openclaw backends are unchanged — they continue to use the
envelope path, which remains the only option for backends without a
native function-call surface.
