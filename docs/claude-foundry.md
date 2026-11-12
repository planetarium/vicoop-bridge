# Claude caller containers with Microsoft Foundry

The caller-container broker can route Claude Messages and token-counting requests
through one explicitly selected Microsoft Foundry resource. The API key stays in
the host bridge process; the caller receives only an execution-scoped grant. This
is separate from Codex Azure OpenAI support and does not configure host-mode or
bundled-direct Claude processes.

## Setup

Use an existing Foundry Claude deployment and its resource API key. The bridge
supports **API keys only** for this provider. Microsoft Entra ID, Azure CLI login
and managed identity are deferred: an absent key fails startup rather than trying
those methods or a saved Anthropic login.

Configure the environment of the host process that starts the bridge daemon:

```sh
export CLAUDE_CODE_USE_FOUNDRY=1
export ANTHROPIC_FOUNDRY_RESOURCE=my-resource
# Alternative to RESOURCE (not both):
# export ANTHROPIC_FOUNDRY_BASE_URL=https://my-resource.services.ai.azure.com/anthropic
export VICOOP_CLAUDE_FOUNDRY_MODEL_MAP='{"claude-sonnet-4-6":"my-sonnet-deployment","claude-haiku-4-5-20251001":"my-haiku-deployment"}'
# Supply ANTHROPIC_FOUNDRY_API_KEY through your host secret manager/environment.
# Do not put the real key in shell history, agent settings, prompts or images.
vicoop-client container init claude
vicoop-client start --detach
```

Unset `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_AUTH_TOKEN` and
`ANTHROPIC_BASE_URL` in this environment. Any of these together with Foundry is an
error. Bedrock and Vertex flags are also rejected. Stale Foundry settings with
Foundry disabled fail startup, preventing accidental direct-provider fallback.

The base URL must use HTTPS and a single resource label under
`services.ai.azure.com`; only the resource root or `/anthropic[/]` is accepted.
Custom domains, private IP literals, sovereign clouds, extra paths, query strings,
userinfo, nonstandard ports and redirects are unsupported. Resource name and URL
are alternatives, not routing overrides. The broker appends `/anthropic` itself.

The model map is required, contains 1–32 entries, and maps exact Claude API IDs to
Azure deployment names. Keys must be `claude-haiku-*`, `claude-sonnet-*` or
`claude-opus-*`; values are 1–128 ASCII letters, digits, dots, underscores or
hyphens, beginning with a letter or digit. There are no implicit entries or
family-wide wildcards. Pin the agent's `--claude-model`/backend model configuration
to a mapped API ID. Include every exact model the installed CLI uses, including
background Haiku requests; dated IDs and undated IDs are distinct. Model aliases
such as `sonnet` are resolved by Claude Code before they reach this map. Upgrading
the CLI may change those resolved IDs; update the explicit map before upgrading.
The map does not change model capabilities or context limits: each Azure deployment
must serve the corresponding model. Do not map different model families to one
unrelated deployment.

Host `ANTHROPIC_DEFAULT_*_MODEL` settings are not forwarded into callers. Keep the
public model ID in the agent configuration, and put the Azure deployment name only
in the host map. The caller cannot select arbitrary deployments: unmapped models
and request-level `fallbacks` are rejected before any credential-bearing request.
The resource and map are immutable for the daemon lifetime. Restart the daemon to
change either or to replace an environment API key. Never rotate a key to a
different account while tasks are active.

## Protocol and isolation

The workload uses the existing local Anthropic-compatible broker transport. The
bridge translates the allowlisted model to its configured deployment and sends
POST `/anthropic/v1/messages` or `/anthropic/v1/messages/count_tokens`, with only
the existing optional `?beta=true` query. Authentication is `api-key`, with
`anthropic-version: 2023-06-01`; there is no Azure OpenAI `api-version` setting on
this provider path. No provider key, endpoint, model map or Foundry environment is
forwarded to Docker. Claude Code receives the ephemeral grant in
`ANTHROPIC_API_KEY` and a loopback `ANTHROPIC_BASE_URL`.

The existing broker strips caller credentials and routing headers, removes the
OAuth beta for API keys, and sanitizes provider error bodies/headers. Authentication
or configuration failure never retries through Anthropic or another resource.
Successful SSE/JSON bodies remain provider output and are not a general-purpose
redaction layer. The same per-execution limits, revocation, cancellation and
caller-container isolation apply. Resume obtains a new grant against the pinned
provider, not the previous execution's grant.

## Versions, validation and real integration check

The runtime retains the repository's Claude Code `>=2.0.0` gate. This is a version
admission rule, not a claim that every admitted CLI/model combination was tested
against Foundry. No native Claude Foundry mode is required inside the container;
model selection and supported Claude request features still depend on the CLI and
selected deployment. Keep an operator-tested image version pinned.

Synthetic Node tests cover resource/URL validation, conflicting authentication,
model translation, Messages/token-counting routes, host header substitution,
credential rotation/loss, no fallback, sanitized failures and real relay environment
isolation. Existing direct OAuth/API-key, cancellation and grant tests remain in
place. Run them after building the protocol workspace:

```sh
pnpm -r build
pnpm -r typecheck
pnpm exec tsx --test packages/client/src/claude-auth-broker.test.ts packages/client/src/claude-broker-spawn.test.ts
```

**Real Foundry caller-container inference is pending; synthetic success is not
live-provider evidence.** Before production rollout, use an isolated test agent
and existing Claude-enabled resource. Record the bridge revision, exact container
image/Claude version, resource identifier and deployment/model mapping (never the
key). With the host environment above, initialize the caller runtime, send an A2A
task asking Claude to write a synthetic nonce to `/workspace/output/foundry.txt`
and report it, and verify terminal `completed` plus the expected nonce. Resume the
same conversation and have it read that file. Inspect caller environment and
artifacts for provider credentials without printing secret values; retain only
boolean pass/fail results. The workload should see a `vbc_exec_` grant and no
Foundry key/resource configuration. Test a deliberately wrong key in a separate
test daemon: it must fail with no direct-provider inference. Restore the real
host key and restart after the negative test. Keep live result evidence separate
from mock test counts.

## Migration and rollback

Stop and drain the daemon before switching providers. Save the current nonsecret
agent config/image version and keep a separate backup of caller state. Remove
custom provider patches and host-to-container credential mounts only after this
broker path has passed the real integration check. Keep the resource, exact model
map and host key configuration: removing patches does not remove their required
configuration. Existing caller storage does not need a second adapter or credential
copy. Previously exposed credentials in old workspace/transcript data require
separate cleanup/rotation; this feature does not sanitize old files.

To roll back, stop/drain the daemon, unset `CLAUDE_CODE_USE_FOUNDRY`,
`ANTHROPIC_FOUNDRY_RESOURCE`, `ANTHROPIC_FOUNDRY_BASE_URL`,
`ANTHROPIC_FOUNDRY_API_KEY` and `VICOOP_CLAUDE_FOUNDRY_MODEL_MAP`, then restore the
chosen direct Anthropic host credential and compatible agent model configuration.
Restart with the recorded image/client version and validate a new task. Do not
switch an in-flight conversation's provider silently; use a new conversation for
the rollback check and retain the prior state for recovery.

Provider references: [Microsoft Claude Code setup](https://learn.microsoft.com/en-us/azure/foundry/foundry-models/how-to/configure-claude-code)
and [Anthropic Foundry protocol](https://platform.claude.com/docs/en/build-with-claude/claude-in-microsoft-foundry).
Azure billing and promotional credit eligibility must be checked separately for
Claude; this transport support makes no billing-eligibility guarantee.
