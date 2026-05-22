#!/usr/bin/env bash
# vicoop fork-into-container — inject the parent agent's curated harness
# (skills/, agents/, commands/, CLAUDE.md or AGENTS.md) into the
# per-backend runtime container managed by `vicoop-client container`.
#
# Auth, image, volume lifecycle are all delegated to upstream:
#   `vicoop-client container init <kind> --from-host`
# already reads creds from the host Keychain / disk and copies them
# into the runtime container's creds volume. This script's only job is
# to top-up the *harness* pieces that upstream intentionally doesn't
# carry.
#
# See SKILL.md for the user-facing contract.

set -euo pipefail

log() { printf '[fork] %s\n' "$*" >&2; }
die() { log "ERROR: $*"; exit 1; }

# ── detect parent kind ────────────────────────────────────────────────────
detect_kind() {
    local has_claude=0 has_codex=0
    [[ -n "${CLAUDE_CONFIG_DIR:-}" || -d "$HOME/.claude" ]] && has_claude=1
    [[ -n "${CODEX_HOME:-}"        || -d "$HOME/.codex"  ]] && has_codex=1
    if (( has_claude && ! has_codex )); then echo claude; return; fi
    if (( has_codex  && ! has_claude )); then echo codex;  return; fi
    if (( has_claude && has_codex )); then
        log "both ~/.claude and ~/.codex present — defaulting to claude."
        log "set VICOOP_FORK_KIND=codex to override."
        echo claude; return
    fi
    die "could not detect parent kind — set VICOOP_FORK_KIND=claude|codex"
}

KIND="${VICOOP_FORK_KIND:-$(detect_kind)}"
case "$KIND" in claude|codex) ;; *) die "unsupported VICOOP_FORK_KIND='$KIND' (expected claude|codex)" ;; esac
log "parent kind: $KIND"

case "$KIND" in
    claude) SRC_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"; MEMORY_FILE="CLAUDE.md" ;;
    codex)  SRC_DIR="${CODEX_HOME:-$HOME/.codex}";          MEMORY_FILE="AGENTS.md" ;;
esac
[[ -d "$SRC_DIR" ]] || die "source config dir not found: $SRC_DIR"
log "source: $SRC_DIR"

# ── preflight ─────────────────────────────────────────────────────────────
command -v docker         >/dev/null 2>&1 || die "docker not found in PATH"
command -v vicoop-client  >/dev/null 2>&1 || die "vicoop-client not found in PATH (install: https://github.com/planetarium/vicoop-bridge)"
docker info >/dev/null 2>&1 || die "docker daemon not reachable"

CONTAINER="vicoop-runtime-$KIND"
TARGET="/data/creds/$KIND"

# ── ensure runtime container exists (delegates auth + image + volume) ──────
if docker inspect "$CONTAINER" >/dev/null 2>&1; then
    log "runtime container present: $CONTAINER (reusing)"
else
    log "runtime container absent — bootstrapping via vicoop-client container init"
    vicoop-client container init "$KIND" --from-host
fi

# ── bring container up only for the inject window ────────────────────────
# Upstream `container init` (post-#271) leaves the runtime stopped; the
# bridge daemon's RuntimeContainer.start() will bring it up at launch.
# `docker exec` for inject needs it running *now* though — so start it
# if we found it stopped, and put it back the way we found it on exit
# (matches the state convention upstream introduced).
WAS_RUNNING=0
if docker inspect "$CONTAINER" --format '{{.State.Running}}' 2>/dev/null | grep -q true; then
    WAS_RUNNING=1
fi
if (( ! WAS_RUNNING )); then
    log "starting $CONTAINER for inject (was stopped)"
    docker start "$CONTAINER" >/dev/null
fi

cleanup() {
    [[ -n "${STAGE:-}" ]] && rm -rf "$STAGE"
    if (( ! WAS_RUNNING )); then
        log "restoring $CONTAINER to stopped state"
        docker stop "$CONTAINER" >/dev/null 2>&1 || true
    fi
}
trap cleanup EXIT

# ── stage curated harness ─────────────────────────────────────────────────
# Allowlist only — credentials live in upstream's --from-host path,
# session/project state stays host-side on purpose.
STAGE="$(mktemp -d -t vicoop-fork.XXXXXX)"
log "staging at: $STAGE"

for d in skills agents commands; do
    if [[ -d "$SRC_DIR/$d" ]]; then
        cp -R "$SRC_DIR/$d" "$STAGE/$d"
        log "  + $d/"
    fi
