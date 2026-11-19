import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { TaskState } from '@a2x/sdk';
import {
  formatFederatedPrincipal,
  OPERATION_APPROVAL_EXTENSION_URI,
  OPERATION_PROPOSAL_TYPE,
} from '@vicoop-bridge/protocol';
import { Wallet } from 'ethers';
import { Hono } from 'hono';
import postgres from 'postgres';
import { SiweMessage } from 'siwe';
import { z } from 'zod';
import {
  issueSessionToken,
  revokeSessionTokenByRaw,
  type IssueSessionTokenInput,
} from './auth/caller-token.js';
import { ensureSchema } from './db.js';
import { MENTIONABLE_OAUTH_PROFILE_ID } from './oauth/profiles/mentionable-v0.1.js';
import { issueTokenExchangeAccessToken } from './oauth/token-exchange/store.js';
import { mountOperations, readOperationRegistry } from './operations.js';
import { PostgresTaskStore } from './postgres-task-store.js';

const view = z.object({ id: z.string(), state: z.string(), digest: z.string() });

test(
  'direct operation APIs bind requests and decisions to authorized individuals in the same scheme',
  { skip: !process.env.DATABASE_URL },
  async (t) => {
    const sql = postgres(process.env.DATABASE_URL!, { onnotice() {} });
    const runtime = postgres(process.env.DATABASE_URL!, { connection: { role: 'app_postgraphile' } });
    const agentId = 'direct-ops-' + randomUUID();
    const callerIds: string[] = [];
    t.after(async () => {
      await runtime.end();
      await sql`DELETE FROM infra.a2a_tasks WHERE owner_agent=${agentId}`;
      await sql`DELETE FROM agents WHERE id=${agentId}`;
      await sql`DELETE FROM callers WHERE id=ANY(${callerIds}::text[])`;
      await sql.end();
    });
    await ensureSchema(sql);

    const google = 'google:101',
      googleOperator = 'google:102',
      unlisted = 'google:103';
    const wallet = Wallet.createRandom();
    const eth = 'eth:' + wallet.address.toLowerCase();
    const ethOperator = 'eth:' + Wallet.createRandom().address.toLowerCase();
    const actor = 'did:web:slack.test',
      slack = 'slack:T/U',
      slackGrant = formatFederatedPrincipal({
        issuer: actor,
        method: 'urn:mentionable:auth:slack-workspace-member:v0.1',
        subject: slack,
      })!;
    const domain = 'bridge.test';
    const credential = async (
      principalId: string,
      provider: IssueSessionTokenInput['provider'],
      options: Partial<Pick<IssueSessionTokenInput, 'audience' | 'ttlMs'>> = {},
    ) => {
      const issued = await issueSessionToken(sql, { principalId, provider, audience: 'caller', ...options });
      callerIds.push(issued.callerId);
      return issued.rawToken;
    };
    const googleToken = await credential(google, 'google');
    const reviewer = await credential(googleOperator, 'google');
    const walletToken = await credential(eth, 'siwe');
    const walletReviewer = await credential(ethOperator, 'siwe');
    const ownerSession = await credential(googleOperator, 'google', { audience: 'owner_session' });
    const apiKey = await credential('apikey:ops-test', 'apikey');
    const outsider = await credential(unlisted, 'google');
    const grants = [
      'google:sub:101',
      'google:sub:102',
      'google:sub:103',
      eth,
      ethOperator,
      'apikey:ops-test',
      slackGrant,
    ];
    const owner = 'owner-' + randomUUID();
    await sql`INSERT INTO agents(id,owner_principal,name,token_hash,allowed_callers)
      VALUES(${agentId},${owner},'direct operations',${agentId},${grants})`;
    const slackToken = (
      await issueTokenExchangeAccessToken(sql, {
        agentId,
        profileId: MENTIONABLE_OAUTH_PROFILE_ID,
        resource: 'https://bridge.test/agents/' + agentId,
        principalId: slack,
        actorId: actor,
        allowedCaller: slackGrant,
        scopes: ['a2a:task.read', 'a2a:message.send'],
        expiresAt: new Date(Date.now() + 60_000),
      })
    ).rawToken;
    const executor = randomUUID();
    const policies = readOperationRegistry(
      JSON.stringify([
        {
          agentId,
          ownerPrincipal: owner,
          ownerRevision: 0,
          operation: 'deploy',
          version: '1',
          ttlSeconds: 3600,
          executorId: 'host',
          executorTokenSha256: createHash('sha256').update(executor).digest('hex'),
          operators: [
            { principalId: google },
            { principalId: googleOperator },
            { principalId: eth },
            { principalId: ethOperator },
            { principalId: slack, actorId: actor },
          ],
          fields: { revision: { type: 'integer' } },
        },
      ]),
    );
    const app = new Hono();
    mountOperations(app, runtime, policies, domain);
    const path = '/agents/' + agentId + '/operations';
    const post = (url: string, token: string, body: unknown) =>
      app.request(url, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    const get = (id: string, token: string) =>
      app.request(path + '/' + id, {
        headers: { Authorization: 'Bearer ' + token },
      });
    const store = new PostgresTaskStore(sql, { ownerAgent: agentId });
    async function proposal(principal: string, grant: string, actorId?: string) {
      const task = await store.createTask({
        contextId: randomUUID(),
        metadata: actorId
          ? {
              _principalId: principal,
              _actorId: actorId,
              _authorizationKey: grant,
              _authorizationProfile: MENTIONABLE_OAUTH_PROFILE_ID,
            }
          : { _principalId: principal, _operationGrantKey: grant },
      });
      const proposalKey = randomUUID();
      const data = { type: OPERATION_PROPOSAL_TYPE, operation: 'deploy', arguments: { revision: 17 } };
      await store.updateTask(task.id, {
        artifacts: [
          {
            artifactId: proposalKey,
            extensions: [OPERATION_APPROVAL_EXTENSION_URI],
            parts: [{ data }],
          },
        ],
        status: { state: TaskState.COMPLETED },
      });
      return { taskId: task.id, proposalKey, operation: data.operation, arguments: data.arguments };
    }
    const register = async (token: string, payload: Awaited<ReturnType<typeof proposal>>) => {
      const response = await post(path, token, payload);
      assert.equal(response.status, 200, await response.clone().text());
      return view.parse(await response.json());
    };
    const decide = (item: z.infer<typeof view>, token: string) =>
      post(path + '/' + item.id + '/decision', token, { decision: 'approve', digest: item.digest });

    const federatedRequest = await register(slackToken, await proposal(slack, slackGrant, actor));
    for (const token of [reviewer, walletReviewer]) {
      assert.equal((await get(federatedRequest.id, token)).status, 404);
      assert.equal((await decide(federatedRequest, token)).status, 404);
    }

    const googleProposal = await proposal(google, grants[0]);
    assert.equal((await post(path, reviewer, googleProposal)).status, 404);
    const googleRequest = await register(googleToken, googleProposal);
    for (const token of [outsider, walletReviewer, slackToken]) {
      assert.equal((await get(googleRequest.id, token)).status, 404);
      assert.equal((await decide(googleRequest, token)).status, 404);
    }
    for (const token of [ownerSession, apiKey, await credential(googleOperator, 'google', { ttlMs: -1 })]) {
      assert.equal((await decide(googleRequest, token)).status, 401);
    }
    const ownRequest = await register(outsider, await proposal(unlisted, grants[2]));
    assert.equal((await decide(ownRequest, outsider)).status, 404);
    assert.equal((await get(googleRequest.id, googleToken)).status, 200);
    assert.equal((await get(googleRequest.id, reviewer)).status, 200);
    const revokedReviewer = await credential(googleOperator, 'google');
    assert.equal((await get(googleRequest.id, revokedReviewer)).status, 200);
    await revokeSessionTokenByRaw(sql, revokedReviewer);
    assert.equal((await decide(googleRequest, revokedReviewer)).status, 401);
    assert.equal((await decide(googleRequest, reviewer)).status, 200);

    // A credential verified for a different origin cannot register a proposal.
    // A wallet's signed bearer and its issued caller token represent the same requester.
    const signedBearer = async (forDomain: string) => {
      const message = new SiweMessage({
        domain: forDomain,
        address: wallet.address,
        uri: 'https://' + forDomain,
        version: '1',
        chainId: 1,
        nonce: randomUUID().replaceAll('-', ''),
        issuedAt: new Date().toISOString(),
        expirationTime: new Date(Date.now() + 60_000).toISOString(),
      }).prepareMessage();
      return Buffer.from(JSON.stringify({ message, signature: await wallet.signMessage(message) })).toString(
        'base64url',
      );
    };
    const walletProposal = await proposal(eth, eth);
    assert.equal((await post(path, await signedBearer('other.test'), walletProposal)).status, 401);
    const walletRequest = await register(await signedBearer(domain), walletProposal);
    assert.equal((await decide(walletRequest, reviewer)).status, 404);
    assert.equal((await decide(walletRequest, walletToken)).status, 200);
    assert.equal((await post(path + '/' + walletRequest.id + '/cancel', walletReviewer, {})).status, 404);
    assert.equal((await post(path + '/' + walletRequest.id + '/cancel', walletToken, {})).status, 200);

    // Removing a direct grant invalidates decisions and source tasks even after restoring access.
    const pending = await proposal(googleOperator, grants[1]);
    // Legacy text arrays can contain NULL elements. An absent grant must still
    // be revoked permanently even when SQL ANY would return NULL.
    await sql`UPDATE agents SET allowed_callers=array_append(${grants.filter((g) => g !== grants[1])}::text[], NULL::text)
      WHERE id=${agentId}`;
    assert.ok([401, 404].includes((await get(googleRequest.id, reviewer)).status));
    await sql`UPDATE agents SET allowed_callers=${grants} WHERE id=${agentId}`;
    assert.equal((await post(path, reviewer, pending)).status, 404);
    assert.equal(view.parse(await (await get(googleRequest.id, googleToken)).json()).state, 'cancelled');

    await sql`UPDATE agents SET allowed_callers='{}' WHERE id=${agentId}`;
    const publicProposal = await proposal(google, 'public');
    const publicRequest = await register(googleToken, publicProposal);
    assert.equal((await decide(publicRequest, reviewer)).status, 200);
    await sql`UPDATE agents SET allowed_callers=${grants} WHERE id=${agentId}`;
    await sql`UPDATE agents SET allowed_callers='{}' WHERE id=${agentId}`;
    const claimed = await post('/operation-executors/' + agentId + '/deploy/claim', executor, {});
    assert.equal(claimed.status, 200);
    assert.deepEqual(await claimed.json(), { operation: null });
  },
);
