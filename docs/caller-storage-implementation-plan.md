# Proposal: hard caller storage using fixed-capacity images (#508)

Status: proposed implementation plan informed by Docker feasibility tests.
Target integration branch: `codex/497-docker-runtimes` (baseline `5f4e626`).
This PR does not implement production storage, enable isolation, close #508, or
satisfy the hard-storage release gate in #497.

## Decision and evidence

Use one **fully allocated ext4 image per existing caller storage scope**, mounted
through Docker's built-in `local` volume driver. Manage images and loop devices
with standard Linux tools in a digest-pinned operator helper container. Keep the
client independent of Colima, SSH, and private Desktop VM interfaces.

The scope uses the existing agent/principal identity and backend ownership
mapping; no new caller-selected identity or cross-backend sharing is introduced.
`workspace` and `sessions` are subdirectories of the same filesystem, mounted at
the current runtime paths. Filesystem byte and inode boundaries enforce the
budget even between monitoring intervals.

| Alternative | Evidence and decision |
| --- | --- |
| Docker built-in block quota | Fast-write containment worked on XFS, but it admitted quotas above available capacity and exposed no inode cap. A exhausted shared inodes and broke B. Do not use as the complete isolation mechanism. |
| Fixed images using standard tools | Byte/inode isolation and restart recovery worked in a Linux guest and Docker Desktop. Preferred implementation direction. |
| Third-party loopback driver | Similar mechanism exists, but would add an old driver dependency without removing our admission, ownership or migration work. |
| External quota/reservation storage | Possible future pool backend; not required for the first local implementation. |

Feasibility tests on a Colima Linux guest and macOS Docker Desktop confirmed
byte/inode containment, continued writes by another caller, and recovery after
restart with changed loop-device numbers. Docker Desktop used management
containers and the Docker API without VM-specific access. These findings support
the design direction; they do not establish production lifecycle correctness or
physical-capacity reservation outside the VM.

## Capacity contract and release blocker

Define `storageMiB` as **total image size**, including filesystem metadata. Report
usable bytes, free bytes, total/free inodes separately. The 64 MiB fixtures held
roughly 58 MiB of payload; do not promise `storageMiB` bytes of usable files.
The experiment's 2,048-inode setting is not a production default. Choose and
record an inode-density policy using representative Git/package/session workloads
before implementation ships; persist the resulting count per image.

Reservation has two distinct layers:

1. The managed pool admits the full image size plus conservative metadata and
   operational headroom. `fallocate` must succeed, formatting must use
   `nodiscard`, runtime mounts must disable discard, and allocated blocks must
   remain at least the image size. Reject sparse or incompatible backing stores.
2. The pool must have a validated **physical backing-capacity guarantee**. A full
   allocation inside a thin VM disk is not a physical-host reservation.

The Desktop probe saw ~927 GB free inside its VM but only ~73 GB on the Mac.
Therefore Desktop/Colima guest `df`, a configured pool cap, or host free-space
polling alone cannot satisfy the second requirement. Do not silently downgrade
to a soft/monitored guarantee.

Initial production eligibility should require an operator-provided pool with
validated physical reservation semantics (for example, a dedicated, non-thin
Linux filesystem with independently bounded shared consumers). This is a
**proposed eligibility condition**, not a platform already release-certified by
the VM tests. The Desktop/macOS reservation method remains an explicit design
blocker: either establish and test a thick/reserved backing strategy across the
outer storage layer or leave hard-storage activation unsupported there.

Keep primitive feasibility and release support separate:

| Environment | Primitive tested | Full hard-storage release eligibility |
| --- | --- | --- |
| Colima Linux guest, rootful Docker | Yes | Outer VM capacity guarantee and production integration outstanding |
| macOS Docker Desktop 4.91.0 / Engine 29.8.0 | Yes | Physical Mac reservation unresolved; not release eligible yet |
| Native Linux with reserved pool | Not yet tested on bare metal | Intended first eligible configuration, after validation |
| Rootless Docker, Desktop ECI, Windows Desktop | Not tested | Reject until explicitly supported and validated |

