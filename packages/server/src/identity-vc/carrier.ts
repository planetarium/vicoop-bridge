import type { Message } from '@a2x/sdk';
import {
  DEFAULT_IDENTITY_VC_LIMITS,
  type IdentityVcLimits,
  type IdentityVcRejection,
} from './types.js';

const LEGACY_CARRIER_KEY = 'identity_evidence';
const VC_CARRIER_KEY = 'verifiable_credentials';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function jsonByteLength(value: unknown): number | undefined {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * Extract the v0.2 carrier and return a metadata clone with both identity
 * carriers removed. Callers should put `metadata` on the request that may be
 * persisted/forwarded immediately; raw credentials never appear in it.
 */
export function extractAndStripIdentityCarrier(
  metadata: Message['metadata'],
  limits: Pick<IdentityVcLimits, 'maxCarrierBytes' | 'maxCredentialBytes' | 'maxCredentials'> =
    DEFAULT_IDENTITY_VC_LIMITS,
): {
  credentials: unknown[];
  metadata: Record<string, unknown> | undefined;
  rejections: IdentityVcRejection[];
} {
  if (!isRecord(metadata)) {
    return { credentials: [], metadata: undefined, rejections: [] };
  }

  const sanitized: Record<string, unknown> = { ...metadata };
  const mentionable = metadata.mentionable;
  if (!isRecord(mentionable)) {
    return { credentials: [], metadata: sanitized, rejections: [] };
  }

  const cleanMentionable = { ...mentionable };
  const rawCarrier = cleanMentionable[VC_CARRIER_KEY];
  delete cleanMentionable[VC_CARRIER_KEY];
  // Legacy evidence remains unverified in #467, but is secret-bearing input
  // all the same. Strip it at the same narrow boundary.
  delete cleanMentionable[LEGACY_CARRIER_KEY];
  if (Object.keys(cleanMentionable).length === 0) delete sanitized.mentionable;
  else sanitized.mentionable = cleanMentionable;

  const cleanMetadata = Object.keys(sanitized).length === 0 ? undefined : sanitized;
  if (rawCarrier === undefined) {
    return { credentials: [], metadata: cleanMetadata, rejections: [] };
  }

  const carrierBytes = jsonByteLength(rawCarrier);
  if (carrierBytes === undefined || carrierBytes > limits.maxCarrierBytes) {
    return {
      credentials: [],
      metadata: cleanMetadata,
      rejections: [{ code: 'limit_exceeded' }],
    };
  }
  if (!Array.isArray(rawCarrier)) {
    return {
      credentials: [],
      metadata: cleanMetadata,
      rejections: [{ code: 'malformed' }],
    };
  }
  if (rawCarrier.length > limits.maxCredentials) {
    return {
      credentials: [],
      metadata: cleanMetadata,
      rejections: [{ code: 'limit_exceeded' }],
    };
  }

  const credentials: unknown[] = [];
  const rejections: IdentityVcRejection[] = [];
  for (const credential of rawCarrier) {
    const size = jsonByteLength(credential);
    if (size === undefined || size > limits.maxCredentialBytes) {
      rejections.push({ code: 'limit_exceeded' });
    } else {
      credentials.push(credential);
    }
  }
  return { credentials, metadata: cleanMetadata, rejections };
}
