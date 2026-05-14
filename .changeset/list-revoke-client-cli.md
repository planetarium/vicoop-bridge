---
"@vicoop-bridge/client": minor
"@vicoop-bridge/server": minor
---

Add `vicoop-client list-clients` and `vicoop-client revoke-client` subcommands so an owner can inspect and clean up their own `clients` rows from the CLI without dropping into admin GraphQL or psql (issue #166).

**Client surface**

- `vicoop-client list-clients [--bridge URL] [--json]` lists every `clients` row owned by the operator. Output columns are `client_id`, `client_name`, `allowed_agent_ids`, `revoked`, `connected`, `created_at`. `connected` reflects in-memory registry state so orphans left behind by an aborted setup or an exited daemon show up with `connected: false`.
- `vicoop-client revoke-client <client-id-or-name> [--bridge URL]` resolves either a UUID `client_id` or a unique `client_name` and sets `revoked = true` on the row. An ambiguous name exits non-zero with a list of candidate ids so the operator can retry with the id.
- Both subcommands authenticate with the existing `vicoop-client login` owner-session bearer — same flow as `add-caller` / `remove-caller`.

**Server surface**

- `GET /admin-api/clients` and `DELETE /admin-api/clients/:target` under the same owner-session bearer guard as the existing `/admin-api/agents/*` routes. RLS filters list/delete to the operator's own rows; reads of another principal's rows return 404 (no existence leak), name-resolution ambiguity returns 409.
- `Registry.disconnectClient(clientId)` closes every live WebSocket bound to a revoked client with new close code **4012 "client revoked"**. (4010 was already taken by the agent-id-owned-by-different-principal path in `ws.ts`.)

**Daemon behavior**

- The client daemon's reconnect loop now branches on close code 4012: log `client revoked by owner; exiting`, abort inflight tasks, and exit non-zero without reconnecting. Without this branch the daemon would loop forever against a permanently-failing auth.

**Revocation propagation**

- Client-token verification in `ws.ts` queries `clients` directly on every WS register (no LRU cache, unlike the 60s `callers` cache documented in `local-testing.md`), so revocation is effectively synchronous from the next auth attempt — a daemon relaunched with the same token after revoke fails with close code 4005 "bad token". No cache-invalidation work needed on the server side.

**Schema**

- No schema migration. The existing `clients.revoked BOOLEAN` column and `revoke_client(TEXT)` PL/pgSQL function are reused as-is. Promoting the column to a `revoked_at TIMESTAMPTZ` for audit-trail purposes is filed as a follow-up — it's orthogonal to the CLI surface this change ships and would have a much larger blast radius (the `client_with_token` TYPE, the admin agent's LLM prompt, and all `SELECT … WHERE revoked = false` predicates would need touching).

Documentation: a new "Inspecting and revoking your clients" section in `docs/install-client.md` replaces the previous "use the admin agent's CRUD mutations" hand-wave for the cleanup case.
