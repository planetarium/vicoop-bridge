---
'@vicoop-bridge/client': patch
---

Container distribution PR 2 of #244: interactive setup wizard + host-side
wrapper. The bridge client TypeScript surface is unchanged; this only
adds operator UX in the image and a new top-level shell script.

- `container/entrypoint.sh` — adds `wizard()`. Triggered when no config
  exists and stdin/stdout are both TTYs (i.e. `docker run -it`). Walks
  through `vicoop-client auth login` (Google OAuth device flow) →
  prompts for agent name / id / backend → `vicoop-client agent
  register` → backend install + per-backend OAuth (`claude auth login
  --claudeai` / `codex login`). The wizard exits on completion; it
  does *not* transition into daemon mode, so a follow-up `docker run
  -d ...` (or the new wrapper, below) starts the actual daemon. Env
  tokens (`CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`,
  `OPENAI_API_KEY`) detected at wizard time skip the corresponding
  per-backend OAuth step.

- `install-container.sh` — new top-level wrapper for the case-B path.
  Pulls the image, runs the wizard (`--rm -it`) when the data volume
  doesn't have a config yet, then stops + replaces any prior daemon
  container with a fresh `-d --restart unless-stopped` one. Volume /
  container / image names are overridable via env
  (`VICOOP_DATA_VOLUME`, `VICOOP_CONTAINER`, `VICOOP_IMAGE`,
  `VICOOP_WORK_VOLUME`). Re-runs are idempotent: existing setup is
  detected and the wizard is skipped.

- `docs/container.md` — restructured so the wizard / wrapper is the
  recommended first path. Headless / case-A docs preserved below.
