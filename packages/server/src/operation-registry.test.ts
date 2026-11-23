import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import test from 'node:test';
import postgres from 'postgres';
import { ensureSchema } from './db.js';
import { activeDefinitions, executorDefinition, migrateOperationRegistry } from './operation-registry.js';

test('legacy registry migration is atomic and never reapplies stale configuration', {
  skip: !process.env.DATABASE_URL,
}, async t => {
  const db = postgres(process.env.DATABASE_URL!, { onnotice() {} });
  t.after(() => db.end());
  await ensureSchema(db);
  // Roll back the singleton migration marker and fixtures together, allowing
  // this test to run against databases already migrated by other test suites.
  const rollback = new Error('rollback migration test');
  await assert.rejects(db.begin(async tx => {
    await tx`DELETE FROM infra.operation_registry_migration`;
    const owner = 'google:' + randomUUID();
    const agentId = 'migrate-ops-' + randomUUID();
    await tx`INSERT INTO agents(id, owner_principal, name, token_hash) VALUES
      (${agentId},${owner},'legacy operation',${agentId})`;
    const policy = {agentId, ownerPrincipal: owner, ownerRevision: 0, operation: 'merge', version: 'v1',
      operators: [{principalId: owner}], ttlSeconds: 3600, fields: {}, executorId: 'pt4',
      executorTokenSha256: createHash('sha256').update(randomUUID()).digest('hex')};
    const next = { ...policy, ownerRevision: 1, ownerPrincipal: 'google:' + randomUUID(),
      executorTokenSha256: createHash('sha256').update(randomUUID()).digest('hex') };
    await tx`UPDATE agents SET owner_principal=${next.ownerPrincipal} WHERE id=${agentId}`;
    await tx`SET LOCAL ROLE app_postgraphile`;
    await assert.rejects(tx.savepoint(sp => migrateOperationRegistry(sp, JSON.stringify([policy,
      { ...next, agentId: 'missing-' + agentId }]))), /does not match/);
    assert.equal(await executorDefinition(tx, agentId, policy.operation, policy.executorTokenSha256), undefined);
    await migrateOperationRegistry(tx, JSON.stringify([policy, next]));
    assert.deepEqual(await activeDefinitions(tx, agentId), [next]);
    const old = await executorDefinition(tx, agentId, 'merge', policy.executorTokenSha256);
    assert.equal(old?.active, false);
    assert.equal(old?.definition.ownerPrincipal, owner);
    await tx`UPDATE infra.operation_definitions SET active=false WHERE agent_id=${agentId}`;
    await migrateOperationRegistry(tx, JSON.stringify([policy, next]));
    assert.deepEqual(await activeDefinitions(tx, agentId), []);
    throw rollback;
  }), err => err === rollback);
});
