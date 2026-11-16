---
"@vicoop-bridge/client": patch
---

Fix Codex agents on the default `read-only` sandbox answering "no execution environment is available" instead of calling the caller's tools on OpenAI-compatible requests that carry `tools`. The client now tells Codex that those tools run in the caller's environment and are not covered by the local sandbox; the sandbox mode itself is never changed. Caller tools whose name a Codex built-in hides (for example `apply_patch` or `exec_command` on Codex CLI 0.167.2) are now left out with a warning in the client log instead of being sent and never called; a request fails with `thread_start_failed` only when no usable tool remains or `tool_choice` names such a tool. Document how `--codex-sandbox` interacts with OpenAI-compatible requests: nothing to set for requests with caller tools, `workspace-write` for host-side write workflows.
