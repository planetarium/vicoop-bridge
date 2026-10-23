import { ApprovalDecision } from '@vicoop-bridge/protocol';
import { z } from 'zod';
import type { Sql } from './db.js';
import type { Registry } from './registry.js';
import { logEvent } from './log.js';
import { approvalView, type ToolApproval } from './tool-approvals.js';
import {
  isTokenExchangeAuthorizationActive,
  loadTokenExchangeTaskAuthorization,
  verifyTokenExchangeAccessToken,
  type TokenExchangeAccessToken,
} from './oauth/token-exchange/store.js';
import { TOKEN_EXCHANGE_ACCESS_TOKEN_PREFIX } from './oauth/token-exchange/types.js';
import { OAUTH_FEDERATION_SCOPE_TASK_READ } from './oauth/profiles/mentionable-v0.1.js';

// Requester tool approvals (docs/tool-approval-v1.md).
//
// A federated task.read token authenticates *who* is asking; it does not by
// itself confer approval authority, and the federation scope semantics are
// unchanged. Authority comes from two independent facts checked on every
// access:
//   1. the agent owner has persisted `requester_approvals_enabled = true`;
//   2. the token's principal/actor/profile/exact grant equal the immutable
//      origin snapshot taken from the TaskBinding that raised the request, the
//      grant is still active, and that same execution is still live.
// The task row is deliberately not the source of truth: token-exchange
// authorization tolerates a missing row, and a task ID is reused across
// executions. Owner-session, caller and public requests are rejected here; the
// owner keeps the /admin-api decision route.

export type RequesterApprovalResult =
  | { ok: true; approval: ToolApproval; token: TokenExchangeAccessToken }
  | { ok: false; status: 401 | 404 | 409; error: string };

export const RequesterDecisionBody = z.object({ decision: ApprovalDecision }).strict();

const NOT_FOUND = { ok: false, status: 404, error: 'Not found' } as const;
const NOT_LIVE = {
  ok: false, status: 409, error: 'Approval expired, consumed, or execution no longer active',
} as const;

function reject(
  agentId: string,
  requestId: string,
  reason: string,
  result: Extract<RequesterApprovalResult, { ok: false }>,
): RequesterApprovalResult {
  logEvent('requester_approval_rejected', { agentId, requestId, reason, status: result.status });
  return result;
}

export async function authorizeRequesterApproval(
  db: Sql,
  registry: Registry,
  agentId: string,
  requestId: string,
  authorization: string | undefined,
): Promise<RequesterApprovalResult> {
  const raw = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!raw || !raw.startsWith(TOKEN_EXCHANGE_ACCESS_TOKEN_PREFIX)) {
    return reject(agentId, requestId, raw ? 'unsupported_token_type' : 'missing_bearer',
      { ok: false, status: 401, error: 'Federated bearer token required' });
  }
  let token: TokenExchangeAccessToken;
  try {
    token = await verifyTokenExchangeAccessToken(db, raw, agentId);
  } catch {
    return reject(agentId, requestId, 'invalid_token_exchange_token',
      { ok: false, status: 401, error: 'Invalid bearer token' });
  }
  if (!token.scopes.includes(OAUTH_FEDERATION_SCOPE_TASK_READ)) {
    return reject(agentId, requestId, 'insufficient_scope', NOT_FOUND);
  }

  const policy = await db<{ enabled: boolean }[]>`
    SELECT requester_approvals_enabled AS enabled FROM agents WHERE id = ${agentId}
  `;
  if (policy[0]?.enabled !== true) return reject(agentId, requestId, 'policy_disabled', NOT_FOUND);

  const approval = registry.approvals.get(requestId);
  const origin = registry.approvals.origin(requestId);
  if (!approval || !origin || approval.agentId !== agentId) {
    return reject(agentId, requestId, 'approval_not_found', NOT_FOUND);
  }
  if (!origin.principalId || !origin.actorId || !origin.authorizationProfile || !origin.authorizationKey) {
    return reject(agentId, requestId, 'origin_not_federated', NOT_FOUND);
  }
  if (token.principalId !== origin.principalId || token.actorId !== origin.actorId
    || token.profileId !== origin.authorizationProfile || token.allowedCaller !== origin.authorizationKey) {
    return reject(agentId, requestId, 'origin_mismatch', NOT_FOUND);
  }
  if (token.taskId !== undefined && token.taskId !== approval.taskId) {
    return reject(agentId, requestId, 'token_task_mismatch', NOT_FOUND);
  }
  if (!(await isTokenExchangeAuthorizationActive(db, agentId, origin.authorizationKey))) {
    return reject(agentId, requestId, 'grant_revoked', NOT_FOUND);
  }
  // Supplementary only: a persisted row that is revoked or bound to another
  // identity denies; a missing row does not grant anything by itself.
  const task = await loadTokenExchangeTaskAuthorization(db, agentId, approval.taskId);
  if (task && (task.authorizationRevoked || task.principalId !== origin.principalId
    || task.actorId !== origin.actorId || task.profileId !== origin.authorizationProfile
    || task.authorizationKey !== origin.authorizationKey)) {
    return reject(agentId, requestId, 'task_grant_mismatch', NOT_FOUND);
  }

  // Callers must act on the result synchronously: with no await between this
  // liveness check and decide()/view, the execution cannot change in between,
  // and a displacement during the DB reads above is observed here.
  return checkLive(registry, agentId, requestId, token);
}

function checkLive(
  registry: Registry,
  agentId: string,
  requestId: string,
  token: TokenExchangeAccessToken,
): RequesterApprovalResult {
  const approval = registry.approvals.get(requestId);
  const origin = registry.approvals.origin(requestId);
  if (!approval || !origin || approval.agentId !== agentId) {
    return reject(agentId, requestId, 'approval_not_found', NOT_FOUND);
  }
  const live = registry.approvals.liveBinding(approval);
  if (!live || live.principalId !== origin.principalId || live.actorId !== origin.actorId
    || live.authorizationProfile !== origin.authorizationProfile
    || live.authorizationKey !== origin.authorizationKey) {
    return reject(agentId, requestId, 'execution_not_live', NOT_LIVE);
  }
  if (Date.parse(approval.expiresAt) <= Date.now() || approval.state === 'expired'
    || approval.state === 'invalidated') {
    return reject(agentId, requestId, 'approval_expired', NOT_LIVE);
  }
  return { ok: true, approval, token };
}

export function requesterApprovalResponse(approval: ToolApproval) {
  return { approval: approvalView(approval) };
}
