# @vicoop-bridge/client

## 0.10.0

### Minor Changes

- f995db4: claude backend: inject self-identity via `--append-system-prompt` so the
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

- a390f51: Switch release tag format from `client-v<version>` to the Changesets monorepo
  standard `@vicoop-bridge/client@<version>`. `install.sh`, `vicoop-client
upgrade`, and the release workflow now target the new format only; the prior
  `client-v*` releases remain on GitHub but are no longer extended. `--version`
  accepts a bare semver (`0.9.1`), `v0.9.1`, or the full new tag.

## 0.9.0

### Minor Changes

- Split owner login from client setup and add one-step setup support for creating client tokens, writing daemon env files, and optionally configuring allowed callers.
