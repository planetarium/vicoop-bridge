---
"@vicoop-bridge/client": patch
---

Add `vicoop-client container ls` / `list` to show managed runtime container and volume state, plus `container rm` / `remove` for name-based cleanup and named runtime instances for multi-instance workflows. `container rm` removes the container and volumes by default, with `--preserve-volumes` for credential/session retention. `container init` now assigns a runtime name even when `--name` is omitted, stops the initialized container until daemon startup, and fails when the target runtime already exists instead of reinstalling into it.
