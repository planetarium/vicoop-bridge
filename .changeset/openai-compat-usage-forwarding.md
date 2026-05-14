---
"@vicoop-bridge/client": minor
---

Forward authoritative token counts from the `codex` and `claude` backends as the A2A [openai-compat/v1 response-side `usage`](https://github.com/planetarium/oai2a2a/pull/35) payload, so OpenAI-compatible gateways can surface real numbers in `chat.completion.usage` instead of falling back to a local cl100k_base estimate.

Wiring:

- **codex**: parse `turn.completed.usage` (`input_tokens` / `cached_input_tokens` / `output_tokens` / `reasoning_output_tokens`) and map 1:1 to the spec — `cached_input_tokens` is already included in `input_tokens` (mirrored to `prompt_tokens_details.cached_tokens`); `reasoning_output_tokens` is a breakdown of `output_tokens`, not additive.
- **claude**: parse the terminal `result.modelUsage` map and sum across entries. Using top-level `result.usage` would silently underreport because Claude Code can route a single turn through internal sub-models (e.g. haiku for summarisation) whose tokens never appear on `result.usage` but do appear under `modelUsage`. `cacheReadInputTokens` is mirrored losslessly: included in `prompt_tokens` AND surfaced as `prompt_tokens_details.cached_tokens`.

When the underlying CLI omits usage (older codex versions, claude runs that never produced a `result` event), the agent emits no `usage` key and the gateway falls back to its local estimate — emission is best-effort per the spec.

The wire shape lives on `Task.status.message.metadata[<openai-compat/v1 URI>].usage` of the final A2A message of the turn, with `total_tokens = prompt_tokens + completion_tokens` computed locally so the MUST invariant holds regardless of what the runtime reports.
