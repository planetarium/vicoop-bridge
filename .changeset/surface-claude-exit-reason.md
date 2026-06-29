---
"@vicoop-bridge/client": patch
---

fix(claude): surface claude's terminal result reason in `claude_exit_nonzero`

When claude exits non-zero with zero usage, it first emits a terminal `result`
event whose `result` field carries the human-readable cause — e.g. "You've hit
your session limit · resets 3pm (UTC)", "API Error: Server is temporarily
limiting requests ... · Rate limited", "Overloaded". The bridge captured this
text in `finalText` but dropped it from the failure message, so the only thing
reaching the router was an inscrutable `claude exited with code 1 [stdout: <raw
JSON tail>]`.

The `claude_exit_nonzero` message now includes that reason right after the exit
code, before the raw stdout dump. Because the router persists the task-fail
message as the terminal error and keyword-classifies it, the real cause
(session/rate limit, overload, auth) now shows up in the admin usage report and
drives the runtime-status classifier — instead of being buried in the stdout
JSON. The raw stdout tail is still appended for diagnostics.
