---
'@vicoop-bridge/client': minor
---

Add `vicoop-client agent` command group as the operator-facing primary
surface for agent state (#218, #224, follow-up to server-side unification
in #219).

New commands:

- `vicoop-client agent register --name NAME --agent-id ID [--caller PRINCIPAL ...]`
  — register an agent and persist daemon credentials. Replaces the older
  `setup --client-name N --agent-ids ID1` shape with singular agent-first
  flags. The stderr success block surfaces `agent_id`, `name`, and
  `AGENT_TOKEN` (the operator-supplied id, not the server's registration
  UUID).
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

The older flat aliases (`setup`, `list-agents`, `list-clients`,
`revoke-client`, `add-caller`, `remove-caller`, `list-callers`) keep
working but now print a one-line deprecation warning to stderr pointing
at their `agent <sub>` replacement. The legacy commands also keep their
client-first vocabulary on stderr (`client_id`, `client_name`,
`CLIENT_TOKEN`) so scripts that parse stderr are unaffected. They will
be removed in a future release.

The wire contracts and `--json` payload shape are unchanged: `agent
register` calls the same `registerClient` GraphQL mutation as `setup`
and returns the same response fields (`client_id`, `client_token`,
`client_name`, `allowed_agent_ids`); `agent list` calls the same
`/admin-api/clients` endpoint (now backed by the unified `agents` table
from #219, which already returns `agent_id`); `agent revoke` calls the
same `DELETE /admin-api/clients/<target>`. No server-side changes ship
in this changeset.
