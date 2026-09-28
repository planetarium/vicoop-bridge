# Fixed filesystem storage for callers

`caller_runtime.fixedImageStorage` enables a fixed-size ext4 filesystem per
caller scope. `/workspace` and `/data/sessions/<backend>` use separate subdirectories
of that filesystem. Both allocated blocks and inodes are limited by ext4; writes
fail with `ENOSPC` immediately. `storageMiB` is the **filesystem size**, including
journal and metadata, rather than a promise of that many usable data bytes.

`container init claude|codex` enables this storage by default. Initialization
never falls back to monitored volumes when fixed storage preparation fails.
Existing development configurations are not rewritten until initialization succeeds.

## Reservation boundary

The helper preallocates the entire image, disables discard during formatting and
mounting, checks allocated blocks, and serializes admission with a pool-wide file
lock and SQLite catalog. The catalog fixes the pool capacity and free-space
reserve on first use. Every client sharing that pool must specify the same policy.
Incomplete allocations continue consuming admission capacity until explicit removal.

The reservation is **inside the Docker daemon's backing filesystem**. Docker
Desktop and Colima can use thin virtual disks: guest allocation does not reserve
physical space on the Mac. Thin provisioning beneath native Linux has the same
limitation. This implementation does not claim the end-to-end physical reservation
required by #508 and is not sufficient to close that issue or its #497 gate.
The explicit `reservationBoundary` setting acknowledges this narrower contract.
Images, logs, other pools, and unrelated host processes remain outside this budget.

## Initialize

Register the agent and prepare host authentication as described in
[caller runtime setup](caller-runtime.md), then run:

```sh
vicoop-client container init claude
# Or: vicoop-client container init codex
```

The standalone CLI embeds the reviewed helper Dockerfile, TypeScript sources and
SQLite adapter. Docker builds the executable with Bun **inside the build image**;
no checkout, host Bun/Python, manual Docker commands or JSON edits are required.
The CLI pins both images by immutable local image ID. Subsequent initialization
reuses those images; `--rebuild` rebuilds both bundled images. `--image IMAGE`
selects only the workload image, keeping the helper build trusted and bundled.

The default `vicoop-caller-storage` local volume is shared by all agents and both
backends on the selected Docker daemon/context. `--storage-pool VOLUME` selects a
separate pool or an existing managed pool. Foreign labels, non-local drivers and
driver options are rejected. Existing pool data is never reformatted or adopted.

| Option (integer MiB) | New pool/default behavior |
| --- | --- |
| `--storage-mib` | Per-caller filesystem size; 1024, or the existing backend setting |
| `--storage-capacity-mib` | Pool admission budget; `storageMiB × maxScopes` (normally 8192) |
| `--storage-reserve-mib` | Free-space floor; `max(1024, ceil(capacityMiB / 10))` |

The budget follows the existing scope defaults, rather than treating the previous
8192/1024 example as a universal sizing requirement. It is an **aggregate pool
budget**, not capacity promised to every agent: sharing more agents/backends does
not multiply it. `maxScopes` continues to limit each backend independently.
Choose a larger budget on first initialization when sharing across many agents.
Ext4 metadata/journal are included in each scope's size. Reserve applies to free
space on the backing filesystem, including unrelated consumption at admission.

Unspecified capacity/reserve inherit an existing labeled pool's policy. Explicit
conflicts are rejected. A #509 manually created pool without policy labels still
validates the supplied/default policy against its existing SQLite catalog; use
`--rebuild` if its pinned development helper predates probe support, and supply
its original values if they differ from the defaults. Policy remains immutable,
even when empty. New pools smaller than a single scope are rejected before
creation. Init does not resize pools or retained scope filesystems, or move
an already-configured backend to another pool. Rebuilding the helper does not
change image UUIDs, pool policy, caller state, registration or unrelated settings.

```sh
# Example for a NEW pool, not a universal capacity recommendation:
vicoop-client container init codex --storage-pool team-callers \
  --storage-mib 2048 --storage-capacity-mib 32768 --storage-reserve-mib 4096
```

