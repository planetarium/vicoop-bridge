# Claude Code telemetry (OTEL)

The `claude` backend runs the Claude Code CLI as a child process. That CLI
carries its own OpenTelemetry instrumentation, entirely separate from the
bridge's journal. This page is about getting it somewhere useful.

## Do you need it?

Maybe not, if all you want is the model question. Two things are already in the
journal at the default `info` level, with no collector and no configuration:

- **Which model served a task** — a line per CLI spawn, from the `system/init`
  event:

  ```text
  [claude] session init taskId=<id> model=claude-opus-4-8[1m] requested=claude-opus-4-8
  ```

  `requested=` is the model the bridge put on `--model`, and it appears only
  when there was one: openai-compat tasks carrying `envelope.model`. It is
  absent on the agentic path (which lets claude choose) and also when the
  requested id was not among this install's advertised models — that case is
  dropped and reported on its own `warn` line instead.

- **Silent model switches** — every non-`init` `system` event is logged, and a
  `model_refusal_fallback` (claude retrying your turn on a different model)
  warns with `from=` / `to=`.

Everything else on this page is what the journal does **not** give you:

- **Tokens and cost.** Token counts are parsed off the terminal `result`
  event's `modelUsage`, but they go into the openai-compat response envelope,
  not the journal — and only on that path. Cost is not computed at all. If you
  want either in your own records, OTEL is the route.
- **Per-request granularity.** The journal is per CLI spawn; OTEL emits an
  `api_request` record per underlying request, so a turn that retried
  internally is visible as several records.
- **`request_id`**, the Anthropic-side id worth quoting in a support thread,
  plus `duration_ms` / `effort` / `speed`.

Going the other way, OTEL does **not** report the *requested* model — only what
served. Only the bridge knows what was asked for, which is why the `session
init` line carries `requested=`.

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

Point the endpoint at any OTLP collector you already run.

You do not need to tune the export intervals for short tasks: the CLI flushes
on shutdown, so a run that exits well inside the default interval still
delivers everything. Verified on a ~6s task with the block above verbatim —
all log record types and all four metrics arrived, just batched into fewer
HTTP posts. `OTEL_LOGS_EXPORT_INTERVAL` / `OTEL_METRIC_EXPORT_INTERVAL`
(milliseconds) only change how promptly records show up *during* a long run.

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
OTEL's `session.id` is a value the bridge knows. Two caveats before you rely on
the join:

- **The journal only prints it at `debug`.** The session id appears in the
  `claude.spawn.start … argv=` line, which is `debug`-level, so at the default
  `info` you will not find it. Raise `VICOOP_CLIENT_LOG_LEVEL=debug` on the
  client if you need to correlate.
- **It is not one-to-one with tasks.** Follow-up tasks sharing an A2A
  `contextId` reuse the same claude session via `--resume`, so one `session.id`
  can cover several `taskId`s.

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
