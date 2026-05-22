---
'@vicoop-bridge/client': patch
---

CLI help cleanup: drop the `--runtime` option from `container init` (it was a placeholder that only accepted `container` and exited with an error for `host`); name the `KIND` positional and list its valid values (`claude`, `codex`); remove the noisy config-precedence blurb from the help output (it leaked under every subcommand) — the same content lives in `docs/install-client.md`; on parse errors, scope the pre-error help to the partially parsed subcommand instead of dumping the full root usage.
