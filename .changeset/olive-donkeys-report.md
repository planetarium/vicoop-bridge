---
'@vicoop-bridge/client': patch
---

docs: add `docs/claude-telemetry.md` — observability for the `claude` backend.
Covers what the journal already reports without any setup (served + requested
model per task, tokens/cost, silent model switches), and the OTLP recipe for
collecting the Claude Code CLI's own OpenTelemetry stream when per-request
granularity or `request_id` is needed. Notably: `OTEL_LOGS_EXPORTER=console`
emits nothing under the bridge, so operators running it today are collecting
nothing — use `otlp`.
