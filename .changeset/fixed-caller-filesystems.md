---
"@vicoop-bridge/client": minor
---

Add fixed-size caller filesystems, enabled by normal caller-runtime initialization, with synchronous block/inode limits, daemon-side pool admission, retained image reattachment, and explicit cleanup. Reservation covers the Docker backing filesystem, not physical capacity outside thin VM disks. Existing shared-runtime volumes are preserved separately and are not automatically copied into caller environments. Caller-scoped storage has never shipped, so no migration of the intermediate development format is required or provided.

Recover interrupted initial reservations and deletion retries without blocking unrelated callers; persist helper identities and quarantine scopes until privileged helper termination is confirmed.

Build the storage helper from TypeScript into a standalone Bun executable and run its recovery tests in the existing Node/Bun test suite; no Python runtime is required.
