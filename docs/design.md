# vicoop-bridge — Design

## 1. Problem

로컬/사설망에 있는 코딩 에이전트(OpenClaw, Claude Code, Codex 등)를 외부에서 **Google A2A 프로토콜**로 호출 가능하게 만든다. 방화벽 뒤에서도 동작해야 하므로 인바운드 포트 오픈은 가정하지 않는다.

## 2. Architecture

```
External A2A Client
        │  (A2A HTTP/JSON-RPC)
        ▼
┌─────────────────────────────┐
│  vicoop-bridge Server       │   공개 배포 (Fly.io 등)
│  - /.well-known/agent.json  │
│  - /agents/{id}/agent.json  │
│  - POST /agents/{id}/messages/send
│  - WS /connect   (clients)   │
└─────────────────────────────┘
        ▲  WebSocket (outbound from client)
        │
┌───────┴─────────────────────┐
│  vicoop-bridge Client       │   사설망
│  - backend: echo | openclaw | claude | codex
│  - backendKind + optional AgentCard override
│  - task lifecycle 번역       │
└─────────────────────────────┘
        │
        ▼
  실제 에이전트 프로세스 / API
```

- **Server**는 dispatch 로직을 에이전트 종류에 결합하지 않는다. 다만
  built-in backend의 AgentCard metadata는 `backendKind`로 canonical card를
  선택해 서버 배포만으로 갱신할 수 있다.
- **Client**가 에이전트별 변환을 담당. Claude Code/Codex 같은 CLI 에이전트는 태스크당 subprocess spawn과 각 CLI의 resume primitive로 세션 유지.
- 연결 방향은 항상 Client → Server (아웃바운드).

## 3. Repo Layout

```
vicoop-bridge/
├── docs/
│   └── design.md
├── packages/
│   ├── protocol/   # Server ↔ Client 프레임 타입 (shared)
│   ├── server/     # HTTP + WS 서버
│   └── client/     # 스탠드얼론 client 데몬 (backend 플러그인)
├── pnpm-workspace.yaml
└── package.json
```

## 4. Server ↔ Client Protocol (WS JSON frames)

**Client → Server**
- `hello`         — `{ backendKind?, agentCard?, version, token }`
- `task.status`   — `{ taskId, status }`
- `task.artifact` — `{ taskId, artifact }`
- `task.complete` — `{ taskId, result }`
- `task.fail`     — `{ taskId, error }`
- `pong`

**Server → Client**
- `task.assign`   — `{ taskId, contextId, content, card }`
- `task.cancel`   — `{ taskId }`
- `ping`

### 4.1 Disconnect handling (acknowledged task replay)

A `TaskBinding` is not tied to the connection that created it — it holds only
`agentId`, and outbound sends re-resolve the live socket at send time. So a
dropped WebSocket does not by itself invalidate an in-flight task.

Clients opt in by advertising `task-replay-v1` in `hello`. After authentication,
the server answers with `hello.ack`, then gives every `task.assign` a unique
`executionId`. The client adds that ID and a consecutive `seq` to each task frame,
retains the encoded frame until `task.ack`, and resends the same ID and sequence
after reconnecting. The server deduplicates acknowledged prefixes and fails the
task on a sequence gap. This generation key is required because A2A can reuse a
`taskId` across turns; output from an old turn must never complete a newer one.

When a negotiated client's socket closes, the server keeps the binding alive
for `BRIDGE_DISCONNECT_GRACE_MS` (default 30s) instead of failing the task at
once. Only a generation-correct, gap-free frame on the next authenticated
connection resumes the binding. An unresumed hold expires into exactly the
terminal that path always produced: `disconnected` for a drop, `superseded` for
a same-token reconnect.

Legacy clients do not receive `hello.ack`, execution IDs, or grace holds. They
retain the previous fail-immediately behavior, which keeps rolling server-first
deploys safe. A new client connected to an older server recognizes a legacy
`task.assign` and also uses the old fail-fast path.

