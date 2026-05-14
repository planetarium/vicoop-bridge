---
'@vicoop-bridge/client': minor
---

Add per-task timing milestones to codex and claude backends. Each task now
emits a single structured `[client] timing backend=… taskId=… contextId=…
mapMs=… spawnMs=… firstOutMs=… firstFinalMs=… closedMs=… emitMs=…
totalMs=… state=… code=…` line at the terminal emit, so operators can grep
per-phase distribution without running a profiler. The output goes through
the existing client logger; default level (`info`) shows it.
