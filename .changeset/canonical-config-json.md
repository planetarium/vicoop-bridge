---
"@vicoop-bridge/client": minor
---

Consolidate client state under a canonical `config.json` (#137). `vicoop-client setup` now writes the daemon credentials to a single JSON config; its directory is resolved as `$VICOOP_HOME > (existing) ~/.vicoop > $XDG_CONFIG_HOME/vicoop > ~/.vicoop` — the existing-`~/.vicoop` branch preserves prior installs that already have an `owner-session.json` there, so setting `$XDG_CONFIG_HOME` later doesn't orphan them. The daemon resolves args as CLI flag > env > `--config <path>` > canonical config. `--write-env-file` stays as an opt-in for systemd `EnvironmentFile=`. Existing `SERVER_URL` / `SERVER_TOKEN` / `AGENT_ID` env vars and `owner-session.json` behaviour are unchanged.

The daemon also prints the agent's `whoami` identity block (mention / acct / a2a endpoint / agent-card URL / WebFinger URL) on first connect, so operators don't have to run `vicoop-client whoami` in a second shell after startup.

**Backend sandbox defaults flipped on**: the Claude backend now forwards `--settings '{"sandbox":{"enabled":true,"failIfUnavailable":true}}'` when neither `CLAUDE_SETTINGS_JSON` nor `backends.claude.settings` is set, and the Codex backend explicitly passes `-c sandbox_mode="read-only"` (the same effective default Codex CLI applied, now stamped into argv). Operators with sandbox-aware settings keep their override semantics — supplying any value replaces the default. To run without a sandbox, pass `{ "sandbox": { "enabled": false } }` to Claude or `CODEX_SANDBOX_MODE=danger-full-access` to Codex.
