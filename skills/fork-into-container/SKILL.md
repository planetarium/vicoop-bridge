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

## Install

This repo just ships the skill source under `skills/fork-into-container/`.
To actually use it, drop it into your agent's skills tree on the host:

**Claude Code** (user-wide):

```bash
DEST=~/.claude/skills/vicoop-fork-into-container
mkdir -p "$DEST"
cp -R skills/fork-into-container/. "$DEST/"
chmod +x "$DEST/fork.sh"
```

Project-scoped variant: replace `~/.claude` with `.claude` inside the repo
you're working in.

**Codex**:

```bash
DEST=~/.codex/skills/vicoop-fork-into-container
mkdir -p "$DEST"
cp -R skills/fork-into-container/. "$DEST/"
chmod +x "$DEST/fork.sh"
```

## Prerequisites

- **`docker`** reachable from the parent shell (`docker info` works)
- **`vicoop-client` on `$PATH`** — install with `npm i -g @vicoop-bridge/client`
  or symlink the binary out of a built workspace checkout. The script
  invokes `vicoop-client` directly and aborts (`set -e`) at preflight if
  it's missing.
- **One-time auth on the host** (nothing to re-export per invocation):
  - `claude setup-token` (claude) or `codex login --device-auth` (codex)
  - `vicoop-client auth login` (bridge owner session)
- **A registered bridge agent** via `vicoop-client agent register`. The
  skill itself doesn't read the agent id / client token — they sit on
  disk for the daemon launch step that follows.

## Invocation

The skill ships one script, `fork.sh`, alongside this SKILL.md. It takes
no positional arguments; behavior is fully auto-detected or env-driven
(see the env table below).

When the agent runtime invokes the skill, it already knows the skill's
directory and runs `fork.sh` from there — no environment plumbing needed.

For manual invocation from a shell, point at the installed path:

```bash
# Claude install path:
bash ~/.claude/skills/vicoop-fork-into-container/fork.sh

# Codex install path:
bash ~/.codex/skills/vicoop-fork-into-container/fork.sh
```

Optional env overrides:

| Var | Meaning |
|---|---|
| `VICOOP_FORK_KIND` | force `claude` or `codex` instead of auto-detect |

## What the script does

1. Detect parent kind from env / `~/.claude` vs `~/.codex` presence.
2. If `vicoop-runtime-<kind>` is **not** present at all, invoke
   `vicoop-client container init <kind> --from-host`. Upstream pulls
   creds, installs the agent CLI, compat-checks the version, and (per
   #271) leaves the container stopped.
3. Capture the container's running state. If stopped, `docker start`
   it for the inject window; restore it to its original state on exit
   so the upstream "stopped after init" convention isn't broken.
4. Stage a curated payload to `mktemp -d`:
   - `skills/`, `agents/`, `commands/` subtrees
   - `CLAUDE.md` (and its transitive `@`-imports — claude only;
     `AGENTS.md` has no equivalent directive) or `AGENTS.md`
   - Defensive `find -delete` for credential-shaped names and macOS
     AppleDouble `._*` sidecars.
5. `tar -C $STAGE --no-xattrs -cf - . | docker exec -i -u node $CONTAINER bash -c "tar -C /data/creds/<kind> -xf -"`.
   Tar-pipe (not `docker cp`) so the extract runs as the `node` user
   and the agent CLI can traverse the files immediately.
6. Print the daemon-start command:
   `vicoop-client --backend <kind> --runtime container --runtime-name <kind>`
7. Emit `{container, runtime_name, kind, injected_into}` JSON for the
   parent agent to chain off of.

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
