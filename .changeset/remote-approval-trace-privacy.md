---
"@vicoop-bridge/client": patch
---

With remote tool approvals enabled (Claude `remote_approvals`, Codex `approval_decision: "remote"`), traceability artifacts and failure messages no longer include native tool arguments: Claude tool-call traces show only the tool name, subagent events omit the description, Codex command traces omit the command and its output, and Claude exit diagnostics (stdout/stderr tails) stay in the local log. The private approval request still carries the full arguments.
