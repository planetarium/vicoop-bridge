import { createHash } from 'node:crypto';
import { CallerAttestationV2 } from '@vicoop-bridge/protocol';
export * from '@mentionable/connector-kit';
import {
  evaluateTokenExchangeRequest,
  OAUTH_FEDERATION_CLAIM_METHOD,
  OAUTH_FEDERATION_CLAIM_TASK_ID,
  OAUTH_FEDERATION_CLOCK_SKEW_SECONDS,
  OAUTH_FEDERATION_EXTENSION_URI,
  OAUTH_FEDERATION_SCOPES,
  OAUTH_FEDERATION_TYP_SUBJECT_ASSERTION,
  OAUTH_FEDERATION_TYP_TASK_CONTINUATION_ASSERTION,
  OAUTH_TOKEN_TYPE_JWT,
} from '@mentionable/connector-kit';
import {
  verifyTokenExchange,
  type IssuerDidDocument,
  type TokenExchangeVerifyResult,
} from '@mentionable/connector-kit/signing';
import { decodeJwt, decodeProtectedHeader, type JWTPayload } from 'jose';
import { formatFederatedPrincipal, parseFederatedPrincipal } from '../../auth/principal.js';
import type { DidDocumentResolver, ResolvedDidDocument } from '../../identity-vc/types.js';
import { loadTokenExchangeTaskAuthorization } from '../token-exchange/store.js';
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
  const assertionMethod: (string | { id: string })[] = [];
  for (const entry of Array.isArray(doc.assertionMethod) ? doc.assertionMethod : []) {
    if (typeof entry === 'string') {
      assertionMethod.push(entry);
    } else if (typeof entry === 'object' && entry !== null) {
      const id = (entry as { id?: unknown }).id;
      if (typeof id === 'string') assertionMethod.push({ id });
    }
  }
  return {
    ...doc,
    id: doc.id,
    verificationMethod: Array.isArray(doc.verificationMethod)
      ? doc.verificationMethod.flatMap((entry) => {
          if (typeof entry !== 'object' || entry === null) return [];
          const value = entry as Record<string, unknown>;
          if (typeof value.id !== 'string' || value.controller !== doc.id) return [];
          return [{ ...value, id: value.id }];
        })
      : undefined,
    assertionMethod,
  };
}

