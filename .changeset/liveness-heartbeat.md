---
'@vicoop-bridge/client': minor
---

feat(client): emit a tagged liveness heartbeat from the shared backend task
loop. The idle `working` `task.status` beat (claude / codex / openclaw) now
fires every 10s of silence (was 30s) and carries
`metadata[openai-compat/v1] = { heartbeat: true }`. The bridge server maps this
onto the A2A `TaskStatusUpdateEvent.metadata`, where the oai2a2a codec (≥0.6.0)
translates it to a `: a2a-heartbeat` SSE comment that re-arms the
a2x-internal-router's first-content / stall watchdog. This keeps a backend that
is alive but byte-silent (long reasoning, tool runs) observably alive so it
isn't false-failed-over, while a backend that errors (e.g. quota-out →
`task.fail`) ends the loop and stops heartbeating so failover still works
(planetarium/a2x-internal-router#95). The 10s cadence sits at or below half the
router's tightened 25–30s window. Heartbeats carry no content and are safe to
emit unconditionally.
