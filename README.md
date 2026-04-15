# vicoop-bridge

A2A Relay + Connector for exposing local coding agents (OpenClaw, Claude Code, Codex, …) as Google A2A-compliant remote agents.

Agents connect *outbound* to a public Relay via WebSocket, so they can sit behind NAT/firewalls while still being addressable by external A2A clients.

See [`docs/design.md`](./docs/design.md) for the full design.

## Connector Releases

Tagging the repository with `connector-v*` publishes a portable `vicoop-bridge-connector` bundle to GitHub Releases.

Example:

```bash
git tag connector-v0.1.0
git push origin connector-v0.1.0
```

After extracting the release bundle, run the connector with:

```bash
./bin/vicoop-connector --help
```

## Status

Pre-implementation. Design phase only.
