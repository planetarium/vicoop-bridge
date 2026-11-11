# Consumer consent and deferred continuation integration

The integrated regression in
`packages/server/src/consent-continuation-e2e.test.ts` connects the
[consumer consent contract](./consumer-consent-v1.md) to the
[deferred job contract](./deferred-jobs-v1.md).

It starts a real HTTP bridge, a WebSocket supplier fixture, a local HTTP
provider, and uses PostgreSQL for all durable state. The consumer sends A2A
requests over HTTP; it receives the stored proposal as a structured
`input-required` response and explicitly decides through the consent API.
The trusted host adapter claims execution before uploading a reference or
submitting a provider job. It registers a deferred job using the same
operation ID, version, digest and originating task/execution.

After the provider finishes, the test persists completion and destroys both
the bridge server and supplier connection. A new service instance resumes
from the database, dispatches a distinct task in the same authorized context,
and returns a file artifact. The consumer separately retrieves the task,
decodes the attachment and checks its SHA-256 digest.

## Run

Use a disposable PostgreSQL database. The schema creates roles and extensions,
so the setup user needs the appropriate local database privileges.

```sh
createdb vicoop_consent_e2e
export DATABASE_URL="postgres://localhost/vicoop_consent_e2e"
pnpm install --frozen-lockfile
pnpm -r build
pnpm --filter @vicoop-bridge/server exec tsx --test src/consent-continuation-e2e.test.ts
```

The focused test initializes its schema. To run the full existing server
suite, initialize the schema first because some older tests assume it exists:

```sh
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f packages/server/schema.sql
pnpm --filter @vicoop-bridge/server test
```

## Assertions

| Boundary | Evidence asserted by the test |
| --- | --- |
| Proposal visibility | Actual A2A response contains the structured proposal; authenticated pending lookup works |
| Consent | Wrong caller/context/digest and ordinary approval prose cannot authorize the operation |
| Denial and replacement | Rejected/canceled proposals cannot be claimed; stale approval cannot authorize another proposal |
| Single execution allowance | Concurrent claims yield exactly one `execute: true`; a new claim ID cannot repeat the attempt |
| Upload and submission | Provider observes zero calls before a successful claim, then one reference upload and one generation submission |
| Completion authenticity | Consumer credentials and a changed operation digest cannot report trusted completion |
| Durability | Completion survives a new bridge and supplier connection; repeated callbacks and claim retries create no extra provider calls |
| Routing and delivery | Successor task has the original caller/context, source task remains unchanged, and received attachment bytes match the expected digest |

The fixture has no real provider credentials and incurs no generation charges.
It does not run Claude or Codex, assess generation quality, or prove container
stop/start behavior. It tests the backend-neutral bridge contracts and normal
WebSocket dispatch path. Backend-specific native process and caller-container
coverage must be reported separately; this regression must not be cited as a
live Claude/Codex or fal test.

The host adapter is trusted to enforce the claim and use only the returned
stored request. These APIs do not sandbox a malicious executor that already
holds provider credentials. Reference-byte validation, provider retry policy
and reconciliation of an ambiguous paid submission remain executor duties.
