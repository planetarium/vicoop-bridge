---
"@vicoop-bridge/client": patch
---

fix(client): qualify caller-tool names in replayed chat_history under claude
native dispatch. Caller tools are exposed to claude as
`mcp___vb-caller-tools__<name>`, but the wire `chat_history` records prior
calls by their bare OpenAI name (e.g. `read`). Replaying the bare name
conditioned the model to re-emit it; claude then rejected the call with "No
such tool available: read", the call never reached the caller-tools MCP (so it
was never captured), the model retried, and the run died at `--max-turns 1`
with `terminal_reason:"max_turns"` surfaced as `claude_exit_nonzero`. The
replayed history names are now rewritten to the live MCP ids so the model's
historical view matches its tool list. As a diagnostic backstop, a "No such
tool available" tool error now adds a tool-name-mismatch hint to the terminal
failure message instead of a bare exit-1.
