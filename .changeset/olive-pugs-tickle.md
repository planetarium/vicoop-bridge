---
'@vicoop-bridge/client': patch
---

claude backend: the `session init` log line now reports the claude session id
(`session=`), and the requested model that the advertised-models gate rejected
(`requestedDropped=`). The session id is the join key to the CLI's OTEL records
and its on-disk transcript, and previously appeared only in a `debug` line. The
dropped model previously left no trace on this line at all, making a task whose
model request was rejected indistinguishable from one that requested nothing.
