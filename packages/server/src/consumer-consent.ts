import { createHash } from 'node:crypto';
import { CONSUMER_CONSENT_EXTENSION_URI, type ConsentRegistration, type ConsentDecision,
  type ConsentClaim, type ConsentResult } from '@vicoop-bridge/protocol';
import type { Sql, SqlExecutor } from './db.js';
import { executionMarker } from './execution-marker.js';
import { matchPrincipal, type VerifiedCaller } from './auth/principal.js';

export class ConsentError extends Error {
  constructor(readonly status: 400 | 401 | 403 | 404 | 409, message: string) { super(message); }
}
export interface ConsentIdentity {
  principalId: string;
  actorId?: string;
  authorizationProfile?: string;
  authorizationKey?: string;
  taskId?: string;
  caller?: VerifiedCaller;
  // Digests only; bearer material is never stored in a proposal or audit.
  credential?: { kind: 'session' | 'federation'; hash: string };
}
interface Origin {
  principalId: string;
  actorId?: string;
  authorizationProfile?: string;
  authorizationKey?: string;
}
export interface ConsentProposal extends ConsentRegistration {
  agentId: string;
  version: 1;
  payloadDigest: string;
  contextId: string;
  state: 'awaiting_approval' | 'approved' | 'rejected' | 'expired' | 'canceled' | 'invalidated' | 'claimed' | 'succeeded' | 'failed' | 'unknown';
  createdAt: string;
  decision?: { decisionId: string; decision: 'approve' | 'reject'; principalId: string; actorId?: string; at: string };
  execution?: { claimId: string; executorPrincipal: string; claimedAt: string; outcome?: ConsentResult };
}
interface StoredProposal extends ConsentProposal {
  origin: Origin;
  ownerPrincipal: string;
  ownerRevision: string;
  policyRevision: string;
  decisionCredential?: ConsentIdentity['credential'];
}
interface AgentRow {
  owner_principal: string;
  owner_revision: string;
  consent_policy_revision: string;
  allowed_callers: string[];
}
interface TaskRow {
  context_id: string;
  state: string;
  owner_principal: string | null;
  owner_actor: string | null;
  authorization_profile: string | null;
  authorization_key: string | null;
  authorization_revoked_at: Date | null;
  task_json: { metadata?: Record<string, unknown> };
}
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
}
export function consentDigest(input: ConsentRegistration): string {
  // Every reviewable execution/consent term is covered, including expiry,
  // source execution, references, policy and attempt allowance.
  return createHash('sha256').update(canonical(input)).digest('hex');
}
export function consentView(value: StoredProposal): ConsentProposal {
  const { origin: _origin, ownerPrincipal: _owner, ownerRevision: _rev, policyRevision: _policy,
    decisionCredential: _credential, ...view } = value;
  return structuredClone(view);
}
export function consentPresentation(proposal: ConsentProposal) {
  const path = `/agents/${encodeURIComponent(proposal.agentId)}/consent-proposals/${proposal.operationId}`;
  const part = { kind: 'data' as const, data: { type: CONSUMER_CONSENT_EXTENSION_URI,
    proposal, statusUrl: path, decisionUrl: `${path}/decision` } };
  return { proposal, part, status: { state: proposal.state === 'awaiting_approval' ? 'input-required' as const : 'completed' as const, timestamp: new Date().toISOString(),
    message: { role: 'agent' as const, messageId: proposal.operationId,
      parts: [part], extensions: [CONSUMER_CONSENT_EXTENSION_URI] } } };
}
const pendingStates = new Set<ConsentProposal['state']>(['awaiting_approval', 'approved']);
function originFromTask(task: TaskRow): Origin {
  if (!task.owner_principal) throw new ConsentError(409, 'Authenticated originating task required');
  return { principalId: task.owner_principal,
    ...(task.owner_actor ? { actorId: task.owner_actor } : {}),
    ...(task.authorization_profile ? { authorizationProfile: task.authorization_profile } : {}),
    ...(task.authorization_key ? { authorizationKey: task.authorization_key } : {}) };
}
function sameOrigin(a: Origin, b: Origin): boolean {
  return a.principalId === b.principalId && a.actorId === b.actorId &&
    a.authorizationProfile === b.authorizationProfile && a.authorizationKey === b.authorizationKey;
}

