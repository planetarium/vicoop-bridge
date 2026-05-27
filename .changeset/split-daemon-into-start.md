---
'@vicoop-bridge/client': minor
---

Promote the daemon entrypoint to an explicit `vicoop-client start`
subcommand and stop treating bare invocation as "start the daemon".
Running `vicoop-client` with no arguments (or with `--help`) now prints
the top-level help and exits 0, where previous releases would open the
bridge WS. Replace any operator scripts / systemd units / docker
commands that ran `vicoop-client …` with `vicoop-client start …`; the
flag surface is unchanged. The bundled container entrypoint
(`container/bundled/entrypoint.sh`) already rewrites the historical
flags-only / no-args invocation to `vicoop-client start` before
exec'ing, so `docker run … <image>` keeps working unchanged.
