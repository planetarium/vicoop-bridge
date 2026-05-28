---
"@vicoop-bridge/client": minor
---

Migrate `vicoop-codex` / `codex` / `claude` backends to **envelope-direct** reads off `metadata[URI].chat_completions_request`, and forward `envelope.model` end-to-end (closes the per-backend half of #302).

Previously each backend ran through `parseOpenAICompatMetadata`'s decomposed `{system, tools, tool_choice, chat_history}` projection. Backends now read the inbound OpenAI Chat Completions request body directly via a new `parseOpenAICompatEnvelope` helper and consume `envelope.model` / `envelope.tools` / `envelope.tool_choice` / `envelope.messages[]` verbatim. The projection helpers (`collectSystemFromMessages`, `chatHistoryFromMessages`) are now exported so each backend does its own derivation off the envelope.

**Wire-level effect — model forwarding:** the gateway-resolved model id (planetarium/oai2a2a#80 `ResolvedAgent.modelOverride`) now flows end-to-end. Pool slug → resolved model id → backend dispatches to the right model:
- `vicoop-codex.ts`: adds `model: envelope.model` to the JSON body sent to `vicoop-codex call`.
- `codex.ts`: passes `envelope.model` as `thread/start.config.model` so codex dispatches per-thread instead of using `config.toml`'s pinned default.
- `claude.ts`: passes `--model <id>` on the claude CLI spawn.

Internal API changes (test surface only):
- `callerToolDispatchActive(meta)` → `callerToolDispatchActive(tools, toolChoice)`.
- `composeNativeDevInstructions(meta)` → `composeNativeDevInstructions(system, toolChoice)` (codex).
- `buildOpenAICompatNativeSystemPrompt(meta)` → `buildOpenAICompatNativeSystemPrompt(system, tools, toolChoice)` (claude).
- `dumpOpenAICompatTaskWire` no longer takes a parsed-view param; it derives the summary from metadata directly.

`openclaw` stays on `parseOpenAICompatMetadata`'s decomposed view — its envelope-direct migration plus the final parser/`OpenAICompatMetadata` shim deletion will land in a follow-up PR (issue #302 strategy step 3+4).
