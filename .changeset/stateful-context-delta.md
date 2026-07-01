---
'@vicoop-bridge/client': minor
---

Backends now reconstruct prior conversation turns for stateful-context delta
requests. When the bridge forwards a delta turn (only the new message, per the
openai-compat `stateful-context` capability), the connector folds the
server-reconstructed `contextHistory` ahead of the envelope's own chat history
so the model sees the full conversation. Classic full-replay requests are
unchanged.
