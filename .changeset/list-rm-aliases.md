---
'@vicoop-bridge/client': minor
---

Accept docker-style short aliases on the agent and container CLI groups: `agent list` / `agent callers list` / `container list` also accept `ls`, and `agent remove` / `agent callers remove` / `container remove` also accept `rm`. `agent remove` is now the canonical form of the previous `agent delete` (which keeps working as a third alias). Help output stays a single row per subcommand — the canonical name shows in the listing with the alias noted in the brief.
