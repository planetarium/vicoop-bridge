# Claude Code telemetry (OTEL)

The `claude` backend runs the Claude Code CLI as a child process. That CLI
carries its own OpenTelemetry instrumentation, entirely separate from the
bridge's journal. This page is about getting it somewhere useful.

## Do you need it?

Often not. The bridge already puts the two most-asked-for facts in its own
journal, with no collector and no configuration:

- **Which model served a task** — one `info` line per task, from the CLI's
  `system/init` event, carrying both the served model and the requested one:

  ```text
  [claude] session init taskId=<id> model=claude-opus-4-8[1m] requested=claude-opus-4-8
  ```

- **Tokens and cost** — parsed off the terminal `result` event's `modelUsage`.

- **Silent model switches** — every non-`init` `system` event is logged, and a
  `model_refusal_fallback` (claude retrying your turn on a different model)
  warns with `from=` / `to=`.

Reach for OTEL when you want what those *can't* give you: per-**request**
granularity rather than per-task (a turn that retried internally shows up as
several `api_request` records), the Anthropic-side `request_id`, or
`duration_ms` / `effort` / `speed`.

Note that OTEL does **not** report the *requested* model — only what served.
Only the bridge knows what was asked for, which is why the `session init` line
above carries `requested=`.

## Do not use the console exporter

`OTEL_LOGS_EXPORTER=console` **produces no output at all** under the bridge —
measured on CLI 2.1.226 in the bridge's exact spawn shape (stream-json on
stdout, both streams piped): stdout was 14/14 valid stream-json lines with zero
non-JSON output, and stderr was 0 bytes. Nothing is being swallowed by the
bridge's stream parsing; nothing is emitted in the first place.

If you have `CLAUDE_CODE_ENABLE_TELEMETRY=1` and a console exporter set today,
you are collecting nothing. Use OTLP.

## Recipe

The client does not read these — they ride to the CLI child through
`process.env`, so set them wherever the client process gets its environment
(systemd unit, container env, shell). This is passthrough, not runtime config:
see the "Env vars are out of the runtime-config chain" note in
[`install-client.md`](./install-client.md).

```bash
CLAUDE_CODE_ENABLE_TELEMETRY=1
OTEL_LOGS_EXPORTER=otlp
OTEL_METRICS_EXPORTER=otlp
OTEL_EXPORTER_OTLP_PROTOCOL=http/json
OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318
```

Point the endpoint at any OTLP collector you already run. Short-lived tasks may
finish before the default export interval elapses — cut
`OTEL_LOGS_EXPORT_INTERVAL` / `OTEL_METRIC_EXPORT_INTERVAL` (milliseconds) if
you are debugging a single run and want a prompt flush.

## What arrives

| kind | records |
| --- | --- |
| logs | `api_request`, `assistant_response`, `user_prompt`, `hook_execution_start` / `hook_execution_complete`, `hook_registered`, `mcp_server_connection`, `plugin_loaded` |
| metrics | `claude_code.token.usage`, `claude_code.cost.usage`, `claude_code.session.count`, `claude_code.active_time.total` |

An `api_request` log record carries:

```text
model                                          the model that served this request
input_tokens, output_tokens,
  cache_read_tokens, cache_creation_tokens
cost_usd, cost_usd_micros, duration_ms
request_id                                     Anthropic-side; quote it in support threads
prompt.id, client_request_id
speed, effort, query_source
session.id                                     joins to the bridge's taskId — see below
user.id, user.email, user.account_id,
  user.account_uuid, organization.id           operator-account attributes
```

### Joining a record back to a task

The bridge mints the CLI session id itself and passes it as `--session-id`, so
OTEL's `session.id` is the same value the bridge logs alongside `taskId`. No
extra correlation work is needed.

### Operator-account attributes

Every record carries the operator's account identity (`user.email`,
`user.account_id`, `user.account_uuid`, `organization.id`). On a collector you
run yourself this is unremarkable — it is your own account, on your own host.
It matters if you forward the stream anywhere shared or off-host: filter those
attribute keys at the collector before it leaves.

This is a different channel from the caller-facing one. The bridge separately
prevents the model from disclosing operator-account metadata *in its responses*
to whoever is talking to the agent (`OPENAI_COMPAT_OPERATOR_PRIVACY_CLAUSE`);
that protection is about the response, and says nothing about where you route
telemetry.
