---
'@vicoop-bridge/client': minor
---

Add opt-in crash telemetry. Off by default — the client only loads or
initializes the Sentry SDK when config.json has `"telemetry": "on"`. Opt in
with `vicoop-client agent register --enable-telemetry` (persists the field) or
by hand-editing config.json; disable by removing the field. When on, only
crash reports are sent: exception class + stack trace with the operator's home
path redacted. Tracing is disabled, breadcrumbs/console capture are suppressed,
and `sendDefaultPii` is off — so prompts, code, agent output, tokens, and logs
are never transmitted. The daemon prints a one-line disclosure at registration
and at startup. DSN is configurable via `VICOOP_CLIENT_SENTRY_DSN`.
