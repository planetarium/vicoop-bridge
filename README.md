# vicoop-bridge

A2A Server + Client for exposing local coding agents (OpenClaw, Claude Code, Codex, …) as Google A2A-compliant remote agents.

Agents connect *outbound* to a public Server via WebSocket, so they can sit behind NAT/firewalls while still being addressable by external A2A clients.

Docs:

- [`docs/design.md`](./docs/design.md) — architectural design
- [`docs/install-client.md`](./docs/install-client.md) — onboarding a new client against a deployed bridge
- [`docs/remote-testing.md`](./docs/remote-testing.md) — end-to-end testing against a deployed bridge
- [`docs/local-testing.md`](./docs/local-testing.md) — running both bridge and client from source
- [`docs/openclaw-e2e.md`](./docs/openclaw-e2e.md) — exercising the `openclaw` backend directly against the gateway Docker image

## Client Releases

Tagging the repository with `client-v*` publishes a portable `vicoop-bridge-client` bundle to GitHub Releases.

Example:

```bash
git tag client-v0.1.0
git push origin client-v0.1.0
```

Operators installing from a published release should follow
[`docs/install-client.md`](./docs/install-client.md) — the one-liner
installer plus SIWE/registerClient flow for obtaining a client token.

## Status

Pre-implementation. Design phase only.
