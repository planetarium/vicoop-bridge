---
'@vicoop-bridge/client': patch
---

claude backend: log the resolved model once per task at `info`. The
`system/init` event was the one `system` subtype that never reached a log, so a
task that went fine left no record of which model actually served it. The line
carries the model string verbatim (the normalised id is the openai-compat
envelope's need, not the log's) plus the requested `envelope.model` when there
was one, making "asked for X, served Y" — the `model_refusal_fallback` failure
mode — legible from a single log line.
