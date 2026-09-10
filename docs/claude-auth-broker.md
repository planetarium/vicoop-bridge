# Claude container authentication broker

Claude `--runtime container` now uses the host bridge's built-in authentication
broker. Claude and its tools still execute inside the external runtime. Real
provider credentials are read only by the host and are never passed to Docker,
agent arguments, workload environment, mounted login files or broker errors.
No additional account, proxy service, port configuration or package is required.

This is the **main-first implementation of #500**. It does not complete #500's
caller-scoped R2 integration or #497's release gates. An external runtime remains
one shared security domain; different callers using it are not isolated.

## Supported authentication

| Mode | Host source | Workload receives |
| --- | --- | --- |
| Claude subscription OAuth | Existing host Claude login (macOS Keychain or credentials file) | Temporary execution grant |
| Explicit OAuth token | Host `CLAUDE_CODE_OAUTH_TOKEN` | Temporary execution grant |
| Anthropic API key | Host `ANTHROPIC_API_KEY` | Temporary execution grant |

Set at most one credential environment variable. If neither is set, the bridge
selects the host login store. An explicit `CLAUDE_CONFIG_DIR` selects that
credentials file; otherwise macOS selects an existing Keychain entry first,
then the default credentials file if no entry exists at startup. Other hosts
select the credentials file. The chosen store/type stays pinned for the daemon's
lifetime. Removal or failure never falls back to another store or API key.
Operators must not replace a selected store with another account while work is
running: store pinning is not account-identity verification.

Credentials are reread before each provider request, so token rotation in the
selected store takes effect without copying anything into the container. An
OAuth expiry within 30 seconds fails closed. **The bridge does not refresh
OAuth** and does not read/use refresh tokens for refresh operations. Renew the
login with Claude on the host, then retry the failed task. Explicit environment
credentials must be changed by restarting the daemon. Missing/expired login
fails startup; loss during execution returns a sanitized broker error and a
host-side instruction to renew the selected credential. Provider errors never
trigger automatic broker retries, request replay or a credential fallback.
Claude itself may retry a request; each attempt counts against the grant limit.

Bedrock, Vertex, Foundry, custom Anthropic origins, `ANTHROPIC_AUTH_TOKEN`,
container-local login and `apiKeyHelper` authentication are not supported by this
mode. Do not pass authentication settings or secrets through agent settings,
workspace files, prompts or mounted state. Host mode, Codex authentication and
the bundled-direct image keep their existing behavior; this broker does not
make their provider credentials inaccessible to their agent processes.

## Fresh setup

Log into Claude on the **host**, or supply one supported credential variable to
the host bridge process. Then run:

```sh
vicoop-client container init claude
vicoop-client --backend claude --runtime container
```

`container init claude --from-host` is accepted for compatibility but does not
copy secrets. Both forms validate host authentication. The runtime image must
contain Node at `/usr/local/bin/node`, `/usr/bin/tini`, `iptables`, `ip6tables` and the normal install recipe (the existing
`vicoop-runtime` image includes them).

## Existing runtime migration

Stop the bridge daemon first. Preserve the original runtime image reference and
any workspace bind-mount path in your operational records. Then, replacing
`claude` with your runtime instance name:

```sh
vicoop-client container remove claude --preserve-volumes
vicoop-client container init claude --name claude --reuse-state --from-host
vicoop-client --backend claude --runtime container --runtime-name claude
```

The explicit removal discards the old container's writable layer. Back up any
files kept there before running it. Named agent/session volumes remain and are
reused; the legacy credentials volume is retained **without being mounted into
the new workload**. `--reuse-state` also runs a short-lived, networkless helper
which mounts that legacy volume read-only and copies only `projects/**/*.jsonl`
and `todos/**/*.json` into the new session config directory. Existing destination
files are kept; symlinks, settings, login files and environment snapshots are
excluded. The helper exits and is removed before normal agent use. No host login
is overwritten, imported from the container or deleted.

For a custom `/workspace` bind mount, add `--workspace /original/host/path`
to the replacement `container init` command, and keep the original daemon
`--cwd /original/host/path` setting. The data on the host is retained by
container removal. Do not mount the operator's home, credential stores or Docker
socket into the workload. The runtime refuses mounts outside the agent/session
volumes, `/workspace`, and designated temporary directories. Legacy runtimes or
containers with provider environment variables fail before any new agent spawn.

