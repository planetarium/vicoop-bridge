---
"@vicoop-bridge/client": minor
---

Add opt-in Claude caller-isolated Docker execution with bounded transactional workspaces, direct-principal negotiation, cancellation cleanup, crash reconciliation, and offline state inspection/deletion. Requires an upgraded bridge server and a pinned backend image; existing host and single-container modes remain supported.

Preserve existing conversations when queued requests exceed the context limit, and let detached caller daemons finish their cleanup before `stop` escalates to SIGKILL.

Allow caller-isolated Claude to reuse the operator's host OAuth login through explicit `host-claude` credential provisioning, forwarding only the current access token per execution. Existing API-key-file configuration remains supported; token refresh remains operator-managed.
