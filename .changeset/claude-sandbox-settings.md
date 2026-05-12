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

### Two-layer hardening: sandbox is necessary but not sufficient

Empirically (Claude Code 2.1.139): `{"sandbox":{"enabled":true}}`
alone does **not** block reads outside the working directory — the
sandbox's default read policy is permissive, and the built-in
Read/Edit/Write tools bypass the OS sandbox entirely (only Bash
subprocesses are isolated). Operators that want real isolation need
two layers in the same `--settings` JSON:

1. `sandbox.filesystem.denyRead` / `allowRead` — blocks Bash
   subprocess reads (covers `gh`, `git`, `npm`, `kubectl`, etc.).
2. `permissions.deny` rules for `Read(...)` / `Edit(...)` — blocks
   Claude's own internal file tools.

A vetted starter profile that keeps common dev tooling (`gh`, `git`,
`npm`) working while blocking SSH keys, cloud credentials, `.env`
files, and DNS-shaped exfil tools (CVE-2025-55284 pattern):

```json
{
  "sandbox": {
    "enabled": true,
    "failIfUnavailable": true,
    "allowUnsandboxedCommands": false,
    "filesystem": {
      "denyRead": ["~/.ssh", "~/.aws", "~/.gnupg", "~/.netrc"],
      "allowWrite": ["/tmp/vicoop"]
    },
    "network": { "allowManagedDomainsOnly": true }
  },
  "permissions": {
    "deny": [
      "Read(~/.ssh/**)", "Read(~/.aws/**)", "Read(~/.netrc)",
      "Read(**/.env*)",
      "Bash(ping:*)", "Bash(nslookup:*)", "Bash(dig:*)",
      "Bash(host:*)", "Bash(curl:*)", "Bash(wget:*)",
      "Bash(nc:*)", "Bash(socat:*)"
    ]
  }
}
```

This is a starting point, not a guarantee — broader `network.allowedDomains`
opens domain-fronting paths the built-in proxy cannot inspect (the
proxy does not terminate TLS), and `allowUnsandboxedCommands:false`
is required to neutralise the documented `dangerouslyDisableSandbox`
escape hatch (the Ona writeup showed Claude self-disabling the
sandbox when caught).

### Observability via OpenTelemetry

`claude-code` is OTEL-native; the bridge daemon inherits its env
verbatim. Setting `OTEL_EXPORTER_OTLP_ENDPOINT` plus
`OTEL_LOG_TOOL_DETAILS=1`, `OTEL_LOG_TOOL_CONTENT=1`, and
`OTEL_LOG_USER_PROMPTS=1` on the systemd unit (see install.sh env
template) gives a queryable trace of every tool call, file read,
and user prompt — usable as an audit trail since the agent cannot
tamper with it once exported.

Closes #138.
