# @vicoop-bridge/client

## 0.12.0

### Minor Changes

- e84dc43: Consolidate client state under a canonical `config.json` (#137). `vicoop-client setup` now writes the daemon credentials to a single JSON config; its directory is resolved as `$VICOOP_HOME > (existing) ~/.vicoop > $XDG_CONFIG_HOME/vicoop > ~/.vicoop` — the existing-`~/.vicoop` branch preserves prior installs that already have an `owner-session.json` there, so setting `$XDG_CONFIG_HOME` later doesn't orphan them. The daemon resolves args as CLI flag > env > `--config <path>` > canonical config. `--write-env-file` stays as an opt-in for systemd `EnvironmentFile=`. Existing `SERVER_URL` / `SERVER_TOKEN` / `AGENT_ID` env vars and `owner-session.json` behaviour are unchanged.

  The daemon also prints the agent's `whoami` identity block (mention / acct / a2a endpoint / agent-card URL / WebFinger URL) on first connect, so operators don't have to run `vicoop-client whoami` in a second shell after startup.

  **Backend sandbox defaults flipped on**: the Claude backend now forwards `--settings '{"sandbox":{"enabled":true,"failIfUnavailable":true}}'` when neither `CLAUDE_SETTINGS_JSON` nor `backends.claude.settings` is set, and the Codex backend explicitly passes `-c sandbox_mode="read-only"` (the same effective default Codex CLI applied, now stamped into argv). Operators with sandbox-aware settings keep their override semantics — supplying any value replaces the default. To run without a sandbox, pass `{ "sandbox": { "enabled": false } }` to Claude or `CODEX_SANDBOX_MODE=danger-full-access` to Codex.

## 0.11.0

### Minor Changes

- 58de79c: Claude backend now forwards an operator-supplied Claude Code settings
  JSON to every spawned `claude -p` via `--settings <json>`. The new
  `CLAUDE_SETTINGS_JSON` env var (read by the daemon's `pickBackend`)
  accepts a top-level JSON object; it is parsed at startup, re-serialized
  with `JSON.stringify`, and forwarded as `--settings <json>` on every
  spawn (whitespace and key order may change but the semantic value is
  preserved). Primary use case is enabling the OS-level sandbox (Seatbelt
  on macOS, bubblewrap on Linux) in non-interactive mode, where the
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
  `npm`/`pnpm`) working while blocking SSH keys, cloud credentials,
  `.env` files, and DNS-shaped exfil tools (CVE-2025-55284 pattern):

  ```json
  {
    "sandbox": {
      "enabled": true,
      "failIfUnavailable": true,
      "allowUnsandboxedCommands": false,
      "filesystem": {
        "denyRead": ["~/.ssh", "~/.aws", "~/.gnupg", "~/.netrc"],
        "allowWrite": ["/tmp/vicoop", "~/.npm", "~/.cache/pnpm"]
      },
      "network": {
        "allowManagedDomainsOnly": true,
        "allowedDomains": [
          "github.com",
          "api.github.com",
          "codeload.github.com",
          "objects.githubusercontent.com",
          "uploads.github.com",
          "registry.npmjs.org"
        ]
      }
    },
    "permissions": {
      "deny": [
        "Read(~/.ssh/**)",
        "Read(~/.aws/**)",
        "Read(~/.netrc)",
        "Read(**/.env*)",
        "Bash(ping:*)",
        "Bash(nslookup:*)",
        "Bash(dig:*)",
        "Bash(host:*)",
        "Bash(curl:*)",
        "Bash(wget:*)",
        "Bash(nc:*)",
        "Bash(socat:*)"
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

  ### Non-obvious gotchas (verified empirically on Seatbelt + claude 2.1.139)

  - **`allowedDomains` must be nested under `sandbox.network`.** Placing
    it at `sandbox.allowedDomains` is silently ignored — every outbound
    request still gets a proxy 403. Easy to miss because no error fires.
  - **`npm`/`pnpm` need their cache dirs in `allowWrite`.** With only
    `/tmp/vicoop` allowed, even `npm view <pkg>` fails with EPERM at the
    cache-write step _after_ the registry fetch succeeds. Add `~/.npm`
    and/or `~/.cache/pnpm`.
  - **`gh` cannot read its macOS Keychain token under Seatbelt.**
    `gh auth status` fails regardless of network policy. If the agent
    needs `gh`, inject the token via `GH_TOKEN` env on the systemd unit
    (a fine-grained PAT scoped to the repos the agent actually touches)
    — matches Anthropic's recommended "credential-injecting proxy"
    pattern.

  ### Observability via OpenTelemetry

  `claude-code` is OTEL-native; the bridge daemon inherits its env
  verbatim. Setting `OTEL_EXPORTER_OTLP_ENDPOINT` plus
  `OTEL_LOG_TOOL_DETAILS=1`, `OTEL_LOG_TOOL_CONTENT=1`, and
  `OTEL_LOG_USER_PROMPTS=1` on the systemd unit (see install.sh env
  template) gives a queryable trace of every tool call, file read,
  and user prompt — usable as an audit trail since the agent cannot
  tamper with it once exported.

  Closes #138.

- f9f41e3: `vicoop-client setup --write-env-file` now emits `export KEY=VALUE`
  lines instead of bare `KEY=VALUE`. Sourcing the generated file with
  `. vicoop-client.env` followed by running `vicoop-client whoami` (or the
  daemon) used to fail with `missing required: agentId, server` because
  the assignments stayed shell-local and never reached the child
  process's environment. The `export` prefix makes the source-then-run
  idiom work without needing `set -a` wrappers. The stdout-only `setup`
  output (no `--write-env-file`) gains the prefix too, so piping it into
  a file behaves the same way. Fixes #134.

  systemd's `EnvironmentFile=` consumer is unaffected — the install-time
  template written by `install.sh` to `/etc/vicoop-client.env` (or the
  user-scope equivalent) is unchanged and still uses bare `KEY=VALUE`,
  matching what systemd actually parses.

  `vicoop-client login --write-env-file` (and its deprecated `--env-file`
  alias) is **removed**. In its default mode `login` saves the owner
  bearer to `~/.vicoop/owner-session.json`, and admin subcommands fall
  back to that file via `resolveOwnerSession` whenever the
  `VICOOP_OWNER_TOKEN` / `VICOOP_BRIDGE` env pair is unset — so the
  env-file output was structurally redundant. Scripts that need the raw
  access token without touching the session file can still use
  `vicoop-client login --json`, which prints the token-endpoint response
  to stdout and (intentionally) does not persist. Closes #136.

  The setup-written env file now single-quotes its values
  (`export KEY='value'`) so shell metacharacters in operator input —
  notably AGENT_ID, which the bridge echoes back verbatim — can't
  trigger expansion or command substitution when the file is sourced.

- 3f76593: Add a first-party Codex CLI backend with text/image input, session resume, trace artifacts, and canonical cards.

## 0.10.0

### Minor Changes

- f995db4: claude backend: inject self-identity via `--append-system-prompt` so the
  spawned `claude` recognises its own A2A mention (`@<agentId>@<host>` /
  `acct:<agentId>@<host>`) as a self-reference and responds directly instead
  of calling out to itself via a2a-wallet or any other outbound A2A skill.
  Addresses the failure mode in #128 where a backend Claude tried to a2a-call
  its own canonical address.

  New `vicoop-client whoami` subcommand prints the agent's mention, acct,
  A2A endpoint, A2A agent-card URL, and WebFinger URL — useful for operators
  registering this agent on other agents' allowed-caller lists, sharing the
  A2A endpoint with a caller, or pasting into the OpenClaw gateway persona
  (OpenClaw's `chat.send` has no per-message system field, so its persona is
  configured separately on the gateway). `--verify` actually performs the
  WebFinger lookup to confirm the bridge resolves the acct; `--json` emits a
  machine-readable record.

- a390f51: Switch release tag format from `client-v<version>` to the Changesets monorepo
  standard `@vicoop-bridge/client@<version>`. `install.sh`, `vicoop-client
upgrade`, and the release workflow now target the new format only; the prior
  `client-v*` releases remain on GitHub but are no longer extended. `--version`
  accepts a bare semver (`0.9.1`), `v0.9.1`, or the full new tag.

## 0.9.0

### Minor Changes

- Split owner login from client setup and add one-step setup support for creating client tokens, writing daemon env files, and optionally configuring allowed callers.
