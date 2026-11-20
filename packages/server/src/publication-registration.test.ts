import assert from 'node:assert/strict';
import test from 'node:test';
import { createPostGraphileSchema } from 'postgraphile';
import { Pool } from 'pg';
import { ensureSchema } from './db.js';
import { createPublicationTestDb } from './publication-test-db.js';

test('publication identity survives rollout and is isolated across renames, transfers and new registrations', {
  skip: !process.env.DATABASE_URL,
}, async t => {
  const db = await createPublicationTestDb(t);
  const id = 'publication-lifecycle';
  const first = 'google:first';
  const successor = 'google:second';
  const register = (owner: string) => db.begin(async tx => {
    await tx`SET LOCAL ROLE app_authenticated`;
    await tx`SELECT set_config('jwt.claims.principal_id', ${owner}, true)`;
    const [row] = await tx`SELECT id FROM register_client(${id}, ARRAY[${id}])`;
    return row!.id as string;
  });
  const client = await register(first);
  const getState = async () => {
    const [row] = await db`SELECT id, owner_revision::text, publication_revision::text,
      token_hash IS DISTINCT FROM publication_blocked_token_hash AS ready
      FROM agents WHERE client_id = ${client}`;
    return row;
  };
  assert.deepEqual(await getState(), { id, owner_revision: '0', publication_revision: '0', ready: true });

  const [database] = await db`SELECT current_database() AS name`;
  const url = new URL(process.env.DATABASE_URL!);
  url.pathname = '/' + database!.name;
  const pool = new Pool({ connectionString: url.href });
  try {
    const schema = await createPostGraphileSchema(pool, 'public', { ignoreRBAC: false, legacyRelations: 'omit' });
    const patch = schema.getType('AgentPatch');
    assert.ok(patch && 'getFields' in patch);
    assert.ok(!('clientId' in patch.getFields()));
    assert.ok(!('publicationBlockedTokenHash' in patch.getFields()));
    assert.ok(!('publicationRevision' in patch.getFields()));
    const clientPatch = schema.getType('ClientPatch');
    assert.ok(clientPatch && 'getFields' in clientPatch);
    assert.ok(!('id' in clientPatch.getFields()));
    assert.ok(!schema.getType('IssuedRegistrationId'));
  } finally { await pool.end(); }
  await assert.rejects(db`UPDATE clients SET id = 'changed' WHERE id = ${client}`, /immutable/);
  await assert.rejects(db`UPDATE agents SET client_id = 'changed' WHERE id = ${id}`, /immutable/);

  for (const [address, generation] of [[id + '-renamed', '1'], [id, '2']] as const) {
    await db.begin(async tx => {
      await tx`SET LOCAL ROLE app_authenticated`;
      await tx`SELECT set_config('jwt.claims.principal_id', ${first}, true)`;
      await tx`SELECT update_client_allowed_agents(${client}, ARRAY[${address}])`;
    });
    assert.deepEqual(await getState(), { id: address, owner_revision: '0', publication_revision: generation, ready: true });
  }
  // The GraphQL AgentPatch rename can leave the compatibility shadow at the old
  // address. Startup must neither resurrect the old row nor fail the backfill.
  await db`UPDATE agents SET id = ${id + '-direct'} WHERE client_id = ${client}`;
  await ensureSchema(db);
  assert.equal((await getState())?.id, id + '-direct');
  await db`UPDATE agents SET id = ${id} WHERE client_id = ${client}`;
  await db`UPDATE agents SET owner_principal = ${successor} WHERE id = ${id}`;
  await db`UPDATE clients SET owner_principal = ${successor} WHERE id = ${client}`;
  assert.deepEqual(await getState(), { id, owner_revision: '1', publication_revision: '5', ready: false });

  await db.begin(async tx => {
    await tx`SET LOCAL ROLE app_authenticated`;
    await tx`SELECT set_config('jwt.claims.principal_id', ${successor}, true)`;
    await tx`SELECT rotate_client_token(${client})`;
  });
  await ensureSchema(db);
  assert.equal((await getState())?.ready, true);

  // Simulate an already-transferred legacy registration as seen by the initial migration.
  await db`DROP TRIGGER agents_publication_epoch ON agents`;
  await db`ALTER TABLE agents ALTER COLUMN publication_revision DROP NOT NULL`;
  await db`UPDATE agents SET publication_revision = NULL, publication_blocked_token_hash = NULL WHERE id = ${id}`;
  await ensureSchema(db);
  assert.deepEqual(await getState(), { id, owner_revision: '1', publication_revision: '1', ready: false });

  await db.begin(async tx => {
    await tx`SET LOCAL ROLE app_authenticated`;
    await tx`SELECT set_config('jwt.claims.principal_id', ${successor}, true)`;
    await tx`SELECT delete_client(${client})`;
  });
  await assert.rejects(db`INSERT INTO agents (id, client_id, owner_principal, name, token_hash)
    VALUES (${id}, ${client}, ${successor}, 'test', 'unused')`, /issued_registration_ids_pkey/);
  assert.notEqual(await register(successor), client);
});
