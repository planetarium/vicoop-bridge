import { createHash } from 'node:crypto';
import { CallerAttestationV2 } from '@vicoop-bridge/protocol';
import {
  evaluateTokenExchangeRequest,
  OAUTH_FEDERATION_CLAIM_METHOD,
  OAUTH_FEDERATION_CLAIM_TASK_ID,
  OAUTH_FEDERATION_CLOCK_SKEW_SECONDS,
  OAUTH_FEDERATION_EXTENSION_URI,
  OAUTH_FEDERATION_SCOPES,
  OAUTH_FEDERATION_TYP_SUBJECT_ASSERTION,
  OAUTH_FEDERATION_TYP_TASK_CONTINUATION_ASSERTION,
  OAUTH_GRANT_TYPE_TOKEN_EXCHANGE,
  OAUTH_TOKEN_TYPE_ACCESS_TOKEN,
} from '@mentionable/connector-kit';
import {
  verifyTokenExchange,
  type IssuerDidDocument,
  type TokenExchangeVerifyResult,
} from '@mentionable/connector-kit/signing';
import { decodeJwt, decodeProtectedHeader, type JWTPayload } from 'jose';
import type { Hono, Context, Next } from 'hono';
import { formatFederatedPrincipal, parseFederatedPrincipal } from '../auth/principal.js';
import type { Sql } from '../db.js';
import type { DidDocumentResolver, ResolvedDidDocument } from '../identity-vc/types.js';
import { logEvent } from '../log.js';
import { newRejectionId } from '../agent-auth.js';
import {
  OAUTH_FEDERATION_ACCESS_TOKEN_TTL_SECONDS,
  OAUTH_FEDERATION_MAX_FORM_BYTES,
} from './profile.js';
import {
  consumeFederationReplays,
  FederatedReplayError,
  issueFederatedAccessToken,
  loadFederatedTaskAuthorization,
} from './store.js';

type OAuthErrorCode =
  | 'invalid_request'
  | 'invalid_client'
  | 'invalid_grant'
  | 'unsupported_grant_type'
  | 'invalid_scope'
  | 'invalid_target'
  | 'unauthorized_client'
  | 'server_error';

function oauthError(
  c: Context,
  status: 400 | 401 | 500,
  error: OAuthErrorCode,
  description: string,
  rejectionId?: string,
) {
  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');
  return c.json({
    error,
    error_description: description,
    ...(rejectionId !== undefined ? { rejection_id: rejectionId } : {}),
  }, status);
}

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

function canonicalAgentResource(publicUrl: string, agentId: string): string {
  return `${publicUrl.replace(/\/$/, '')}/agents/${agentId}`;
}

function agentIdFromResource(publicUrl: string, resource: string): string | null {
  try {
    const base = new URL(publicUrl);
    const target = new URL(resource);
    if (target.origin !== base.origin || target.search || target.hash) return null;
    const basePath = base.pathname.replace(/\/$/, '');
    const prefix = `${basePath}/agents/`;
    if (!target.pathname.startsWith(prefix)) return null;
    const encoded = target.pathname.slice(prefix.length);
    if (!encoded || encoded.includes('/')) return null;
    const agentId = decodeURIComponent(encoded);
    return resource === canonicalAgentResource(publicUrl, agentId) ? agentId : null;
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
    expiresAt: new Date(
      ((payload.exp as number) + OAUTH_FEDERATION_CLOCK_SKEW_SECONDS) * 1000,
    ),
  };
}

function verificationError(result: Exclude<TokenExchangeVerifyResult, { ok: true }>): {
  status: 400 | 401;
  error: OAuthErrorCode;
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
    return { status: 401, error: 'invalid_client', stage: result.stage, reason: result.reason };
  }
  if (result.stage === 'subject-assertion') {
    return { status: 400, error: 'invalid_grant', stage: result.stage, reason: result.reason };
  }
  return { status: 400, error: 'invalid_request', stage: result.stage, reason: result.reason };
}

export interface OAuthFederationRouteOptions {
  sql: Sql;
  publicUrl: string;
  resolver: DidDocumentResolver;
  now?: () => Date;
  /** Whether another /oauth/token handler should receive non-exchange grants. */
  passThroughOtherGrants?: boolean;
}