Initialization requires Linux Docker (rootful), privileged helpers, loop devices,
ext4 and Docker CLI/Engine API 1.45+ for volume subpaths. The API requirement follows
[Docker's Subpath API addition](https://docs.docker.com/reference/api/engine/version-history/#v145-api-changes).
It performs a disposable full-size filesystem allocation, mount, write, fsync,
readback and deletion before saving config. This requires room for one scope plus
the reserve, including on reinitialization. A full pool can therefore reject init;
existing config/data remain usable. The helper executes the entire probe under
#509's pool-wide flock; concurrent initializers agree on immutable volume labels
and the SQLite policy. No physical allocation beyond the Docker filesystem is
claimed; initialization prints that boundary explicitly.

Build, capability, capacity and config-write failures preserve the previous config.
The shared pool and build-cache images remain reusable after failed initialization;
init never prunes either. Only the recorded disposable probe image/helper is
removed. Cleanup uncertainty fails initialization and retains a private recovery
journal under `<stateDirectory>/storage-init` (including `probe.json` and SQLite).
Restore Docker access and rerun init with the pool's original capacity/reserve to
reconcile the helper by immutable ID and remove the interrupted probe before trying
again. `--rebuild` also uses the newly validated helper for recovery, preserving the
recorded pool and filesystem identity. A rejected probe with neither a catalog
allocation nor an image can be cleared without adopting its rejected policy;
retained allocations and unrecorded files still fail closed. Do not delete
that journal or the pool to bypass a failure. An abrupt kill likewise leaves the
journal for the next run; incomplete allocation is deleted, never reformatted.

The pool must not be exposed to workloads, pruned, or manually modified. Only the
trusted helper receives privileged pool/device access; it has no network or Docker
socket. Workloads receive workspace/session subpaths, not the backing pool.

## Lifecycle and recovery

The client records a random filesystem UUID, storage key, pool and size in its
existing SQLite scope database before helper mutation. The pool has a separate
SQLite allocation catalog shared across agents. An image is formatted once;
interrupted allocation is quarantined, never automatically reformatted.
On acquisition, the helper validates UUID, type, size and allocated blocks, then
reattaches the image and restores its UUID device alias before Docker starts it.
A missing image/catalog entry fails closed. Back up both client state and pool.
Helper identities are journaled in client SQLite before Docker creation. Helpers
are created stopped, then started by immutable container ID. Startup, shutdown
and failed requests reconcile that journal; unconfirmed termination quarantines
the caller and prevents releasing runtime ownership. An interrupted scope
reservation before image identity creation remains safely removable after a
check that no Docker resources exist for it.

`container recreate SCOPE` retains the filesystem and its files.
`container remove SCOPE` checks resource ownership and foreign consumers, removes
containers/volume, confirms loop detachment, deletes the image, and releases the
catalog reservation. Interrupted removal can be retried. Do not detach or mount
managed devices outside this lifecycle.

A full filesystem can still be acquired so the caller can remove files. The
legacy `du` threshold is not used for fixed filesystems. Increasing or decreasing
`storageMiB`, changing pools, or disabling fixed storage for retained scopes is
rejected; restore the original configuration to administer them.

Existing ordinary-volume scopes cannot be adopted automatically. Keep their
original configuration/state and data. The intermediate per-caller ordinary-volume format was never released; no migration
subsystem is provided. Older released shared runtimes retain their volumes: follow
the [configuration transition guide](caller-runtime.md), prepare host authentication,
and do not assign shared workspaces/sessions to an authenticated caller. In-place
resizing and end-to-end physical pool provisioning remain separate work.

## Tests

Unit tests run with the client suite. The integration test builds disposable
images and uses privileged helper containers; select a disposable/test engine:

```sh
cd packages/client
DOCKER_CONTEXT=desktop-linux VICOOP_FIXED_STORAGE_TEST=1 \
  pnpm exec tsx --test src/caller-storage.integration.test.ts src/caller-storage-init.integration.test.ts
```

It covers actual runtime creation, block/inode exhaustion, independent callers,
shared-pool admission across client states, recreation, loss of loop attachments,
capacity-change rejection, retained data, and explicit deletion/capacity reuse.

The init integration test exercises concurrent Claude/Codex initialization against
one pool, first-caller fixed storage, retained files/UUIDs after reinitialization,
policy-change rejection and returned probe capacity. On test failure it retains
recovery state rather than deleting uncertain resources. The compiled packaging
smoke (`scripts/storage-init-packaging-smoke.mjs`) runs the CLI outside a checkout
against a deterministic Docker fixture and verifies exact embedded build inputs;
it is not a substitute for the opt-in real-Docker tests. Docker Desktop lifecycle
results from #509 do not establish native Linux/Colima or integrated restart release
validation; those, physical backing reservation and provider checks remain open.
