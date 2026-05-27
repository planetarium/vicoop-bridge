---
'@vicoop-bridge/client': minor
---

Advertise the underlying model(s) on the `openai-compat/v1` AgentExtension's
`params.models` slot for the `claude` and `codex` backends, per
planetarium/oai2a2a#63. The advertise lands on the hello card so A2A callers
can route by declared model without waiting for the first task.

- `claude`: a SIGTERM'd probe spawns `claude --output-format stream-json …`
  and reads `model` from the `system/init` event — no LLM call. The
  Claude Code-specific tier suffix (e.g. `[1m]`) is stripped at both
  emission sites (advertise + `usage.model`) so the canonical Anthropic
  id is what callers see.
- `codex`: the probe drives an `app-server` and calls the `model/list`
  RPC for the full model pool. `reasoning` comes from each entry's
  `supportedReasoningEfforts`. The `default` tag prefers the operator's
  `config.toml` model (the value the spawn actually loads) over
  codex's own recommended `isDefault`.
- Daemon-wiring fixes that the advertise needed in order to reach
  the server card: load the bundled `cards/<backend>.json` as the
  default inline card on hello (so `resolveCapabilities()` runs at all),
  and raise the outer probe deadline from 3s to 12s so the claude probe
  on hook-heavy operator cwds completes before hello.

Probes are best-effort and silent on failure; the advertise is omitted
when the model cannot be determined. Wire semantics are unchanged.
