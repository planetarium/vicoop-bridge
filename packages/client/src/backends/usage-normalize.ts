// Shared helpers for normalising backend usage into the canonical
// `BridgeUsage` shape (see @vicoop-bridge/protocol). The per-backend mappers
// (claude oauth/rate_limit, vicoop-codex serve /usage) live with their
// backends; only the unit/format conventions are shared here so every backend
// agrees on them.

import type { UsageSeverity } from '@vicoop-bridge/protocol';

// One uniform severity rule for every backend/window, derived from usedPercent
// — so severity means the same thing regardless of whether the upstream
// reported one.
export function deriveSeverity(usedPercent: number): UsageSeverity {
  if (usedPercent >= 90) return 'critical';
  if (usedPercent >= 75) return 'warning';
  return 'ok';
}

export function clampPercent(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
}

// Epoch SECONDS → ISO 8601, or null for a missing/non-numeric value.
export function epochSecondsToIso(epochSeconds: unknown): string | null {
  if (typeof epochSeconds !== 'number' || !Number.isFinite(epochSeconds)) {
    return null;
  }
  return new Date(epochSeconds * 1000).toISOString();
}

// Pass through an already-ISO string, else null.
export function isoOrNull(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}
