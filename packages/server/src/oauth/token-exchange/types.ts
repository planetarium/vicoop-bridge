import type { CallerAttestationV2 } from '@vicoop-bridge/protocol';
import type { Sql } from '../../db.js';

/** RFC 8693 protocol identifiers owned by the generic token-exchange layer. */
export const TOKEN_EXCHANGE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:token-exchange';
export const ACCESS_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:access_token';

/** Bridge policy for opaque access tokens; profiles do not control token shape. */
export const TOKEN_EXCHANGE_ACCESS_TOKEN_PREFIX = 'vbc_oauth_';
export const TOKEN_EXCHANGE_ACCESS_TOKEN_TTL_SECONDS = 300;
export const TOKEN_EXCHANGE_MAX_FORM_BYTES = 64 * 1024;

export type TokenExchangeErrorCode =
  | 'invalid_request'
  | 'invalid_client'
  | 'invalid_grant'
  | 'unsupported_grant_type'
  | 'invalid_scope'
  | 'invalid_target'
  | 'unauthorized_client'
  | 'server_error';

export interface TokenExchangeFailure {
  ok: false;
  status: 400 | 401 | 500;
  error: TokenExchangeErrorCode;
  description: string;
  reason: string;
  stage?: string;
}

export interface TokenExchangeReplay {
  issuer: string;
  jti: string;
  expiresAt: Date;
}

export interface TokenExchangeAuthorization {
  ok: true;
  principalId: string;
  actorId: string;
  authorizationKey: string;
  scopes: string[];
  taskId?: string;
  attestation?: CallerAttestationV2;
  replays: TokenExchangeReplay[];
  kind: string;
}

export type TokenExchangeProfileResult = TokenExchangeAuthorization | TokenExchangeFailure;

export interface TokenExchangeProfileContext {
  sql: Sql;
  form: URLSearchParams;
  tokenEndpoint: string;
  expectedResource: string;
  agentId: string;
  allowedCallers: string[];
  now: Date;
}

/**
 * One authorization profile layered on RFC 8693.
 *
 * The core owns HTTP parsing, resource selection, opaque token issuance, and
 * the RFC response. It persists replay evidence by default; a profile may do
 * so inside its verifier when that ordering is part of the profile contract.
 * A profile owns assertion syntax, trust establishment, cryptographic
 * verification, scopes, and the derived principal/actor authorization context.
 */
export interface TokenExchangeProfile {
  id: string;
  /**
   * Profiles must explicitly declare whether successful exchanges produce
   * single-use replay evidence. `required` is enforced by the core before any
   * token is issued; `not-applicable` is for exchanges whose subject/client
   * credentials are not replayable assertions.
   */
  replayProtection: 'required' | 'not-applicable';
  /**
   * Where required assertion replays are atomically registered. The generic
   * core consumes `result.replays` by default; profiles whose reference
   * verifier requires an in-verifier replay cache set this to `profile`.
   */
  replayPersistence?: 'core' | 'profile';
  clientAuthMethods: readonly string[];
  clientAuthSigningAlgorithms: readonly string[];
  scopes: readonly string[];
  subjectTokenTypes: readonly string[];
  authorizationServerMetadata?: Readonly<Record<string, unknown>>;
  /** Optional profile override for a replayed assertion; RFC 8693 defaults to invalid_request. */
  replayFailure?: TokenExchangeFailure;
  recognizes(form: URLSearchParams): boolean;
  validateRequest?(
    form: URLSearchParams,
    expectedResource: string,
  ): TokenExchangeFailure | undefined;
  verify(context: TokenExchangeProfileContext): Promise<TokenExchangeProfileResult>;
}