The new `CLAUDE_CONFIG_DIR` is `/data/sessions/claude/config`. The old credential
path is an empty tmpfs. The guarantee starts with the new broker runtime: this
migration does **not** sanitize tokens that previous tools copied into code,
conversation transcripts, todos, backups or snapshots. If old work may contain
secrets, rotate them on the host and use a fresh runtime name without reusing
state. Operator-supplied images and workspace contents remain trusted inputs.

Rollback to an older bridge can restore direct credential exposure if the old
credentials volume is mounted again. Do not use the old `container remove`
without `--preserve-volumes` if the retained data is needed. Recover a legacy
installation from your saved image/mount configuration and retained volumes;
there is no automatic downgrade or silent direct-auth fallback.

## Transport and lifecycle

Each agent spawn owns a random `vbc_exec_<64 hex characters>` grant. This
provider-independent prefix distinguishes it from real Anthropic credentials;
the environment variable still matches the selected OAuth/API-key mode. The
spawn also owns an HTTP broker on a Unix socket in a
host-private temporary directory (mode 0700), and a Docker exec relay. No host
TCP port is opened and no Unix socket/path is mounted into Docker. The relay
listens only on `127.0.0.1` inside its runtime and multiplexes HTTP and agent
stdio through Docker exec. The host supplies only a fixed local Unix-socket
destination; workload frames cannot choose host paths or forwarding targets.
This uses the same transport on macOS Docker Desktop and Linux Docker. There is
no container-to-host network hop requiring TLS; host-to-Anthropic uses HTTPS.
A trusted local Docker daemon is required; Windows hosts and remote Docker
transports have not been validated for this implementation.

A token stolen by another runtime cannot authenticate to that runtime's broker,
and the owning relay is unreachable outside its container loopback. Workload
code in the **same** runtime can read/use an active grant: main's single runtime
is not a caller boundary. R2 must bind relay/runtime ownership to the authorized
caller scope, lease and generation before caller-isolation claims are made.

The workload runs as `node` with `no-new-privileges`. Before agent use, the host
installs firewall rules through a privileged Docker control-plane exec using an
absolute shell path and a fixed system-only PATH. Writable agent binaries cannot
replace these privileged commands on restart. Private,
link-local and host interface/gateway destinations are rejected, and IPv6 egress
is blocked except loopback. DNS (UDP/TCP port 53) is allowed only to the
configured IPv4 resolvers, including Docker default-bridge private resolvers. Public internet tool traffic remains subject to the
image's existing egress policy. Failure to apply this boundary stops startup;
`VICOOP_SKIP_FIREWALL` cannot disable these broker-specific rules. Workloads can
no longer reach private repositories, LAN services or host-local MCP servers;
move required services to an appropriately authenticated public endpoint or keep
using host mode for that workload. A workload cannot alter these rules using
its unprivileged exec user. Host administrative APIs and credential stores are
not exposed by the relay.

Host-generated `--system-prompt-file` and `--append-system-prompt-file` inputs
are transferred in bounded chunks over the same Docker channel (16 MiB total).
The relay rewrites their arguments to private execution-owned temporary files
and removes those files on exit. Workload frames cannot request host files.

Completion, cancellation, transport loss and shutdown revoke the grant and close
active upstream connections. Each execution runs under its own root-owned tini
subreaper and supervisor, started using absolute image-owned binaries with Node
and dynamic-loader injection variables cleared. The supervisor only forwards
opaque stdio and manages process lifetime; it never interprets workload frames
or runs workload commands as root. It drops the relay to UID/GID 1000 before
execution. Workload code cannot signal the supervisor. On relay exit, stdin loss
or TTL expiry, it stops and kills all descendants of that execution's subreaper,
including detached/double-forked children, while preserving other executions.
Cancellation revokes the grant and destroys the host's supervisor-input pipe,
discarding queued frames; it does not depend on the relay processing a signal.
The supervisor drains input with a bounded queue rather than pausing input on
relay backpressure, so a SIGSTOP'd relay cannot hide cancellation EOF. Both
SIGTERM and SIGKILL cancellation requests use this forced cleanup path.
The host waits for supervisor exit and pipe drainage before reporting task close.
If supervisor/Docker exit leaves cleanup uncertain, the adapter stops accepting
work and attempts to stop the entire shared runtime through Docker; this also
interrupts other tasks. Docker control-plane availability remains required for
that fallback. Killing only the host `docker exec` process is not used as proof
of agent termination. Startup failure, malformed
frames and transport limits fail the child execution. A new daemon/spawn creates
new random grants; old grants have no surviving broker and cannot be resumed.
A hard host crash can leave an inert Unix socket file in its private temporary
directory, but no credential or reusable grant is persisted there. Temporary
files may be removed by normal host temporary-directory cleanup.

