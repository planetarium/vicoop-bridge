---
'@vicoop-bridge/client': minor
---

Replace the initial bridge-specific signing contract with agent-publication-v1. The local signing socket takes the target URL and digest and returns HTTP headers identifying the agent by its domain-authorized, non-reassigned ID. Upgrade signing daemons and servers together.
