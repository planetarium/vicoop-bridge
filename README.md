# vicoop-bridge

A2A Server + Client for exposing local coding agents (OpenClaw, Claude Code, Codex, …) as Google A2A-compliant remote agents.

Agents connect *outbound* to a public Server via WebSocket, so they can sit behind NAT/firewalls while still being addressable by external A2A clients.

See [`docs/design.md`](./docs/design.md) for the full design.

## Client Releases

Tagging the repository with `client-v*` publishes a portable `vicoop-bridge-client` bundle to GitHub Releases.

Example:

```bash
git tag client-v0.1.0
git push origin client-v0.1.0
```

After extracting the release bundle, run the client with:

```bash
./bin/vicoop-client --help
```

## Status

Pre-implementation. Design phase only.
