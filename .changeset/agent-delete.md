---
'@vicoop-bridge/server': major
'@vicoop-bridge/client': major
---

Rename agent revocation to deletion and switch to hard delete.

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

**Client CLI (breaking)**

- `vicoop-client agent revoke <TARGET>` → `vicoop-client agent delete <TARGET>`.
  The new `delete` subcommand prompts `Delete agent "<TARGET>"? [y/N]`
  before calling the API; pass `--yes` / `-y` to skip (required for
  non-TTY usage like scripts and CI).
- The deprecated `vicoop-client revoke-client` flat alias now points at
  `agent delete` in its warning text. It still calls the same endpoint
  and skips the prompt (preserving script behavior).
- Daemon close-code 4014 reason text changes from `"client revoked"` to
  `"client deleted"`; the log line is now `client deleted by owner;
  stopping`. The behavior (exit non-zero, no reconnect) is unchanged.

**Migration**

- Operators using `vicoop-client agent revoke …` interactively: switch
  to `agent delete …` and confirm the prompt.
- Scripts using the same: switch to `agent delete --yes …`.
- API consumers reading `revoked: true` from the DELETE response:
  switch to `deleted: true`. Consumers reading the `revoked` field on
  `GET /admin-api/clients` rows: remove that field — agents that exist
  are by definition active.
- Direct GraphQL callers of `mutate_revokeClient` /
  `mutate_unrevokeClient`: switch to `mutate_deleteClient(clientId)`.
  There is no replacement for unrevoke; re-register if you need the
  agent back.
