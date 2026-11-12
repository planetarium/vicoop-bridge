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

1. Explicit Azure provider settings described below, if any are present (incomplete
   or conflicting Azure settings fail closed).
2. Explicit `OPENAI_API_KEY` in the bridge environment.
3. An API key or ChatGPT OAuth login in `$CODEX_HOME/auth.json` (default
   `~/.codex/auth.json`). OAuth requires `auth_mode="chatgpt"`; unsupported
   login modes and files containing both credential types are rejected.

The selected source and login kind stay pinned. OAuth also pins the account ID.
Credentials are reread for each request; an expired token, removed file, or
changed account fails closed. OAuth must remain valid for at least 30 seconds.
The bridge never refreshes OAuth or falls back to another account or API key.
Renew the login on the host and retry; restart after changing accounts or
environment credentials. Keyring-only logins, arbitrary custom providers, host config profiles and
`OPENAI_BASE_URL` overrides are unsupported in this profile. The explicit Azure
provider below is supported independently of host Codex custom-provider config.

For direct OpenAI/ChatGPT, only the host config's root `model` setting is inherited. Other host settings,
MCP servers and credential files are not copied. For OAuth, the host loads the
authenticated model catalog and stages non-secret model metadata per execution.
In per-caller container mode, loading is lazy: the first request for a backend
version and credential fetches the catalog. Concurrent requests share that fetch;
successful results are cached until the version or credentials change. A failed
fetch fails the request with `runtime_failed`, stops its container, and retains
its files; other callers remain unaffected. Restore host login/provider
connectivity and retry (failures are not cached). A running daemon is therefore
not proof that catalog access works. The legacy runtime profile loads the catalog
at startup and requires a restart to refresh it. API-key mode uses Codex's
embedded catalog.

The provider uses HTTP/SSE Responses. Both request compression and
Responses-lite are disabled. The built-in provider's initial WebSocket handshake
receives HTTP 426 from the authenticated broker, selecting HTTP fallback
without repeated connection attempts; no WebSocket request reaches upstream.
The broker permits only POST `/responses` and
`/responses/compact`, routed to the selected OpenAI API, ChatGPT Codex, or pinned Azure v1 endpoint.
Other routes, query parameters, background requests and unsupported model
names are rejected. Credentials, account headers and upstream error bodies
are never accepted from or echoed back to the workload.

## Azure OpenAI caller containers

This path supports host-held **API keys only**. Microsoft Entra ID and managed
identity are deferred; Azure identity tokens are rejected rather than treated as
API keys. It uses the Azure OpenAI **v1** Responses API, including
`/openai/v1/responses/compact`. Dated preview APIs and query-string API-version
selection are not supported. The optional `VICOOP_CODEX_AZURE_API_VERSION` must
be `v1`; omitting it also selects v1.

Set these variables in the **host bridge process**, including its daemon/service
environment. Do not add them to the caller image, runtime environment, mounts,
prompts, or repository files:

```sh
export VICOOP_CODEX_AZURE_ENDPOINT=https://YOUR-RESOURCE.openai.azure.com/openai/v1
export VICOOP_CODEX_AZURE_MODEL=gpt-5.4
export VICOOP_CODEX_AZURE_DEPLOYMENT=YOUR-DEPLOYMENT-NAME
# Supply AZURE_OPENAI_API_KEY through your host secret manager/environment.
vicoop-client container init codex
vicoop-client start --detach
```

All four settings (including the key) are required. The endpoint must be HTTPS
on a single resource under `openai.azure.com` or `services.ai.azure.com`, with
exactly `/openai/v1` (optional trailing slash), no credentials, query, fragment,
or custom port. Private/custom-domain endpoints and sovereign-cloud suffixes
are not supported by this initial adapter.

`VICOOP_CODEX_AZURE_MODEL` is the underlying Codex-compatible model identifier,
not necessarily the deployment name. It becomes the runtime's model, overriding
the host's root model. `VICOOP_CODEX_AZURE_DEPLOYMENT` is the Azure deployment
name. The broker accepts only the selected logical model and substitutes the
pinned deployment in the upstream JSON body. For example, `gpt-5.4` can map to
`production-codex`. A caller's request for another model fails closed. Configure
a deployment whose underlying model matches the logical model and supports
Responses/compaction; validation of names cannot establish regional availability
or deployment capabilities.

