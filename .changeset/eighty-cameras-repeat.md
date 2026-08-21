---
'@vicoop-bridge/client': patch
---

Preserve in-flight task output across transient bridge reconnects with an
acknowledged, generation-scoped replay protocol. Unacknowledged frames retain
their original binding ID and sequence when resent, while bounded retention and
legacy-server fallback fail closed instead of risking partial or stale output.
