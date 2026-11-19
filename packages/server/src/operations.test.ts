import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { Hono } from 'hono';
import { z } from 'zod';
const requestView = z.object({ id: z.string().uuid(), state: z.string(), digest: z.string() });
const claim = z.object({ operation: requestView.nullable() });
const history = z.object({
  history: z.array(
    z.object({ event: z.string(), by: z.string().optional(), actor: z.string().optional() }),
  ),
});
import { PostgresTaskStore } from './postgres-task-store.js';
import { ensureSchema } from './db.js';
import { issueTokenExchangeAccessToken } from './oauth/token-exchange/store.js';
import { mountOperations, readOperationRegistry } from './operations.js';

test(
  'registered operations bind A2A artifacts, preserve individual authority and claim a single external execution',
  { skip: !process.env.DATABASE_URL },
  async (t) => {
    const sql = postgres(process.env.DATABASE_URL!, { onnotice() {} });
    await ensureSchema(sql);
    const agentId = 'ops-' + randomUUID(),
      owner = 'eth:' + randomUUID(),
      actor = 'did:web:test-connector.example';
    const operator = 'slack:T/O',
      requester = 'slack:T/R',
      sharedGrant = 'grant-' + randomUUID(),
      requesterGrant = 'grant-' + randomUUID();
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
      operators: [{ principalId: operator, actorId: actor }],
      fields: { pull: { type: 'integer' }, repo: { type: 'string', allowedValues: ['org/repo'] } },
    };
    const app = new Hono();
    mountOperations(app, sql, readOperationRegistry(JSON.stringify([policy])));
    const path = '/agents/' + agentId + '/operations';
    const worker = '/operation-executors/' + agentId + '/merge-pr';
    t.after(async () => {
      await sql`DELETE FROM infra.a2a_tasks WHERE owner_agent=${agentId}`;
      await sql`DELETE FROM agents WHERE id=${agentId}`;
      await sql.end();
    });
    await sql`INSERT INTO agents(id,owner_principal,name,token_hash,allowed_callers)
    VALUES(${agentId},${owner},'ops test',${agentId},${[requesterGrant, sharedGrant]})`;
    const issue = async (principalId: string, allowedCaller: string, task?: string) =>
      (
        await issueTokenExchangeAccessToken(sql, {
          agentId,
          resource: 'https://bridge.example/agents/' + agentId,
          profileId: 'mentionable',
          principalId,
          actorId: actor,
          allowedCaller,
          scopes: ['a2a:task.read'],
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
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify(input ?? {}),
      });
    const get = (uri: string, token: string) =>
      app.request(uri, { headers: { Authorization: 'Bearer ' + token } });
    const artifacts = Array.from({ length: 8 }, (_, index) => ({
      artifactId: randomUUID(),
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
    const { id: taskId } = await store.createTask({
      contextId: randomUUID(),
      metadata: {
        _principalId: requester,
        _actorId: actor,
        _authorizationKey: requesterGrant,
        _authorizationProfile: 'mentionable',
      },
    });
    await store.updateTask(taskId, { artifacts });
    const payload = (i: number) => ({
      taskId,
      proposalKey: artifacts[i].artifactId,
      operation: 'merge-pr',
      arguments: artifacts[i].parts[0].data.arguments,
    });
    const create = async (i: number) => {
      const r = await post(path, caller, payload(i));
      assert.equal(r.status, 200, await r.clone().text());
      return requestView.parse(await r.json());
    };
    assert.equal(
      (await post(path, caller, { ...payload(0), proposalKey: randomUUID() })).status,
      409,
    );
    assert.equal(
      (await post(path, caller, { ...payload(0), arguments: { repo: 'org/repo', pull: 500 } }))
        .status,
      409,
    );
    assert.equal((await post(path, other, payload(0))).status, 404);
    assert.equal(
      (await post(path, await issue(requester, requesterGrant, randomUUID()), payload(0))).status,
      404,
    );
    const [a, replay] = await Promise.all([create(0), create(0)]);
    assert.deepEqual(a, replay);
    assert.equal((await get(path + '/' + a.id, other)).status, 404);
    const decide = (item: typeof a, token = approver, decision = 'approve') =>
      post(path + '/' + item.id + '/decision', token, { decision, digest: item.digest });
    assert.equal((await decide(a, caller)).status, 404);
    assert.equal((await decide({ ...a, digest: '0'.repeat(64) })).status, 409);
    assert.equal((await decide(a)).status, 200);
    assert.equal((await decide(a)).status, 200);
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
    const b = await create(1);
    await sql`UPDATE infra.operation_requests SET expires_at=clock_timestamp() WHERE id=${b.id}`;
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
    await sql`UPDATE agents SET owner_principal=${'new-' + owner} WHERE id=${agentId}`;
    await sql`UPDATE agents SET owner_principal=${owner} WHERE id=${agentId}`;
    assert.equal((await get(path + '/' + a.id, caller)).status, 404);
    assert.equal((await post(worker + '/claim', executorToken)).status, 404);
  },
);
