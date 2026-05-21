// Per-backend compat data used by the container image's entrypoint to decide
// whether the agent CLI version recorded in /data/installed.json is one this
// bridge client knows how to drive. On mismatch the entrypoint refuses to
// start and tells the operator which `install-backend.sh` invocation will
// realign things.
//
// Membership in this manifest is the authoritative answer to "does the image
// know how to install this backend?". Backends absent from here (echo,
// openclaw, vicoop-codex today) are still valid `VICOOP_BACKEND` choices —
// they just need the operator to handle any out-of-process setup (e.g.
// openclaw's gateway runs as a separate service). To add a new installable
// backend: add an entry here AND create `container/backends/<kind>.sh`.
//
// `supportedRange` follows node-semver syntax. Ranges are intentionally
// permissive in this initial cut: we tighten them once a real breakage
// motivates a floor.

export type InstallableBackendKind = 'claude' | 'codex';

export interface BackendManifestEntry {
  readonly supportedRange: string;
}

export const BACKENDS_MANIFEST: Record<InstallableBackendKind, BackendManifestEntry> = {
  claude: { supportedRange: '>=2.0.0' },
  codex: { supportedRange: '>=0.100.0' },
};
