---
'@vicoop-bridge/client': patch
---

claude backend: stage the openai-compat system prompt in a per-task temp file (`--system-prompt-file`) instead of argv, fixing `E2BIG: argument list too long` spawn failures on large system prompts (#437). The file is written 0600 and removed when the spawned process closes.
