# Fixed filesystem storage for callers

`caller_runtime.fixedImageStorage` enables a fixed-size ext4 filesystem per
caller scope. `/workspace` and `/data/sessions/<backend>` use separate subdirectories
of that filesystem. Both allocated blocks and inodes are limited by ext4; writes
fail with `ENOSPC` immediately. `storageMiB` is the **filesystem size**, including
journal and metadata, rather than a promise of that many usable data bytes.

This is an opt-in implementation on the Docker runtimes feature branch. Existing
configurations retain their existing monitored-volume behavior. Selecting fixed
images never falls back to ordinary volumes if provisioning fails.

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

## Set up a new state directory

Build the trusted helper from the repository, using the same Docker context as
the client. The helper requires a rootful Linux Docker engine, loop devices,
ext4, privileged containers, and volume subpath support. This path was exercised
on macOS Docker Desktop; native Linux and Colima still need release validation.

```sh
docker build -t vicoop-caller-storage packages/client/container/storage
docker image inspect --format '{{.Id}}' vicoop-caller-storage
docker volume create --label vicoop.component=caller-storage-pool vicoop-caller-storage
```

Initialize the ordinary caller runtime with `container init claude` or
`container init codex`. Before its first caller is created, add this object to
that backend's `caller_runtime` configuration, replacing the helper image ID:

```json
{
  "storageMiB": 1024,
  "fixedImageStorage": {
    "image": "sha256:<64-character-local-image-ID>",
    "poolVolume": "vicoop-caller-storage",
    "capacityMiB": 8192,
    "reserveMiB": 1024,
    "reservationBoundary": "docker-filesystem"
  }
}
```

The pool must be an existing local Docker volume with the label shown above and
no driver options. Do not share it with workloads, delete it with volume-prune,
modify its catalog/images manually, or change its capacity policy in place.
The helper image ID is trusted operator code: it runs privileged with the pool
and daemon `/dev`, with no network or Docker socket. Workload containers retain
the existing isolation boundary and receive only the two filesystem subpaths.

## Lifecycle and recovery

The client records a random filesystem UUID, storage key, pool and size in its
existing SQLite scope database before helper mutation. The pool has a separate
SQLite allocation catalog shared across agents. An image is formatted once;
interrupted allocation is quarantined, never automatically reformatted.
On acquisition, the helper validates UUID, type, size and allocated blocks, then
reattaches the image and restores its UUID device alias before Docker starts it.
A missing image/catalog entry fails closed. Back up both client state and pool.

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
original configuration/state and data. A verified offline copy/migration workflow
with rollback, in-place resizing, and end-to-end physical pool provisioning are
not implemented in this change.

## Tests

Unit tests run with the client suite. The integration test builds disposable
images and uses privileged helper containers; select a disposable/test engine:

```sh
cd packages/client
DOCKER_CONTEXT=desktop-linux VICOOP_FIXED_STORAGE_TEST=1 \
  pnpm exec tsx --test src/caller-fixed-storage.integration.test.ts
```

It covers actual runtime creation, block/inode exhaustion, independent callers,
shared-pool admission across client states, recreation, loss of loop attachments,
capacity-change rejection, retained data, and explicit deletion/capacity reuse.