Only the host broker sees `AZURE_OPENAI_API_KEY`; it injects `api-key` on the
pinned upstream request and never forwards the workload's authorization,
`api-key`, cookies or ChatGPT account headers. The workload retains the same
execution-scoped grant, private relay, native `send_file`, process cleanup and
conversation-resume paths used by direct OpenAI. No host Azure configuration or
credentials are staged in the container. API-key mode uses Codex's embedded
model catalog and never fetches the ChatGPT catalog.

The provider, key, endpoint, logical model, deployment and API version remain
pinned for the reader lifetime. Changes require a bridge restart. Authentication
errors and redirects are sanitized and never trigger fallback to OpenAI,
ChatGPT or another Azure account. Remove `OPENAI_API_KEY`, `OPENAI_BASE_URL`,
`AZURE_OPENAI_ENDPOINT`, Azure identity-token variables, and generic dated API
version settings from this host process; mixed settings are rejected. An
existing host `auth.json` is not consulted when explicit Azure settings exist.

### Migration and rollback

Stop the bridge before changing provider settings. Record the existing provider,
model/deployment mapping, image version and caller-state paths. Upgrade the
client and use a compatible caller image (the broker floor is stable Codex
0.153.4; see live evidence below for the version actually exercised).

Operators retiring custom Azure patches must transfer their resource endpoint,
API key, **logical model and deployment name** into these settings first. Keep
any host CLI configuration needed by standalone Codex; it is not copied to or
used as the caller's Azure provider. Remove patched provider routing from the
bridge and caller image, then initialize/validate the normal caller runtime and
restart with the host settings above. Verify inference and native attachments
before moving production traffic.

For rollback, stop the daemon, remove all `VICOOP_CODEX_AZURE_*` and
`AZURE_OPENAI_*` settings from its environment, restore the intended direct
OpenAI API key or host ChatGPT login (or restore the previously recorded patched
client/configuration), and restart. Keep caller storage; do not delete it as an
authentication migration step. Model/provider changes can make old transcripts
incompatible, so first test a fresh context, then an existing conversation.

### Azure validation evidence

Synthetic broker tests cover distinct logical/deployment names, endpoint and
configuration rejection, credential/header isolation, account pinning, both
Responses routes, sanitized authentication/rate-limit/server/redirect failures,
revocation, and no fallback. Existing direct OpenAI/ChatGPT tests remain in the
same suite. Shared execution tests cover concurrency, cancellation and resume.
These are not live-provider evidence.

A real validation must run the Azure caller runtime, complete inference, resume
an existing conversation, run concurrent contexts, cancel an active execution
and verify its grant is revoked. With `fileDelivery` enabled, have the model
create synthetic attachment bytes and call native `send_file`; an A2A consumer
must retrieve the bytes and verify the expected contents/hash both before and
after resume. Check workload environments, mounts, session files and emitted
artifacts/logs for credentials without printing the key. Record backend/client
versions and successful gates, and distinguish skipped gates from passed ones.
Live results are recorded separately by the integration harness; an existing
historical custom-provider run does not validate this implementation.

Provider references: [Azure Responses and compaction](https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/responses),
[Azure endpoint and deployment mapping](https://learn.microsoft.com/en-us/azure/foundry-classic/openai/how-to/switching-endpoints).
Billing eligibility (including promotional credits) is outside this transport
implementation and must be checked for the selected Azure deployment.

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
Existing credential-mounted runtimes are rejected. Stop the bridge daemon,
back up the old container's writable layer and record its image/mounts before
optional cleanup:

```sh
vicoop-client container legacy list
vicoop-client container legacy remove codex --preserve-volumes
vicoop-client container init codex
vicoop-client container validate
vicoop-client start --detach
```

Replace `codex` in the legacy remove command with the old runtime instance name.
Legacy named volumes and host workspace files are retained but are not copied
or assigned to any caller. There is no automatic rollout/session migration into
per-caller execution. `--name`, `--workspace` and `--reuse-state` are retired.
Initialization removes legacy `cwd`/`runtime_name` configuration after successful
validation. Old transcripts may still contain historical secrets; preserving
volumes does not scrub them. See [caller runtime configuration](caller-runtime.md)
for custom images and separate agent configurations.

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