export class ConsumerConsentService {
  constructor(private readonly db: Sql) {}

  private async agent(sql: SqlExecutor, agentId: string): Promise<AgentRow> {
    const rows = await sql<AgentRow[]>`SELECT owner_principal, owner_revision::text,
      consent_policy_revision::text, allowed_callers FROM agents WHERE id = ${agentId} FOR SHARE`;
    if (!rows[0]) throw new ConsentError(404, 'Not found');
    return rows[0];
  }
  private async source(sql: SqlExecutor, agentId: string, taskId: string): Promise<TaskRow | undefined> {
    const rows = await sql<TaskRow[]>`SELECT context_id, state, owner_principal, owner_actor,
      authorization_profile, authorization_key, authorization_revoked_at, task_json
      FROM infra.a2a_tasks WHERE task_id = ${taskId} AND owner_agent = ${agentId} FOR SHARE`;
    return rows[0];
  }
  private async audit(sql: SqlExecutor, p: StoredProposal, event: string, principalId: string) {
    await sql`INSERT INTO infra.consumer_consent_audit (agent_id, operation_id, event)
      VALUES (${p.agentId}, ${p.operationId}, ${sql.json({ event, principalId, state: p.state,
        version: p.version, payloadDigest: p.payloadDigest, at: new Date().toISOString() })})`;
  }
  private async save(sql: SqlExecutor, p: StoredProposal, event: string, principalId: string) {
    await sql`UPDATE infra.consumer_consent SET document = ${sql.json(p as never)}, updated_at = now()
      WHERE agent_id = ${p.agentId} AND operation_id = ${p.operationId}`;
    await this.audit(sql, p, event, principalId);
  }
  private async credentialActive(sql: SqlExecutor, credential: ConsentIdentity['credential'], requireUnexpired: boolean): Promise<boolean> {
    if (!credential) return true; // SIWE: authority is the live principal policy.
    const rows = credential.kind === 'session'
      ? await sql`SELECT revoked, expires_at FROM callers WHERE token_hash = ${credential.hash} FOR SHARE`
      : await sql`SELECT revoked, expires_at FROM infra.oauth_token_exchange_access_tokens WHERE token_hash = ${credential.hash} FOR SHARE`;
    return !!rows[0] && !rows[0].revoked && (!requireUnexpired || new Date(rows[0].expires_at).getTime() > Date.now());
  }
  private async identityActive(sql: SqlExecutor, identity: ConsentIdentity) {
    if (!(await this.credentialActive(sql, identity.credential, true))) throw new ConsentError(401, 'Credential expired or revoked');
  }
  private async sourceAllowed(sql: SqlExecutor, origin: Origin, agent: AgentRow): Promise<boolean> {
    if (origin.authorizationKey) return agent.allowed_callers.includes(origin.authorizationKey);
    if (agent.allowed_callers.length === 0) return true; // Explicit per-proposal policy still required.
    const callers = await sql`SELECT email FROM callers WHERE principal_id = ${origin.principalId}
      AND audience = 'caller' AND revoked = false AND expires_at > now() AND email IS NOT NULL LIMIT 1`;
    const email = callers[0]?.email as string | undefined;
    return agent.allowed_callers.some(entry => matchPrincipal(entry, {
      principalId: origin.principalId, ...(email ? { email, emailVerified: true } : {}),
    }));
  }
  async register(agentId: string, identity: ConsentIdentity, input: ConsentRegistration) {
    const expires = Date.parse(input.expiresAt);
    if (expires <= Date.now() || expires > Date.now() + 7 * 86_400_000)
      throw new ConsentError(400, 'Expiry must be in the next seven days');
    return this.db.begin(async sql => {
      await this.identityActive(sql, identity);
      const agent = await this.agent(sql, agentId);
      if (agent.owner_principal !== identity.principalId) throw new ConsentError(404, 'Not found');
      // Serialize same-id creation, including retries before the row exists.
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${agentId}:${input.operationId}`}, 575))`;
      const existing = await sql<{ document: StoredProposal }[]>`SELECT document FROM infra.consumer_consent
        WHERE agent_id = ${agentId} AND operation_id = ${input.operationId} FOR UPDATE`;
      if (existing[0]) {
        const p = existing[0].document;
        if (p.payloadDigest !== consentDigest(input) || p.ownerRevision !== agent.owner_revision)
          throw new ConsentError(409, 'Operation ID already identifies a different request');
        return consentPresentation(consentView(p));
      }
      const task = await this.source(sql, agentId, input.sourceTaskId);
      if (!task || task.authorization_revoked_at || task.state === 'canceled' ||
          executionMarker(task.task_json.metadata) !== input.sourceExecutionId)
        throw new ConsentError(409, 'Originating execution is stale, canceled or unavailable');
      const origin = originFromTask(task);
      if (!(await this.sourceAllowed(sql, origin, agent))) throw new ConsentError(403, 'Originating authority revoked');
      const p: StoredProposal = { ...structuredClone(input), agentId, version: 1,
        payloadDigest: consentDigest(input), contextId: task.context_id, origin,
        ownerPrincipal: identity.principalId, ownerRevision: agent.owner_revision,
        policyRevision: agent.consent_policy_revision, state: 'awaiting_approval', createdAt: new Date().toISOString() };
      await sql`INSERT INTO infra.consumer_consent (agent_id, operation_id, document)
        VALUES (${agentId}, ${input.operationId}, ${sql.json(p as never)})`;
      await this.audit(sql, p, 'registered', identity.principalId);
      return consentPresentation(consentView(p));
    });
  }

