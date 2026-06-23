---
name: vicoop-bridge-logs
description: Inspect the runtime logs of a deployed vicoop-bridge server on Fly.io. Captures the server's stdout and summarizes its structured JSON event stream — agent requests, task completions/failures, rejections (by reason), client connect/disconnect, and backend activity — converting timestamps to KST. Complements admin-API metrics by exposing live runtime events. Use when the user says "check bridge logs", "브리지 로그 봐줘", "who got rejected / 누가 거부됐는지", "is backend X getting traffic / 백엔드 가용성", "task 완료·실패 추적", "client connect 추적", "bridge runtime logs / 브리지 런타임 로그".
allowed-tools: Bash
---

# vicoop-bridge-logs

Read and summarize the **runtime logs** of a deployed `vicoop-bridge` **server**
(`packages/server`, the gateway deployed via `fly deploy`). Every server log line
is a single JSON object emitted by `logEvent()`
(`packages/server/src/log.ts`) — `{ ...fields, event, ts }` — so the logs are a
structured event stream, not free text. This skill captures a recent window with
`fly logs` and summarizes it.

> **Scope.** This is read-only log inspection of the **server** deployment. It does
> not SSH, mutate the app, or touch the database. App lifecycle (status, restarts,
> Postgres) is generic Fly.io work — use your Fly ops tooling for that.

## Install

This repo ships the skill source under `skills/vicoop-bridge-logs/`. Drop it into
your agent's skills tree on the host:

**Claude Code** (user-wide):

```bash
DEST=~/.claude/skills/vicoop-bridge-logs
mkdir -p "$DEST"
cp -R skills/vicoop-bridge-logs/. "$DEST/"
```

Project-scoped variant: replace `~/.claude` with `.claude` inside the repo you're
working in. **Codex**: replace `~/.claude` with `~/.codex`.

## Prerequisites

- `flyctl` authenticated, with access to the org that owns your bridge server app.
- `jq` for parsing the JSON event stream.
- The **Fly app name** of your server deployment. Set it once per session; every
  snippet below honors it and falls back to the conventional `vicoop-bridge-server`:

  ```bash
  export BRIDGE_APP="${BRIDGE_APP:-vicoop-bridge-server}"
  ```

  If you don't know it, `fly apps list` (filter for your bridge) or check the app's
  `fly.toml`.

## Core capture pattern

`fly logs --no-tail` prints the recent buffer then **blocks waiting for new lines**
— it does not exit on its own. Bound it:

```bash
# Linux (coreutils `timeout` available):
timeout 10 fly logs -a "$BRIDGE_APP" --no-tail 2>/dev/null

# macOS / no `timeout` — run in background and kill after a few seconds:
( fly logs -a "$BRIDGE_APP" --no-tail 2>/dev/null & p=$!; sleep 10; kill "$p" 2>/dev/null )
```

flyctl prints lines as `<ts> app[<machine>] <region> [info]{...json...}` with ANSI
color. Extract the JSON payload with `grep -oE '\{.*\}'` (this also drops the ANSI
noise) and parse with `jq`:

```bash
( fly logs -a "$BRIDGE_APP" --no-tail 2>/dev/null & p=$!; sleep 10; kill "$p" 2>/dev/null ) \
  | grep -oE '\{.*\}' | jq -c 'select(.event)'
```

The flyctl stderr line `Warning: Metrics token unavailable…` is harmless — that's
why the snippets drop stderr (`2>/dev/null`).

## Event reference

Derived from `logEvent(` call sites in `packages/server/src`. Every event carries
`event` and `ts`; the fields below are the notable extras. Optional fields are
omitted when absent.

### Request lifecycle

| `event`                  | source                | key fields | meaning |
|--------------------------|-----------------------|------------|---------|
| `agent_request`          | `http.tsx`            | `agentId`, `backend`, `hasAuth`, `ownerEmail?`, `principalId?`, `callerEmail?` | inbound `POST /agents/:id` accepted (the common "traffic" event) |
| `agent_request_rejected` | `agent-auth.ts`       | `agentId`, `reason`, `rejectionId`, `principalId?` | inbound request refused — **the key ops signal** (see reasons below) |
| `task_completed`         | `ws.ts`               | `agentId`, `backend`, `taskId`, `contextId`, `state`, `principalId?` | client reported the task terminal; `state` is usually `completed` |
| `task_failed_by_client`  | `ws.ts`               | `agentId`, `backend`, `taskId`, `contextId`, `errorCode`, `errorMessage`, `principalId?` | the connected agent failed the task |
| `task_unreachable`       | `executor.ts`         | `agentId`, `taskId`, `contextId`, `principalId?` | no live client to deliver the task to (agent dropped mid-flight) |

**`agent_request_rejected` reasons** (from `agent-auth.ts`, roughly in check order):
`missing_bearer`, `bad_token_prefix`, `invalid_token`, `invalid_siwe_bearer`,
`owner_session_on_caller_route`, `caller_not_authorized` (authenticated but not
permitted for that agent), `agent_not_connected`, `agent_unavailable` (no backend
registered for the agent id). The first six are auth failures; the last two mean
the target agent isn't reachable.

### Client / agent connection

