---
"@vicoop-bridge/client": minor
---

Align with the **symmetric envelope contract** for the `openai-compat/v1` A2A extension (companion to planetarium/oai2a2a#80 / planetarium/oai2a2a#81).

**Wire-breaking** for advertising agents (client major bump expected once the project crosses 1.0; using minor under the 0.x convention).

Response side: codex (app-server), vicoop-codex (CLI), and claude backends now emit a spec-complete `chat_completion` envelope on the terminal A2A status message metadata: `id` / `object` / `created` / `model` / `choices[].{message, finish_reason, logprobs}` / `usage`. Tool calls surface exclusively via `chat_completion.choices[0].message.tool_calls`; the legacy data-part `tool_calls` artifact is no longer emitted from any of the three supported backends.

A new shared helper `packages/client/src/backends/openai-compat-usage.ts` (`buildOpenAICompatResponseMetadata`, `buildOpenAICompatUsage`) is the single source of truth so the supported backends cannot drift on envelope shape. Each backend synthesizes a stable `id` keyed off the A2A task id (`chatcmpl-codex-…`, `chatcmpl-vicoop-codex-…`, `chatcmpl-claude-…`).

For codex (app-server) specifically: tool-call-only turns (where codex's `thread/tokenUsage/updated` notification doesn't fire because the turn is interrupted) emit a `{0, 0, 0}` placeholder for `chat_completion.usage` rather than omit the field — the placeholder honestly signals "runtime did not report" while satisfying the new strict usage MUST on the gateway side.

Request side: `parseOpenAICompatMetadata` now reads `metadata[URI].chat_completions_request` (the envelope) and decomposes it into the existing 4-field `OpenAICompatMetadata` view that backends already consume. The 4 backends (claude / codex / vicoop-codex / openclaw) keep their existing parameter-reading code — the parser is the seam. Legacy decomposed shape (`{system, tools, tool_choice, chat_history}`) still accepted as a transitional compat shim during gateway migration.

`openclaw` backend is **not** updated to emit the response envelope — out of scope per the supported-backend set (`vicoop-codex` / `codex` / `claude`). openclaw can continue to emit data-part `tool_calls` but is no longer reachable through advertising-agent code paths on the new gateway.

Also includes a follow-up race fix: claude's post-exit trailing-flush handler now runs before the `settled = true` cleanup so an orphan terminal `result` event (no trailing newline) is not silently dropped. Previously, claude exiting 1 immediately after a multi-tool turn could trip a spurious `claude_exit_nonzero` failure even when claude reported `terminal_reason: "completed"` in stdout.
