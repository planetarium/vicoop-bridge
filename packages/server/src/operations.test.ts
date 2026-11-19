import { test } from 'node:test';
import { OPERATION_APPROVAL_EXTENSION_URI } from '@vicoop-bridge/protocol';
import { TaskState } from '@a2x/sdk';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { SignJWT, generateKeyPair, exportJWK } from 'jose';
import { formatFederatedDelegation } from './auth/federated-delegation.js';
import { formatFederatedPrincipal } from './auth/principal.js';
import { mountTokenExchangeRoutes } from './oauth/token-exchange/routes.js';
import {
  createMentionableOAuthProfile,
  MENTIONABLE_OAUTH_PROFILE_ID,
  OAUTH_FEDERATION_CLAIM_TASK_ID,
  OAUTH_FEDERATION_TYP_CLIENT_ASSERTION,
  OAUTH_FEDERATION_TYP_TASK_CONTINUATION_ASSERTION,
  OAUTH_GRANT_TYPE_TOKEN_EXCHANGE,
  OAUTH_TOKEN_TYPE_ACCESS_TOKEN,
  OAUTH_TOKEN_TYPE_JWT,
  OAUTH_CLIENT_ASSERTION_TYPE_JWT_BEARER,
} from './oauth/profiles/mentionable-v0.1.js';
import { Hono } from 'hono';
import { z } from 'zod';
const requestView = z.object({
  id: z.string().uuid(),
  state: z.string(),
  digest: z.string(),
});
const claim = z.object({ operation: requestView.nullable() });
const history = z.object({
  history: z.array(
    z.object({
      event: z.string(),
      by: z.string().optional(),
      actor: z.string().optional(),
    }),
  ),
});
import { PostgresTaskStore } from './postgres-task-store.js';
import { ensureSchema } from './db.js';
import {
  issueTokenExchangeAccessToken,
  verifyTokenExchangeAccessToken,
} from './oauth/token-exchange/store.js';
import {
  mountOperations,
  readOperationRegistry,
  reconcileOperationPolicies,
} from './operations.js';