The grace is therefore *how long to wait before declaring a client dead*, not a
cap on task duration; a long task is governed by
`BRIDGE_TASK_INACTIVITY_TIMEOUT_MS` as before.

Closes that are this server's own verdict rather than a transport failure skip
the hold: the app-level codes it issues (`4000`–`4999`) and a clean `1000`.
Since the code the server *observes* is not always the one it *sent* (a peer
that never echoes the close frame surfaces as `1006`), the intent is recorded
when the close is issued and takes precedence.

One app-level close is deliberately excepted. `4009` — a second daemon
authenticating with the same `CLIENT_TOKEN` — is *usually* the same client
coming back rather than a rival, and the server cannot tell the two apart
(`readyState` reports only what it has observed, and the client's own heartbeat
normally detects a dead path first). So a `4009` collision holds like any other
reconnect and expires as `superseded` if the task is never reclaimed. Operators
reading a delayed collision failure should expect that delay.

Setting `BRIDGE_DISCONNECT_GRACE_MS=0` disables the hold and restores the
previous fail-immediately behavior exactly — the rollback lever if holds ever
delay failover more than they save.

The client bounds unacknowledged output by frame count, encoded bytes, and age.
Exceeding a bound aborts and suppresses that run so the server fails it closed;
it never replays a suffix after dropping a prefix. The server keeps short-lived
terminal receipts so a terminal whose acknowledgement was lost can be
acknowledged again without reopening or completing a reused task ID.

Background: issue #474.

### 4.2 Caller context versions and trust boundary

Caller identity is an optional, bridge-owned field on `task.assign`. New
clients advertise both `caller-context-v2` and `caller-context-v1`; the server
chooses v2 first, falls back to the strict v1 shape for older clients, and
omits `caller` for clients supporting neither version.

The v2 wire shape is:

```json
{
  "caller": {
    "principal": { "id": "eth:0xabc" },
    "actor": { "id": "service:gateway" },
    "attestations": [
      {
        "credentialId": "urn:uuid:...",
        "issuer": "did:web:identity.example.com",
        "subject": "slack:T123/U456",
        "method": "urn:mentionable:auth:slack-workspace-member:v0.1"
      }
    ]
  }
}
```

`principal` is the effective security principal established by the bridge.
`actor` is present only for a distinct directly authenticated entity acting on
its behalf. `attestations` are verified external claims and remain attribution
data; verification alone does not make their subject a principal. The v1
adapter maps principal to `authenticated.principalId` and attestations to
`presented`; v1 cannot represent a distinct actor.

Both wire versions normalize to one canonical structured representation before
backend rendering or session scoping. Dynamic identity values are carried only
at user priority, while privileged prompts contain a static rule saying that
the values are inert data. Claude, Codex, and OpenClaw session isolation—and
the vicoop-codex fallback prompt-cache key—derive from a stable projection of
the canonical identity. The projection retains principal, actor, and each
attestation's issuer/subject/method/assurance/platform scope, but excludes
per-presentation `credentialId`, profile, and observed invocation values. It
also sorts and deduplicates attestations. Equivalent v1/v2 frames and freshly
issued credentials for the same identity therefore share scope, while a
security-relevant identity change still splits sessions.

OAuth token exchange is the authorization-capable exception to the otherwise
context-only attestation path. The RFC 8693 route, opaque-token lifecycle, and
replay store are profile-neutral; installed profiles derive the identity and
authorization context. The first installed profile is Mentionable v0.1. In
its direct-Connector topology, an exact
`(issuer, method, subject)` tuple must already exist in the target agent's
`allowed_callers`. After full assertion and client authentication, the bridge
sets principal to the platform subject, actor to the Connector DID, and retains
the collision-safe tuple key only as a server-side authorization binding.
Tasks persist those values plus the issuing profile identifier in dedicated
columns. Follow-up
operations require a resource/scope-constrained bearer, task-bound principal
and actor matches, and a still-active exact tuple; neither task ids nor context
ids are proof. Continuation-derived tokens are additionally restricted to the
verified `mentionable_task_id`.
Federated delivery therefore requires caller-context-v2. See
[`oauth-federation.md`](./oauth-federation.md) for the wire profile and
operator flow.