done
if [[ -f "$SRC_DIR/$MEMORY_FILE" ]]; then
    cp "$SRC_DIR/$MEMORY_FILE" "$STAGE/$MEMORY_FILE"
    log "  + $MEMORY_FILE"
    # Claude Code's CLAUDE.md supports `@<path>` import directives
    # that pull other files in at parse time. Codex's AGENTS.md has
    # no equivalent, so we only resolve imports for claude.
    #
    # Policy: only follow imports that resolve inside SRC_DIR — anything
    # outside (e.g. `@~/Documents/notes.md`) is a host coupling we don't
    # carry into the container. Cap recursion at depth 5 (matches the
    # upstream parser) and skip lines inside ``` fences. If python3
    # isn't available the resolver is skipped with a warning; the file
    # itself still travels, just without its imports.
    if [[ "$KIND" == "claude" ]]; then
        if command -v python3 >/dev/null 2>&1; then
            python3 - "$SRC_DIR" "$STAGE" "$MEMORY_FILE" <<'PY' 2>&1 | sed 's|^|[fork]   |' >&2
import os, re, sys
src   = os.path.realpath(sys.argv[1])
stage = os.path.realpath(sys.argv[2])
root  = sys.argv[3]
MAX_DEPTH = 5
IMPORT_RE = re.compile(r'^[\t ]*@(\S+)')
FENCE_RE  = re.compile(r'^[\t ]*```')
seen = set()
def walk(path, depth):
    rp = os.path.realpath(path)
    if rp in seen:
        return
    seen.add(rp)
    if depth > MAX_DEPTH:
        print(f'WARN: depth >{MAX_DEPTH} at {os.path.relpath(rp, src)}; stopping recursion')
        return
    try:
        with open(rp, encoding='utf-8', errors='replace') as f:
            in_fence = False
            for line in f:
                if FENCE_RE.match(line):
                    in_fence = not in_fence
                    continue
                if in_fence:
                    continue
                m = IMPORT_RE.match(line)
                if not m:
                    continue
                ref = os.path.expanduser(m.group(1))
                base = os.path.dirname(rp)
                ref_abs = os.path.realpath(os.path.join(base, ref))
                if not (ref_abs == src or ref_abs.startswith(src + os.sep)):
                    print(f'WARN: skip @{m.group(1)} from {os.path.relpath(rp, src)}: '
                          f'resolves outside SRC_DIR ({ref_abs})')
                    continue
                if not os.path.isfile(ref_abs):
                    print(f'WARN: @{m.group(1)} not found at {ref_abs}')
                    continue
                rel = os.path.relpath(ref_abs, src)
                dest = os.path.join(stage, rel)
                os.makedirs(os.path.dirname(dest) or stage, exist_ok=True)
                with open(ref_abs, 'rb') as r, open(dest, 'wb') as w:
                    w.write(r.read())
                print(f'+ {rel} (@-import via {os.path.relpath(rp, src)})')
                walk(ref_abs, depth + 1)
    except OSError as e:
        print(f'WARN: could not read {rp}: {e}')
walk(os.path.join(src, root), 0)
PY
        else
            log "  WARN: python3 not found — @-imports inside $MEMORY_FILE are not followed"
        fi
    fi
fi

# Defensive scrub — a skill or agent may have shipped a credential
# inline; cheap insurance on top of the allowlist. The `._*` entries
# are macOS AppleDouble sidecars that BSD tar emits for extended
# attributes; GNU tar inside the container treats them as ordinary
# files and would pollute the creds dir.
find "$STAGE" \( \
    -iname 'credentials*' -o \
    -iname '.credentials*' -o \
    -iname 'auth.json'     -o \
    -iname '*.token'       -o \
    -iname '*.pem'         -o \
    -iname 'id_rsa*'       -o \
    -name  '._*'           \
\) -print -delete >&2 || true

# ── inject via `tar | docker exec` ────────────────────────────────────────
# We tar-pipe instead of `docker cp` so we can extract as the `node`
# user (the cp'd files would otherwise land root-owned and the agent
# CLI couldn't traverse them on first invocation).
if [[ -n "$(ls -A "$STAGE" 2>/dev/null || true)" ]]; then
    log "injecting into $CONTAINER:$TARGET"
    # COPYFILE_DISABLE=1 stops BSD tar (macOS) from emitting AppleDouble
    # `._*` sidecars; --no-xattrs stops it from inlining `com.apple.*`
    # xattrs in pax extended headers (which GNU tar inside the container
    # would otherwise warn about for every file). No-op on Linux hosts.
    COPYFILE_DISABLE=1 tar --no-xattrs -C "$STAGE" -cf - . \
        | docker exec -i -u node "$CONTAINER" \
              bash -c "tar -C '$TARGET' -xf -"
else
    log "nothing to inject (source has no skills/agents/commands/$MEMORY_FILE)"
fi

log ""
log "done. start the bridge daemon (in another shell) with:"
log "    vicoop-client --backend $KIND --runtime container --runtime-name $KIND"

printf '{"container":"%s","runtime_name":"%s","kind":"%s","injected_into":"%s"}\n' \
    "$CONTAINER" "$KIND" "$KIND" "$TARGET"
