---
"@vicoop-bridge/client": minor
---

Keep Claude OAuth/API credentials on the host through a built-in authentication broker; caller workloads receive execution-scoped access instead of credential files. Private/host-network services are blocked from caller workloads.

For an existing shared Docker runtime, stop the daemon, preserve its configuration and volumes, prepare Claude authentication on the host, then run `container init claude --config /path/to/config.json` before restarting. Shared workspaces and sessions are not automatically copied into caller storage. The retired `--reuse-state` init flag is rejected. See the [caller runtime transition guide](https://github.com/planetarium/vicoop-bridge/blob/main/docs/caller-runtime.md). Host execution and bundled-direct authentication behavior are unchanged.