function verifiedReplayTuple(payload: JWTPayload): {
  issuer: string;
  jti: string;
  expiresAt: Date;
} {
  return {
    issuer: payload.iss as string,
    jti: payload.jti as string,
    expiresAt: new Date(((payload.exp as number) + OAUTH_FEDERATION_CLOCK_SKEW_SECONDS) * 1000),
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
    clientAuthMethods: ['private_key_jwt'],
    clientAuthSigningAlgorithms: ['EdDSA'],
    scopes: OAUTH_FEDERATION_SCOPES,
    subjectTokenTypes: [OAUTH_TOKEN_TYPE_JWT],
    authorizationServerMetadata: {
      mentionable_profile: OAUTH_FEDERATION_EXTENSION_URI,
    },
    // Mentionable v0.1 pins replayed subject assertions to invalid_grant.
    replayFailure: failure(400, 'invalid_grant', 'assertion replayed', 'replayed_jti'),
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
      if (shape.scopes.length === 0) {
        return failure(
          400,
          'invalid_scope',
          'at least one scope is required',
          'empty_scope',
          'shape',
        );
      }
      return undefined;
    },
    async verify({ sql, form, tokenEndpoint, expectedResource, agentId, allowedCallers, now }) {
      const subjectToken = form.get('subject_token')!;
      const candidate = decodeCandidate(subjectToken);
      if (!candidate) {
        return failure(
          400,
          'invalid_request',
          'malformed subject assertion',
          'malformed_subject',
          'shape',
        );
      }

      let authorizationKey: string | undefined;
      let trustedTask:
        | {
            principalId: string;
            actorId: string;
            authorizationKey: string;
            taskId: string;
          }
        | undefined;
      if (candidate.typ === OAUTH_FEDERATION_TYP_SUBJECT_ASSERTION) {
        if (!candidate.method) {
          return failure(
            400,
            'invalid_grant',
            'subject assertion has no authentication method',
            'missing_method',
          );
        }
        authorizationKey =
          formatFederatedPrincipal({
            issuer: candidate.issuer,
            method: candidate.method,
            subject: candidate.subject,
          }) ?? undefined;
        if (!authorizationKey || !allowedCallers.includes(authorizationKey)) {
          return failure(
            400,
            'invalid_grant',
            'subject is not authorized for this resource',
            'caller_not_allowed',
          );
        }
      } else if (candidate.typ === OAUTH_FEDERATION_TYP_TASK_CONTINUATION_ASSERTION) {
        if (!candidate.taskId) {
          return failure(
            400,
            'invalid_grant',
            'continuation assertion has no task binding',
            'missing_task_id',
          );
        }
        const task = await loadTokenExchangeTaskAuthorization(sql, agentId, candidate.taskId);
        if (
          !task?.principalId ||
          !task.actorId ||
          task.profileId !== MENTIONABLE_OAUTH_PROFILE_ID ||
          !task.authorizationKey ||
          task.principalId !== candidate.subject ||
          task.actorId !== candidate.issuer ||
          !allowedCallers.includes(task.authorizationKey)
        ) {
          return failure(
            400,
            'invalid_grant',
            'task continuation is not authorized',
            'task_binding_mismatch',
          );
        }
        authorizationKey = task.authorizationKey;
        trustedTask = {
          principalId: task.principalId,
          actorId: task.actorId,
          authorizationKey: task.authorizationKey,
          taskId: candidate.taskId,
        };
      } else {
        return failure(400, 'invalid_grant', 'unsupported subject assertion type', 'wrong_typ');
      }

      // Exact receiver policy has matched. Only now may an issuer-controlled
      // did:web URL be resolved.
      let issuerDocument: IssuerDidDocument;
      try {
        issuerDocument = asConnectorKitDidDocument(
          await options.resolver.resolve(candidate.issuer),
        );
      } catch {
        return failure(
          400,
          'invalid_grant',
          'subject assertion verification failed',
          'did_resolution_failed',
          'subject-assertion',
        );
      }

      let verification: TokenExchangeVerifyResult;
      try {
        verification = await verifyTokenExchange(form, {
          tokenEndpoint,
          verifiedAt: now.toISOString(),
          expectedResource,
          trustedIssuers: new Set([candidate.issuer]),
          resolveIssuerDocument: (issuer) =>
            issuer === candidate.issuer ? issuerDocument : undefined,
        });
      } catch {
        return failure(
          500,
          'server_error',
          'token exchange temporarily unavailable',
          'verifier_failed',
        );
      }
      if (!verification.ok) {
        const mapped = verificationError(verification);
        return failure(
          mapped.status,
          mapped.error,
          `${mapped.stage} verification failed`,
          mapped.reason,
          mapped.stage,
        );
      }

      const context = verification.authorization;
      if (
        context.actor !== candidate.issuer ||
        context.principal !== candidate.subject ||
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

      const verifiedClientPayload = decodeJwt(form.get('client_assertion')!);
      return {
        ok: true,
        principalId: context.principal,
        actorId: context.actor,
        authorizationKey: authorizationKey!,
        attestation: attestationResult.data,
        scopes: verification.scopes,
        ...(context.task_id !== undefined ? { taskId: context.task_id } : {}),
        replays: [
          verifiedReplayTuple(verifiedClientPayload),
          verifiedReplayTuple(verifiedSubjectPayload),
        ],
        kind: context.task_id === undefined ? 'platform_subject' : 'task_continuation',
      };
    },
  };
}
