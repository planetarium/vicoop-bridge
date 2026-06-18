---
'@vicoop-bridge/client': minor
---

feat(client): forward vicoop-codex's reasoning summary on an openai-compat/v1
`reasoning` channel. The vicoop-codex backend surfaces `delta.reasoning_content`
stream chunks (emitted serve-side via `summary:"auto"`) as a dedicated
`vicoop-codex-reasoning` artifact carrying
`metadata[openai-compat/v1] = { channel: "reasoning" }`, kept on a distinct
artifact id so reasoning never co-mingles with the answer. This lets the
a2x-internal-router treat a long silent reasoning turn as alive instead of
false-failing-over it (planetarium/a2x-internal-router#95, #375). ON by default;
disable with `--no-vicoop-codex-reasoning` or
`backends.vicoop-codex.reasoning: false` when the deployed oai2a2a codec predates
0.6.0 and can't yet interpret the channel marker (otherwise the reasoning would
fold into the answer). Unlike the claude backend there is no thinking-enablement
injection — codex reasoning is already enabled serve-side.

The liveness heartbeat half of #375 is intentionally deferred: tagging the
`working` status with `metadata = { heartbeat: true }` needs a `metadata` field
on `TaskStatus` (protocol) + the server's A2A `TaskStatusUpdateEvent.metadata`
mapping — a cross-package change that lands with the shared-loop heartbeat
follow-up.
