---
'@vicoop-bridge/client': patch
---

claude backend: report the actual response model in the OpenAI-compatible
envelope. The envelope's top-level `model` (and its embedded `usage.model`)
now resolve from model ids claude itself reports — the model named on the
`assistant` turn, falling back to the `system/init` resolved model — instead
of the `result.modelUsage` largest-output-share heuristic, which on short
responses could be dominated by an internal sub-model (e.g.
`claude-haiku-4-5-*` used for title generation) and mislabel the envelope even
when the requested override model handled the request. The requested
`envelope.model` is deliberately not used as a fallback, since it may be a
routing slug or an A2A card url rather than a real model id. `modelUsage` is
now used only to sum token counts (#348).
