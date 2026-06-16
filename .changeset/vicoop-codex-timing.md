---
"@vicoop-bridge/client": patch
---

vicoop-codex backend: emit a per-task `timing` breadcrumb (debug-gated) that
stamps serveReady / firstByte / firstDelta / total milestones, so operators
can split model-wait from streaming time on a slow turn. Opt in with
`VICOOP_CLIENT_LOG_LEVEL=debug`; no new output at the default `info` level.
