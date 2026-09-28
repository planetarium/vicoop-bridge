---
"@vicoop-bridge/client": minor
---

Keep Codex OpenAI API keys and ChatGPT credentials on the host. Authenticate each caller execution through the host broker with an ephemeral login instead of mounting provider credentials or passing them in token environment variables. Require Codex 0.153.4 or newer and reject unsupported OAuth login modes.

For an existing shared Docker runtime, stop the daemon, preserve its configuration and volumes, prepare Codex authentication on the host, then run `container init codex --config /path/to/config.json` before restarting. Shared workspaces and sessions are not automatically copied into caller storage. See the [caller runtime transition guide](https://github.com/planetarium/vicoop-bridge/blob/main/docs/caller-runtime.md). Host execution and bundled-direct authentication behavior are unchanged.

Wait for execution cleanup before completing or resuming tasks, settle queued cancellation without overtaking active cleanup, and validate workload ownership, persistent mounts, firewall capabilities and confinement. Provider-secret filtering prevents credential environment variables from entering workloads.
