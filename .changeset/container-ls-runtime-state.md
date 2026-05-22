---
"@vicoop-bridge/client": patch
---

Add `vicoop-client container ls` / `list` to show managed runtime container and volume state, plus `container rm` / `remove` and named runtime instances for cleanup and multi-instance workflows. `container init` now fails when the target runtime already exists instead of reinstalling into it.
