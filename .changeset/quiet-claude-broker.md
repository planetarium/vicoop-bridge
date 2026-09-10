---
"@vicoop-bridge/client": minor
---

Move Claude external-container authentication to a built-in host broker so real OAuth/API credentials stay outside the workload. Existing runtimes require migration: preserve volumes, recreate with `container init claude --reuse-state`, and authenticate on the host. The old credentials volume remains detached; selected conversations and todos are preserved. Private/host-network services are now blocked for Claude runtimes. See `docs/claude-auth-broker.md` for supported modes, migration and rollback limits. Codex, host mode and bundled-direct authentication are unchanged.