## 5. Client Backends

```bash
# OpenClaw (native integration)
vicoop-client start \
  --server wss://bridge.vicoop.xyz \
  --token $TOKEN \
  --backend openclaw

# Claude Code
vicoop-client start \
  --backend claude
  # internally: `claude -p --session-id <ctx> --resume ...`

# Codex CLI
vicoop-client start \
  --backend codex
  # internally: `codex app-server` (one persistent JSON-RPC over stdio process)

# Generic webhook
vicoop-client start \
  --backend webhook \
  --backend-url http://localhost:8080/agent \
  --card ./cards/custom.json
```

Shipped built-in backends (`echo`, `openclaw`, `claude`, `codex`) send a `backendKind`
and can use the bridge server's canonical AgentCard. `--card` is only needed
for operator overrides, older server compatibility, or custom backends.

각 backend는 공통 인터페이스를 구현:
```ts
interface Backend {
  handle(task: TaskAssign, emit: (frame: UpFrame) => void): Promise<void>;
  cancel(taskId: string): Promise<void>;
}
```

초기엔 **spawn-per-task** 만 지원. `maxConcurrency` 옵션으로 동시 태스크 제한. Process pool은 Phase 4로 미룬다.

## 6. External A2A Surface

Server는 기존 A2A v0.3 호출을 유지하면서 각 연결된 에이전트에 A2A v1을
별도 base URL로 함께 노출한다.

- `GET /.well-known/agent-card.json` — bridge admin agent의 v0.3 AgentCard
- `GET /agents/{id}/.well-known/agent-card.json` — 연결된 에이전트의 v0.3 AgentCard
- `POST /agents/{id}` — v0.3 JSON-RPC
- `GET /agents/{id}/v1/.well-known/agent-card.json` — 연결된 에이전트의 v1 AgentCard
- `POST /agents/{id}/v1` — v1 JSON-RPC
- `/agents/{id}/v1/*` — 같은 base URL을 쓰는 v1 HTTP+JSON operation
  (`message:send`, `message:stream`, `tasks`, `tasks/{taskId}`, cancel,
  subscribe, push-notification config, extended card)

v1 AgentCard의 `supportedInterfaces`는 `/agents/{id}/v1`을 JSONRPC와
HTTP+JSON 두 binding으로 광고한다. HTTP+JSON의 operation 이름은 고정된
`/v1` prefix가 아니라 이 owner-defined base URL에 상대적으로 붙는다.

## 7. Auth (미결)

후보:
- (A) Client: 정적 토큰, External client: API key
- (B) Client: 정적 토큰, External client: SIWE (vicoop 생태계 통합)
- (C) mTLS

**Phase 1 결정**: (A) 로 시작, Phase 4에서 SIWE 통합.

## 8. Roadmap

| Phase | 범위 |
|------|------|
| 1 (MVP) | `protocol` + `server` + `openclaw` backend, Fly.io 배포, 단일 client 연결 |
| 2 | `claude-cli`, `codex` backend |
| 3 | `webhook` backend + client SDK 분리 |
| 4 | 인증 강화 (SIWE), 동시성/process pool, 모니터링, 다중 에이전트 컨텍스트 공유 |

## 9. Open Questions

- AgentCard 업데이트 흐름 (client 재연결 vs. 별도 프레임)
- 여러 client가 같은 agent id로 붙으면? (active/standby? round-robin?)
- Task artifact 대용량 처리 (바이너리 / 파일) — 직접 업로드 vs. presigned URL
- Claude Code stdout 파싱 포맷 확정 (JSON stream mode?)
- Server 재시작 시 in-flight task 복구 정책

## 10. Out of Scope (for now)

- 에이전트 간 협업/오케스트레이션 (그건 A2A client 측 문제)
- 결제/x402 통합 (별도 레이어, a2a-x402-wallet 참조)
- UI/대시보드
