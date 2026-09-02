import type { Context, Hono, Next } from 'hono';
import { newRejectionId } from '../../agent-auth.js';
import type { Sql } from '../../db.js';
import { logEvent } from '../../log.js';
import {
  consumeTokenExchangeReplays,
  issueTokenExchangeAccessToken,
  TokenExchangeReplayError,
} from './store.js';
import {
  ACCESS_TOKEN_TYPE,
  TOKEN_EXCHANGE_ACCESS_TOKEN_TTL_SECONDS,
  TOKEN_EXCHANGE_GRANT_TYPE,
  TOKEN_EXCHANGE_MAX_FORM_BYTES,
  type TokenExchangeErrorCode,
  type TokenExchangeFailure,
  type TokenExchangeProfile,
} from './types.js';

export interface TokenExchangeRouteOptions {
  sql: Sql;
  publicUrl: string;
  profiles: readonly TokenExchangeProfile[];
  now?: () => Date;
  /** Whether another /oauth/token handler should receive non-exchange grants. */
  passThroughOtherGrants?: boolean;
  /** Other grants served by the same authorization server and token endpoint. */
  additionalGrantTypes?: readonly string[];
  additionalTokenEndpointAuthMethods?: readonly string[];
  deviceAuthorizationEndpoint?: string;
}

class TokenExchangeBodyTooLargeError extends Error {}

