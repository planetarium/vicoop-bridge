---
"@vicoop-bridge/client": patch
---

Fix Codex agents on the default `read-only` sandbox answering "no execution environment is available" instead of calling the caller's tools on OpenAI-compatible requests that carry `tools`. The client now tells Codex that those tools run in the caller's environment and are not covered by the local sandbox; the sandbox mode itself is never changed. Document how `--codex-sandbox` interacts with OpenAI-compatible requests: nothing to set for requests with caller tools, `workspace-write` for host-side write workflows.
