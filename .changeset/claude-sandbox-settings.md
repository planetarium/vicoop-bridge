---
'@vicoop-bridge/client': minor
---

Claude backend now forwards an operator-supplied Claude Code settings
JSON to every spawned `claude -p` via `--settings <json>`. The new
`CLAUDE_SETTINGS_JSON` env var (read by the daemon's `pickBackend`)
accepts a top-level JSON object that is serialized verbatim on the
argv — primary use case is enabling the OS-level sandbox (Seatbelt on
macOS, bubblewrap on Linux) in non-interactive mode, where the
`/sandbox` slash command is unavailable and on-disk `settings.json`
is awkward on systemd `DynamicUser=yes` hosts.

The backend does not validate or merge defaults: operators set the
shape they want. Malformed JSON or a non-object value fails loud at
startup (exit 1, named error on stderr) so a typo in a sandbox
profile surfaces before any task runs unsandboxed. The flag sits
between identity args and operator `extraArgs`, so an `extraArgs`-
supplied `--settings` would still win if both are set.

When the `send_file` MCP server is enabled, operators that turn on
`sandbox.network.allowManagedDomainsOnly` must allow the loopback
host themselves — the URL is chosen lazily per task, so the backend
does not rewrite the operator's JSON to inject it.

Closes #138.
