# Codex container authentication broker

Codex `--runtime container` runs the agent and its tools in Docker while the
host bridge holds provider credentials. The workload receives a temporary
`vbc_exec_` grant through the app-server's `account/login/start` API-key login.
The built-in `openai` provider is pointed at the loopback relay with a
per-execution `openai_base_url` override; no custom provider is defined.
`cli_auth_credentials_store="ephemeral"` keeps the temporary login in memory,
without writing `auth.json` or injecting a token environment variable. Codex
sees an API-key login even when the host authenticates upstream with ChatGPT
OAuth. Codex 0.153.4 app-server does not pick up `OPENAI_API_KEY` or
`CODEX_API_KEY` for this login, so changing the URL and environment alone is
insufficient.
The host replaces the grant with the selected credential over a private Docker
stdio channel. No host TCP listener or separate proxy deployment is needed.

This implements the Codex external-runtime work in #503. Host execution and
bundled-direct retain their existing authentication. A shared runtime is one
security domain: this does not isolate different callers within that runtime.

## Authentication and compatibility

A stable Codex release **0.153.4 or newer** is required for this runtime profile. The tested
version is 0.153.4. `vicoop-client info` advertises this floor as
`backends.codex.externalRuntimeSupportedRange`; `supportedRange` retains the
existing host/bundled-direct range. Supported host sources, selected in order:

1. Explicit `OPENAI_API_KEY` in the bridge environment.
2. An API key or ChatGPT OAuth login in `$CODEX_HOME/auth.json` (default
   `~/.codex/auth.json`). OAuth requires `auth_mode="chatgpt"`; unsupported
   login modes and files containing both credential types are rejected.

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

The provider uses HTTP/SSE Responses. Both request compression and
Responses-lite are disabled. The built-in provider's initial WebSocket handshake
receives HTTP 426 from the authenticated broker, selecting HTTP fallback
without repeated connection attempts; no WebSocket request reaches upstream.
The broker permits only POST `/responses` and
`/responses/compact`, routed to the fixed OpenAI API or ChatGPT Codex endpoint.
Other routes, query parameters, background requests and unsupported model
names are rejected. Credentials, account headers and upstream error bodies
are never accepted from or echoed back to the workload.

## Current per-caller setup

After registering the bridge agent and preparing Codex authentication on
the host, run:

```sh
vicoop-client container init codex
vicoop-client start --detach
```

Initialization builds or validates an image, creates private caller state and
saves the agent config. See [caller runtime setup](caller-runtime.md) for custom
images, alternate configs and migration behavior.

### Legacy per-backend resources (historical)

The migration details below describe older shared runtimes and their retained
administrative commands. The old init flags shown below apply only to earlier
client versions; current init rejects them. They do not configure the current
per-caller daemon.


`--from-host` is accepted for compatibility but does not copy credentials.
Existing credential-mounted runtimes are rejected. Stop their bridge daemon,
back up needed state, then explicitly recreate the runtime:

```sh
vicoop-client container remove codex --preserve-volumes
vicoop-client container init codex --name codex --reuse-state --from-host
# Configure per-caller execution separately; see caller-runtime.md.
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

Workspace binds must use a separate project directory: paths overlapping the host Claude/Codex credential directories (including configured homes and symlink aliases) are rejected before startup. This check protects known credential locations; operators must still keep unrelated secrets out of shared project files. Runtime labels and volume names must match the requested runtime identity, and shared host/user/IPC namespaces and device requests are rejected.
