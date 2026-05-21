# Running vicoop-bridge — bundled-direct container profile

This document covers the **bundled-direct deployment profile**: a single
container image (`container/bundled/Dockerfile`) hosting both the bridge
client and the agent CLI install machinery. The headless / env-driven
path is described below; an interactive setup wizard for first-time
operators is on a separate branch and not yet merged.

An alternative deployment profile — **external-runtime** ([#249][249]) —
keeps the bridge client bare-metal on the host and spawns per-backend
agent runtime containers via `docker exec`. The two profiles coexist;
choose whichever fits your deployment. This doc is the bundled-direct
side ([#244][244]).

[244]: https://github.com/planetarium/vicoop-bridge/issues/244
[249]: https://github.com/planetarium/vicoop-bridge/issues/249

## Why a container

The bridge client spawns agent CLIs (claude code, codex, openclaw) as
subprocesses; on bare metal those subprocesses have unrestricted access to
the host's filesystem, network, and user session. Wrapping the client in
an OCI container with an outbound-allowlist firewall (`init-firewall.sh`)
limits the blast radius without the host-sandbox trust gaps of
firejail/bubblewrap. The bridge client always connects outbound to the
bridge server, so the container exposes zero inbound ports.

## Image

- Registry: `ghcr.io/planetarium/vicoop-bridge-client`
- Tags: `:<client-semver>` and `:latest`, pushed by `release.yml` on
  every changeset-driven release
- Platforms: `linux/amd64` (arm64 follow-up — see PR 1 notes in #244)
- Base: `node:20-bookworm-slim`
- Size: ~250 MB before any agent CLI is installed

## Quick start

You need three things:

1. A bridge **client token** + **agent ID** (issued by an operator running
   `vicoop-client auth login` + `vicoop-client agent register` on a host
   with a TTY — see [`docs/install-client.md`](./install-client.md)).
2. The bridge server URL (defaults to `wss://vicoop-bridge-server.fly.dev`).
3. Tokens for whichever backend you'll use:
   - claude: `CLAUDE_CODE_OAUTH_TOKEN` (run `claude setup-token` once on
     a TTY host — see [Anthropic's docs][anthropic-token]) or
     `ANTHROPIC_API_KEY`
   - codex: `OPENAI_API_KEY`
   - openclaw: a reachable gateway URL (mount-side config; see below)
   - echo: no tokens needed (smoke testing only)

[anthropic-token]: https://code.claude.com/docs/en/authentication

Then:

```bash
docker volume create vicoop-data
docker volume create vicoop-work

docker run -d --restart unless-stopped \
  --name vicoop-bridge \
  --cap-add NET_ADMIN --cap-add NET_RAW \
  -e VICOOP_BRIDGE_TOKEN=<your client token> \
  -e VICOOP_AGENT_ID=<your agent id> \
  -e VICOOP_BACKEND=claude \
  -e CLAUDE_CODE_OAUTH_TOKEN=<claude OAuth token> \
  -v vicoop-data:/data \
  -v vicoop-work:/home/node/work \
  ghcr.io/planetarium/vicoop-bridge-client:latest
```

On first start the entrypoint:

1. Sees `/data/config.json` is absent → reads the bootstrap env vars and
   generates one.
2. Installs the backend CLI into `/data/agents/<kind>/` (claude / codex
   via npm; openclaw is no-op because the gateway runs out-of-process).
3. Applies the outbound-allowlist firewall (if `NET_ADMIN` was granted).
4. Hands off to `vicoop-client` daemon mode.

On every subsequent start the entrypoint skips bootstrap and just
re-runs the firewall + compatibility check.

## Volumes

Two named volumes, by design (see #244 for the rationale):

| Mount | What lives there |
|-------|-------------------|
| `/data` | `config.json`, `installed.json`, `agents/<kind>/...`, `creds/claude/`, `creds/codex/` |
| `/home/node/work` | Working directory the agent CLIs operate in. Bind-mount a host path if you want operator visibility into the agent's edits. |

The image sets `CLAUDE_CONFIG_DIR=/data/creds/claude` and
`CODEX_HOME=/data/creds/codex` so each agent CLI's native credential
location ends up inside the single `/data` volume. Operators only have
to manage two mounts.

## Environment variables

### Bootstrap (required on first start, ignored thereafter)
| Var | Required | Notes |
|---|---|---|
| `VICOOP_BRIDGE_TOKEN` | yes | client token issued by `vicoop-client agent register` |
| `VICOOP_AGENT_ID` | yes | UUID also from `agent register` |
| `VICOOP_BACKEND` | yes | one of `echo`, `claude`, `codex`, `openclaw`, `vicoop-codex` |
| `VICOOP_BRIDGE_URL` | no | defaults to `wss://vicoop-bridge-server.fly.dev` |

### Backend tokens (read directly by each CLI at runtime — not by the entrypoint)
| Var | Backend | Notes |
|---|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` | claude | long-lived OAuth token from `claude setup-token` |
| `ANTHROPIC_API_KEY` | claude | alternative to OAuth |
| `OPENAI_API_KEY` | codex | required when `VICOOP_BACKEND=codex` |

Env vars are consulted only during the one-time bootstrap. After
`/data/config.json` exists, the daemon reads its config from there and
ignores `VICOOP_BRIDGE_*` env vars. (Backend-process env vars like
`CLAUDE_CODE_OAUTH_TOKEN` still apply because each agent CLI reads them
itself.)

### Operational knobs
| Var | Notes |
|---|---|
| `VICOOP_SKIP_FIREWALL=1` | Skip `init-firewall.sh` even when CAP_NET_ADMIN is granted. Useful for dev or for operators running their own host-side network policy. |
| `VICOOP_EXTRA_ALLOW_DOMAINS` | Space-separated FQDNs to add to the outbound allowlist (e.g. a self-hosted LLM endpoint). See "Outbound allowlist" below. |

## Outbound allowlist

The default allowlist (resolved by DNS at container start):

- `registry.npmjs.org` — agent CLI install / upgrade
- `github.com`, `objects.githubusercontent.com`, `codeload.github.com` —
  GitHub asset downloads; `api.github.com` and the rest of GitHub's
  published CIDR ranges
- `api.anthropic.com` — claude code's LLM endpoint
- `api.openai.com` — codex's LLM endpoint
- `<bridge-server-host>` — derived from `VICOOP_BRIDGE_URL`

Extend it via:

```bash
docker run ... \
  -e VICOOP_EXTRA_ALLOW_DOMAINS="my-llm.example.com mirror.example.org" \
  ghcr.io/planetarium/vicoop-bridge-client
```

If `--cap-add NET_ADMIN` isn't granted, the entrypoint logs a warning
and skips `init-firewall.sh` — the container still works but operates
with the runtime's default network policy (typically: outbound open).

## Troubleshooting

### Install a specific backend version

```bash
docker exec vicoop-bridge \
  /usr/local/lib/vicoop-bridge/install-backend.sh claude@2.1.146
```

`install-backend.sh` writes the new version to `/data/installed.json`
which the entrypoint reads on next boot to compat-check against the
running bridge client's supported range.

### Inspect the bridge client's manifest

```bash
docker exec vicoop-bridge vicoop-client info
```

Emits `{version, imageVersion, backends: {<kind>: {supportedRange, installable}}}`.
`docker exec` works because `info` is a passthrough subcommand — the
entrypoint doesn't gate on config existence for it.

### Self-upgrade is disabled inside the container

```bash
$ docker exec vicoop-bridge vicoop-client upgrade
error: running inside vicoop-bridge container image (X.Y.Z); self-upgrade is disabled
       because the binary lives in the image layer and will revert on container recreate.
error: to update, bump the image tag:
error:   docker pull ghcr.io/planetarium/vicoop-bridge-client:<tag>
error:   docker compose up -d   # or restart the container
```

This is intentional: the binary lives in the image layer, so an overlay
write doesn't survive container recreation. Bump the image tag instead.

### Image bump rejected by compat check

If the new image's `vicoop-client info` reports a tighter `supportedRange`
than the installed backend version, the entrypoint refuses to start:

```text
backend 'claude' version 2.0.5 is outside this image's supported range '>=2.1.0'. To fix:
    docker exec <container> /usr/local/lib/vicoop-bridge/install-backend.sh claude@<version-in-range>
or pull a newer / older image whose supportedRange covers the installed version.
```

Run the suggested `install-backend.sh` then restart.

## Stronger isolation (optional)

The image runs under `runc` by default. Operators wanting kernel-level
isolation on top of the container boundary can swap to gVisor (`runsc`)
without any image changes — Modal uses the same approach for the OpenAI
Agents SDK, Daytona ships Kata/Sysbox as the upgrade tier. Configure the
runtime per your orchestrator's documentation (Docker daemon
`runtimes`, k8s RuntimeClass, etc.) — the bridge client image works
unchanged.
