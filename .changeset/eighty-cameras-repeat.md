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

The buffer is bounded by both frame count (`maxPendingFrames`, default 2000)
and encoded size (`maxPendingBytes`, default 4 MiB) — a count alone bounds
nothing, since the protocol puts no size limit on text, file or data parts.
Setting either to `0` disables buffering and restores the previous behavior.
