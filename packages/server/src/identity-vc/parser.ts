import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import {
  MENTIONABLE_IDENTITY_CONTEXT_URI,
  VC_V2_CONTEXT_URI,
  type IdentityVcRejectionCode,
  type UnverifiedPlatformIdentityCredential,
} from './types.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const MAX_PROOF_FIELD_LENGTH = 2_048;
const MAX_CALLER_IDENTIFIER_LENGTH = 512;
const MAX_CALLER_SUMMARY_LENGTH = 256;

const boundedString = (max: number) => z.string().min(1).max(max);
const identifier = boundedString(MAX_CALLER_IDENTIFIER_LENGTH);
const absoluteUri = identifier.url();
const summary = boundedString(MAX_CALLER_SUMMARY_LENGTH);

const credentialSchema = z.object({
  '@context': z.array(z.unknown()),
  id: absoluteUri,
  type: z.array(z.unknown()),
  issuer: boundedString(MAX_CALLER_IDENTIFIER_LENGTH),
  validFrom: boundedString(128),
  validUntil: boundedString(128),
  credentialSubject: z.object({
    id: absoluteUri,
    method: summary,
    assurance: summary.optional(),
    platform: z.object({
      provider: summary.optional(),
      workspaceId: summary.optional(),
    }).passthrough().optional(),
    observedInvocation: z.object({
      target: identifier.optional(),
    }).passthrough().optional(),
    profile: z.object({
      displayName: summary.optional(),
      username: summary.optional(),
    }).passthrough().optional(),
  }).passthrough(),
  proof: z.object({
    '@context': z.array(z.unknown()),
    type: z.literal('DataIntegrityProof'),
    cryptosuite: z.literal('eddsa-jcs-2022'),
    proofPurpose: z.literal('assertionMethod'),
    verificationMethod: boundedString(MAX_PROOF_FIELD_LENGTH),
    proofValue: boundedString(MAX_PROOF_FIELD_LENGTH),
    domain: boundedString(MAX_PROOF_FIELD_LENGTH),
    challenge: boundedString(MAX_PROOF_FIELD_LENGTH),
    created: boundedString(128).optional(),
  }).passthrough(),
}).passthrough();

const DATE_TIME_STAMP_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|([+-])(\d{2}):(\d{2}))$/u;

/** Strict XML Schema dateTimeStamp syntax and calendar validation. */
export function parseDateTimeStamp(value: string): number | undefined {
  const match = DATE_TIME_STAMP_RE.exec(value);
  if (!match) return undefined;
  const [, yearRaw, monthRaw, dayRaw, hourRaw, minuteRaw, secondRaw, , zone, , tzHourRaw, tzMinuteRaw] = match;
  const year = Number(yearRaw);
  const month = Number(monthRaw);
  const day = Number(dayRaw);
  const hour = Number(hourRaw);
  const minute = Number(minuteRaw);
  const second = Number(secondRaw);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > days[month - 1]! ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return undefined;
  }
  if (zone !== 'Z') {
    const tzHour = Number(tzHourRaw);
    const tzMinute = Number(tzMinuteRaw);
    if (tzHour > 14 || tzMinute > 59 || (tzHour === 14 && tzMinute !== 0)) return undefined;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

export type ParseCredentialResult =
  | { ok: true; credential: UnverifiedPlatformIdentityCredential }
  | { ok: false; code: IdentityVcRejectionCode };

/** Structural parsing never promotes a credential to a trusted identity. */
export function parsePlatformIdentityCredential(input: unknown): ParseCredentialResult {
  if (!isRecord(input)) return { ok: false, code: 'malformed' };

  const context = input['@context'];
  const types = input.type;
  if (
    !Array.isArray(context) ||
    context[0] !== VC_V2_CONTEXT_URI ||
    context[1] !== MENTIONABLE_IDENTITY_CONTEXT_URI ||
    !Array.isArray(types) ||
    !types.includes('VerifiableCredential') ||
    !types.includes('PlatformIdentityCredential')
  ) {
    return { ok: false, code: 'unsupported_profile' };
  }

  const proof = input.proof;
  if (!isRecord(proof)) return { ok: false, code: 'malformed' };
  if (proof.type !== 'DataIntegrityProof' || proof.cryptosuite !== 'eddsa-jcs-2022') {
    return { ok: false, code: 'unsupported_cryptosuite' };
  }
  if (!Array.isArray(proof['@context']) || !isDeepStrictEqual(proof['@context'], context)) {
    return { ok: false, code: 'unsupported_profile' };
  }
  const parsed = credentialSchema.safeParse(input);
  if (!parsed.success) {
    const code = parsed.error.issues.some((issue) => issue.code === 'too_big')
      ? 'limit_exceeded'
      : 'malformed';
    return { ok: false, code };
  }

  return {
    ok: true,
    credential: parsed.data as unknown as UnverifiedPlatformIdentityCredential,
  };
}