export function mountOAuthFederationRoutes(
  app: Hono,
  options: OAuthFederationRouteOptions,
): void {
  const publicUrl = options.publicUrl.replace(/\/$/, '');
  const tokenEndpoint = `${publicUrl}/oauth/token`;

  app.get('/.well-known/oauth-authorization-server', (c) =>
    c.json({
      issuer: publicUrl,
      token_endpoint: tokenEndpoint,
      grant_types_supported: [OAUTH_GRANT_TYPE_TOKEN_EXCHANGE],
      token_endpoint_auth_methods_supported: ['private_key_jwt'],
      token_endpoint_auth_signing_alg_values_supported: ['EdDSA'],
      scopes_supported: [...OAUTH_FEDERATION_SCOPES],
      subject_token_types_supported: ['urn:ietf:params:oauth:token-type:jwt'],
      mentionable_profile: OAUTH_FEDERATION_EXTENSION_URI,
    }),
  );

  app.post('/oauth/token', async (c: Context, next: Next) => {
    const contentType = c.req.header('Content-Type')?.split(';', 1)[0]?.trim().toLowerCase();
    const declaredLength = Number(c.req.header('Content-Length') ?? 0);
    if (Number.isFinite(declaredLength) && declaredLength > OAUTH_FEDERATION_MAX_FORM_BYTES) {
      const rejectionId = newRejectionId();
      logEvent('oauth_federation_exchange_rejected', {
        rejectionId,
        reason: 'request_too_large',
      });
      return oauthError(
        c,
        400,
        'invalid_request',
        'token request exceeds size limit',
        rejectionId,
      );
    }
    const raw = await c.req.raw.clone().text();
    const form = contentType === 'application/x-www-form-urlencoded'
      ? new URLSearchParams(raw)
      : null;
    const isExchange = form?.getAll('grant_type').includes(OAUTH_GRANT_TYPE_TOKEN_EXCHANGE) === true;
    if (!isExchange) {
      if (options.passThroughOtherGrants) return next();
      return oauthError(c, 400, 'unsupported_grant_type', 'unsupported grant_type');
    }

    const rejectionId = newRejectionId();
    const reject = (
      status: 400 | 401 | 500,
      error: OAuthErrorCode,
      description: string,
      reason: string,
      fields: Record<string, unknown> = {},
    ) => {
      logEvent('oauth_federation_exchange_rejected', {
        rejectionId,
        reason,
        ...fields,
      });
      return oauthError(c, status, error, description, rejectionId);
    };

    if (contentType !== 'application/x-www-form-urlencoded' || form === null) {
      return reject(400, 'invalid_request', 'expected form-encoded token request', 'content_type');
    }
    if (Buffer.byteLength(raw) > OAUTH_FEDERATION_MAX_FORM_BYTES) {
      return reject(400, 'invalid_request', 'token request exceeds size limit', 'request_too_large');
    }

    const requestedResource = form.get('resource') ?? '';
    const agentId = agentIdFromResource(publicUrl, requestedResource);
    if (!agentId) {
      return reject(400, 'invalid_target', 'resource is not a canonical agent URL', 'invalid_target');
    }
    const expectedResource = canonicalAgentResource(publicUrl, agentId);
    const shape = evaluateTokenExchangeRequest(form, { expectedResource });
    if (!shape.ok) {
      return reject(
        shape.error === 'invalid_client' ? 401 : 400,
        shape.error,
        'token exchange request is invalid',
        shape.reason,
        { agentId, stage: 'shape' },
      );
    }
    if (shape.scopes.length === 0) {
      return reject(400, 'invalid_scope', 'at least one scope is required', 'empty_scope', {
        agentId,
        stage: 'shape',
      });
    }

    const subjectToken = form.get('subject_token')!;
    const candidate = decodeCandidate(subjectToken);
    if (!candidate) {
      return reject(400, 'invalid_request', 'malformed subject assertion', 'malformed_subject', {
        agentId,
        stage: 'shape',
      });
    }

    const rows = await options.sql<{ allowed_callers: string[] }[]>`
      SELECT allowed_callers FROM agents WHERE id = ${agentId}
    `;
    const allowedCallers = rows[0]?.allowed_callers;
    if (!allowedCallers) {
      return reject(400, 'invalid_target', 'unknown agent resource', 'unknown_agent', { agentId });
    }

    let authorizationKey: string | undefined;
    let trustedTask:
      | { principalId: string; actorId: string; authorizationKey: string; taskId: string }
      | undefined;
    if (candidate.typ === OAUTH_FEDERATION_TYP_SUBJECT_ASSERTION) {
      if (!candidate.method) {
        return reject(400, 'invalid_grant', 'subject assertion has no authentication method', 'missing_method', {
          agentId,
        });
      }
      authorizationKey = formatFederatedPrincipal({
        issuer: candidate.issuer,
        method: candidate.method,
        subject: candidate.subject,
      }) ?? undefined;
      if (!authorizationKey || !allowedCallers.includes(authorizationKey)) {
        return reject(400, 'invalid_grant', 'subject is not authorized for this resource', 'caller_not_allowed', {
          agentId,
        });
      }
    } else if (candidate.typ === OAUTH_FEDERATION_TYP_TASK_CONTINUATION_ASSERTION) {
      if (!candidate.taskId) {
        return reject(400, 'invalid_grant', 'continuation assertion has no task binding', 'missing_task_id', {
          agentId,
        });
      }
      const task = await loadFederatedTaskAuthorization(options.sql, agentId, candidate.taskId);
      if (
        !task?.principalId ||
        !task.actorId ||
        !task.authorizationKey ||
        task.principalId !== candidate.subject ||
        task.actorId !== candidate.issuer ||
        !allowedCallers.includes(task.authorizationKey)
      ) {
        return reject(400, 'invalid_grant', 'task continuation is not authorized', 'task_binding_mismatch', {
          agentId,
        });
      }
      authorizationKey = task.authorizationKey;
      trustedTask = {
        principalId: task.principalId,
        actorId: task.actorId,
        authorizationKey: task.authorizationKey,
        taskId: candidate.taskId,
      };
    } else {
      return reject(400, 'invalid_grant', 'unsupported subject assertion type', 'wrong_typ', {
        agentId,
      });
    }

    // Exact receiver policy has matched. Only now may an issuer-controlled
    // did:web URL be resolved.
    let issuerDocument: IssuerDidDocument;
    try {
      issuerDocument = asConnectorKitDidDocument(
        await options.resolver.resolve(candidate.issuer),
      );
    } catch {
      return reject(400, 'invalid_grant', 'subject assertion verification failed', 'did_resolution_failed', {
        agentId,
        stage: 'subject-assertion',
      });
    }

    const verifiedAt = (options.now?.() ?? new Date()).toISOString();
    let verification: TokenExchangeVerifyResult;
    try {
      verification = await verifyTokenExchange(form, {
        tokenEndpoint,
        verifiedAt,
        expectedResource,
        trustedIssuers: new Set([candidate.issuer]),
        resolveIssuerDocument: (issuer) =>
          issuer === candidate.issuer ? issuerDocument : undefined,
      });
    } catch {
      return reject(500, 'server_error', 'token exchange temporarily unavailable', 'verifier_failed', {
        agentId,
      });
    }
    if (!verification.ok) {
      const mapped = verificationError(verification);
      return reject(
        mapped.status,
        mapped.error,
        `${mapped.stage} verification failed`,
        mapped.reason,
        { agentId, stage: mapped.stage },
      );
    }

    const context = verification.authorization;
    if (
      context.actor !== candidate.issuer ||
      context.principal !== candidate.subject ||
      (trustedTask !== undefined && context.task_id !== trustedTask.taskId) ||
      (trustedTask === undefined && context.task_id !== undefined)
    ) {
      return reject(400, 'invalid_grant', 'verified authorization binding mismatch', 'verified_binding_mismatch', {
        agentId,
      });
    }

    const parsedTuple = parseFederatedPrincipal(authorizationKey!);
    if (!parsedTuple) {
      return reject(500, 'server_error', 'token exchange temporarily unavailable', 'stored_tuple_invalid', {
        agentId,
      });
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
      return reject(400, 'invalid_grant', 'subject assertion exceeds caller context limits', 'context_limits', {
        agentId,
      });
    }

    const verifiedClientPayload = decodeJwt(form.get('client_assertion')!);
    try {
      await consumeFederationReplays(options.sql, [
        verifiedReplayTuple(verifiedClientPayload),
        verifiedReplayTuple(verifiedSubjectPayload),
      ]);
    } catch (error) {
      if (error instanceof FederatedReplayError) {
        return reject(400, 'invalid_grant', 'assertion replayed', 'replayed_jti', { agentId });
      }
      return reject(500, 'server_error', 'token exchange temporarily unavailable', 'replay_store_failed', {
        agentId,
      });
    }

    const issuedAt = options.now?.() ?? new Date();
    const expiresAt = new Date(
      issuedAt.getTime() + OAUTH_FEDERATION_ACCESS_TOKEN_TTL_SECONDS * 1000,
    );
    let issued: Awaited<ReturnType<typeof issueFederatedAccessToken>>;
    try {
      issued = await issueFederatedAccessToken(options.sql, {
        agentId,
        resource: expectedResource,
        principalId: context.principal,
        actorId: context.actor,
        allowedCaller: authorizationKey!,
        attestation: attestationResult.data,
        scopes: verification.scopes,
        ...(context.task_id !== undefined ? { taskId: context.task_id } : {}),
        expiresAt,
      });
    } catch {
      return reject(500, 'server_error', 'token exchange temporarily unavailable', 'token_store_failed', {
        agentId,
      });
    }

    logEvent('oauth_federation_exchange_accepted', {
      agentId,
      kind: context.task_id === undefined ? 'platform_subject' : 'task_continuation',
      scopes: verification.scopes,
    });
    c.header('Cache-Control', 'no-store');
    c.header('Pragma', 'no-cache');
    return c.json({
      access_token: issued.rawToken,
      issued_token_type: OAUTH_TOKEN_TYPE_ACCESS_TOKEN,
      token_type: 'Bearer',
      expires_in: OAUTH_FEDERATION_ACCESS_TOKEN_TTL_SECONDS,
      scope: verification.scopes.join(' '),
    });
  });
}
