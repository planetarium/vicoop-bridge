---
name: vicoop-fork-into-container
description: Top up the per-backend vicoop-bridge runtime container with the parent agent's curated harness — its `skills/`, sub-agents, slash-commands, and project memory file (`CLAUDE.md` / `AGENTS.md`). Compatibility helper for an existing legacy shared runtime only; it does not bootstrap or inject into per-caller containers. Use when the user says "fork into a container", "spawn an isolated copy with my skills", "컨테이너로 분기", "내 하네스까지 가져가서 격리된 에이전트로 띄워줘", "샌드박스에서 돌려".
allowed-tools: Bash
---

# Fork-into-Container

This compatibility skill injects a curated harness only into an **existing legacy
shared runtime** (`vicoop-runtime-<kind>`). It does not support the new per-caller
mode. Current `container init` prepares per-caller configuration and does not
create a shared runtime, so the helper fails explicitly if the legacy target is
absent. Per-caller environment/harness setup remains separate follow-up work.

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
- **`vicoop-client` on `$PATH`** — install via the one-liner in
  [`docs/install-client.md`](../../docs/install-client.md) (downloads the
  released binary and drops it into `$INSTALL_DIR`), or build from
  source and symlink. The package is workspace-private — not on npm.
  The script invokes `vicoop-client` directly and aborts (`set -e`)
  at preflight if it's missing.
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

Parent kind (claude vs codex) is detected from the **install path of the
script itself** — running `~/.codex/skills/.../fork.sh` picks codex,
running `~/.claude/skills/.../fork.sh` picks claude. The script falls
back to checking host config-dir presence only when invoked from
outside either skill tree (e.g. a dev checkout); in the rare case both
`~/.claude` and `~/.codex` exist *and* the script is outside both
trees, you'll get a hard error with an instruction to set the override
below.

Optional env overrides:

| Var | Meaning |
|---|---|
| `VICOOP_FORK_KIND` | force `claude` or `codex` (only needed when invoked from outside a skill tree with both config dirs present) |

## What the script does

1. Detect parent kind from env / `~/.claude` vs `~/.codex` presence.
2. Require an existing `vicoop-runtime-<kind>` and validate its broker boundary
   through `vicoop-client container legacy validate <kind>`. If absent or unsafe,
   stop without starting a container or copying files.
3. Capture the container's running state. If stopped, `docker start`
   it for the inject window; restore it to its original state on exit
   so the upstream "stopped after init" convention isn't broken.
4. Stage a curated payload to `mktemp -d`:
   - `skills/`, `agents/`, `commands/` subtrees
   - `CLAUDE.md` (and its transitive `@`-imports — claude only;
     `AGENTS.md` has no equivalent directive) or `AGENTS.md`
   - Defensive `find -delete` for credential-shaped names and macOS
     AppleDouble `._*` sidecars.
5. Create `/data/sessions/<kind>/config` as `node` if absent, then tar-pipe
   the staged harness into that directory. This is the runtime's
   `CODEX_HOME` / `CLAUDE_CONFIG_DIR` on its persistent sessions volume;
   `/data/creds/<kind>` is temporary and must not hold the harness.
   Tar-pipe (not `docker cp`) so the extract runs as the `node` user
   and the agent CLI can traverse the files immediately.
6. Print the daemon-start command:
   `vicoop-client start --backend <kind> --runtime container --runtime-name <kind>`
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

## Legacy compatibility

Host authentication remains outside the runtime. The script checks the existing
runtime through `vicoop-client container legacy validate <kind>` before starting
or injecting. Credential-mounted or otherwise unsafe runtimes are rejected.
Back up old state before optional `container legacy remove NAME
--preserve-volumes`; there is no automatic migration into per-caller environments.
The current daemon no longer executes tasks in these legacy shared runtimes.
