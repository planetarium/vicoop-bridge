---
'@vicoop-bridge/client': minor
---

feat(client): multi-model support on the claude backend via `--claude-models`

Claude Code has no headless "list models" interface, so the claude backend
used to advertise — and accept per-request openai-compat `model` overrides
for — only a single model (the `--claude-model` pin or the startup-probed
default). Operators can now declare additional models their install can
serve with `--claude-models claude-sonnet-4-6,claude-haiku-4-5`
(comma-separated) or `backends.claude.models` in `config.json`. Declared ids
are advertised on the openai-compat `params.models[]` block after the
default, and a matching per-request `model` rides to the spawned `claude` as
`--model <id>`. The `envelope.model` gate now also matches on the normalized
(tier-suffix-stripped) form, so a caller selecting e.g.
`claude-opus-4-8[1m]` against an advertised `claude-opus-4-8` passes through
with the tier selection intact.
