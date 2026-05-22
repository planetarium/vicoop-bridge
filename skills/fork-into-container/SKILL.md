---
name: vicoop-fork-into-container
description: Top up the per-backend vicoop-bridge runtime container with the parent agent's curated harness — its `skills/`, sub-agents, slash-commands, and project memory file (`CLAUDE.md` / `AGENTS.md`). Bootstraps the runtime container itself via `vicoop-client container init <kind> --from-host` if it's not already present, so the operator only needs to be logged in once. Use when the user says "fork into a container", "spawn an isolated copy with my skills", "컨테이너로 분기", "내 하네스까지 가져가서 격리된 에이전트로 띄워줘", "샌드박스에서 돌려".
allowed-tools: Bash
---

# Fork-into-Container

This skill is a thin layer on top of `vicoop-client container init`.
Upstream already handles **auth, image, and volume lifecycle** — it pulls
the operator's host creds (macOS Keychain or `~/.claude/.credentials.json`
or `~/.codex/auth.json`) straight into the runtime container's named
volume. What upstream intentionally does **not** carry is the operator's
*harness* — `skills/`, sub-agents, slash-commands, the project memory
file. That gap is what this skill fills.

## What you need before invoking

Just be **logged in once** on the host:

- `claude setup-token` (claude) or `codex login --device-auth` (codex)
- `vicoop-client auth login` (bridge owner session)

That's it. No env vars, no manually-passed tokens — `--from-host` reads
the right keychain entry / disk file itself.

## Invocation

```bash
bash "${CLAUDE_PLUGIN_ROOT:-$(dirname "$0")}/fork.sh"
```

Optional override:

| Var | Meaning |
|---|---|
| `VICOOP_FORK_KIND` | force `claude` or `codex` instead of auto-detect |

## What the script does

1. Detect parent kind from env / `~/.claude` vs `~/.codex` presence.
2. If `vicoop-runtime-<kind>` is **not** already running, invoke
   `vicoop-client container init <kind> --from-host`. Upstream pulls
   creds, installs the agent CLI, compat-checks the version.
3. Stage a curated payload to `mktemp -d`:
   - `skills/`, `agents/`, `commands/` subtrees
   - `CLAUDE.md` or `AGENTS.md`
   - Defensive `find -delete` for anything credential-shaped that a
     skill may have shipped inline.
4. `tar -C $STAGE -cf - . | docker exec -i -u node $CONTAINER bash -c "tar -C /data/creds/<kind> -xf -"`.
   Tar-pipe (not `docker cp`) so the extract runs as the `node` user
   and the agent CLI can traverse the files immediately.
5. Print the daemon-start command:
   `vicoop-client --backend <kind> --runtime container`
6. Emit `{container, kind, injected_into}` JSON for the parent agent
   to chain off of.

## What this skill does NOT do

- **Start the daemon.** The bridge client is a long-running process;
  the operator launches it in their own shell after this skill
  finishes. (Auto-starting from inside a skill is awkward and racy.)
- **Re-inject on every call.** Tar-extract overlays existing files;
  re-running the skill refreshes the harness in place. Removed files
  on the host stay in the container until the operator wipes the
  creds volume.
- **Carry MCP servers, `settings.json`, or hooks.** Those are commonly
  bound to host-absolute paths or sockets and don't survive the
  container boundary without rewriting; left out of the allowlist on
  purpose.

## Why this is much smaller than v1

The v1 prototype tried to spawn the bundled-direct container with a
half-dozen env vars (`VICOOP_BRIDGE_TOKEN`, `VICOOP_AGENT_ID`,
`CLAUDE_CODE_OAUTH_TOKEN`, …) hand-rolled by the operator. Upstream's
external-runtime profile + `container init --from-host` removed every
one of those — bridge auth lives in the host bridge client (it never
enters the container at all), and backend auth is auto-pulled. This
skill now just plugs the one remaining gap.
