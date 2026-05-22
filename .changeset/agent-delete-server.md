---
'@vicoop-bridge/server': major
---

Rename agent revocation to deletion and switch to hard delete (server side).

The previous `revoke_client()` flow set `revoked = TRUE` on the `agents`
and `clients` rows but kept them around for "audit history." Nothing
actually consumed the soft-deleted state — `ws.ts` filtered it out as
"not found," no message log or audit table referenced the rows, and
`unrevoke_client()` had zero callers. The soft-delete pattern added DB
weight and a misleading mental model with no payoff, so this PR removes
it.

**Schema (breaking)**

- Drops `revoked` column from `agents` and `clients`.
- Replaces `revoke_client(TEXT)` and `unrevoke_client(TEXT)` SQL
  functions with `delete_client(TEXT)` that hard-deletes both rows.
  `agent_policies` is cleaned up via `ON DELETE CASCADE`.
- `client_with_token` composite drops its `revoked` field (affects
  `register_client` / `rotate_client_token` GraphQL response shape).

**HTTP API (breaking response shape)**

- `DELETE /admin-api/clients/:target` now returns
  `{ client_id, client_name, deleted: true, closed_connections }` instead
  of `{ … revoked: true, … }`. The URL and method are unchanged.
- `GET /admin-api/clients` no longer includes a `revoked` field on each
  client.

**Migration**

- API consumers reading `revoked: true` from the DELETE response:
  switch to `deleted: true`. Consumers reading the `revoked` field on
  `GET /admin-api/clients` rows: remove that field — agents that exist
  are by definition active.
- Direct GraphQL callers of `mutate_revokeClient` /
  `mutate_unrevokeClient`: switch to `mutate_deleteClient(clientId)`.
  There is no replacement for unrevoke; re-register if you need the
  agent back.
