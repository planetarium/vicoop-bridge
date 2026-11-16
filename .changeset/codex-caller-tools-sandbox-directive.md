---
"@vicoop-bridge/client": patch
---

Fix Codex agents on the default `read-only` sandbox answering "no execution environment is available" instead of calling the caller's tools on OpenAI-compatible requests that carry `tools`. The client now tells Codex that calls to the request's function tools are handed back to the caller to run and that the local sandbox mode describes this machine only; the sandbox mode itself is never changed and no restriction on Codex's own or MCP tools is lifted. Caller tools whose name a Codex built-in takes (for example `apply_patch` or `exec_command` on Codex CLI 0.167.2) are now left out with a warning in the client log instead of being sent and never called; a request fails with `thread_start_failed` only when no usable tool remains or `tool_choice` names such a name. Document how `--codex-sandbox` interacts with OpenAI-compatible requests: nothing to set for requests with caller tools, `workspace-write` for host-side write workflows.
