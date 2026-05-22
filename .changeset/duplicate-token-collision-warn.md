---
'@vicoop-bridge/client': minor
---

Recognize WebSocket close code 4009 (another daemon connected with the
same `CLIENT_TOKEN`, i.e. the bridge's clientId-level duplicate-token
collision) as a distinct failure mode: log a dedicated warn line naming
the cause and the remediation (`pgrep -fl vicoop-client`), and floor the
next reconnect at `collisionBackoffMs` (default 5 min) so a
duplicate-token ping-pong damps out within one cycle instead of looping
at the 30 s exponential-backoff cap forever. 4009 remains non-fatal — if
the other daemon goes away, this side still recovers on its own.
