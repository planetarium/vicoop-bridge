// Per-backend compat data used by the container image's entrypoint to decide
// whether the agent CLI version recorded in /data/installed.json is one this
// bridge client knows how to drive. On mismatch the entrypoint refuses to
// start and tells the operator which `install-backend.sh` invocation will
// realign things.
//
// Membership in BACKENDS_MANIFEST is the authoritative answer to "does the
// container runtime install AND drive this backend?" — it's the set keyed by
// `InstallableBackendKind`, which the whole container-runtime creds/auth path
// (expectedCredsPath, copyHostCreds, resolveRuntime, …) is typed against.
// Backends absent from here (echo, openclaw, vicoop-codex today) are still
// valid `VICOOP_BACKEND` choices — they just don't run under `--runtime
// container`; the operator handles any setup on the host. To add a new
// container-installable backend: add an entry here AND create
// `container/backends/<kind>.sh`.
//
// `info` advertises a SUPERSET of these — see BACKEND_COMPAT below — so
// operators can see the supported CLI version range for host-only backends
// (vicoop-codex) too, without dragging them into the container machinery.
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

// Backends the client knows how to drive but the container image does NOT
// install or run under `--runtime container`. They're host-process only, so
// they stay out of `InstallableBackendKind` (and its creds/auth machinery) —
// but `info` still advertises their supported CLI range so operators running
// them on the host can check compatibility.
//
// vicoop-codex: driven via `vicoop-codex serve` + `vicoop-codex models --json`.
// The >=0.7.0 floor tracks the `context_window` field the bridge reads from
// `models --json` for the openai-compat/v1 `contextWindow` advertise, which
// vicoop-codex first surfaces in 0.7.0 (planetarium/vicoop-codex-cli#34). This
// is a host-only backend, so the range is advisory (shown in `info`, NOT gated
// like the container backends): older 0.3.x–0.6.x still run — they just
// advertise no window.
export type HostOnlyBackendKind = 'vicoop-codex';

export const HOST_ONLY_BACKENDS: Record<HostOnlyBackendKind, BackendManifestEntry> = {
  'vicoop-codex': { supportedRange: '>=0.7.0' },
};

// What `vicoop-client info` reports under `backends`: every backend the client
// can drive, container-installable or not, each with its supported CLI range.
export const BACKEND_COMPAT: Record<string, BackendManifestEntry> = {
  ...BACKENDS_MANIFEST,
  ...HOST_ONLY_BACKENDS,
};
