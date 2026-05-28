---
"@vicoop-bridge/client": patch
---

Implement `envelope.model` forwarding for the three migrated backends (`vicoop-codex` / `codex` / `claude`) so the gateway-resolved model id (planetarium/oai2a2a#80 `ResolvedAgent.modelOverride`) reaches the underlying CLI instead of being silently dropped (#302). Pool slug → resolved model id → backend dispatches to the right model:

- `vicoop-codex`: adds `model` to the JSON body sent to `vicoop-codex call`. New `resolveCapabilities` probe (`vicoop-codex models --json`) advertises the supported ids on the agent card.
- `codex`: passes `envelope.model` as `thread/start.config.model` so codex dispatches per-thread instead of using `config.toml`'s pinned default.
- `claude`: passes `--model <id>` on the claude CLI spawn.

Each backend validates `envelope.model` against its advertised model list (codex's `model/list`, claude's `probeClaudeModel`, vicoop-codex's `models --json`) and silently falls back to the CLI default when the value is not in the list — defensive against gateways that forward unresolved routing keys (e.g. `a2a/<card-url>`) verbatim.

The backend-side migration also rewrites all three to read the envelope directly off `metadata[URI].chat_completions_request` instead of going through the legacy `OpenAICompatMetadata` decomposed view. Behaviour is unchanged for operators that aren't routing through an openai-compat gateway; the wire-shape change is invisible end-to-end.

`openclaw` stays on `parseOpenAICompatMetadata`'s decomposed view — its envelope-direct migration plus the final parser/`OpenAICompatMetadata` shim deletion will land in a follow-up PR (issue #302 strategy step 3+4).
