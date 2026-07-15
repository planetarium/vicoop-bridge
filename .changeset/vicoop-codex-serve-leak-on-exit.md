---
"@vicoop-bridge/client": patch
---

client daemon: reap the vicoop-codex `serve` child on every non-SIGKILL exit

The `vicoop-codex` host backend spawns a long-lived `vicoop-codex serve`
app-server whose only teardown is `backend.stop()`, reached via
`client.stop()`. But the daemon also exits WITHOUT running the SIGINT/SIGTERM
handler — on a fatal terminal WS close (`onFatal` → `process.exit(1)`), an
`uncaughtException`/`unhandledRejection`, or SIGHUP (previously unhandled) —
so `stop()` never fired and the serve child leaked as an orphan (reparented to
init, still LISTENing), accumulating one per restart.

Register SIGHUP through the graceful path, and add a `process.once('exit')`
last-resort that calls `client.stop()` synchronously — it runs on every
`process.exit()` path, so the child is reliably reaped on all non-SIGKILL
exits. (SIGKILL can't be trapped; vicoop-codex-cli's `serve` carries its own
parent-death watchdog for that case.)
