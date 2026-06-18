---
'@vicoop-bridge/client': minor
---

feat(client): openai-compat/v1 reasoning channel (claude + vicoop-codex) +
shared liveness heartbeat (all backends).

**Reasoning channel.** The claude and vicoop-codex backends now forward the
model's reasoning on a dedicated openai-compat/v1 `reasoning` channel — a
separate artifact (`claude-reasoning` / `vicoop-codex-reasoning`) carrying
`metadata[openai-compat/v1] = { channel: "reasoning" }`, kept on a distinct
artifact id so reasoning never co-mingles with the answer. The claude side
surfaces `thinking_delta` stream events and injects a `MAX_THINKING_TOKENS`
budget on openai-compat spawns so Claude Code emits thinking on the wire
(budget defaults to 8000, configurable via `--claude-thinking-budget` /
`backends.claude.thinking_budget`); the vicoop-codex side surfaces
`delta.reasoning_content` chunks (already enabled serve-side via
`summary:"auto"`, no thinking-enablement injection needed). This lets the
a2x-internal-router treat a long silent reasoning turn as alive instead of
false-failing-over it (planetarium/a2x-internal-router#95, #375, #376).

Each reasoning channel is ON by default and individually disablable:
`--no-claude-reasoning` / `backends.claude.reasoning: false` and
`--no-vicoop-codex-reasoning` / `backends['vicoop-codex'].reasoning: false`.
**Disable the reasoning channel when the deployed oai2a2a codec predates
0.6.0** — an old codec doesn't understand the channel marker and would fold the
reasoning artifact into the answer (the #95 rollout-order hazard). Claude
redacted-thinking blocks are never forwarded.

**Liveness heartbeat.** Every backend's shared task loop (claude, codex,
openclaw, **and now vicoop-codex**) emits a tagged liveness heartbeat: the idle
`working` `task.status` beat now fires every 10s of silence (was a per-backend
30s beat) and carries `metadata[openai-compat/v1] = { heartbeat: true }`. The
bridge server maps this onto the A2A `TaskStatusUpdateEvent.metadata`, where the
oai2a2a codec (≥0.6.0) translates it to a `: a2a-heartbeat` SSE comment that
re-arms the router's first-content / stall watchdog. This keeps a backend that
is alive but byte-silent (long reasoning, tool runs) observably alive so it
isn't false-failed-over, while a backend that errors (`task.fail`) ends the loop
and stops heartbeating so failover still works
(planetarium/a2x-internal-router#95). The 10s cadence sits at or below half the
router's tightened 25–30s window; heartbeats carry no content and are safe to
emit unconditionally.
