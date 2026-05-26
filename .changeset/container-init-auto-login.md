---
'@vicoop-bridge/client': patch
---

`container init`: when `--from-host` is omitted and stdin is a TTY,
launch the agent CLI's interactive auth flow (`claude setup-token` /
`codex login --device-auth`) inside the freshly-installed runtime
container right after the install + compat check. Non-TTY callers (CI,
piped input) keep the previous hint-only behavior. The daemon
(`--runtime container`) now also probes the per-kind creds file at
startup and exits with the same auth hint when it is missing, instead
of accepting tasks that would fail at first spawn with a
backend-specific auth error.
