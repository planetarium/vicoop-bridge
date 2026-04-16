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
│  - backend: openclaw | claude-cli | codex | webhook
│  - AgentCard 제공            │
│  - task lifecycle 번역       │
└─────────────────────────────┘
        │
        ▼
  실제 에이전트 프로세스 / API
```

- **Server**는 에이전트 종류를 모른다. 순수 A2A 프록시 + 라우터.
- **Client**가 에이전트별 변환을 담당. Claude Code/Codex 같은 CLI 에이전트는 태스크당 subprocess spawn, `--resume` / `--session-id` 로 세션 유지.
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
- `hello`         — `{ agentCard, version, token }`
- `task.status`   — `{ taskId, status }`
- `task.artifact` — `{ taskId, artifact }`
- `task.complete` — `{ taskId, result }`
- `task.fail`     — `{ taskId, error }`
- `pong`

**Server → Client**
- `task.assign`   — `{ taskId, contextId, content, card }`
- `task.cancel`   — `{ taskId }`
- `ping`

## 5. Client Backends

```bash
# OpenClaw (native integration)
vicoop-client \
  --server wss://bridge.vicoop.xyz \
  --token $TOKEN \
  --backend openclaw \
  --card ./cards/openclaw.json

# Claude Code
vicoop-client \
  --backend claude-cli \
  --card ./cards/claude-code.json
  # internally: `claude -p --session-id <ctx> --resume ...`

# Codex
vicoop-client --backend codex --card ./cards/codex.json

# Generic webhook
vicoop-client \
  --backend webhook \
  --backend-url http://localhost:8080/agent \
  --card ./cards/custom.json
```

각 backend는 공통 인터페이스를 구현:
```ts
interface Backend {
  handle(task: TaskAssign, emit: (frame: UpFrame) => void): Promise<void>;
  cancel(taskId: string): Promise<void>;
}
```

초기엔 **spawn-per-task** 만 지원. `maxConcurrency` 옵션으로 동시 태스크 제한. Process pool은 Phase 4로 미룬다.

## 6. External A2A Surface

Server는 `@a2aproject/a2a-js` v0.3.x 스펙을 따른다.

- `GET /.well-known/agent.json` — Server 메타
- `GET /agents/{id}/agent.json` — 연결된 특정 에이전트의 AgentCard
- `POST /agents/{id}/messages/send` — A2A task 생성
- `POST /agents/{id}/messages/stream` — SSE 스트리밍
- `POST /agents/{id}/tasks/{taskId}/cancel`

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
