---
"@vicoop-bridge/client": minor
---

Enable fixed ext4 caller storage during container init using a bundled Docker-built helper, a shared managed pool, immutable capacity policy, and a recoverable filesystem probe. Reject undersized pools before creation and allow safe retries after a rejected policy without altering retained data. Add MiB sizing and pool-selection options, preserve retained state on reinitialization, and report the Docker-filesystem reservation boundary explicitly.
