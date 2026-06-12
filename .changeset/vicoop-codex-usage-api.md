---
"@vicoop-bridge/client": minor
---

vicoop-codex backend: report per-account Codex usage to the bridge on request. The client answers the new `usage.request` frame by querying its local `vicoop-codex serve` `/usage` endpoint, which backs the server's admin/owner-only `GET /admin-api/agents/:id/usage` API.
