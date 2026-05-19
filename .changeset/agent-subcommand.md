---
'@vicoop-bridge/client': minor
---

Add `vicoop-client agent` command group as the operator-facing primary
surface for agent state (#218, follow-up to server-side unification in
#219).

New commands:

- `vicoop-client agent list [--connected]` — list agent registrations
  under this owner. Renders a whitespace-padded table with columns
  `AGENT_ID`, `NAME`, `CONNECTED`, `REVOKED`, `REGISTERED_AT`. The legacy
  `client_id` UUID is omitted from the human view (it remains in `--json`
  for backward-compat scripts). `--connected` filters to agents whose
  daemon is currently live; without it, every registration (including
  disconnected/revoked ones) is shown.
- `vicoop-client agent revoke AGENT_ID` — revoke an agent. The argument
  resolves against the agent id, the legacy registration id, or a unique
  registration name (same server-side resolver as the previous
  `revoke-client`).
- `vicoop-client agent callers {list,add,remove}` — manage an agent's
  allowed-callers list.

The older flat aliases (`list-agents`, `list-clients`, `revoke-client`,
`add-caller`, `remove-caller`, `list-callers`) keep working but now
print a one-line deprecation warning to stderr pointing at their
`agent <sub>` replacement. They will be removed in a future release.

The wire contracts are unchanged: `agent list` calls the same
`/admin-api/clients` endpoint (now backed by the unified `agents`
table from #219, which already returns `agent_id`), and
`agent revoke` calls the same `DELETE /admin-api/clients/<target>`.
No server-side changes ship in this changeset.
