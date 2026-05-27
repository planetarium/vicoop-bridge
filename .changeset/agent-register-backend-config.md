---
'@vicoop-bridge/client': minor
---

`vicoop-client agent register` now accepts the backend's core defaults
inline so a fresh install can be configured in a single command. Per the
chosen `--backend`:

- `claude`: `--cwd`, `--runtime`, `--runtime-name`, `--claude-settings-file`
- `codex`: `--cwd`, `--runtime`, `--runtime-name`, `--codex-sandbox`
- `openclaw`: `--openclaw-gateway`, `--openclaw-gateway-token`,
  `--openclaw-agent`, `--openclaw-openai-compat-agent`,
  `--openclaw-task-timeout-ms`

`--claude-settings-file` is read at register time and its parsed JSON is
embedded into `backends.claude.settings` so the persisted config.json is
self-contained. Mismatched pairings (e.g. `--codex-sandbox` with
`--backend claude`, or any backend-specific flag without `--backend`)
are rejected up front — before the GraphQL call — so the operator
never ends up holding a minted token that can't be persisted into a
coherent config. Only the active backend's slot in `backends.*` is
touched; other slots survive unmodified and within the active slot
unspecified fields are preserved.
