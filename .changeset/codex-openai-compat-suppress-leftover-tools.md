---
'@vicoop-bridge/client': patch
---

Suppress remaining codex built-in tool leaks under openai-compat caller-side
dispatch so the model falls back to the `tool_calls` envelope instead of
chaining host-side scaffolding (issue #207).

Two seams:

- **`config.mcp_servers: {}` on `thread/start` / `thread/resume` for any
  openai-compat call** — empties the MCP server map at thread scope, which
  trips the `if params.mcp_tools.is_some()` gate in codex-rs `spec_plan.rs`
  and prevents `list_mcp_resources`, `list_mcp_resource_templates`, and
  `read_mcp_resource` from being pushed into the tool registry. In the
  observed #207 session the model burned three turns on
  `list_mcp_resources({server:"local"})` before bailing with text-only
  output. Gated to all openai-compat calls (not just caller-side dispatch)
  because MCP discovery never fits the LLM-endpoint mental model of an
  openai-compat caller, regardless of whether `tools` are supplied or
  `tool_choice` is `"none"`.

- **`CODEX_LEFTOVER_TOOL_DIRECTIVE` appended to `developerInstructions`** —
  `update_plan` and `request_user_input` are unconditional
  `executors.push(...)` entries in `spec_plan.rs` with no feature gate, so
  config-level disable is not possible. The directive names both tools
  explicitly and tells the model they are host scaffolding outside this
  task's tool surface — the only legitimate outputs are a `tool_calls`
  envelope or a natural-language reply. Gated to caller-side dispatch so
  non-openai-compat callers keep their normal codex affordances.

No change to the existing `environments: []` / `config.features.*=false`
suppression set or to non-openai-compat paths.
