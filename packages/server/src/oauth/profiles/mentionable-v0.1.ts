import { createHash } from 'node:crypto';
import { CallerAttestationV2 } from '@vicoop-bridge/protocol';
export * from '@mentionable/connector-kit';
import {
  evaluateTokenExchangeRequest,
  OAUTH_FEDERATION_CLAIM_METHOD,
  OAUTH_FEDERATION_CLAIM_TASK_ID,
  OAUTH_FEDERATION_ASSERTION_MAX_TTL_SECONDS,
  OAUTH_FEDERATION_CLOCK_SKEW_SECONDS,
  OAUTH_FEDERATION_EXTENSION_URI,
  OAUTH_FEDERATION_SCOPES,
  OAUTH_FEDERATION_TYP_SUBJECT_ASSERTION,
  OAUTH_FEDERATION_TYP_TASK_CONTINUATION_ASSERTION,
  OAUTH_TOKEN_ENDPOINT_AUTH_METHOD_PRIVATE_KEY_JWT,
  OAUTH_TOKEN_TYPE_JWT,
} from '@mentionable/connector-kit';
import {
  verifyTokenExchange,
  type IssuerDidDocument,
  type TokenExchangePolicyCandidate,
  type TokenExchangeVerifyResult,
} from '@mentionable/connector-kit/signing';
import { decodeJwt, decodeProtectedHeader } from 'jose';
import { formatFederatedPrincipal, parseFederatedPrincipal } from '../../auth/principal.js';
import type { DidDocumentResolver, ResolvedDidDocument } from '../../identity-vc/types.js';
import {
  consumeTokenExchangeReplays,
  loadTokenExchangeTaskAuthorization,
  TokenExchangeReplayError,
} from '../token-exchange/store.js';
import type {
  TokenExchangeErrorCode,
  TokenExchangeFailure,
  TokenExchangeProfile,
} from '../token-exchange/types.js';

interface CandidateAssertion {
  typ: string;
  issuer: string;
  subject: string;
  method?: string;
  taskId?: string;
}

function decodeCandidate(token: string): CandidateAssertion | null {
  try {
    const header = decodeProtectedHeader(token);
    const payload = decodeJwt(token);
    if (
      typeof header.typ !== 'string' ||
      typeof payload.iss !== 'string' ||
      typeof payload.sub !== 'string'
    ) {
      return null;
    }
    const method = payload[OAUTH_FEDERATION_CLAIM_METHOD];
    const taskId = payload[OAUTH_FEDERATION_CLAIM_TASK_ID];
    return {
      typ: header.typ,
      issuer: payload.iss,
      subject: payload.sub,
      ...(typeof method === 'string' ? { method } : {}),
      ...(typeof taskId === 'string' ? { taskId } : {}),
    };
  } catch {
    return null;
  }
}

function asConnectorKitDidDocument(doc: ResolvedDidDocument): IssuerDidDocument {
  const assertionMethod: IssuerDidDocument['assertionMethod'] = [];
  for (const entry of Array.isArray(doc.assertionMethod) ? doc.assertionMethod : []) {
    if (typeof entry === 'string') {
      assertionMethod.push(entry);
    } else if (typeof entry === 'object' && entry !== null) {
      const value = entry as Record<string, unknown>;
      if (typeof value.id === 'string') assertionMethod.push({ ...value, id: value.id });
    }
  }
  return {
    ...doc,
    id: doc.id,
    verificationMethod: Array.isArray(doc.verificationMethod)
      ? doc.verificationMethod.flatMap((entry) => {
          if (typeof entry !== 'object' || entry === null) return [];
          const value = entry as Record<string, unknown>;
          if (typeof value.id !== 'string') return [];
          return [{ ...value, id: value.id }];
        })
      : undefined,
    assertionMethod,
  };
}

function verificationError(result: Exclude<TokenExchangeVerifyResult, { ok: true }>): {
  status: 400 | 401;
  error: TokenExchangeErrorCode;
  stage: string;
  reason: string;
} {
  if (result.stage === 'shape') {
    return {
      status: result.error === 'invalid_client' ? 401 : 400,
      error: result.error,
      stage: result.stage,
      reason: result.reason,
    };
  }
  if (result.stage === 'client-assertion') {
    return {
      status: 401,
      error: 'invalid_client',
      stage: result.stage,
      reason: result.reason,
    };
  }
  if (result.stage === 'subject-assertion') {
    return {
      status: 400,
      error: 'invalid_grant',
      stage: result.stage,
      reason: result.reason,
    };
  }
  if (result.stage === 'policy') {
    return {
      status: 400,
      error: result.error,
      stage: result.stage,
      reason: result.reason,
    };
  }
  return {
    status: 400,
    error: 'invalid_request',
    stage: result.stage,
    reason: result.reason,
  };
}

