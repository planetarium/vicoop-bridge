---
"@vicoop-bridge/client": minor
---

Implement the A2A [openai-compat/v1 extension](https://github.com/planetarium/oai2a2a/extensions/openai-compat/v1) on the `claude` backend. When an inbound `Message.metadata` carries the extension key, the client lifts `system` / `tools` / `tool_choice` out of the payload and folds them into a per-task `--append-system-prompt` that teaches the spawned `claude` to emit a `{"tool_calls":[{"id":"call_…","function":{"name":"…","arguments":{…}}}]}` envelope when it decides to call a function. Envelope replies are detected at every assistant turn and surfaced as an A2A `data` part artifact (`extensions: ["…/openai-compat/v1"]`) so the upstream OpenAI-compatible gateway can forward them verbatim as `tool_calls`; non-envelope turns continue to stream as text artifacts.

`tool_choice` is honored at the prompt level: `"auto"` adds a soft directive, `"required"` and `{type:"function", function:{name}}` mandate the envelope, and `"none"` suppresses the envelope contract entirely and instructs the model to answer in natural language. The `claude` agent card now advertises the extension URI under `capabilities.extensions[]`, so cooperating gateways can discover the capability from a card fetch. Tasks that do not carry the extension metadata key are unchanged — no system-prompt injection, no envelope detection.
