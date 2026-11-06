---
"@vicoop-bridge/client": minor
---

Add opt-in caller_runtime.idleTimeoutMs to stop idle caller containers and release workers after execution cleanup, then restart on demand with retained files and an explicit conversation reset. Preserve retained-scope and storage capacity accounting, quarantine unconfirmed cleanup, and expose idle-stop/recovery outcomes in lifecycle logs and runtime inspection.
