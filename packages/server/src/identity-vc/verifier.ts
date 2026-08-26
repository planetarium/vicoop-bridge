import { DataIntegrityProof } from '@digitalbazaar/data-integrity';
import { createVerifyCryptosuite } from '@digitalbazaar/eddsa-jcs-2022-cryptosuite';
import { CredentialIssuancePurpose, verifyCredential } from '@digitalbazaar/vc';
import { PresentedCallerIdentityV1 } from '@vicoop-bridge/protocol';
import { parseDateTimeStamp, parsePlatformIdentityCredential } from './parser.js';
import {
  DEFAULT_IDENTITY_VC_LIMITS,
  type DidDocumentResolver,
  type DidVerificationMethod,
  type IdentityReplayStore,
  type IdentityVcLimits,
  type IdentityVcRejectionCode,
  type IdentityVcVerificationResult,
  type ResolvedDidDocument,
  type UnverifiedPlatformIdentityCredential,
  type VerifiedPresentedIdentity,
} from './types.js';

export interface PlatformIdentityVerifierOptions {
  trustedIssuers: Iterable<string>;
  resolver: DidDocumentResolver;
  replayStore: IdentityReplayStore;
  limits?: Partial<Pick<IdentityVcLimits, 'maxTtlMs' | 'clockSkewMs'>>;
  now?: () => Date;
}

function reject(code: IdentityVcRejectionCode): IdentityVcVerificationResult {
  return { ok: false, rejection: { code } };
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === 'string' ? value : undefined;
}

function hasValidDidDocumentShape(value: unknown): value is ResolvedDidDocument {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const doc = value as Record<string, unknown>;
  return (
    typeof doc.id === 'string' &&
    (doc.verificationMethod === undefined || Array.isArray(doc.verificationMethod)) &&
    (doc.assertionMethod === undefined || Array.isArray(doc.assertionMethod))
  );
}

function findVerificationMethod(
  doc: ResolvedDidDocument,
  id: string,
): DidVerificationMethod | undefined {
  const verificationMethods = Array.isArray(doc.verificationMethod) ? doc.verificationMethod : [];
  const assertionMethods = Array.isArray(doc.assertionMethod) ? doc.assertionMethod : [];
  const embedded = [...verificationMethods, ...assertionMethods].find(
    (entry) => typeof entry === 'object' && entry !== null && (entry as { id?: unknown }).id === id,
  );
  if (typeof embedded !== 'object' || embedded === null) return undefined;
  const candidate = embedded as Record<string, unknown>;
  if (
    candidate.type !== 'Multikey' ||
    typeof candidate.id !== 'string' ||
    typeof candidate.controller !== 'string' ||
    typeof candidate.publicKeyMultibase !== 'string'
  ) {
    return undefined;
  }
  return candidate as unknown as DidVerificationMethod;
}

function assertionMethodApproves(doc: ResolvedDidDocument, id: string): boolean {
  return (Array.isArray(doc.assertionMethod) ? doc.assertionMethod : []).some(
    (entry) =>
      entry === id ||
      (typeof entry === 'object' && entry !== null && (entry as { id?: unknown }).id === id),
  );
}

function normalize(credential: UnverifiedPlatformIdentityCredential): VerifiedPresentedIdentity {
  const subject = credential.credentialSubject;
  const platform = subject.platform;
  const observed = subject.observedInvocation;
  const profile = subject.profile;
  const provider = stringField(platform, 'provider');
  const workspaceId = stringField(platform, 'workspace_id');
  const target = stringField(observed, 'target');
  const displayName = stringField(profile, 'display_name');
  const username = stringField(profile, 'username');

  return {
    credentialId: credential.id,
    issuer: credential.issuer,
    subject: subject.id,
    method: subject.method,
    ...(subject.assurance !== undefined ? { assurance: subject.assurance } : {}),
    ...(provider !== undefined || workspaceId !== undefined
      ? { platform: { ...(provider !== undefined ? { provider } : {}), ...(workspaceId !== undefined ? { workspaceId } : {}) } }
      : {}),
    ...(target !== undefined ? { observedInvocation: { target } } : {}),
    ...(displayName !== undefined || username !== undefined
      ? { profile: { ...(displayName !== undefined ? { displayName } : {}), ...(username !== undefined ? { username } : {}) } }
      : {}),
  };
}

export class PlatformIdentityVerifier {
  private readonly trustedIssuers: ReadonlySet<string>;
  private readonly maxTtlMs: number;
  private readonly clockSkewMs: number;
  private readonly now: () => Date;
  private readonly suite = new DataIntegrityProof({
    cryptosuite: createVerifyCryptosuite(),
  });

  constructor(private readonly options: PlatformIdentityVerifierOptions) {
    this.trustedIssuers = new Set(options.trustedIssuers);
    this.maxTtlMs = options.limits?.maxTtlMs ?? DEFAULT_IDENTITY_VC_LIMITS.maxTtlMs;
    this.clockSkewMs = options.limits?.clockSkewMs ?? DEFAULT_IDENTITY_VC_LIMITS.clockSkewMs;
    this.now = options.now ?? (() => new Date());
  }

