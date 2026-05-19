---
'@vicoop-bridge/client': minor
---

claude backend: opt-in native MCP dispatch for openai-compat caller tools
(#213), the claude analog of codex's `dynamicTools` (#212).

When `createClaudeBackend({ nativeToolDispatch: true })` AND the caller
supplies openai-compat `tools`, the backend stands up a per-task
in-process MCP server (`caller-tools-mcp`) that exposes each tool as a
native MCP tool. claude sees them via `tools/list` and invokes them
through its normal `tool_use` surface — no JSON-text envelope contract,
no parser. When the model invokes one, the bridge:

- emits a `tool_calls` data artifact on the A2A task (byte-equivalent
  wire shape to the legacy envelope path — downstream gateways see no
  difference)
- returns a short structured-error ack to claude (`isError: true`) so
  the model treats the call as captured and stops, matching the
  system-prompt directive `buildOpenAICompatNativeSystemPrompt`
  installs
- suppresses any wrap-up text from `status.message.parts` on
  completion (same #200/#212 invariant: the `tool_calls` artifact is
  the complete output for this turn)
- passes `--max-turns 1` to the spawned `claude` so the model emits
  exactly one round of tool calls (parallel `tool_use` blocks in a
  single assistant message are allowed) and the bridge never pays for
  sentinel-driven chains across multiple model turns. Claude's
  resulting `exit code 1` is mapped to `task.complete state=completed`
  when a tool call was actually captured (matching codex backend's
  `interrupted → completed` mapping under #212); real startup
  failures with no capture still surface as `task.fail` as before.

The follow-up A2A turn carrying `tool_call_history` continues to flow
through the existing `formatToolCallHistory` text-prepend path. claude
has no native equivalent of codex's `thread/inject_items`, so the
history block remains the source of truth across resume turns.

Off by default — the envelope-text path (#208) stays the supported
route until operators flip `nativeToolDispatch: true` and validate
against their traffic shape. The two MCP servers (`vicoop-bridge` for
`send_file`, `caller-tools` for caller-supplied tools) coexist on the
same spawn under a single `--mcp-config` argv.
