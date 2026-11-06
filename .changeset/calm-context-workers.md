---
"@vicoop-bridge/client": minor
---

Add opt-in bounded same-caller concurrency for Claude and Codex containers, with context-private persistent workspaces, fair execution admission, isolated cancellation and file routing, and explicit queue timeouts. Existing serial mode remains the default; parallel mode requires fixed storage and records a new manifest version for safe recovery. Execution transports and cleanup are pinned to immutable container IDs so delayed callbacks cannot stop a replacement execution.
