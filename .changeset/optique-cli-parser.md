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
  `wss://vicoop-bridge-server.fly.dev`). A fresh install on the public
  bridge no longer needs `--server` or `SERVER_URL`.
- **Typo'd flags are rejected** instead of silently ignored. The old
  parser passed unknown `--whatever` through, which masked real mistakes
  (a misspelled flag would fall all the way through every fallback to
  the wrong default with no signal).
- **Enum validation happens at parse time.** `--codex-sandbox banana`
  now reports the bad value at the parser layer with a list of accepted
  values, rather than exiting later from `parseCodexSandboxMode` in
  `cli.ts`.

Out of scope for this PoC and tracked separately: removing env vars from
the runtime config precedence chain (#189 §5), the `install.sh` systemd
unit rewrite (#189 §5 / AC#6), and the `docs/install-client.md` flag-first
rewrite (#189 §6 AC#8–10). Help text is preserved verbatim so existing
operator habits and test assertions keep working — moving to optique's
auto-generated, grouped `--help` output is a follow-up.