| `event`               | source         | key fields | meaning |
|-----------------------|----------------|------------|---------|
| `client_connected`    | `ws.ts`        | `agentId`, `clientId`, `ownerPrincipal`, `backend`, `email?` | an operator's agent attached over the outbound WebSocket |
| `client_disconnected` | `ws.ts`        | `agentId`, `clientId?`, `ownerPrincipal?`, `backend?`, `email?` | that agent detached |
| `client_rejected`     | `ws.ts`        | `agentId`, `reason` | a WS handshake was refused (`agent id reserved`, `bad token`, `agent not allowed`, or a card/handshake-specific reason) |
| `client_collision`    | `registry.ts`  | `agentId`, … | two clients claimed the same agent id |

### Maintenance & internal errors

| `event`                          | source            | meaning |
|----------------------------------|-------------------|---------|
| `a2a_tasks_pruned`               | `index.ts`        | retention sweep deleted stale task contexts (`deleted`, `retentionDays`) |
| `agent_lookup_failed`            | `agent-auth.ts`   | agent registry/db lookup failed for a request |
| `task_persist_error`             | `executor.ts`     | best-effort task persistence failed (`taskId`, `error`) |
| `admin_persist_error`            | `admin.ts`        | admin-side persistence failed |
| `admin_api_error`                | `http.tsx`        | an admin API call errored |
| `caller_last_used_touch_failed`  | `auth/caller-token.ts` | best-effort `last_used_at` update failed (benign on read-only DB) |
| `registry_agent_listener_error`  | `registry.ts`     | a registry listener threw |

> This table is generated from the source; if you add a `logEvent(` call, add a row
> here in the same change. Re-derive the full list with:
> `grep -rhoE "logEvent\(['\"][a-zA-Z0-9_]+" packages/server/src | grep -oE "[a-zA-Z0-9_]+$" | sort -u`

**Privacy.** Events may carry `ownerEmail` / `callerEmail` / `email` and
`principalId` / `ownerPrincipal` (namespaced `apikey:…`, `eth:0x…`, `google:…`).
Caller-controlled strings are bounded via `truncate()` before logging, but treat a
captured window as containing operator/user identifiers — don't paste it into
public channels unredacted.

## Subcommands

Parse the subcommand from the request; default to `summary`.

### summary  (default)

Tally events over a recent window and report health, KST-localized.

```bash
( fly logs -a "$BRIDGE_APP" --no-tail 2>/dev/null & p=$!; sleep 10; kill "$p" 2>/dev/null ) \
  | grep -oE '\{.*\}' \
  | jq -rc 'select(.event) | {event, reason, state, backend}' \
  | sort | uniq -c | sort -rn
```

Report: counts per `event` (per `reason` for rejections, per `state` for tasks),
which backends are active, last activity time (max `ts`) **converted to KST
(UTC+9)**, and any error-class events present.

### rejections

The most common reason to read these logs.

```bash
( fly logs -a "$BRIDGE_APP" --no-tail 2>/dev/null & p=$!; sleep 10; kill "$p" 2>/dev/null ) \
  | grep -oE '\{.*\}' \
  | jq -rc 'select(.event=="agent_request_rejected") | "\(.ts)\t\(.reason)\t\(.agentId)\t\(.principalId // "-")\t\(.rejectionId)"'
```

Group by `reason` + `agentId`. `agent_unavailable` / `agent_not_connected` → the
backend agent isn't attached (cross-check `client_connected` for that `agentId`).
`caller_not_authorized` and the auth-failure reasons → report the offending
`principalId`.

### backend \<name\>

Filter to one backend/agent (e.g. `claude`, a codex backend, `inline`).

```bash
( fly logs -a "$BRIDGE_APP" --no-tail 2>/dev/null & p=$!; sleep 10; kill "$p" 2>/dev/null ) \
  | grep -oE '\{.*\}' \
  | jq -rc --arg b NAME 'select(.event and (.backend==$b or ((.agentId // "")|test($b)))) | "\(.ts)\t\(.event)\t\(.agentId)\t\(.state // .reason // "-")"'
```

Replace `NAME`. Answers "is backend X getting traffic / completing tasks / being
rejected?".

### tail [seconds]

Bounded live follow (default 15s) — same kill-guard so it never blocks:

```bash
( fly logs -a "$BRIDGE_APP" 2>/dev/null & p=$!; sleep 15; kill "$p" 2>/dev/null )
```

(Without `--no-tail` it follows new lines.) Use when watching a deploy or
reproducing a live rejection.

### errors

Surface non-routine activity: failures, rejections, and internal `*_error` events.

```bash
( fly logs -a "$BRIDGE_APP" --no-tail 2>/dev/null & p=$!; sleep 10; kill "$p" 2>/dev/null ) \
  | grep -oE '\{.*\}' \
  | jq -rc 'select(.event | test("rejected|failed|error|unreachable|collision")) | {ts, event, reason, errorCode, agentId}'
```

## Tips

- Always convert `ts` (ISO-8601 UTC) to **KST (UTC+9)** in summaries.
- The capture only holds the recent buffer; `fly logs` has no start-time flag on
  the CLI. For historical lookups use the Fly dashboard log search.
- Empty output usually means the machine is stopped or idle, not an error — confirm
  with `fly status -a "$BRIDGE_APP"`.
- A recurring non-JSON `MaxListenersExceededWarning` line may appear; it's a Node
  runtime warning surfaced on stdout, not a per-request failure. The JSON-only
  snippets above (`grep -oE '\{.*\}'`) skip it.
