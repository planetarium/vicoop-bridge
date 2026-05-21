---
'@vicoop-bridge/client': minor
---

Remove `--name` from `vicoop-client agent register`. The flag was a
display-only label with no authz, routing, or lookup logic tied to it
(admin UI does not render it; active-agent listings pull from the
runtime `AgentCard`, not the registration row). The CLI now sends the
operator-supplied `--agent-id` as `clientName` so the server's
`register_client()` NOT NULL contract on `agents.name` /
`clients.client_name` stays satisfied without a schema migration. The
redundant `name` line in the `agent register` stderr success block is
dropped for the same reason — it used to just echo the flag back.

Migration: drop `--name "$CLIENT_NAME"` from your `agent register`
invocation. The legacy `setup` alias still accepts `--client-name` for
back-compat (it's already deprecated and slated for removal).