Transport cancellation does not prove the provider immediately stopped inference
or billing. Broker failure must be handled as failed/uncertain work by the existing
backend; no grant is reissued to replay uncertain requests. An expired grant
terminates the child after at most one hour even if a caller disconnects.

## Protocol and resource limits

Only POST `/v1/messages` and `/v1/messages/count_tokens`, optionally with exactly
`?beta=true`, are forwarded to `https://api.anthropic.com`. Other paths, methods,
queries, destinations and redirects are rejected. Model IDs must be in the
Claude Haiku/Sonnet/Opus families; the broker does not translate model names. The
internal broker API can further restrict an execution to an explicit model list.

Request authentication/cookie/routing headers are dropped. The broker sets the
provider credential, content type and Anthropic version; forwards the syntactically
validated Anthropic beta list, user-agent and x-app; and adds the OAuth beta for
OAuth credentials (and strips that OAuth beta for API keys). The workload CLI
receives the temporary grant in the environment variable matching its selected
authentication mode. Successful response bodies, including SSE and usage/cache
accounting, pass through unchanged. Only content-type is retained from upstream
headers. Error bodies/headers and redirects are discarded. Successful model
content is trusted Anthropic output, not a general-purpose secret-redaction filter.

Defaults per execution: one-hour grant, 256 admitted requests, four concurrent
requests, 16 MiB request body, 64 MiB response, 128,000 maximum output tokens per
messages request, five-minute request timeout, and 16 transport sockets. Headers
are bounded to 16 KiB. Framing/stdio queues are bounded; excessively slow consumers
fail the execution instead of causing unbounded buffering. These are resource
limits, **not** spending caps or guarantees about provider billing.

## Reproduction and evidence

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm -r build
pnpm -r typecheck
pnpm --filter @vicoop-bridge/client test
bun test packages/client/src/claude-auth-broker.test.ts packages/client/src/claude-broker-spawn.test.ts
pnpm exec tsx packages/client/scripts/auth-broker/smoke.ts
bun build --compile packages/client/scripts/auth-broker/smoke.ts --outfile /tmp/vicoop-auth-broker-smoke
/tmp/vicoop-auth-broker-smoke

# Uses existing host OAuth allowance for two short Haiku turns.
# Requires a cached image with /usr/local/bin/claude; override as needed.
VICOOP_SMOKE_CLAUDE_IMAGE=vicoop-caller-r2-validation:latest \
  /tmp/vicoop-auth-broker-smoke --real
```

`VICOOP_SMOKE_IMAGE` overrides the cached runtime image. The smoke creates only
randomly named test containers/volumes and removes them in `finally`. It prints
sanitized outcomes, not credentials or raw model diagnostics. The local source
spike was replaced by the reviewable modules and smoke script in this change.

Validated on 2026-09-10 with macOS Docker Desktop (Linux Docker engine): Node/tsx
and Bun-compiled Docker mock requests, OAuth inference and continuation, workload
credential probes, process cancellation, abrupt bridge death, stolen-grant rejection across two
runtimes, a listening host-service access probe, Docker migration and cleanup.
Adversarial Docker regressions additionally cover privileged PATH shadowing on
restart, relay SIGKILL, detached descendants, supervisor signal protection,
SIGSTOP'd relay cancellation (including blocked input), and
preservation of concurrent executions. Node and Bun unit tests also
cover API-key substitution, token-counting policy, SSE/cache usage, grant rejection,
rotation/source pinning, errors/redirects and active upstream disconnection observed
by an independent Node process. Migration tests cover preservation and excluded
files. **Actual API-key inference (`--real-api`) and native Linux-host operation still need release
validation**; no host API key was available during implementation. R2's real A/B/A,
lease/generation, replay/checkpoint and full A2A acceptance tests remain follow-up
work and this change must not close #500 or #497.


A main-first production-server smoke on 2026-09-10 also exercised the compiled
client with a newly installed Claude 2.1.267 runtime: an authenticated A2A request
created and read back a workspace file, and a separate task lookup confirmed
`completed`. Fresh installation exposed a Docker private-DNS exception missing
from the firewall, while the first A2A request exposed host prompt-file paths;
both paths now have fixes and regression coverage. This is single-runtime A2A
evidence, not R2 caller-isolation acceptance evidence.
