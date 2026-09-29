---
"@vicoop-bridge/client": patch
---

Fix invalid macOS x64 release signatures by ad-hoc signing the final executable in Linux CI before generating checksums. Validate both macOS architectures on native CI runners.
