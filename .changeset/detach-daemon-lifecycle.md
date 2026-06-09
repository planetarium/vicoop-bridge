---
"@vicoop-bridge/client": minor
---

Add `start --detach` plus `stop` / `status` for unattended background operation (#190). `--detach` runs the daemon as a new session/process-group leader under a pidfile, surviving the session/pgrp reaping that kills `nohup … &` in agent-driven exec sandboxes (#186). `stop` does SIGTERM → grace → SIGKILL; `status` reports running/stopped/stale. Both refuse to act on a recycled PID. POSIX-only; documents the cgroup/reboot-persistence gap (the future `service install` tier).