  private async access<T>(agentId: string, operationId: string, identity: ConsentIdentity,
    mode: 'owner' | 'consumer', action: (sql: SqlExecutor, p: StoredProposal) => Promise<T>): Promise<T> {
    // Return errors after commit: expiry/invalidation must remain durable even
    // when the requested decision/claim is rejected.
    const outcome = await this.db.begin(async sql => {
      await this.identityActive(sql, identity);
      const agent = await this.agent(sql, agentId);
      const rows = await sql<{ document: StoredProposal }[]>`SELECT document FROM infra.consumer_consent
        WHERE agent_id = ${agentId} AND operation_id = ${operationId} FOR UPDATE`;
      if (!rows[0]) throw new ConsentError(404, 'Not found');
      const p = rows[0].document;
      if (mode === 'owner') {
        if (agent.owner_principal !== identity.principalId || p.ownerPrincipal !== identity.principalId ||
          agent.owner_revision !== p.ownerRevision) throw new ConsentError(404, 'Not found');
      } else if (!sameOrigin(p.origin, identity) || (identity.taskId && identity.taskId !== p.sourceTaskId)) {
        throw new ConsentError(404, 'Not found');
      }
      const task = await this.source(sql, agentId, p.sourceTaskId);
      const valid = task && !task.authorization_revoked_at && task.state !== 'canceled' &&
        task.context_id === p.contextId && task.owner_principal && sameOrigin(p.origin, originFromTask(task)) &&
        agent.owner_principal === p.ownerPrincipal && agent.owner_revision === p.ownerRevision &&
        agent.consent_policy_revision === p.policyRevision && await this.sourceAllowed(sql, p.origin, agent) &&
        await this.credentialActive(sql, p.decisionCredential, false);
      if (pendingStates.has(p.state)) {
        if (!valid) { p.state = 'invalidated'; await this.save(sql, p, 'invalidated', identity.principalId); }
        else if (Date.parse(p.expiresAt) <= Date.now()) { p.state = 'expired'; await this.save(sql, p, 'expired', identity.principalId); }
      }
      if (mode === 'consumer' && !valid) return { error: new ConsentError(404, 'Not found') };
      try { return { result: await action(sql, p) }; }
      catch (error) { if (error instanceof ConsentError) return { error }; throw error; }
    });
    if ('error' in outcome) throw outcome.error;
    return outcome.result as T;
  }
  async get(agentId: string, operationId: string, identity: ConsentIdentity, mode: 'owner' | 'consumer') {
    return this.access(agentId, operationId, identity, mode, async (_sql, p) => consentPresentation(consentView(p)));
  }
  private correlate(p: StoredProposal, input: { version: number; payloadDigest: string }) {
    if (p.version !== input.version || p.payloadDigest !== input.payloadDigest) throw new ConsentError(409, 'Stale or changed proposal');
  }
  async decide(agentId: string, operationId: string, identity: ConsentIdentity, input: ConsentDecision) {
    return this.access(agentId, operationId, identity, 'consumer', async (sql, p) => {
      this.correlate(p, input);
      if (p.contextId !== input.contextId) throw new ConsentError(409, 'Wrong context');
      if (p.decision && p.decision.decisionId === input.decisionId && p.decision.decision === input.decision &&
          p.decision.principalId === identity.principalId && p.decision.actorId === identity.actorId &&
          !['expired', 'canceled', 'invalidated'].includes(p.state)) return consentPresentation(consentView(p));
      if (p.state !== 'awaiting_approval') throw new ConsentError(409, 'Proposal already decided, expired or canceled');
      p.state = input.decision === 'approve' ? 'approved' : 'rejected';
      p.decision = { decisionId: input.decisionId, decision: input.decision, principalId: identity.principalId,
        ...(identity.actorId ? { actorId: identity.actorId } : {}), at: new Date().toISOString() };
      p.decisionCredential = identity.credential;
      await this.save(sql, p, input.decision, identity.principalId);
      return consentPresentation(consentView(p));
    });
  }
  async claim(agentId: string, operationId: string, identity: ConsentIdentity, input: ConsentClaim) {
    return this.access(agentId, operationId, identity, 'owner', async (sql, p) => {
      this.correlate(p, input);
      // A duplicate claim is a status/reconciliation response, NEVER another
      // permission to submit. A lost first response must not cause a paid POST.
      if (p.execution?.claimId === input.claimId) return { execute: false, proposal: consentView(p) };
      if (p.state !== 'approved') throw new ConsentError(409, 'Proposal is not executable');
      p.state = 'claimed';
      p.execution = { claimId: input.claimId, executorPrincipal: identity.principalId, claimedAt: new Date().toISOString() };
      await this.save(sql, p, 'claimed', identity.principalId);
      return { execute: true, proposal: consentView(p), request: structuredClone(p.request) };
    });
  }
  async result(agentId: string, operationId: string, identity: ConsentIdentity, input: ConsentResult) {
    return this.access(agentId, operationId, identity, 'owner', async (sql, p) => {
      this.correlate(p, input);
      if (!p.execution || p.execution.claimId !== input.claimId || p.execution.executorPrincipal !== identity.principalId)
        throw new ConsentError(409, 'Unknown execution claim');
      if (p.execution.outcome && canonical(p.execution.outcome) === canonical(input)) return consentPresentation(consentView(p));
      if (p.state !== 'claimed' && p.state !== 'unknown') throw new ConsentError(409, 'Execution already finalized');
      // Unknown -> known is reconciliation of the original attempt, not retry.
      if (p.execution.outcome?.providerJobId && input.providerJobId !== p.execution.outcome.providerJobId)
        throw new ConsentError(409, 'Provider job cannot change during reconciliation');
      p.state = input.outcome; p.execution.outcome = structuredClone(input);
      await this.save(sql, p, `execution_${input.outcome}`, identity.principalId);
      return consentPresentation(consentView(p));
    });
  }
  async cancel(agentId: string, operationId: string, identity: ConsentIdentity, mode: 'owner' | 'consumer') {
    return this.access(agentId, operationId, identity, mode, async (sql, p) => {
      if (p.state === 'canceled') return consentPresentation(consentView(p));
      if (!pendingStates.has(p.state)) throw new ConsentError(409, 'Cannot cancel consumed or terminal proposal');
      p.state = 'canceled'; await this.save(sql, p, 'canceled', identity.principalId);
      return consentPresentation(consentView(p));
    });
  }
  async auditTrail(agentId: string, operationId: string, identity: ConsentIdentity) {
    return this.access(agentId, operationId, identity, 'owner', async (sql, p) => {
      const events = await sql`SELECT sequence::text, event, recorded_at FROM infra.consumer_consent_audit
        WHERE agent_id = ${agentId} AND operation_id = ${operationId} ORDER BY sequence`;
      return { proposal: consentView(p), events };
    });
  }
}