## Components and privilege boundary

- A new client-side storage manager orchestrates Docker API calls, using the
  existing bounded/cancellable command runner. No Colima-specific CLI calls.
- A pinned helper image contains the standard filesystem tools and a narrow
  command interface (`inspect`, `provision`, `attach`, `verify`, `remove`).
  Inputs are validated opaque storage IDs and bounded capacities, not arbitrary
  paths, mount options, devices or shell commands from caller requests.
- Helpers receive the dedicated manager volume and required host device access.
  The feasibility fixture used `--privileged` plus daemon `/dev`; treat it as
  host-administrator authority. Determine the minimum supported capabilities in
  implementation, and expose this requirement in `container init`.
- Helpers do not receive a Docker socket or provider credentials. The operator
  client invokes Docker; workloads receive only their two filesystem subpaths.
  Keep existing workload capability/security rules intact.
- Use validated UUID device aliases in the daemon's `/dev`. LinuxKit may not run
  udev; the helper can publish an alias after verifying the image/device identity.
  Missing or conflicting aliases must fail closed, never mount a bare directory.
- Keep manager storage root-owned and outside all workload mounts. Pin tool/image
  versions; validate loop/ext4 support and backing allocation behavior at init.

## Persistent identity, locking and lifecycle

Extend `caller-runtime-store.ts` with a versioned storage reference containing
pool ID, opaque storage ID/generation, format version, filesystem UUID, image
size, inode count and lifecycle state. Preserve current namespace, agent,
principal and backend checks. Block incompatible older clients from mutating
the new storage format; do not let them recreate legacy volumes over migrated
records.

A **daemon/pool-wide catalog** must live with the managed backing files. Existing
per-agent client SQLite locks cannot coordinate separate clients on one Docker
daemon. Use a persistent SQLite catalog plus a pool-wide lock shared by every
helper using that pool; record the same storage ID/owner binding in client state.
Specify reconciliation precedence and quarantine disagreements rather than
guessing which side is correct.

Proposed persistent phases:

```text
reserved -> allocating -> formatted -> ready
legacy -> migrating -> ready (legacy retained for rollback)
ready -> deleting -> deleted
any uncertain/mismatched state -> quarantined
```

Reserve before the first mutation. Pending allocations/migrations/deletions
continue to consume admission capacity until their effects are reconciled.
Hold the pool lock through reservation and physical backing allocation; scope
operations additionally serialize against runtime execution leases. Set a
single lock ordering and avoid holding a catalog transaction across unrelated
Docker calls. A lost client connection must not leave an untracked helper still
formatting: identify helpers by operation ID and reconcile their exit/results.

Filesystem operations are not SQLite transactions. Persist operation intent and
completion evidence around each step, fsync metadata/catalog changes, and make
retries inspect existing state. Never reformat an existing image to recover an
uncertain allocation. Validate owner record, file type/identity, size, allocation,
UUID, loop backing file and Docker volume options before reuse; UUID alone is
not ownership proof.

## Provision, restart and deletion

1. Check daemon/pool capabilities, physical-reservation eligibility, pool budget,
   free-space reserve and current pending allocations under the shared lock.
2. Allocate an exclusive staging file; fully reserve blocks, format ext4 with
   discard disabled, persist UUID/inode metadata and initialize directories with
   existing UID/GID/mode restrictions. Publish only after verification.
3. Attach under the device-management lock using `losetup --nooverlap`. Validate
   both image and attached device, then publish its UUID alias.
4. Create one labeled Docker local volume and two `volume-subpath` mounts.
   Validate exact identity/options and consumers before runtime admission.
5. On restart, inspect catalog and resources, reconcile partial operations,
   reattach/rebuild aliases, and only then admit workloads. Loop numbers can
   change. Run offline fsck only when exclusive access is proven; quarantine
   corruption and do not silently repair/reformat potentially recoverable data.
