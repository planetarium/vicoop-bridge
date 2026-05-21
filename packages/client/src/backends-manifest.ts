// Compat ranges between this bridge client and the agent CLI versions it
// knows how to drive. Entrypoint in the container image reads this manifest
// to decide whether the version recorded in /data/installed.json is one the
// running client expects to work with; on mismatch the entrypoint refuses to
// start and tells the operator which `install-backend.sh` invocation will
// realign things.
//
// `supportedRange` follows node-semver syntax. Ranges are intentionally
// permissive in this initial cut: we tighten them once a real breakage
// motivates a floor.
//
// `installable` says whether the image's install-backend.sh has a recipe
// for this backend. `echo` exists in code only and never gets installed;
// `vicoop-codex` isn't covered by an image-side recipe yet.

export type BackendKind =
  | 'echo'
  | 'openclaw'
  | 'claude'
  | 'codex'
  | 'vicoop-codex';

export interface BackendManifestEntry {
  readonly supportedRange: string;
  readonly installable: boolean;
}

export const BACKENDS_MANIFEST: Record<BackendKind, BackendManifestEntry> = {
  echo: { supportedRange: '*', installable: false },
  openclaw: { supportedRange: '*', installable: true },
  claude: { supportedRange: '>=2.0.0', installable: true },
  codex: { supportedRange: '>=0.100.0', installable: true },
  'vicoop-codex': { supportedRange: '*', installable: false },
};
