import {
  MENTIONABLE_IDENTITY_VC_EXTENSION_URI,
  type PresentedCallerIdentityV1,
} from '@vicoop-bridge/protocol';

export const MENTIONABLE_IDENTITY_PROFILE_URI =
  MENTIONABLE_IDENTITY_VC_EXTENSION_URI;
export const MENTIONABLE_IDENTITY_CONTEXT_URI =
  'https://mentionable.dev/ns/identity/v0.2/context.jsonld' as const;
export const VC_V2_CONTEXT_URI = 'https://www.w3.org/ns/credentials/v2' as const;
export const IDENTITY_VC_PRESENTED_METADATA_KEY = '_identityVcPresented' as const;

export const DEFAULT_IDENTITY_VC_LIMITS = {
  maxCarrierBytes: 64 * 1024,
  maxCredentialBytes: 32 * 1024,
  maxCredentials: 4,
  // Mentionable PlatformIdentityCredential v0.2 normative receiver limits.
  maxTtlMs: 10 * 60 * 1000,
  clockSkewMs: 60 * 1000,
} as const;

export interface IdentityVcLimits {
  maxCarrierBytes: number;
  maxCredentialBytes: number;
  maxCredentials: number;
  maxTtlMs: number;
  clockSkewMs: number;
}

export type IdentityVcRejectionCode =
  | 'malformed'
  | 'limit_exceeded'
  | 'unsupported_profile'
  | 'unsupported_issuer_method'
  | 'untrusted_issuer'
  | 'key_fetch_failed'
  | 'issuer_controller_mismatch'
  | 'unsupported_cryptosuite'
  | 'invalid_signature'
  | 'domain_mismatch'
  | 'challenge_mismatch'
  | 'not_yet_valid'
  | 'expired'
  | 'replay_store_failed'
  | 'replayed';

/** The verified shape is exactly the protocol object consumed by #466. */
export type VerifiedPresentedIdentity = PresentedCallerIdentityV1;

export interface IdentityVcRejection {
  code: IdentityVcRejectionCode;
}

export type IdentityVcVerificationResult =
  | { ok: true; identity: VerifiedPresentedIdentity }
  | { ok: false; rejection: IdentityVcRejection };

export interface DataIntegrityProofV1 {
  type: 'DataIntegrityProof';
  cryptosuite: 'eddsa-jcs-2022';
  proofPurpose: 'assertionMethod';
  verificationMethod: string;
  proofValue: string;
  domain: string;
  challenge: string;
  created?: string;
  '@context'?: unknown;
  [key: string]: unknown;
}

export interface UnverifiedPlatformIdentityCredential {
  '@context': unknown[];
  id: string;
  type: unknown[];
  issuer: string;
  validFrom: string;
  validUntil: string;
  credentialSubject: {
    id: string;
    method: string;
    assurance?: string;
    platform?: Record<string, unknown>;
    observedInvocation?: Record<string, unknown>;
    profile?: Record<string, unknown>;
    [key: string]: unknown;
  };
  proof: DataIntegrityProofV1;
  [key: string]: unknown;
}

export type UnsecuredPlatformIdentityCredential = Pick<
  UnverifiedPlatformIdentityCredential,
  '@context' | 'id' | 'type' | 'issuer' | 'validFrom' | 'validUntil' | 'credentialSubject'
>;

export interface DidVerificationMethod {
  id: string;
  type: 'Multikey';
  controller: string;
  publicKeyMultibase: string;
  [key: string]: unknown;
}

export interface ResolvedDidDocument {
  id: string;
  verificationMethod?: unknown[];
  assertionMethod?: unknown[];
  [key: string]: unknown;
}

export interface DidDocumentResolver {
  resolve(issuer: string, options?: { refresh?: boolean }): Promise<ResolvedDidDocument>;
}

export interface IdentityReplayStore {
  /** Atomically consume a tuple. Returns false when it was already consumed. */
  consume(input: {
    issuer: string;
    domain: string;
    challenge: string;
    expiresAt: Date;
  }): Promise<boolean>;
}
