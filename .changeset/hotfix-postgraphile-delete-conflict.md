---
'@vicoop-bridge/server': patch
---

Hide PostGraphile auto-generated `deleteClient` / `deleteAgent` mutations.

The previous PR introduced `delete_client(TEXT)`, which PostGraphile
surfaces as a `deleteClient(input: …): DeleteClientPayload` mutation.
That collided with the auto-generated row-by-PK delete on the `clients`
table (same mutation name, same payload type name), producing a
`A type naming conflict has occurred — two entities have tried to define
the same type 'DeleteClientPayload'` build error in the server log on
startup. The server kept running (it's a recoverable schema-build error)
but the custom mutation was not callable via GraphQL.

Fix: extend the existing `@omit create` comments on `clients` and `agents`
to `@omit create,delete`, so the only delete path on either table is the
semantic `delete_client(TEXT)` SQL function. Bypassing the wrapper via
`deleteAgentById` would also leave an orphan `clients` row, so blocking
it here is the right behavior independent of the type conflict.