test(
  'registered operations bind A2A artifacts, preserve individual authority and claim a single external execution',
  { skip: !process.env.DATABASE_URL },
  async (t) => {
    const sql = postgres(process.env.DATABASE_URL!, { onnotice() {} });
    await ensureSchema(sql);
    const agentId = 'ops-' + randomUUID(),
      owner = 'eth:' + randomUUID(),
      actor = 'did:web:test-connector.example';
    const secondActor = 'did:web:second-connector.example';
    const slackMethod = 'urn:mentionable:auth:slack-member:v0.1';
    const otherMethod = 'urn:example:employee';
    const otherGrant = formatFederatedDelegation({ id: randomUUID(), issuer: actor, method: otherMethod })!;
    const secondGrant = formatFederatedDelegation({ id: randomUUID(), issuer: secondActor, method: slackMethod })!;
    const operator = 'slack:T/O',
      requester = 'slack:T/R',
      sharedGrant = formatFederatedDelegation({ id: randomUUID(), issuer: actor, method: slackMethod })!,
      requesterGrant = formatFederatedPrincipal({
        issuer: actor,
        method: slackMethod,
        subject: requester,
      })!;
    const executorToken = randomUUID();
    const policy = {
      agentId,
      ownerPrincipal: owner,
      ownerRevision: 0,
      executorId: 'ops-host',
      operation: 'merge-pr',
      version: '1',
      ttlSeconds: 86400,
      executorTokenSha256: createHash('sha256').update(executorToken).digest('hex'),
      operators: [
        { principalId: operator, actorId: actor }, { principalId: requester, actorId: actor },
        { principalId: requester, actorId: secondActor },
      ],
      fields: {
        pull: { type: 'integer' },
        repo: { type: 'string', allowedValues: ['org/repo'] },
      },
    };
    const successorToken = randomUUID();
    const successor = {
      ...policy,
      ownerPrincipal: 'new-' + owner,
      ownerRevision: 1,
      executorTokenSha256: createHash('sha256').update(successorToken).digest('hex'),
    };
    assert.throws(
      () =>
        readOperationRegistry(
          JSON.stringify([
            policy,
            { ...successor, executorTokenSha256: policy.executorTokenSha256 },
          ]),
        ),
      /distinct executor credentials/,
    );
    // Connect like the HTTP server, after applying migrations with the setup role.
    const runtime = postgres(process.env.DATABASE_URL!, {
      connection: { role: 'app_postgraphile' },
    });
    t.after(async () => runtime.end());
    assert.equal((await runtime`SELECT current_user`)[0].current_user, 'app_postgraphile');
    const exposed =
      await sql`SELECT role FROM (VALUES ('app_anonymous'), ('app_authenticated')) AS r(role)
      WHERE has_table_privilege(role, 'infra.operation_requests', 'SELECT,INSERT,UPDATE,DELETE')`;
    assert.deepEqual([...exposed], []);
    const app = new Hono();
    mountOperations(app, runtime, readOperationRegistry(JSON.stringify([policy, successor])));
    const path = '/agents/' + agentId + '/operations';
    const worker = '/operation-executors/' + agentId + '/merge-pr';
    t.after(async () => {
      await sql`DELETE FROM infra.a2a_tasks WHERE owner_agent=${agentId}`;
      await sql`DELETE FROM agents WHERE id=${agentId}`;
      await sql.end();
    });
    await sql`INSERT INTO agents(id,owner_principal,name,token_hash,allowed_callers)
    VALUES(${agentId},${owner},'ops test',${agentId},${[requesterGrant, sharedGrant, otherGrant, secondGrant]})`;
    const issue = async (principalId: string, allowedCaller: string, task?: string,
      scopes = task ? ['a2a:task.read'] : ['a2a:task.read', 'a2a:message.send', 'a2a:task.cancel'], actorId = actor) =>
      (
        await issueTokenExchangeAccessToken(sql, {
          agentId,
          resource: 'https://bridge.example/agents/' + agentId,
          profileId: MENTIONABLE_OAUTH_PROFILE_ID,
          principalId,
          actorId,
          allowedCaller,
          scopes,
          taskId: task,
          expiresAt: new Date(Date.now() + 60_000),
        })
      ).rawToken;
    const caller = await issue(requester, requesterGrant),
      approver = await issue(operator, sharedGrant);
    const other = await issue('slack:T/OTHER', sharedGrant);
    const post = (uri: string, token: string, input?: unknown) =>
      app.request(uri, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + token,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(input ?? {}),
      });
    const get = (uri: string, token: string) =>
      app.request(uri, { headers: { Authorization: 'Bearer ' + token } });
    const artifacts = Array.from({ length: 12 }, (_, index) => ({
      artifactId: randomUUID(),
      extensions: [OPERATION_APPROVAL_EXTENSION_URI],
      parts: [
        {
          kind: 'data',
          data: {
            type: 'vicoop.operation-proposal.v1',
            operation: 'merge-pr',
            arguments: { pull: index + 1, repo: 'org/repo' },
          },
        },
      ],
    }));
    const store = new PostgresTaskStore(sql, { ownerAgent: agentId });
    const metadata = {
      _principalId: requester,
      _actorId: actor,
      _authorizationKey: requesterGrant,
      _authorizationProfile: MENTIONABLE_OAUTH_PROFILE_ID,
    };
    const { id: taskId } = await store.createTask({
      contextId: randomUUID(),
      metadata,
    });
    await store.updateTask(taskId, {
      artifacts,
      status: { state: TaskState.WORKING },
    });
    const payload = (i: number) => ({
      taskId,
      proposalKey: artifacts[i].artifactId,
      operation: 'merge-pr',
      arguments: artifacts[i].parts[0].data.arguments,
    });
    assert.equal((await post(path, caller, payload(0))).status, 409);
    const abandoned = await store.createTask({
      contextId: randomUUID(),
      metadata,
    });
    await store.updateTask(abandoned.id, {
      artifacts,
      status: { state: TaskState.FAILED },
    });
    assert.equal((await post(path, caller, { ...payload(0), taskId: abandoned.id })).status, 400);
    await store.updateTask(taskId, {
      status: { state: TaskState.INPUT_REQUIRED },
    });
    const directOnly = new Hono();
    mountOperations(directOnly, runtime, readOperationRegistry(JSON.stringify([{
      ...policy, operators: [{ principalId: 'google:314159' }],
    }])));
    const incompatiblePolicy = await directOnly.request(path, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + caller, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload(0)),
    });
    assert.equal(incompatiblePolicy.status, 404, 'an older task cannot register after its reviewer scheme is removed');
    // A generic JSON artifact is not an operation proposal, even when its data looks identical.
    const unmarked = { ...artifacts[0], artifactId: randomUUID(), extensions: [] };
    await store.updateTask(taskId, { artifacts: [...artifacts, unmarked] });
    assert.equal((await post(path, caller, { ...payload(0), proposalKey: unmarked.artifactId })).status, 409);
    const create = async (i: number) => {
      const r = await post(path, caller, payload(i));
      assert.equal(r.status, 200, await r.clone().text());
      return requestView.parse(await r.json());
    };
    assert.equal(
      (await post(path, caller, { ...payload(0), proposalKey: randomUUID() })).status,
      400,
    );
    assert.equal(
      (
        await post(path, caller, {
          ...payload(0),
          arguments: { repo: 'org/repo', pull: 500 },
        })
      ).status,
      409,
    );
    assert.equal((await post(path, other, payload(0))).status, 404);
    assert.equal(
      (await post(path, await issue(requester, requesterGrant, randomUUID()), payload(0))).status,
      404,
    );
    const pending = await create(8);
    const approved = await create(9);
    assert.equal(
      (
        await post(path + '/' + approved.id + '/decision', approver, {
          decision: 'approve',
          digest: approved.digest,
        })
      ).status,
      200,
    );
    const oldSameMethod = await create(10);
    const oldOtherMethod = await create(11);
    for (const item of [oldSameMethod, oldOtherMethod]) {
      assert.equal((await post(path + '/' + item.id + '/decision', approver, {
        decision: 'approve', digest: item.digest,
      })).status, 200);
    }
    await sql`UPDATE infra.operation_requests SET decision_scheme_verified=false
      WHERE id=ANY(${[oldSameMethod.id, oldOtherMethod.id]}::uuid[])`;
    await sql`UPDATE infra.operation_requests SET decided_by=${otherGrant} WHERE id=${oldOtherMethod.id}`;
    // Old revisions could record a decision when the requester was also an
    // allowlisted operator. Do not dispatch that already-approved work.
    await sql`UPDATE infra.operation_requests SET decided_principal=requester WHERE id=${approved.id}`;
    assert.equal(claim.parse(await (await post(worker + '/claim', executorToken)).json()).operation, null);
    await reconcileOperationPolicies(runtime, readOperationRegistry(JSON.stringify([policy])));
    assert.equal(claim.parse(await (await post(worker + '/claim', executorToken)).json()).operation?.id, oldSameMethod.id);
    assert.equal((await post(worker + '/' + oldSameMethod.id + '/result', executorToken,
      { state: 'succeeded', result: 'Done' })).status, 200);
    assert.equal(requestView.parse(await (await get(path + '/' + oldOtherMethod.id, caller)).json()).state, 'cancelled');
    const empty = new Hono();
    mountOperations(empty, runtime, []);
    const changed = readOperationRegistry(JSON.stringify([{ ...policy, ttlSeconds: 3600 }]));
    await reconcileOperationPolicies(runtime, changed);
    await reconcileOperationPolicies(runtime, []);
    await reconcileOperationPolicies(runtime, readOperationRegistry(JSON.stringify([policy])));
    for (const item of [pending, approved]) {
      const status = await empty.request(path + '/' + item.id, {
        headers: { Authorization: 'Bearer ' + caller },
      });
      assert.equal(requestView.parse(await status.json()).state, 'cancelled');
      const audit = history.parse(
        await (await get(path + '/' + item.id + '/audit', caller)).json(),
      );
      assert.deepEqual(audit.history.filter((e) => e.event === (item === approved ? 'self_approval_revoked' : 'policy_changed')).length, 1);
    }
    const [a, replay] = await Promise.all([create(0), create(0)]);
    assert.deepEqual(a, replay);
    const canDecide = async (id: string, token: string) =>
      z.object({ canDecide: z.boolean() }).parse(await (await get(path + '/' + id, token)).json())
        .canDecide;
    assert.equal(await canDecide(a.id, caller), false);
    assert.equal(await canDecide(a.id, approver), true);
    const readOnlyOperator = await issue(operator, sharedGrant, undefined, ['a2a:task.read']);
    const taskScopedOperator = await issue(operator, sharedGrant, taskId, ['a2a:task.read', 'a2a:message.send']);
    assert.equal(await canDecide(a.id, readOnlyOperator), false);
    assert.equal(await canDecide(a.id, taskScopedOperator), false);
    await store.updateTask(taskId, { status: { state: TaskState.COMPLETED } });
    assert.equal((await get(path + '/' + a.id, other)).status, 404);
    const decide = (item: typeof a, token = approver, decision = 'approve') =>
      post(path + '/' + item.id + '/decision', token, {
        decision,
        digest: item.digest,
      });
    const wrongMethod = await issue(operator, otherGrant);
    assert.equal((await get(path + '/' + a.id, wrongMethod)).status, 404);
    assert.equal((await decide(a, wrongMethod)).status, 404);
    for (const asRequester of [caller, await issue(requester, sharedGrant), await issue(requester, secondGrant, undefined, undefined, secondActor)]) {
      for (const decision of ['approve', 'deny']) {
        assert.equal((await decide(a, asRequester, decision)).status, 404);
      }
    }
    assert.equal((await decide(a, readOnlyOperator)).status, 404);
    assert.equal((await decide(a, taskScopedOperator)).status, 404);
    assert.equal((await post(path + '/' + a.id + '/cancel', await issue(requester, requesterGrant, taskId))).status, 404);
    assert.equal((await decide({ ...a, digest: '0'.repeat(64) })).status, 409);
    // Read-only views do not wait on a concurrent operation-row writer.
    await sql.begin(async (tx) => {
      await tx`SELECT id FROM infra.operation_requests WHERE id=${a.id} FOR UPDATE`;
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          Promise.all(
            ['', '/audit'].map(async (suffix) => {
              const res = await get(path + '/' + a.id + suffix, caller);
              assert.equal(res.status, 200);
            }),
          ),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(Error('reader blocked')), 2000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    });
    // A connector can poll while an operator retries the same decision.
    // Warm the pool so independent transactions actually use different sessions.
    await Promise.all(Array.from({ length: 6 }, () => sql`SELECT pg_sleep(0.01)`));
    const reviews = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        i % 2 === 0 ? decide(a) : get(path + '/' + a.id, approver),
      ),
    );
    for (const review of reviews) assert.equal(review.status, 200, await review.text());
    assert.equal((await decide(a, approver, 'deny')).status, 409);
    assert.equal((await post(worker + '/claim', caller)).status, 401);
    const claims = await Promise.all(
      Array.from(
        { length: 5 },
        async () =>
          claim.parse(await (await post(worker + '/claim', executorToken)).json()).operation,
      ),
    );
    assert.deepEqual(
      claims.filter((i) => i !== null).map((i) => i.id),
      [a.id],
    );
    const outcome = { state: 'unknown', result: 'Reconciliation required.' };
    assert.equal((await post(worker + '/' + a.id + '/result', executorToken, outcome)).status, 200);
    assert.equal(
      z
        .object({ operations: z.array(requestView) })
        .parse(await (await get(worker + '/unresolved', executorToken)).json()).operations[0].id,
      a.id,
    );
    assert.equal(
      claim.parse(await (await post(worker + '/claim', executorToken)).json()).operation,
      null,
    );
    const final = { state: 'succeeded', result: 'Verified merged head.' };
    assert.equal((await post(worker + '/' + a.id + '/result', executorToken, final)).status, 200);
    assert.equal((await post(worker + '/' + a.id + '/result', executorToken, final)).status, 200);
    assert.deepEqual(
      history
        .parse(await (await get(path + '/' + a.id + '/audit', caller)).json())
        .history.map((entry: { event: string }) => entry.event),
      ['proposed', 'approved', 'claimed', 'unknown', 'succeeded'],
    );
    assert.equal((await decide(a)).status, 200, 'same operator may replay after the host finished');
    const audit = history.parse(
      await (await get(path + '/' + a.id + '/audit', caller)).json(),
    ).history;
    assert.equal(audit[1].by, operator);
    assert.equal(audit[1].actor, actor);
    assert.equal(await canDecide(a.id, approver), false);
    const b = await create(1);
    await sql`UPDATE infra.operation_requests SET expires_at=clock_timestamp() WHERE id=${b.id}`;
    assert.equal(await canDecide(b.id, approver), false);
    assert.equal((await decide(b)).status, 409);
    assert.equal(
      requestView.parse(await (await get(path + '/' + b.id, caller)).json()).state,
      'expired',
    );
    const c = await create(2);
    assert.equal((await decide(c)).status, 200);
    assert.equal((await post(path + '/' + c.id + '/cancel', caller)).status, 200);
    const d = await create(3);
    assert.equal((await decide(d, approver, 'deny')).status, 200);
    const e = await create(4);
    assert.equal((await decide(e)).status, 200);
    await sql`UPDATE agents SET allowed_callers=${[requesterGrant]} WHERE id=${agentId}`;
    await sql`UPDATE agents SET allowed_callers=${[
      requesterGrant,
      sharedGrant,
    ]} WHERE id=${agentId}`;
    assert.equal(
      requestView.parse(await (await get(path + '/' + e.id, caller)).json()).state,
      'cancelled',
    );
    const f = await create(5);
    // Ledger remains usable past execution lifetime and A2A retention.
    await sql`DELETE FROM infra.a2a_tasks WHERE task_id=${taskId}`;
    assert.equal((await decide(f)).status, 200);
    assert.equal(
      claim.parse(await (await post(worker + '/claim', executorToken)).json()).operation?.id,
      f.id,
    );
    // Cron has only a signed task continuation, even when it is recovering a
    // terminal result days after the original Slack event and token expired.
    const keys = await generateKeyPair('EdDSA');
    const kid = actor + '#test';
    const publicKeyJwk = await exportJWK(keys.publicKey);
    const publicUrl = 'https://bridge.test';
    const authorizationServer = new Hono();
    mountTokenExchangeRoutes(authorizationServer, {
      sql,
      publicUrl,
      profiles: [
        createMentionableOAuthProfile({
          resolver: {
            async resolve() {
              return {
                id: actor,
                verificationMethod: [
                  {
                    id: kid,
                    type: 'JsonWebKey',
                    controller: actor,
                    publicKeyJwk,
                  },
                ],
                assertionMethod: [kid],
              };
            },
          },
        }),
      ],
    });
    const exchange = async (subject = requester, task = taskId, scope = 'a2a:task.read') => {
      const signed = (typ: string, sub: string, fields: Record<string, string> = {}) =>
        new SignJWT(fields)
          .setProtectedHeader({ alg: 'EdDSA', typ, kid })
          .setIssuer(actor)
          .setSubject(sub)
          .setAudience(publicUrl + '/oauth/token')
          .setJti(randomUUID())
          .setIssuedAt()
          .setExpirationTime('2m')
          .sign(keys.privateKey);
      return authorizationServer.request('/oauth/token', {
        method: 'POST',
        body: new URLSearchParams({
          grant_type: OAUTH_GRANT_TYPE_TOKEN_EXCHANGE,
          subject_token_type: OAUTH_TOKEN_TYPE_JWT,
          requested_token_type: OAUTH_TOKEN_TYPE_ACCESS_TOKEN,
          client_id: actor,
          client_assertion_type: OAUTH_CLIENT_ASSERTION_TYPE_JWT_BEARER,
          client_assertion: await signed(OAUTH_FEDERATION_TYP_CLIENT_ASSERTION, actor),
          subject_token: await signed(OAUTH_FEDERATION_TYP_TASK_CONTINUATION_ASSERTION, subject, {
            [OAUTH_FEDERATION_CLAIM_TASK_ID]: task,
          }),
          resource: publicUrl + '/agents/' + agentId,
          scope,
        }),
      });
    };
    const response = await exchange();
    assert.equal(response.status, 200, await response.clone().text());
    const recovered = z
      .object({ access_token: z.string() })
      .parse(await response.json()).access_token;
    assert.equal(
      requestView.parse(await (await get(path + '/' + a.id, recovered)).json()).state,
      'succeeded',
    );
    assert.equal(await canDecide(a.id, recovered), false);
    assert.equal((await post(path + '/' + a.id + '/cancel', recovered)).status, 401);
    assert.equal((await decide(f, recovered)).status, 401);
    assert.equal((await get(path + '/' + a.id + '/audit', recovered)).status, 401);
    assert.equal((await post(path, recovered, payload(0))).status, 401);
    await assert.rejects(
      verifyTokenExchangeAccessToken(sql, recovered, agentId),
      /restricted to operation status/,
    );
    assert.equal((await exchange(operator)).status, 400);
    assert.equal((await exchange(requester, randomUUID())).status, 400);
    assert.equal((await exchange(requester, taskId, 'a2a:task.read a2a:task.cancel')).status, 400);
    await sql`UPDATE agents SET allowed_callers=${[sharedGrant]} WHERE id=${agentId}`;
    await sql`UPDATE agents SET allowed_callers=${[
      requesterGrant,
      sharedGrant,
    ]} WHERE id=${agentId}`;
    assert.equal((await exchange()).status, 400);
    assert.equal((await get(path + '/' + a.id, recovered)).status, 404);
    assert.equal((await post(worker + '/' + f.id + '/result', executorToken, outcome)).status, 200);
    await sql`UPDATE agents SET owner_principal=${'new-' + owner} WHERE id=${agentId}`;
    const unresolved = async (credential: string) =>
      z
        .object({ operations: z.array(requestView) })
        .parse(await (await get(worker + '/unresolved', credential)).json())
        .operations.map((row) => row.id);
    assert.deepEqual(await unresolved(executorToken), [f.id]);
    assert.deepEqual(await unresolved(successorToken), []);
    assert.equal((await post(worker + '/claim', executorToken)).status, 404);
    assert.equal(
      claim.parse(await (await post(worker + '/claim', successorToken)).json()).operation,
      null,
    );
    assert.equal((await post(worker + '/' + f.id + '/result', successorToken, final)).status, 404);
    assert.equal((await post(worker + '/' + f.id + '/result', executorToken, final)).status, 200);
    assert.deepEqual(await unresolved(executorToken), []);
    assert.equal((await get(path + '/' + f.id, caller)).status, 404);
    const [settled] =
      await sql`SELECT state,history->-1->>'event' AS last_event FROM infra.operation_requests WHERE id=${f.id}`;
    assert.equal(settled.state, 'succeeded');
    assert.equal(settled.last_event, 'succeeded');
    await sql`UPDATE agents SET owner_principal=${owner} WHERE id=${agentId}`;
    assert.equal((await get(path + '/' + a.id, caller)).status, 404);
    assert.equal((await post(worker + '/claim', executorToken)).status, 404);
  },
);
