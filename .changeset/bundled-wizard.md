---
'@vicoop-bridge/client': minor
---

Add the interactive wizard branch (#244 case B) to the bundled
image's entrypoint. With this, a first-time operator can run

```
docker run -it -v vicoop-data:/data -v vicoop-work:/home/node/work \
  ghcr.io/planetarium/vicoop-bridge-client
```

and complete the entire setup (bridge sign-in, agent registration,
backend install + sign-in) inside the same `docker run`. After the
wizard finishes the entrypoint flows straight into daemon mode —
same image, same command, just with `-it` instead of `-d`.

The wizard is gated on three conditions, all of which have to hold:

- `/data/config.json` doesn't exist (fresh boot).
- None of `VICOOP_BRIDGE_TOKEN` / `VICOOP_AGENT_ID` /
  `VICOOP_BACKEND` is set (any of them signals headless intent;
  we don't want to launch a wizard mid-bootstrap and surprise the
  operator).
- stdin AND stdout are both TTYs.

Composition is intentionally thin: every operator-facing
operation goes through an existing `vicoop-client` subcommand or
the existing `install-backend.sh` recipe, so the wizard's only
real surface is the prompts and the transition. Nothing
duplicates logic from `setup` / `auth login` / `agent register`.

1. `vicoop-client auth login` — Google device-flow OAuth against
   the bridge. URL + code print to the operator's terminal.
2. Prompt for backend kind + agent id (default agent id =
   `hostname` so just-hit-enter still produces a valid
   registration).
3. `vicoop-client agent register --agent-id <id>` — mints the
   one-time AGENT_TOKEN and writes server_url / server_token /
   agent_id into config.json. The `backend` field comes from
   the prompt and gets jq-patched in.
4. `install-backend.sh <kind>` + the native OAuth helper for
   installable backends. claude → `claude setup-token`; codex →
   `codex login --device-auth`. Both inherit the entrypoint's
   TTY so URL+code flows reach the operator directly without
   needing `docker exec -it`.
5. Fall through to the existing daemon `exec`. No extra
   `docker run` needed.

Subsequent `docker start <container>` invocations skip the
wizard because config.json now exists on the named volume.

Manual e2e validated by running

```
docker pull ghcr.io/planetarium/vicoop-bridge-client:latest  # after merge
docker volume create vicoop-bundled-data
docker volume create vicoop-bundled-work
docker run --rm -it \
  -v vicoop-bundled-data:/data \
  -v vicoop-bundled-work:/home/node/work \
  ghcr.io/planetarium/vicoop-bridge-client
# follow the three steps it prints; daemon comes up automatically
```

Headless env-token path (#244 case A) is unchanged. Operators
who pass `-e VICOOP_BRIDGE_TOKEN=…` etc. skip the wizard and
keep the production-grade `docker run -d` shape.
