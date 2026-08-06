---
'@vicoop-bridge/client': minor
---

Manage an agent's x402 pricing from the CLI, and report per-task token usage
on the wire.

`vicoop-client agent x402 {show, set, clear}` sits alongside `agent callers`
and uses the same owner-session bearer, so pricing is managed from your
machine while staying server-side state — a stolen agent token cannot reprice
an agent or redirect its payments. `set` takes either field flags for the
common flat fee (`--amount`, `--asset`, `--pay-to`, `--network`) or
`--file <path|->` for a whole pricing object, which is how the metered `upto`
scheme with its per-MTok rate table is configured. The bridge validates the
body and rejects unrecognized keys, so a typo like `minamount` fails with a
400 naming the field instead of silently changing what the agent charges.
`show` flags the one configuration that quietly gives work away: a metered
agent with no floor set.

The claude, codex, and vicoop-codex backends now also report per-turn token
counts as `usage` on the `task.complete` frame. The same numbers already rode
under the openai-compat extension URI, and still do for that extension's
consumers — but a bridge that bills on consumption should not read its input
from an unrelated extension's namespace, where renaming or versioning it would
silently turn every charge into "unreported". Absent stays absent rather than
becoming a zero: when a runtime drops its accounting for a turn, the field is
omitted, which is what lets a consumer tell "reported nothing" from "reported
zero".
