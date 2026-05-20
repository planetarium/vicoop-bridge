---
'@vicoop-bridge/client': patch
---

claude backend: pre-approve registered MCP servers via `--allowedTools`
so the model's tool calls survive operator environments that leave
claude's permission system at its built-in default (#235).

claude's permission system runs even in `-p` (non-interactive) mode. With
the built-in `defaultMode: "default"` and no TTY there's nothing to
answer a permission prompt, so an MCP tool invocation auto-denies, the
model never reaches the bridge's `caller-tools-mcp` handler, and the run
dies at `--max-turns 1` with `permission_denials` in the result event —
the exact failure path in #235.

The fix is surgical: for every MCP server the bridge itself registers
(`caller-tools` for openai-compat caller tools, `vicoop-bridge` for
`send_file`), append a server-level `--allowedTools mcp__<server>` rule
to the spawn argv. Built-ins are already off via `--tools ""`, so this
allowlist only opens the surface we stood up — and operator settings
retain veto power because claude resolves `deny` rules before `allow`.

Behaviour without an active MCP server (plain claude tasks) is
unchanged: `--allowedTools` is only appended when `--mcp-config` is.
