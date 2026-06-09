---
"@vicoop-bridge/client": minor
---

Add short aliases for the two most-typed daemon flags: `-c` for `--config` and `-d` for `--detach` (e.g. `vicoop-client start -d -c ./config.json`). The detached child is now kept in the foreground daemon path by the `VICOOP_DETACHED` env guard rather than by argv stripping, so the re-exec stays correct even for optique's bundled short flags (`-dc value` parses as `-d -c value`).