6. Stop/recreate never removes images. Explicit scope deletion fences execution,
   validates all consumers, removes container/volume references, confirms no
   mounts remain, detaches devices, confirms detachment and then removes files.
   Lazy loop detachment is not proof that backing capacity can be released.
   Commit deletion/release only after confirming all owned storage is gone.

Docker Desktop restart removes device aliases; validated helper reattachment is
required before runtime start. The fixture's intentional startup failure before
reattachment is the desired behavior, not a reason to fall back to ordinary volumes.

## Migration and capacity changes

Migration must be explicit and offline, using existing exclusive ownership and
lease protections. Keep legacy workspace/session volumes intact during copying.
Reserve full temporary destination capacity and metadata/inode headroom before
starting; oversized scopes or insufficient space fail without changing sources.

Copy with ownership, permissions, symlinks and supported metadata preserved;
verify content and relevant metadata, then atomically publish the new client
storage reference. Treat an interrupted copy as incomplete and non-admissible.
Record source volume IDs, destination identity, verification result and cutover
generation. Do not auto-delete legacy backups during ordinary runtime cleanup.

Before new writes, rollback can restore the original volume references. After
cutover writes, restoring stale backups would lose data: rollback requires an
offline reverse copy into verified suitable storage or an explicit operator
decision about those writes. Document this boundary and test interrupted cutover.

For the first version, reject capacity changes on retained scopes with an
actionable message; do not resize silently when `storageMiB` changes. A later
offline replacement-image migration may support growth/shrink subject to full
temporary reservation and data/inode fit checks.

## Client integration and errors

| Existing area | Planned change |
| --- | --- |
| `caller-runtime-docker.ts` | Delegate provision/recovery/deletion to the storage manager; replace two plain volumes with validated subpaths of one managed filesystem. |
| `caller-runtime-store.ts` | Persist storage identity/lifecycle and migration evidence, with schema downgrade protection. |
| `caller-runtime-config.ts` / `container init` | Pool selection, capacity/reserve policy, pinned helper and capability checks; retain `storageMiB` with explicit total-image semantics. |
| `caller-runtime-admin.ts` | Inspection/recovery/migration and explicit deletion with existing ownership protections. |
| `caller-scoped-backend.ts` | Surface byte/inode exhaustion and storage-unavailable failures consistently; preserve lease cancellation and quarantine behavior. |

Keep monitoring for observability, not enforcement. A filesystem can reject a
write below the configured total size due to metadata, inode exhaustion or
allocation granularity. `du > storageMiB` will no longer be a sufficient failure
condition. Expose distinct actionable errors for unsupported storage, insufficient
reservation, missing/mismatched storage, full bytes/inodes, incomplete migration
and capacity changes. Observe backend failures together with filesystem stats;
do not classify every provider error as a storage failure.

## Delivery sequence and acceptance

1. **This design PR:** agree on image semantics, privileged helper
   boundary and the unresolved outer-capacity guarantee. No release intent.
2. **Manager and store foundation:** persistent pool catalog, strict operation
   interface, admission, ownership, state transitions and recovery fault tests.
   Feature remains unavailable where the full guarantee cannot be established.
3. **Runtime/init integration:** subpath mounts, restart reconciliation, byte and
   inode error handling, operator diagnostics, schema/compatibility protection.
4. **Migration and operations:** offline copy/verification, rollback, partial
   deletion recovery and retained-scope capacity-change rejection.
5. **Release validation:** native Linux with a reserved pool; supported Desktop
   configurations only after outer reservation is solved; compiled-client and
   actual-provider paths. Update #497 only after all required evidence passes.

Required tests include rapid/parallel writes, inode exhaustion with another
caller actively persisting, concurrent allocation by independent clients,
insufficient pool/physical/migration space, cancellation during helper work,
failure injection at every durable phase, stale devices/foreign consumers,
container/client/daemon/host restart, interrupted migration/cutover/deletion,
rollback after writes, and unsupported-platform rejection. Preserve existing
host-mode regressions. Future behavior-changing client PRs need client-only
changesets; this proposal does not ship client behavior.
