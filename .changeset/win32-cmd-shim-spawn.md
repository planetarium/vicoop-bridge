---
'@vicoop-bridge/client': patch
---

Route `node:child_process.spawn` through the shell on Windows so the
codex / vicoop-codex backends can resolve the npm-installed `.cmd`
shims (#254).

`spawn('vicoop-codex', …)` and `spawn('codex', …)` fail with ENOENT
on Windows because npm publishes the binaries as `.cmd` shims that
Node cannot resolve without going through `cmd.exe`. Setting
`shell: process.platform === 'win32'` in both `defaultSpawn`
(vicoop-codex backend) and `defaultAppServerSpawn` (codex app-server
RPC) lets win32 take the shim-resolution path; POSIX hosts keep
`shell: false` to avoid the spawn-with-shell deprecation warning and
quoting surprises.

Safe because `command` and `args` at both call sites are fully
internal to the bridge client (`'vicoop-codex' / ['call']` and
`'codex' / ['app-server']`); no operator-supplied tokens enter the
argv, so shell-injection is not a concern.
