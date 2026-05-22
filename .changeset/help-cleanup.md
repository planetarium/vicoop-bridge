---
'@vicoop-bridge/client': patch
---

CLI help cleanup: drop the `--runtime` option from `container init` (it was a placeholder that only accepted `container` and exited with an error for `host`); name the `KIND` positional and list its valid values (`claude`, `codex`); move the config-precedence note from the always-on footer to the top-level `--help` only, so it no longer prints under every subcommand; on parse errors, scope the pre-error help to the partially parsed subcommand instead of dumping the full root usage.
