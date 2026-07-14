---
"@vicoop-bridge/client": patch
---

fix(vicoop-codex): disable Bun's ~255s native fetch timeout on the request to the local `vicoop-codex serve`

A legitimately slow upstream (long reasoning / slow first byte — observed first-byte latencies up to ~440s) made Bun abort the serve request at ~255s with `The operation timed out.`, failing the task even though serve's own 9-minute upstream deadline had not fired and the request would have (and did) succeed. The request is still bounded by the task abort signal and serve's deadline, so it never hangs unbounded.
