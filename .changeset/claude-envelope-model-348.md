---
'@vicoop-bridge/client': patch
---

claude backend: report the actual response model in the OpenAI-compatible
envelope. The envelope's top-level `model` (and its embedded `usage.model`)
now resolve from the model named on the assistant turn, falling back to the
requested model id (already forwarded to claude as `--model`). The previous
`result.modelUsage` largest-output-share heuristic — which on short responses
could be dominated by an internal sub-model (e.g. `claude-haiku-4-5-*` used
for title generation) and mislabel the envelope even when the requested
override model handled the request — has been removed; `modelUsage` is now
used only to sum token counts (#348).
