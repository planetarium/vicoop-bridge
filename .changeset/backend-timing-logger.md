---
'@vicoop-bridge/client': minor
---

Add per-task timing milestones to codex and claude backends. Each task now
emits a single structured `[client] timing backend=… taskId=… contextId=…
mapMs=… spawnMs=… firstOutMs=… firstFinalMs=… closedMs=… emitMs=…
totalMs=… state=… code=…` line at the terminal emit, so operators can grep
per-phase distribution without running a profiler. Emitted at `debug` so
default `info` level is unchanged; set `VICOOP_CLIENT_LOG_LEVEL=debug` to
see it.
