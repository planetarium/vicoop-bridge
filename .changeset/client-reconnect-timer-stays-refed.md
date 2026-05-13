---
"@vicoop-bridge/client": patch
---

Fix `vicoop-client` daemon exiting on the first WebSocket disconnect instead of reconnecting (#156). `scheduleReconnect()` previously called `.unref()` on the reconnect timer, which left the daemon process with no refed handles after the `close` handler cleared the heartbeat and reconnect-reset timers — Node would drain the event loop and exit before the first reconnect attempt fired, killing the entire exponential-backoff/jitter path. The other `.unref()` calls in the file are kept: the heartbeat and reconnect-reset timers only matter while the WS is open (the WS itself refs the loop then), and the probe-deadline timer is cleared on the fast path. `stop()` still cleans up the now-refed reconnect timer explicitly via `clearReconnectTimer()`, so intentional shutdown remains prompt.

Production daemons running under a supervisor (systemd `Restart=`, etc.) masked the bug behind automatic restarts; dev / sidecar daemons without a supervisor died on the first network blip.
