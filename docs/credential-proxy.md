# Host-held credentials for native service APIs

Caller-isolated Claude and Codex runtimes can opt into a host-side HTTP
credential proxy. The workload keeps using native API methods and SDK schemas;
the bridge inserts service authentication outside the container. There is no
operation registry or model-authored approval field.

This implements the credential-proxy direction discussed in #576. Operation
approval (#544/#575), durable paid-job reconciliation, and completion-triggered
continuation (#574) are separate work. This feature does not complete those
issues or the original broader acceptance criteria of #576.

## Operator configuration

Add `credentialProxy` to the relevant backend's existing `caller_runtime`:

```json
{
  "credentialProxy": {
    "services": [
      {
        "name": "fal",
        "origins": ["https://fal.run", "https://queue.fal.run", "https://rest.fal.ai"],
        "credential": { "file": "/srv/vicoop/secrets/fal-key" },
        "header": "Authorization",
        "prefix": "Key "
      },
      {
        "name": "github",
        "origins": ["https://api.github.com", "https://uploads.github.com"],
        "credential": { "env": "VICOOP_GITHUB_TOKEN" },
        "header": "Authorization",
        "prefix": "Bearer "
      }
    ]
  }
}
```

Only the host daemon reads the environment variable or file. Do not bake the
credential into the container image or mount its file through shared binds.
Files must be private regular files (mode 0600 or stricter), not symlinks, at
most 16 KiB. One final newline is removed. Credential values must be nonempty
printable ASCII without whitespace. Files are reread per request and may be
atomically replaced for rotation. Environment values are read from the daemon's
environment; changing an external shell requires restarting the daemon.
Missing/invalid credentials return a generic 503 without source paths or values.
OAuth refresh and request signing are not implemented.

Origins are exact canonical HTTPS origins, including a nondefault port when
needed, without a trailing slash. No arbitrary upstream is accepted from the
workload. Add backup API domains explicitly if an SDK uses them. Do not add
storage/CDN origins to a credential-bearing service unless they should receive
that service credential.

**All callers allowed to use this agent receive the configured services.**
Execution isolation does not implement per-caller credential selection or
privilege profiles. Register separate agents when their service grants differ.
Services have separate tokens, and each execution has a new set of brokers.
An execution token from another caller/context/execution cannot authenticate
against this execution's proxy. Server-authenticated caller/runtime routing is
inherited from the existing caller runtime; caller IDs in tool arguments have
no role in proxy authentication.

Defaults, shared across the services in one execution:

| Setting | Default | Allowed range |
| --- | --- | --- |
| `maxConcurrent` | 4 | 1–16 |
| `maxRequests` | 1024 | 1–100000 |
| `maxRequestBytes` | 64 MiB | 1 byte–1 GiB |
| `maxResponseBytes` | 256 MiB | 1 byte–1 GiB |
| `timeoutMs` | 300000 | 1000–3600000 |

The execution's own lifetime is also enforced. A limit reached after streaming
has begun terminates that transfer; a partial write may already have reached
the provider. Failure is not evidence that a paid submission did not happen.

## Workload interface

`VICOOP_CREDENTIAL_PROXY` is JSON keyed by service name. Each entry contains:

```json
{
  "url": "http://127.0.0.1:<execution-port>",
  "token": "<temporary execution credential>",
  "origins": ["https://api.github.com", "https://uploads.github.com"],
  "socketPath": "/tmp/vicoop-services-<random>/github.sock",
  "fetchModule": "/tmp/vicoop-services-<random>/fetch.mjs"
}
```

The hostname, paths and tokens are temporary. Read them each execution; do not
persist them as agent configuration. The host does not expose a TCP listener
or mount a host socket into the container. Container loopback/Unix sockets
travel over the existing execution-bound Docker stdio relay. Cancellation,
expiry and transport shutdown revoke service access alongside model access.
Runtime restart creates new endpoints; provider jobs are not tracked or resumed
by this proxy.

For direct HTTP, use `url + originalPath` with `Authorization: Bearer <token>`
(also accepts `token`, `Key`, or `x-api-key` token authentication). The default
destination is the service's first origin. Alternatively send the full original
HTTPS URL in `x-vicoop-target-url` and the token in `x-vicoop-proxy-token`.
The fal-compatible `x-fal-target-url` header is also accepted, but not together
with `x-vicoop-target-url`. The full destination must match a registered origin.

The Unix socket supports native clients retaining the upstream `Host`; it must
match a registered origin. CONNECT, WebSocket upgrades and non-HTTP protocols
are not supported. GET, HEAD, POST, PUT, PATCH, DELETE and OPTIONS use native
bodies and response statuses, including provider errors. Hop-by-hop headers,
cookies, credential headers and proxy controls are removed. Redirect responses
are returned as-is; the host never follows them or automatically retries.
Response bodies are streamed with backpressure; there is no model-specific JSON
parser, SSE requirement, or transparent body decompression.

Registered upstreams are trusted to handle their credentials correctly. They
receive the actual credential and could return it in a response body or encode
it into another capability. This proxy does not claim to sanitize arbitrary
upstream content. Known credential headers and response headers containing the
current raw credential are removed; bodies remain opaque. No request bodies,
response bodies or credential values are logged by the proxy.

## JavaScript SDKs

The generated module provides `createProxyFetch(service, options?)`. It routes
original absolute URLs through the service proxy, so pagination and separate
registered upload API origins do not require changing SDK methods. It follows
at most ten redirects, rechecks every destination and removes authentication
on cross-origin redirects. A streaming request body cannot be replayed across
a 307/308 redirect; it fails instead of buffering an unbounded copy.

```js
import { createFalClient } from "@fal-ai/client";
import { Octokit } from "@octokit/core";

const services = JSON.parse(process.env.VICOOP_CREDENTIAL_PROXY);
const { createProxyFetch } = await import(services.fal.fetchModule);

const fal = createFalClient({
  credentials: services.fal.token,
  fetch: createProxyFetch(services.fal, {
    // Explicit public/signed storage origins, sent directly WITHOUT host-key
    // injection. Populate for your provider/storage configuration.
    passthroughOrigins: ["https://v3.fal.media"],
  }),
});
const github = new Octokit({
  auth: services.github.token,
  request: { fetch: createProxyFetch(services.github) },
});
```

Passthrough origins must be HTTPS and explicitly listed by the caller. They
receive ordinary workload requests, never host credential injection. SDK-issued
upload tokens and signed URLs remain workload-visible. Unknown destinations
fail locally. Do not combine this fetch adapter with fal's `proxyUrl`: the
adapter expects original HTTPS URLs. For inference-only use, fal's alternative
`proxyUrl: {url: service.url, when: "always"}` with `credentials: service.token`
is supported, but its upload PUTs are not covered by that middleware.

SDK retries remain SDK behavior. In tested fal 1.10.1, queue methods supply
retry settings that override global `retry.maxRetries`; setting that global
field to zero is not a guarantee of one submission. Use application-level
submission reconciliation/approval for paid work. The bridge adds no retries.

## GitHub CLI

Use a temporary config directory rather than modifying persistent gh settings:

```sh
task_gh_dir="$(mktemp -d)"
export GH_CONFIG_DIR="$task_gh_dir"
export GH_TOKEN="$(node -e 'console.log(JSON.parse(process.env.VICOOP_CREDENTIAL_PROXY).github.token)')"
gh config set http_unix_socket "$(node -e 'console.log(JSON.parse(process.env.VICOOP_CREDENTIAL_PROXY).github.socketPath)')"
gh api user
gh api graphql -f 'query=query { viewer { login } }'
rm -rf "$task_gh_dir"
unset GH_CONFIG_DIR GH_TOKEN
```

The transport preserves the original Host and requires a registered destination.
No CA installation or MITM is needed. `GH_HOST` is not a proxy URL setting.
`git clone/push` uses a separate transport and is not provided by this feature.
Downloads redirected to unregistered hosts may fail through the gh socket;
the JS adapter's explicit passthrough support is separate.

## Verification scope

Tests pin `@fal-ai/client` 1.10.1 and `@octokit/core` 7.0.8 against local mock
upstreams: fal submit/status/result/upload and its native proxy setting;
Octokit REST/GraphQL, absolute pagination and release upload URLs. They do not
incur provider charges or write to GitHub. The gh test uses an installed CLI
when available (local verification: 2.97.0). It covers REST/GraphQL, not every
CLI command, artifact download, or Git transport.

The runtime test exercises the real relay and per-execution cleanup. Set
`VICOOP_CREDENTIAL_PROXY_TEST_IMAGE` to a caller image with Node and tini to
also run the Docker supervisor paths for both backend modes, without invoking
an LLM. This establishes transport coverage, not live Claude/Codex agent testing.
Full unmodified fal Python SDK support, TLS interception, HTTP/2 gRPC and
realtime WebSockets are not claimed.
