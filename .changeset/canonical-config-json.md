---
"@vicoop-bridge/client": minor
---

Consolidate client state under `~/.vicoop/config.json` (#137). `vicoop-client setup` now writes the daemon credentials to a canonical JSON config (honoring `$VICOOP_HOME > $XDG_CONFIG_HOME/vicoop > ~/.vicoop`), and the daemon resolves args as CLI flag > env > `--config <path>` > canonical config. `--write-env-file` stays as an opt-in for systemd `EnvironmentFile=`. Existing `SERVER_URL` / `SERVER_TOKEN` / `AGENT_ID` env vars and `~/.vicoop/owner-session.json` behaviour are unchanged.

The daemon also prints the agent's `whoami` identity block (mention / acct / a2a endpoint / agent-card URL / WebFinger URL) on first connect, so operators don't have to run `vicoop-client whoami` in a second shell after startup.
