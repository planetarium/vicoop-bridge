---
'@vicoop-bridge/client': minor
---

Fix the codex backend leaving an orphaned `codex app-server` subprocess
after the daemon exits (#186). The `Backend` interface gains an optional
`stop()` hook; `Client.stop()` invokes it before returning, and the codex
backend uses it to SIGTERM the long-lived `app-server` child that
otherwise outlived SIGINT/SIGTERM on the daemon.

Always-on service registration has been removed pending a redesign:
`install.sh` no longer writes a `vicoop-client.service` unit or env
template (the `INSTALL_SKIP_SERVICE` / `INSTALL_SERVICE_SCOPE` env vars
are gone), and `vicoop-client upgrade` no longer tries to
`systemctl try-restart` after swapping the bundle. Restart the daemon
manually with whatever supervisor you use until the new design lands.
`setup --write-env-file` is unchanged; it now describes itself as a
generic shell-sourceable env file rather than a systemd
`EnvironmentFile=`.
