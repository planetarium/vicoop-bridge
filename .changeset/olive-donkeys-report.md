---
'@vicoop-bridge/client': patch
---

docs: add `docs/claude-telemetry.md` — observability for the `claude` backend.
Covers what the journal already reports without any setup (the served and
requested model per CLI spawn, silent model switches) and, just as usefully,
what it does not (token counts go to the openai-compat response envelope rather
than the journal; cost is never computed). Adds the OTLP recipe for collecting
the Claude Code CLI's own OpenTelemetry stream when per-request granularity,
`request_id`, or cost is needed. Notably: `OTEL_LOGS_EXPORTER=console` emits
nothing under the bridge, so operators running it today are collecting nothing
— use `otlp`.
