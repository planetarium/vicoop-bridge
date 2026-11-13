import type { Context, Hono } from 'hono';
import { z } from 'zod';
import { ConsentRegistration, ConsentDecision, ConsentClaim, ConsentResult } from '@vicoop-bridge/protocol';
import { ConsumerConsentService, ConsentError, type ConsentIdentity } from './consumer-consent.js';
import type { Sql } from './db.js';
import { CALLER_TOKEN_PREFIX, OWNER_SESSION_PREFIX, hashCallerToken, verifySessionToken } from './auth/caller-token.js';
import { TOKEN_EXCHANGE_ACCESS_TOKEN_PREFIX } from './oauth/token-exchange/types.js';
import { verifyTokenExchangeAccessToken } from './oauth/token-exchange/store.js';
import { verifySiweBearerToken } from './auth/siwe-bearer.js';
import { logEvent } from './log.js';

const MAX_BODY_BYTES = 128 * 1024;
async function body<T>(c: Context, schema: z.ZodType<T>): Promise<T> {
  // Bound the stream before decoding/parsing, including chunked requests.
  const reader = c.req.raw.body?.getReader();
  if (!reader) throw new ConsentError(400, 'JSON body required');
  const chunks: Uint8Array[] = []; let length = 0;
  try {
    for (;;) {
      const next = await reader.read(); if (next.done) break;
      length += next.value.byteLength;
      if (length > MAX_BODY_BYTES) { await reader.cancel(); throw new ConsentError(400, 'Request too large'); }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new ConsentError(400, 'Invalid JSON'); }
  const result = schema.safeParse(parsed);
  if (!result.success) throw new ConsentError(400, 'Invalid consent request schema');
  return result.data;
}

export function mountConsumerConsent(app: Hono, opts: { db: Sql; siweDomain?: string }) {
  const service = new ConsumerConsentService(opts.db);
  async function identity(c: Context, mode: 'owner' | 'consumer'): Promise<ConsentIdentity> {
    const token = c.req.header('Authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
    if (!token) throw new ConsentError(401, 'Authentication required');
    try {
      if (mode === 'owner') {
        if (!token.startsWith(OWNER_SESSION_PREFIX)) throw new Error('wrong audience');
        const caller = await verifySessionToken(opts.db, token, { expectedAudience: 'owner_session', bypassCache: true });
        return { principalId: caller.principalId, credential: { kind: 'session', hash: hashCallerToken(token) } };
      }
      if (token.startsWith(CALLER_TOKEN_PREFIX)) {
        const caller = await verifySessionToken(opts.db, token, { expectedAudience: 'caller', bypassCache: true });
        return { principalId: caller.principalId, caller, credential: { kind: 'session', hash: hashCallerToken(token) } };
      }
      if (token.startsWith(TOKEN_EXCHANGE_ACCESS_TOKEN_PREFIX)) {
        const value = await verifyTokenExchangeAccessToken(opts.db, token, c.req.param('id')!);
        if (!value.scopes.includes('a2a:task.read')) throw new Error('missing scope');
        return { principalId: value.principalId,
          ...(value.actorId !== value.principalId ? { actorId: value.actorId } : {}),
          authorizationProfile: value.profileId, authorizationKey: value.allowedCaller,
          ...(value.taskId ? { taskId: value.taskId } : {}),
          credential: { kind: 'federation', hash: hashCallerToken(token) } };
      }
      if (opts.siweDomain && !token.startsWith(OWNER_SESSION_PREFIX)) {
        const siwe = await verifySiweBearerToken(token, { domain: opts.siweDomain });
        return { principalId: `eth:${siwe.address}` };
      }
    } catch { throw new ConsentError(401, 'Invalid or revoked credential'); }
    throw new ConsentError(401, 'Unsupported credential');
  }
  function route(mode: 'owner' | 'consumer', action: (c: Context, actor: ConsentIdentity, agentId: string, id: string) => Promise<unknown>) {
    return async (c: Context) => {
      try {
        const actor = await identity(c, mode);
        const id = c.req.param('operationId') ?? '';
        if (id && !z.string().uuid().safeParse(id).success) throw new ConsentError(404, 'Not found');
        return c.json(await action(c, actor, c.req.param('id')!, id));
      } catch (error) {
        if (error instanceof ConsentError) return c.json({ error: error.message }, error.status);
        // Never log request payloads, bearer material or provider responses.
        logEvent('consumer_consent_error', { name: error instanceof Error ? error.name : 'unknown' });
        return c.json({ error: 'Internal error' }, 500);
      }
    };
  }
  const host = '/admin-api/agents/:id/consent-proposals';
  const consumer = '/agents/:id/consent-proposals/:operationId';
  app.post(host, route('owner', async (c, actor, agentId) => service.register(agentId, actor, await body(c, ConsentRegistration))));
  app.get(`${host}/:operationId`, route('owner', async (_c, actor, agentId, id) => service.get(agentId, id, actor, 'owner')));
  app.get(`${host}/:operationId/audit`, route('owner', async (_c, actor, agentId, id) => service.auditTrail(agentId, id, actor)));
  app.post(`${host}/:operationId/claim`, route('owner', async (c, actor, agentId, id) => service.claim(agentId, id, actor, await body(c, ConsentClaim))));
  app.post(`${host}/:operationId/result`, route('owner', async (c, actor, agentId, id) => service.result(agentId, id, actor, await body(c, ConsentResult))));
  app.post(`${host}/:operationId/cancel`, route('owner', async (_c, actor, agentId, id) => service.cancel(agentId, id, actor, 'owner')));
  app.get(consumer, route('consumer', async (_c, actor, agentId, id) => service.get(agentId, id, actor, 'consumer')));
  app.post(`${consumer}/decision`, route('consumer', async (c, actor, agentId, id) => service.decide(agentId, id, actor, await body(c, ConsentDecision))));
  app.post(`${consumer}/cancel`, route('consumer', async (_c, actor, agentId, id) => service.cancel(agentId, id, actor, 'consumer')));
  return service;
}
