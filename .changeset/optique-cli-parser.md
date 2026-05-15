---
'@vicoop-bridge/client': minor
---

Migrate the `vicoop-client` argv parsers to [optique](https://github.com/dahlia/optique),
a type-safe parser-combinator library, as a PoC for #189. The hand-rolled
`for (let i = 0; i < args.length; i++)` loops that lived in `cli-args.ts`,
`login.ts`, `setup.ts`, `whoami.ts`, `admin-cli.ts`, and `cli.ts` (upgrade)
are gone — one optique grammar per subcommand replaces them.

The user-visible behavior changes that land with this:

- **`--flag=value` is accepted everywhere** (#189 §2). The old parser
  silently dropped `--backend=claude` and fell through to the `'echo'`
  default with no error; it now parses identically to `--backend claude`.
- **Every env-only backend knob now has a CLI flag** (#189 §1):
  `--claude-cwd`, `--claude-settings-file`, `--codex-cwd`,
  `--codex-sandbox`, `--openclaw-gateway`, `--openclaw-gateway-token`,
  `--openclaw-agent`, `--openclaw-openai-compat-agent`,
  `--openclaw-task-timeout-ms`. Flag wins over env wins over `backends.*`
  in `config.json`. The corresponding `CLAUDE_CWD` / `CODEX_SANDBOX_MODE` /
  `OPENCLAW_*` env vars are still honoured for systemd compatibility.
- **`--server` falls back to a built-in `DEFAULT_BRIDGE_URL`** (#189 §6,
  `wss://vicoop-bridge-server.fly.dev`); `--bridge` on `login` falls back
  to `DEFAULT_BRIDGE_HTTPS_URL` (`https://vicoop-bridge-server.fly.dev`).
  A fresh install on the public bridge no longer needs `--server` /
  `SERVER_URL` for the daemon or `--bridge` for `login`.
- **Typo'd flags are rejected** instead of silently ignored. The old
  parser passed unknown `--whatever` through, which masked real mistakes
  (a misspelled flag would fall all the way through every fallback to
  the wrong default with no signal).
- **Enum validation happens at parse time.** `--codex-sandbox banana`
  now reports the bad value at the parser layer with a list of accepted
  values, rather than exiting later from `parseCodexSandboxMode` in
  `cli.ts`.
- **Env vars are removed from the runtime config chain entirely**
  (#189 §5). The daemon no longer reads `SERVER_URL`, `SERVER_TOKEN`,
  `AGENT_ID`, `BACKEND`, `AGENT_CARD`, `CLAUDE_CWD`,
  `CLAUDE_SETTINGS_JSON`, `CODEX_CWD`, `CODEX_SANDBOX_MODE`,
  `OPENCLAW_GATEWAY_URL`, `OPENCLAW_GATEWAY_TOKEN`, `OPENCLAW_AGENT`,
  `OPENCLAW_OAI_COMPAT_AGENT`, `OPENCLAW_TASK_TIMEOUT_MS`,
  `OPENCLAW_THINKING`, `OPENCLAW_DEBUG`, or `OPENCLAW_PROCESS_NAME`.
  `vicoop-client whoami` no longer falls back to `AGENT_ID` /
  `SERVER_URL` env either — it reads the canonical `config.json`. The
  resulting precedence is **CLI flag > `--config <path>` > canonical
  config.json > built-in default**. Operators with env-only setups need
  to either run `setup` (persists credentials into `config.json`) or
  pass the equivalent CLI flags. Env vars the client still reads
  (different category — config *location*, not config *content*):
  `VICOOP_HOME`, `XDG_CONFIG_HOME`, `HOME` (config-dir resolution),
  `VICOOP_BRIDGE` / `VICOOP_OWNER_TOKEN` (admin-command owner-session
  bootstrap), `VICOOP_CLIENT_LOG_LEVEL` (logging diagnostic).
  `vicoop-client setup --write-env-file` still emits a shell-sourceable
  file at the path you pass (useful as a credentials audit / scripting
  hook), but the daemon will no longer consume those env vars on its
  own — point operators at `--config` or `config.json` instead.

`docs/install-client.md` is updated alongside the parser so the new
flag forms are the leading examples — Step 6 backend recipes are now
`vicoop-client --backend claude --claude-cwd …` instead of
`BACKEND=claude CLAUDE_CWD=…`, the OpenClaw / Claude / Codex sections
ship flag-keyed knob tables, and the public-bridge examples no longer
export `BRIDGE_URL`. Self-hosting overrides are collected in one place.

`vicoop-client --help` (and `help`) now prints **grouped daemon-mode
help** (#189 §3): Identity / Connection / Backend selection /
Backend-specific (Claude / Codex / OpenClaw), with a precedence-chain
footer. Error-path output keeps the short single-line `usage:` form so
test assertions on `/usage: vicoop-client/` continue to match.

The `install.sh` systemd unit rewrite (#189 AC#6) stays deferred to
**#190** — it depends on the supervisor strategy that #190 will decide
(Linux systemd vs macOS launchd, auto-install vs operator-installed,
etc.). #187 already removed the half-built systemd auto-registration;
reintroducing a Linux-only path here would conflict with that.
