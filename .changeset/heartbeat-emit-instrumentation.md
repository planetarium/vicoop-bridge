---
'@vicoop-bridge/client': patch
---

diag(client): count liveness heartbeats emitted per task and log the count on the
task lifecycle line (`heartbeats=N` on `task.complete` / `task.canceled` /
`task.fail`) — issue #414 hop-1 instrumentation.

The router intermittently trips its 300s stream-stall watchdog on a byte-silent
turn even though the 10s liveness heartbeat should keep it alive. Static analysis
found every hop individually correct, so this adds a cheap, always-on counter at
the point the client emits heartbeat `task.status` frames onto the wire. A
multi-minute task that logs `heartbeats=0` means the beats never fired/left the
client (hop 1); a healthy count (≈ elapsedMs / 10s) shifts suspicion downstream
(server forward / router re-arm). Counts only the tagged liveness beat
(`metadata[openai-compat/v1].heartbeat === true`), not ordinary working-status
frames. Logging-only; no behavior change.

Pairs with the server-side hop-2 counter (`heartbeatsForwarded` on the bridge's
`task_completed` / `task_failed_by_client` events) and the `task_store_slow_update`
latency probe, so a future stall can be localized to a specific hop.
