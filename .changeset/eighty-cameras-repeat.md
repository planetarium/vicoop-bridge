---
'@vicoop-bridge/client': patch
---

Buffer task frames produced while the bridge connection is down and replay them
on reconnect, instead of dropping them on the floor.

`send()` silently discarded any frame written while the socket was not OPEN. A
backend that kept working through a reconnect therefore lost whatever it emitted
during the outage: streamed deltas vanished mid-answer while the backend's own
bookkeeping advanced past them, so the end-of-turn catch-up never re-sent them
and the task completed with a hole. A backend that *finished* during the outage
lost its terminal frame outright and never re-emitted it, so a fully successful
task was reported as failed.

Frames are now held in arrival order and replayed on the next connection, where
the server's reconnect grace hold (vicoop-bridge#474) is keeping the task alive
to receive them. A task that loses frames to the buffer cap fails explicitly
with `client_buffer_overflow` rather than replaying a partial stream — an honest
failure the caller can retry beats a silently truncated answer.

The buffer is bounded by frame count (`maxPendingFrames`, default 2000),
encoded size (`maxPendingBytes`, default 4 MiB) and outage duration
(`maxPendingAgeMs`, default 25s). The last one matters for correctness, not just
memory: a taskId is reusable across A2A turns, so replaying output the bridge
would no longer honour could inject a dead run's frames into a live one. It is
measured from the disconnect and must stay at or below the bridge's
`BRIDGE_DISCONNECT_GRACE_MS`. Setting any of them to `0` disables buffering and
restores the previous behavior.

Requires a bridge with reconnect replay support. Against an older bridge the
replay is rejected (close 4003); the client detects this, logs a warning naming
the bridge upgrade as the fix, and falls back to the previous behavior instead
of reconnecting in a loop.
