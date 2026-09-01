// The wire contract is owned by @mentionable/connector-kit. Re-export it so
// the bridge's resource-server modules share one import point without copying
// profile constants locally.
export * from '@mentionable/connector-kit';

import { OAUTH_FEDERATION_SCOPES } from '@mentionable/connector-kit';

export const OAUTH_FEDERATION_SCOPE_SET: ReadonlySet<string> = new Set(
  OAUTH_FEDERATION_SCOPES,
);

// Bridge-owned opaque access-token policy (not part of the federation wire
// contract).
export const OAUTH_FEDERATION_ACCESS_TOKEN_TTL_SECONDS = 300;
export const OAUTH_FEDERATION_ACCESS_TOKEN_PREFIX = 'vbc_fed_';
export const OAUTH_FEDERATION_MAX_FORM_BYTES = 64 * 1024;
