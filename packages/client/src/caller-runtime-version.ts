import semver from 'semver';
import { BACKENDS_MANIFEST, type InstallableBackendKind } from './backends-manifest.js';

/** Shared by operator initialization and daemon worker construction. */
export function assertCallerRuntimeVersion(kind: InstallableBackendKind, output: string): string {
  const version = output.match(/\b\d+\.\d+\.\d+(?:[-+][\w.-]+)?\b/)?.[0];
  const supported = kind === 'codex'
    ? BACKENDS_MANIFEST.codex.externalRuntimeSupportedRange!
    : BACKENDS_MANIFEST.claude.supportedRange;
  if (!version || !semver.satisfies(version, supported, { includePrerelease: kind === 'claude' }))
    throw new Error(`caller image has an unsupported or missing ${kind} version`);
  return version;
}
