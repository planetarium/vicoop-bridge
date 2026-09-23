---
"@vicoop-bridge/client": minor
---

Add opt-in fixed-size caller filesystems with synchronous block/inode limits, daemon-side pool admission, retained image reattachment, and explicit cleanup. Reservation covers the Docker backing filesystem, not physical capacity outside thin VM disks; existing data requires a separate migration.
