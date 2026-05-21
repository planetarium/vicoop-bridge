---
'@vicoop-bridge/client': minor
---

Add `vicoop-client container init <kind>` — operator one-shot
bootstrap for the external-runtime container profile (#249 PR C).

Lands the host-side UX that PR #251 (image) and PR #252 (spawn
adapter + runtime container) left to the operator to wire up by
hand. Before this, "use container runtime" looked like: docker
run, docker exec --user 0 chown, docker exec install-backend.sh,
manually copy creds into the named volume. Now:

```
$ vicoop-client container init codex --from-host
$ vicoop-client --backend codex --codex-runtime container
```

The command:

1. Boots the per-backend runtime container (`vicoop-runtime-<kind>`),
   reusing an existing one when present.
2. Chowns the per-kind subtrees inside `/data/agents/<kind>` and
   `/data/creds/<kind>` to the image's `node` user — works around
   docker's named-volume permission landmine where the mount point
   ends up root-owned even when the image pre-creates and chowns
   it (the volume's empty state takes over at mount time).
3. Runs the shared `install-backend.sh <kind>` recipe baked into
   the runtime image (PR A).
4. Probes the installed binary's version via `<bin> --version` and
   verifies it satisfies `BACKENDS_MANIFEST[kind].supportedRange`.
   Bad versions surface a clear error here rather than at first-
   task-time.
5. With `--from-host`, copies the operator's existing host creds
   into the container creds volume:
   - claude: macOS Keychain (`security find-generic-password -s
     'Claude Code-credentials'`) or `~/.claude/.credentials.json`
     on linux.
   - codex: `~/.codex/auth.json` plus `~/.codex/config.toml` when
     present.

`--from-host` is opt-in (off by default) so the Decision §4
container-creds-isolation default still holds; operators who want
the convenience explicitly accept the tradeoff.

Naming: the group reads as `container ...` rather than `backend
...` because the operator's mental model is "wire up the docker
container hosting my agent CLI"; `backend` is reserved internal
vocab in the codebase for the Backend interface + BackendKind
enum. The positional argument is still the backend kind
(claude / codex).

Also threads a `user` option through `RuntimeContainer.exec()` so
the chown step can run as root inside an image whose default user
is unprivileged.

Bun compatibility: the docker-exec steps inside `container init`
and the spawn-adapter's `createDockerExecSpawn` both shell out to
the `docker` CLI rather than using dockerode's
`exec.start({ hijack: true })`. bun's node:http client doesn't yet
implement the HTTP 101 'upgrade' event docker's hijack protocol
relies on (oven-sh/bun#22412 is the in-flight fix); under a
bun-compiled vicoop-client the hijack stream deadlocks. dockerode's
non-hijacked lifecycle calls (pull / volume / create / start /
stop / inspect) stay on the programmatic API where they work
cleanly under bun.

Out of scope (still PR C-shaped follow-ups if motivated by ops
feedback):

- Interactive `claude setup-token` / `codex login --device-auth`
  passthrough as a first-class auth path (today the command
  prints the `docker exec -it …` hint to run yourself).
- Host-mode install automation (`--runtime host`); today the
  command errors out with a clear "install via the official
  installer" pointer.
- `container status` / `container rm` siblings — operators still
  reach for `docker ps` / `docker rm -f` / `docker volume rm` for
  those today.