export interface MentionableOAuthProfileOptions {
  resolver: DidDocumentResolver;
}

export const MENTIONABLE_OAUTH_PROFILE_ID = OAUTH_FEDERATION_EXTENSION_URI;

class MentionablePolicyStoreError extends Error {}
class MentionableReplayStoreError extends Error {}

function failure(
  status: 400 | 401 | 500,
  error: TokenExchangeErrorCode,
  description: string,
  reason: string,
  stage?: string,
): TokenExchangeFailure {
  return {
    ok: false,
    status,
    error,
    description,
    reason,
    ...(stage ? { stage } : {}),
  };
}

export function createMentionableOAuthProfile(
  options: MentionableOAuthProfileOptions,
): TokenExchangeProfile {
  return {
    id: MENTIONABLE_OAUTH_PROFILE_ID,
    replayProtection: 'required',
    replayPersistence: 'profile',
    clientAuthMethods: [OAUTH_TOKEN_ENDPOINT_AUTH_METHOD_PRIVATE_KEY_JWT],
    clientAuthSigningAlgorithms: ['EdDSA'],
    scopes: OAUTH_FEDERATION_SCOPES,
    subjectTokenTypes: [OAUTH_TOKEN_TYPE_JWT],
    authorizationServerMetadata: {
      mentionable_profile: OAUTH_FEDERATION_EXTENSION_URI,
    },
    recognizes(form) {
      const token = form.get('subject_token');
      if (!token) return false;
      const candidate = decodeCandidate(token);
      return (
        candidate?.typ === OAUTH_FEDERATION_TYP_SUBJECT_ASSERTION ||
        candidate?.typ === OAUTH_FEDERATION_TYP_TASK_CONTINUATION_ASSERTION
      );
    },
    validateRequest(form, expectedResource) {
      const shape = evaluateTokenExchangeRequest(form, { expectedResource });
      if (!shape.ok) {
        return failure(
          shape.error === 'invalid_client' ? 401 : 400,
          shape.error,
          'token exchange request is invalid',
          shape.reason,
          'shape',
        );
      }
      return undefined;
    },
    async verify({ sql, form, tokenEndpoint, expectedResource, agentId, allowedCallers, now }) {
      const subjectToken = form.get('subject_token')!;
      let authorizationKey: string | undefined;
      let policyCandidate: TokenExchangePolicyCandidate | undefined;
      let issuerDocument: IssuerDidDocument | undefined;
      let trustedTask:
        | {
            principalId: string;
            actorId: string;
            authorizationKey: string;
            taskId: string;
          }
        | undefined;
      let verification: TokenExchangeVerifyResult;
      try {
        verification = await verifyTokenExchange(form, {
          tokenEndpoint,
          verifiedAt: now.toISOString(),
          expectedResource,
          trustedIssuers: new Set([form.get('client_id')!]),
          resolveIssuerDocument: (issuer) =>
            issuer === policyCandidate?.issuer ? issuerDocument : undefined,
          authorizeCandidateBeforeFetch: async (candidate) => {
            if (candidate.resource !== expectedResource) return false;
            if (
              candidate.scopes.length === 0 ||
              candidate.scopes.some(
                (scope) => !(OAUTH_FEDERATION_SCOPES as readonly string[]).includes(scope),
              )
            ) {
              return false;
            }

            let matchedAuthorizationKey: string | undefined;
            if (candidate.kind === 'platform') {
              matchedAuthorizationKey =
                formatFederatedPrincipal({
                  issuer: candidate.issuer,
                  method: candidate.method,
                  subject: candidate.subject,
                }) ?? undefined;
              if (
                matchedAuthorizationKey === undefined ||
                !allowedCallers.includes(matchedAuthorizationKey)
              ) {
                return false;
              }
            } else {
              let task;
              try {
                task = await loadTokenExchangeTaskAuthorization(sql, agentId, candidate.taskId);
              } catch (error) {
                throw new MentionablePolicyStoreError('task policy lookup failed', {
                  cause: error,
                });
              }
              if (
                !task?.principalId ||
                !task.actorId ||
                task.authorizationRevoked ||
                task.profileId !== MENTIONABLE_OAUTH_PROFILE_ID ||
                !task.authorizationKey ||
                task.principalId !== candidate.subject ||
                task.actorId !== candidate.issuer ||
                !allowedCallers.includes(task.authorizationKey)
              ) {
                return false;
              }
              matchedAuthorizationKey = task.authorizationKey;
              trustedTask = {
                principalId: task.principalId,
                actorId: task.actorId,
                authorizationKey: task.authorizationKey,
                taskId: candidate.taskId,
              };
            }

            // Preserve the receiver-owned key independently from the
            // verifier's boolean callback result. The DID fetch happens only
            // after this exact candidate has matched local policy.
            authorizationKey = matchedAuthorizationKey;
            policyCandidate = candidate;
            try {
              issuerDocument = asConnectorKitDidDocument(
                await options.resolver.resolve(candidate.issuer),
              );
            } catch {
              issuerDocument = undefined;
            }
            return true;
          },
          replayCache: {
            async register(tuple) {
              const expiresAt = new Date(
                now.getTime() +
                  (OAUTH_FEDERATION_ASSERTION_MAX_TTL_SECONDS +
                    2 * OAUTH_FEDERATION_CLOCK_SKEW_SECONDS) *
                    1000,
              );
              try {
                await consumeTokenExchangeReplays(sql, MENTIONABLE_OAUTH_PROFILE_ID, [
                  { ...tuple, expiresAt },
                ]);
                return true;
              } catch (error) {
                if (error instanceof TokenExchangeReplayError) return false;
                throw new MentionableReplayStoreError('assertion replay registration failed', {
                  cause: error,
                });
              }
            },
          },
        });
      } catch (error) {
        if (error instanceof MentionablePolicyStoreError) {
          return failure(
            500,
            'server_error',
            'token exchange temporarily unavailable',
            'policy_store_failed',
            'policy',
          );
        }
        if (error instanceof MentionableReplayStoreError) {
          return failure(
            500,
            'server_error',
            'token exchange temporarily unavailable',
            'replay_store_failed',
            'replay',
          );
        }
        return failure(
          500,
          'server_error',
          'token exchange temporarily unavailable',
          'verifier_failed',
        );
      }
      if (!verification.ok) {
        const mapped = verificationError(verification);
        const policyDescription =
          mapped.stage === 'policy'
            ? decodeCandidate(subjectToken)?.typ ===
              OAUTH_FEDERATION_TYP_TASK_CONTINUATION_ASSERTION
              ? 'task continuation is not authorized'
              : 'subject is not authorized for this resource'
            : undefined;
        return failure(
          mapped.status,
          mapped.error,
          policyDescription ?? `${mapped.stage} verification failed`,
          mapped.reason,
          mapped.stage,
        );
      }

      const context = verification.authorization;
      if (
        policyCandidate === undefined ||
        context.actor !== policyCandidate.issuer ||
        context.principal !== policyCandidate.subject ||
        (trustedTask !== undefined && context.task_id !== trustedTask.taskId) ||
        (trustedTask === undefined && context.task_id !== undefined)
      ) {
        return failure(
          400,
          'invalid_grant',
          'verified authorization binding mismatch',
          'verified_binding_mismatch',
        );
      }

      const parsedTuple = parseFederatedPrincipal(authorizationKey!);
      if (!parsedTuple) {
        return failure(
          500,
          'server_error',
          'token exchange temporarily unavailable',
          'stored_tuple_invalid',
        );
      }
      const verifiedSubjectPayload = decodeJwt(subjectToken);
      const attestationResult = CallerAttestationV2.safeParse({
        credentialId:
          'urn:mentionable:oauth-assertion:' +
          createHash('sha256')
            .update(context.actor)
            .update('\0')
            .update(verifiedSubjectPayload.jti as string)
            .digest('base64url'),
        issuer: parsedTuple.issuer,
        subject: parsedTuple.subject,
        method: parsedTuple.method,
      });
      if (!attestationResult.success) {
        return failure(
          400,
          'invalid_grant',
          'subject assertion exceeds caller context limits',
          'context_limits',
        );
      }

      return {
        ok: true,
        principalId: context.principal,
        actorId: context.actor,
        authorizationKey: authorizationKey!,
        attestation: attestationResult.data,
        scopes: verification.scopes,
        ...(context.task_id !== undefined ? { taskId: context.task_id } : {}),
        replays: [],
        kind: context.task_id === undefined ? 'platform_subject' : 'task_continuation',
      };
    },
  };
}