  async verify(
    raw: unknown,
    binding: { expectedDomain: string; messageId: string },
  ): Promise<IdentityVcVerificationResult> {
    const parsed = parsePlatformIdentityCredential(raw);
    if (!parsed.ok) return reject(parsed.code);
    const credential = parsed.credential;

    // Trust is intentionally checked before DID method parsing or resolution,
    // so attacker-selected issuers cannot trigger DNS or HTTPS traffic.
    if (!this.trustedIssuers.has(credential.issuer)) return reject('untrusted_issuer');
    if (!credential.issuer.startsWith('did:web:')) return reject('unsupported_issuer_method');
    if (credential.proof.domain !== binding.expectedDomain) return reject('domain_mismatch');
    if (credential.proof.challenge !== binding.messageId) return reject('challenge_mismatch');

    const validFrom = parseDateTimeStamp(credential.validFrom);
    const validUntil = parseDateTimeStamp(credential.validUntil);
    const now = this.now().getTime();
    if (validFrom === undefined || validUntil === undefined || validUntil <= validFrom) {
      return reject('malformed');
    }
    if (validUntil - validFrom > this.maxTtlMs) return reject('limit_exceeded');
    if (now + this.clockSkewMs < validFrom) return reject('not_yet_valid');
    if (now - this.clockSkewMs >= validUntil) return reject('expired');
    if (
      credential.proof.created !== undefined &&
      parseDateTimeStamp(credential.proof.created) === undefined
    ) {
      return reject('malformed');
    }

    let resolved: unknown;
    try {
      resolved = await this.options.resolver.resolve(credential.issuer);
    } catch {
      return reject('key_fetch_failed');
    }
    if (!hasValidDidDocumentShape(resolved)) return reject('key_fetch_failed');
    let doc = resolved;
    let refreshed = false;
    let method = findVerificationMethod(doc, credential.proof.verificationMethod);
    if (method === undefined && doc.id === credential.issuer) {
      try {
        resolved = await this.options.resolver.resolve(credential.issuer, { refresh: true });
        refreshed = true;
        if (!hasValidDidDocumentShape(resolved)) return reject('key_fetch_failed');
        doc = resolved;
        method = findVerificationMethod(doc, credential.proof.verificationMethod);
      } catch {
        return reject('key_fetch_failed');
      }
    }
    if (
      doc.id !== credential.issuer ||
      method === undefined ||
      method.controller !== credential.issuer ||
      !assertionMethodApproves(doc, credential.proof.verificationMethod)
    ) {
      return reject('issuer_controller_mismatch');
    }

    const verifyWith = async (
      candidateDoc: ResolvedDidDocument,
      candidateMethod: DidVerificationMethod,
    ): Promise<boolean> => {
      const documentLoader = async (url: string) => {
        if (url === candidateMethod.id) {
          return { contextUrl: null, documentUrl: url, document: candidateMethod };
        }
        if (url === candidateDoc.id) {
          return { contextUrl: null, documentUrl: url, document: candidateDoc };
        }
        throw new Error(`Blocked document URL: ${url}`);
      };
      try {
        const verification = await verifyCredential({
          credential,
          suite: this.suite,
          purpose: new CredentialIssuancePurpose(),
          documentLoader,
          now: this.now(),
          // Receiver-local checks above preserve the bridge's exact inclusive
          // boundary semantics; the library remains responsible for VC syntax.
          maxClockSkew: Number.POSITIVE_INFINITY,
        });
        return verification.verified;
      } catch {
        // Digital Bazaar rejects some malformed proof encodings by throwing
        // rather than returning verified:false. Optional evidence must never
        // turn that into a failed outer A2A request.
        return false;
      }
    };

    let verified = await verifyWith(doc, method);
    if (!verified && !refreshed) {
      // Rotation may replace key material while retaining the verification
      // method id. Retry once through the resolver's bounded refresh path.
      try {
        resolved = await this.options.resolver.resolve(credential.issuer, { refresh: true });
      } catch {
        return reject('key_fetch_failed');
      }
      if (!hasValidDidDocumentShape(resolved)) return reject('key_fetch_failed');
      doc = resolved;
      method = findVerificationMethod(doc, credential.proof.verificationMethod);
      if (
        doc.id !== credential.issuer ||
        method === undefined ||
        method.controller !== credential.issuer ||
        !assertionMethodApproves(doc, credential.proof.verificationMethod)
      ) {
        return reject('issuer_controller_mismatch');
      }
      verified = await verifyWith(doc, method);
    }
    if (!verified) return reject('invalid_signature');

    // Resolution and cryptographic verification are untrusted-duration work.
    // Re-evaluate expiration immediately before consuming the replay tuple.
    if (this.now().getTime() - this.clockSkewMs >= validUntil) return reject('expired');

    const identity = normalize(credential);
    if (!PresentedCallerIdentityV1.safeParse(identity).success) return reject('malformed');

    // Consume only after every stateless check, so invalid inputs cannot burn
    // a valid request's one-time tuple.
    let consumed: boolean;
    try {
      consumed = await this.options.replayStore.consume({
        issuer: credential.issuer,
        domain: credential.proof.domain,
        challenge: credential.proof.challenge,
        expiresAt: new Date(validUntil + this.clockSkewMs),
      });
    } catch {
      // Replay protection is mandatory for a verified presentation. Fail this
      // credential closed, but return a structured result so the surrounding
      // optional-evidence request can continue without presented identity.
      return reject('replay_store_failed');
    }
    // The replay store can wait on a pool or database lock. Do not promote a
    // credential that expired while its one-time tuple was being consumed.
    if (this.now().getTime() - this.clockSkewMs >= validUntil) return reject('expired');
    if (!consumed) return reject('replayed');

    return { ok: true, identity };
  }
}
