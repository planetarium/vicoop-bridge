---
'@vicoop-bridge/client': minor
---

Add stateful-context delta support (openai-compat `statefulContext` capability).

The claude / codex / vicoop-codex bundled cards now advertise
`params.statefulContext: true` on the openai-compat extension, and their
backends reconstruct prior conversation turns for delta requests: when the
bridge forwards a delta turn (only the new message) it also ships the prior
turns as `contextHistory`, which the connector folds ahead of the envelope's
own chat history so the model sees the full conversation. Classic full-replay
requests are unchanged, and openclaw stays unadvertised (its delta path is not
yet verified).

Because the advertised card is the one the client sends in its hello frame,
operators must upgrade to this client build for the bridge to advertise the
capability — and the bridge server must already run the matching
`contextHistory` reconstruction (deploy the server first).
