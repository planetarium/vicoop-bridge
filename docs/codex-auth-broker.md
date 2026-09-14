# Codex container authentication broker

Codex `--runtime container` runs the agent and its tools in Docker while the
host bridge holds provider credentials. The workload receives a temporary
`vbc_exec_` grant in `VICOOP_EXECUTION_TOKEN`, with a loopback Responses provider.
The host replaces the grant with the selected credential over a private Docker
stdio channel. No host TCP listener or separate proxy deployment is needed.

This implements the Codex external-runtime work in #503. Host execution and
bundled-direct retain their existing authentication. A shared runtime is one
security domain: this does not isolate different callers within that runtime.

## Authentication and compatibility

Codex **0.153.4 or newer** is required for this runtime profile. The tested
version is 0.153.4. Supported host sources, selected in order:

1. Explicit `OPENAI_API_KEY` in the bridge environment.
2. An API key or ChatGPT OAuth login in `$CODEX_HOME/auth.json` (default
   `~/.codex/auth.json`). Files containing both are rejected.

The selected source and login kind stay pinned. OAuth also pins the account ID.
Credentials are reread for each request; an expired token, removed file, or
changed account fails closed. OAuth must remain valid for at least 30 seconds.
The bridge never refreshes OAuth or falls back to another account or API key.
Renew the login on the host and retry; restart after changing accounts or
environment credentials. Keyring-only logins, custom providers, host config
profiles and `OPENAI_BASE_URL` overrides are unsupported in this profile.

Only the host config's root `model` setting is inherited. Other host settings,
MCP servers and credential files are not copied. For OAuth, the host loads the
authenticated model catalog at startup and stages non-secret model metadata
per execution. Startup fails if that catalog cannot be loaded. Restart to
refresh the catalog. API-key mode uses Codex's embedded catalog.

The provider uses HTTP/SSE Responses with WebSockets, request compression and
Responses-lite disabled. The broker permits only POST `/responses` and
`/responses/compact`, routed to the fixed OpenAI API or ChatGPT Codex endpoint.
Other routes, query parameters, background requests and unsupported model
names are rejected. Credentials, account headers and upstream error bodies
are never accepted from or echoed back to the workload.

## Setup and migration

Log into Codex on the host or set `OPENAI_API_KEY` for the host bridge, then:

```sh
vicoop-client container init codex
vicoop-client --backend codex --runtime container
```

`--from-host` is accepted for compatibility but does not copy credentials.
Existing credential-mounted runtimes are rejected. Stop their bridge daemon,
back up needed state, then explicitly recreate the runtime:

```sh
vicoop-client container remove codex --preserve-volumes
vicoop-client container init codex --name codex --reuse-state --from-host
vicoop-client --backend codex --runtime container --runtime-name codex
```

Adjust the runtime name and restore any workspace/image options used before.
Removal discards the old writable container layer. Migration copies regular
`.jsonl` rollout files from `sessions/` and `archived_sessions/` in the old
credential volume into `/data/sessions/codex/config`. It excludes symlinks,
auth files, settings and databases. Old volumes are retained for operator
cleanup; historical secrets inside conversation text are not scrubbed.

## Execution boundary

Each task owns an app-server process, relay and grant. The bridge retains
conversation IDs so the next task can resume after the previous process is
fully cleaned up. Tasks in a context serialize; different contexts use separate
processes. Completion and cancellation are emitted after process cleanup,
including cancellation during app-server initialization.

The shared Claude/Codex supervisor revokes grants and kills descendants on
exit, cancellation, transport failure or expiry. Runtime validation rejects
credential mounts and provider environment variables. Workloads run as an
unprivileged user with protected firewall rules blocking private destinations.
Public internet access remains available to tools; the bridge supplies no
provider credentials for direct requests. See the [shared boundary and limits](./claude-auth-broker.md)
for transport limits and operational assumptions. Limits bound an execution;
they are not a billing cap. Workload code can read and use its own temporary
grant while it remains valid, but cannot use it to recover the host credential.

## Verification

Unit tests cover OAuth/API-key substitution, route restrictions, account and
source pinning, catalog handling, legacy runtime rejection and rollout
migration. Backend tests cover process teardown, resume, concurrency and
cancellation during initialization. The shared Claude Docker smoke covers the
transport and supervisor failure paths.

Run the actual Codex smoke with an account-supported model:

```sh
VICOOP_SMOKE_CODEX_MODEL=gpt-6-astra pnpm exec tsx packages/client/scripts/codex-auth-broker/smoke.ts
```

It creates and removes a disposable Docker runtime, uses the selected host
credential for real requests, and checks inference, model discovery, resume,
tools, concurrency, cancellation cleanup and absent workload login files.
The same script can be compiled with `bun build --compile`. Actual OAuth was
tested on macOS with Docker Desktop. Actual API-key inference and native Linux
host validation remain unverified; mock API-key tests do not replace them.