async function readBoundedBody(request: Request, maxBytes: number): Promise<Uint8Array> {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel('token request exceeds size limit');
        throw new TokenExchangeBodyTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function replaceRequestBody(c: Context, original: Request, body: Uint8Array): void {
  c.req.raw = new Request(original.url, {
    method: original.method,
    headers: original.headers,
    body: body.byteLength > 0 ? body : undefined,
    ...(body.byteLength > 0 ? { duplex: 'half' as const } : {}),
  });
}

function oauthError(
  c: Context,
  status: 400 | 401 | 500,
  error: TokenExchangeErrorCode,
  description: string,
  rejectionId?: string,
) {
  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');
  return c.json(
    {
      error,
      error_description: description,
      ...(rejectionId !== undefined ? { rejection_id: rejectionId } : {}),
    },
    status,
  );
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

function unique(values: Iterable<string>): string[] {
  return [...new Set(values)];
}

function selectProfile(
  profiles: readonly TokenExchangeProfile[],
  form: URLSearchParams,
): TokenExchangeProfile | undefined {
  const recognized = profiles.filter((profile) => profile.recognizes(form));
  if (recognized.length === 1) return recognized[0];
  // A single installed profile should produce its precise malformed-request
  // error. With multiple profiles, no match or ambiguity must fail closed.
  return profiles.length === 1 ? profiles[0] : undefined;
}

export function mountTokenExchangeRoutes(app: Hono, options: TokenExchangeRouteOptions): void {
  if (options.profiles.length === 0) {
    throw new Error('At least one OAuth token-exchange profile is required');
  }
  if (new Set(options.profiles.map((profile) => profile.id)).size !== options.profiles.length) {
    throw new Error('OAuth token-exchange profile ids must be unique');
  }

  const publicUrl = options.publicUrl.replace(/\/$/, '');
  const tokenEndpoint = `${publicUrl}/oauth/token`;

  app.get('/.well-known/oauth-authorization-server', (c) => {
    const profileMetadata = Object.assign(
      {},
      ...options.profiles.map((profile) => profile.authorizationServerMetadata ?? {}),
    );
    return c.json({
      ...profileMetadata,
      issuer: publicUrl,
      token_endpoint: tokenEndpoint,
      ...(options.deviceAuthorizationEndpoint !== undefined
        ? { device_authorization_endpoint: options.deviceAuthorizationEndpoint }
        : {}),
      grant_types_supported: unique([
        TOKEN_EXCHANGE_GRANT_TYPE,
        ...(options.additionalGrantTypes ?? []),
      ]),
      token_endpoint_auth_methods_supported: unique(
        [
          ...options.profiles.flatMap((profile) => [...profile.clientAuthMethods]),
          ...(options.additionalTokenEndpointAuthMethods ?? []),
        ],
      ),
      token_endpoint_auth_signing_alg_values_supported: unique(
        options.profiles.flatMap((profile) => [...profile.clientAuthSigningAlgorithms]),
      ),
      scopes_supported: unique(options.profiles.flatMap((profile) => [...profile.scopes])),
      subject_token_types_supported: unique(
        options.profiles.flatMap((profile) => [...profile.subjectTokenTypes]),
      ),
      token_exchange_profiles_supported: options.profiles.map((profile) => profile.id),
    });
  });

  app.post('/oauth/token', async (c: Context, next: Next) => {
    const contentType = c.req.header('Content-Type')?.split(';', 1)[0]?.trim().toLowerCase();
    const originalRequest = c.req.raw;
    let bodyBytes: Uint8Array;
    try {
      bodyBytes = await readBoundedBody(originalRequest, TOKEN_EXCHANGE_MAX_FORM_BYTES);
    } catch (error) {
      if (!(error instanceof TokenExchangeBodyTooLargeError)) throw error;
      const rejectionId = newRejectionId();
      logEvent('oauth_token_exchange_rejected', {
        rejectionId,
        reason: 'request_too_large',
      });
      return oauthError(c, 400, 'invalid_request', 'token request exceeds size limit', rejectionId);
    }
    const raw = new TextDecoder().decode(bodyBytes);
    const form =
      contentType === 'application/x-www-form-urlencoded' ? new URLSearchParams(raw) : null;
    const isExchange = form?.getAll('grant_type').includes(TOKEN_EXCHANGE_GRANT_TYPE) === true;
    if (!isExchange) {
      if (options.passThroughOtherGrants) {
        replaceRequestBody(c, originalRequest, bodyBytes);
        return next();
      }
      return oauthError(c, 400, 'unsupported_grant_type', 'unsupported grant_type');
    }

    const rejectionId = newRejectionId();
    const reject = (failure: TokenExchangeFailure, fields: Record<string, unknown> = {}) => {
      logEvent('oauth_token_exchange_rejected', {
        rejectionId,
        reason: failure.reason,
        ...(failure.stage !== undefined ? { stage: failure.stage } : {}),
        ...fields,
      });
      return oauthError(c, failure.status, failure.error, failure.description, rejectionId);
    };

    if (contentType !== 'application/x-www-form-urlencoded' || form === null) {
      return reject({
        ok: false,
        status: 400,
        error: 'invalid_request',
        description: 'expected form-encoded token request',
        reason: 'content_type',
      });
    }
    if (Buffer.byteLength(raw) > TOKEN_EXCHANGE_MAX_FORM_BYTES) {
      return reject({
        ok: false,
        status: 400,
        error: 'invalid_request',
        description: 'token request exceeds size limit',
        reason: 'request_too_large',
      });
    }

    const requestedResource = form.get('resource') ?? '';
    const agentId = agentIdFromResource(publicUrl, requestedResource);
    if (!agentId) {
      return reject({
        ok: false,
        status: 400,
        error: 'invalid_target',
        description: 'resource is not a canonical agent URL',
        reason: 'invalid_target',
      });
    }
    const expectedResource = canonicalAgentResource(publicUrl, agentId);
    const profile = selectProfile(options.profiles, form);
    if (!profile) {
      return reject(
        {
          ok: false,
          status: 400,
          error: 'invalid_request',
          description: 'token exchange profile is unsupported or ambiguous',
          reason: 'unsupported_profile',
        },
        { agentId },
      );
    }

    const shapeFailure = profile.validateRequest?.(form, expectedResource);
    if (shapeFailure) return reject(shapeFailure, { agentId, profileId: profile.id });

    let rows: { allowed_callers: string[] }[];
    try {
      rows = await options.sql<{ allowed_callers: string[] }[]>`
        SELECT allowed_callers FROM agents WHERE id = ${agentId}
      `;
    } catch {
      return reject(
        {
          ok: false,
          status: 500,
          error: 'server_error',
          description: 'token exchange temporarily unavailable',
          reason: 'target_lookup_failed',
          stage: 'target_lookup',
        },
        { agentId, profileId: profile.id },
      );
    }
    const allowedCallers = rows[0]?.allowed_callers;
    if (!allowedCallers) {
      return reject(
        {
          ok: false,
          status: 400,
          error: 'invalid_target',
          description: 'unknown agent resource',
          reason: 'unknown_agent',
        },
        { agentId, profileId: profile.id },
      );
    }

    const now = options.now?.() ?? new Date();
    let result;
    try {
      result = await profile.verify({
        sql: options.sql,
        form,
        tokenEndpoint,
        expectedResource,
        agentId,
        allowedCallers,
        now,
      });
    } catch {
      return reject(
        {
          ok: false,
          status: 500,
          error: 'server_error',
          description: 'token exchange temporarily unavailable',
          reason: 'profile_verification_failed',
          stage: 'profile_verification',
        },
        { agentId, profileId: profile.id },
      );
    }
    if (!result.ok) return reject(result, { agentId, profileId: profile.id });
    if (profile.replayProtection === 'required' && result.replays.length === 0) {
      return reject(
        {
          ok: false,
          status: 500,
          error: 'server_error',
          description: 'token exchange temporarily unavailable',
          reason: 'replay_evidence_missing',
          stage: 'profile_contract',
        },
        { agentId, profileId: profile.id },
      );
    }

    try {
      await consumeTokenExchangeReplays(options.sql, profile.id, result.replays);
    } catch (error) {
      const failure: TokenExchangeFailure =
        error instanceof TokenExchangeReplayError
          ? profile.replayFailure ?? {
              ok: false,
              status: 400,
              error: 'invalid_request',
              description: 'assertion replayed',
              reason: 'replayed_jti',
            }
          : {
              ok: false,
              status: 500,
              error: 'server_error',
              description: 'token exchange temporarily unavailable',
              reason: 'replay_store_failed',
            };
      return reject(failure, { agentId, profileId: profile.id });
    }

    const expiresAt = new Date(now.getTime() + TOKEN_EXCHANGE_ACCESS_TOKEN_TTL_SECONDS * 1000);
    let issued: Awaited<ReturnType<typeof issueTokenExchangeAccessToken>>;
    try {
      issued = await issueTokenExchangeAccessToken(options.sql, {
        profileId: profile.id,
        agentId,
        resource: expectedResource,
        principalId: result.principalId,
        actorId: result.actorId,
        allowedCaller: result.authorizationKey,
        ...(result.attestation !== undefined ? { attestation: result.attestation } : {}),
        scopes: result.scopes,
        ...(result.taskId !== undefined ? { taskId: result.taskId } : {}),
        expiresAt,
      });
    } catch {
      return reject(
        {
          ok: false,
          status: 500,
          error: 'server_error',
          description: 'token exchange temporarily unavailable',
          reason: 'token_store_failed',
        },
        { agentId, profileId: profile.id },
      );
    }

    logEvent('oauth_token_exchange_accepted', {
      agentId,
      profileId: profile.id,
      kind: result.kind,
      scopes: result.scopes,
    });
    c.header('Cache-Control', 'no-store');
    c.header('Pragma', 'no-cache');
    return c.json({
      access_token: issued.rawToken,
      issued_token_type: ACCESS_TOKEN_TYPE,
      token_type: 'Bearer',
      expires_in: TOKEN_EXCHANGE_ACCESS_TOKEN_TTL_SECONDS,
      scope: result.scopes.join(' '),
    });
  });
}
