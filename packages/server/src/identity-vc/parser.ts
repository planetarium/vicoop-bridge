import { isDeepStrictEqual } from 'node:util';
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

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function validAbsoluteUri(value: unknown): value is string {
  if (!nonEmptyString(value)) return false;
  try {
    return new URL(value).href.length > 0;
  } catch {
    return false;
  }
}

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

function validOptionalStringField(record: Record<string, unknown>, key: string): boolean {
  return record[key] === undefined || nonEmptyString(record[key]);
}

function exceeds(value: string, maxLength: number): boolean {
  return value.length > maxLength;
}

function optionalExceeds(
  record: Record<string, unknown> | undefined,
  key: string,
  maxLength: number,
): boolean {
  const value = record?.[key];
  return typeof value === 'string' && exceeds(value, maxLength);
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

  if (
    !validAbsoluteUri(input.id) ||
    !nonEmptyString(input.issuer) ||
    !nonEmptyString(input.validFrom) ||
    !nonEmptyString(input.validUntil) ||
    !isRecord(input.credentialSubject) ||
    !validAbsoluteUri(input.credentialSubject.id) ||
    !nonEmptyString(input.credentialSubject.method) ||
    (input.credentialSubject.assurance !== undefined &&
      !nonEmptyString(input.credentialSubject.assurance)) ||
    (input.credentialSubject.platform !== undefined &&
      !isRecord(input.credentialSubject.platform)) ||
    (input.credentialSubject.observedInvocation !== undefined &&
      !isRecord(input.credentialSubject.observedInvocation)) ||
    (input.credentialSubject.profile !== undefined &&
      !isRecord(input.credentialSubject.profile)) ||
    !isRecord(input.proof)
  ) {
    return { ok: false, code: 'malformed' };
  }

  if (
    exceeds(input.id, MAX_CALLER_IDENTIFIER_LENGTH) ||
    exceeds(input.issuer, MAX_CALLER_IDENTIFIER_LENGTH) ||
    exceeds(input.credentialSubject.id, MAX_CALLER_IDENTIFIER_LENGTH) ||
    exceeds(input.credentialSubject.method, MAX_CALLER_SUMMARY_LENGTH) ||
    (typeof input.credentialSubject.assurance === 'string' &&
      exceeds(input.credentialSubject.assurance, MAX_CALLER_SUMMARY_LENGTH)) ||
    exceeds(input.validFrom, 128) ||
    exceeds(input.validUntil, 128)
  ) {
    return { ok: false, code: 'limit_exceeded' };
  }

  const platform = input.credentialSubject.platform;
  const observed = input.credentialSubject.observedInvocation;
  const profile = input.credentialSubject.profile;
  if (
    (isRecord(platform) &&
      (!validOptionalStringField(platform, 'provider') ||
        !validOptionalStringField(platform, 'workspaceId'))) ||
    (isRecord(observed) && !validOptionalStringField(observed, 'target')) ||
    (isRecord(profile) &&
      (!validOptionalStringField(profile, 'displayName') ||
        !validOptionalStringField(profile, 'username')))
  ) {
    return { ok: false, code: 'malformed' };
  }

  if (
    optionalExceeds(isRecord(platform) ? platform : undefined, 'provider', MAX_CALLER_SUMMARY_LENGTH) ||
    optionalExceeds(isRecord(platform) ? platform : undefined, 'workspaceId', MAX_CALLER_SUMMARY_LENGTH) ||
    optionalExceeds(isRecord(observed) ? observed : undefined, 'target', MAX_CALLER_IDENTIFIER_LENGTH) ||
    optionalExceeds(isRecord(profile) ? profile : undefined, 'displayName', MAX_CALLER_SUMMARY_LENGTH) ||
    optionalExceeds(isRecord(profile) ? profile : undefined, 'username', MAX_CALLER_SUMMARY_LENGTH)
  ) {
    return { ok: false, code: 'limit_exceeded' };
  }

  const proof = input.proof;
  if (proof.type !== 'DataIntegrityProof' || proof.cryptosuite !== 'eddsa-jcs-2022') {
    return { ok: false, code: 'unsupported_cryptosuite' };
  }
  if (!Array.isArray(proof['@context']) || !isDeepStrictEqual(proof['@context'], context)) {
    return { ok: false, code: 'unsupported_profile' };
  }
  if (
    proof.proofPurpose !== 'assertionMethod' ||
    !nonEmptyString(proof.verificationMethod) ||
    !nonEmptyString(proof.proofValue) ||
    !nonEmptyString(proof.domain) ||
    !nonEmptyString(proof.challenge) ||
    (proof.created !== undefined && !nonEmptyString(proof.created))
  ) {
    return { ok: false, code: 'malformed' };
  }
  if (
    exceeds(proof.verificationMethod, MAX_PROOF_FIELD_LENGTH) ||
    exceeds(proof.proofValue, MAX_PROOF_FIELD_LENGTH) ||
    exceeds(proof.domain, MAX_PROOF_FIELD_LENGTH) ||
    exceeds(proof.challenge, MAX_PROOF_FIELD_LENGTH) ||
    (typeof proof.created === 'string' && exceeds(proof.created, 128))
  ) {
    return { ok: false, code: 'limit_exceeded' };
  }

  return { ok: true, credential: input as unknown as UnverifiedPlatformIdentityCredential };
}
