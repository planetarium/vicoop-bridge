---
'@vicoop-bridge/client': minor
---

claude backend: inject self-identity via `--append-system-prompt` so the
spawned `claude` recognises its own A2A mention (`@<agentId>@<host>` /
`acct:<agentId>@<host>`) as a self-reference and responds directly instead
of calling out to itself via a2a-wallet or any other outbound A2A skill.
Addresses the failure mode in #128 where a backend Claude tried to a2a-call
its own canonical address.

New `vicoop-client whoami` subcommand prints the agent's mention, acct,
A2A endpoint, A2A agent-card URL, and WebFinger URL — useful for operators
registering this agent on other agents' allowed-caller lists, sharing the
A2A endpoint with a caller, or pasting into the OpenClaw gateway persona
(OpenClaw's `chat.send` has no per-message system field, so its persona is
configured separately on the gateway). `--verify` actually performs the
WebFinger lookup to confirm the bridge resolves the acct; `--json` emits a
machine-readable record.
