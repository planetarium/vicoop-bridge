---
"@vicoop-bridge/client": patch
---

`vicoop-client info` now advertises the host-only `vicoop-codex` backend (with its supported CLI range `>=0.3.0`) alongside the container-installable `claude` / `codex`. The container compat manifest is unchanged — `vicoop-codex` remains host-process only and is not installed or driven under `--runtime container`.
