---
"@vicoop-bridge/client": patch
---

Fix macOS ARM64 release binaries being killed at startup because of an invalid code signature by upgrading the Bun compiler to 1.4.2. Builds still cross-compile in Linux CI; macOS CI verifies the resulting checksum, signature, and CLI startup. Users whose existing binary cannot start should replace only the executable with the corrected release; see the recovery instructions in docs/install-client.md.
