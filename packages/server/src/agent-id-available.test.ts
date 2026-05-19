import { test } from 'node:test';
import assert from 'node:assert/strict';
import postgres from 'postgres';

const hasDb = !!process.env.DATABASE_URL;

async function callAvailable(sql: postgres.Sql, agentId: string): Promise<boolean> {
  const rows = await sql<{ available: boolean }[]>`
    SELECT agent_id_available(${agentId}) AS available
  `;
  return rows[0]!.available;
}

test(
  'returns true for an agent_id that no client has registered',
  { skip: !hasDb },
  async () => {
    const sql = postgres(process.env.DATABASE_URL!);
    try {
      const agentId = `availability-free-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      assert.equal(await callAvailable(sql, agentId), true);
    } finally {
      await sql.end();
    }
  },
);

test(
  'returns false once an agents row holds the id',
  { skip: !hasDb },
  async () => {
    const sql = postgres(process.env.DATABASE_URL!);
    try {
      const agentId = `availability-taken-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const owner = 'eth:0x1111111111111111111111111111111111111111';
      try {
        await sql`
          INSERT INTO agents (id, owner_principal, name, token_hash)
          VALUES (${agentId}, ${owner}, 'availability-test', ${`fake-hash-${agentId}`})
        `;

        assert.equal(await callAvailable(sql, agentId), false);
      } finally {
        await sql`DELETE FROM agents WHERE id = ${agentId}`;
      }

      // Once cleaned up, the id is free again.
      assert.equal(await callAvailable(sql, agentId), true);
    } finally {
      await sql.end();
    }
  },
);

test(
  'authenticated caller from a different principal still sees available=false (RLS bypass)',
  { skip: !hasDb },
  async () => {
    // Guards the SECURITY DEFINER posture: agents_select restricts
    // SELECT to the owning principal, so without RLS bypass a different
    // principal's direct query would return no rows and the function would
    // wrongly report the id as available. Exercising app_authenticated with a
    // mismatched principal claim proves the bypass is effective.
    const sql = postgres(process.env.DATABASE_URL!);
    try {
      const agentId = `availability-cross-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const owner = 'eth:0x2222222222222222222222222222222222222222';
      const other = 'eth:0x3333333333333333333333333333333333333333';

      try {
        await sql`
          INSERT INTO agents (id, owner_principal, name, token_hash)
          VALUES (${agentId}, ${owner}, 'availability-test', ${`fake-hash-${agentId}`})
        `;

        const available = await sql.begin(async (tx) => {
          await tx`SET LOCAL ROLE app_authenticated`;
          await tx`SELECT set_config('jwt.claims.principal_id', ${other}, true)`;
          const rows = await tx<{ available: boolean }[]>`
            SELECT agent_id_available(${agentId}) AS available
          `;
          return rows[0]!.available;
        });
        assert.equal(available, false);
      } finally {
        await sql`DELETE FROM agents WHERE id = ${agentId}`;
      }
    } finally {
      await sql.end();
    }
  },
);

test(
  'app_anonymous cannot execute agent_id_available (enumeration closed)',
  { skip: !hasDb },
  async () => {
    // GRANTs intentionally exclude app_anonymous so a caller without a
    // vbc_caller_* token cannot probe the existence of arbitrary agent ids.
    // Lock this in: if a future edit widens the grant, this test fails.
    const sql = postgres(process.env.DATABASE_URL!);
    try {
      await assert.rejects(
        () =>
          sql.begin(async (tx) => {
            await tx`SET LOCAL ROLE app_anonymous`;
            await tx`SELECT agent_id_available('any-id')`;
          }),
        /permission denied/i,
      );
    } finally {
      await sql.end();
    }
  },
);

test(
  'NULL or empty agent_id is rejected with invalid_parameter_value',
  { skip: !hasDb },
  async () => {
    // Without the explicit guard, ap.agent_id = NULL matches no rows and the
    // function would return true for a plainly invalid input. Same for ''.
    const sql = postgres(process.env.DATABASE_URL!);
    try {
      await assert.rejects(
        () => sql`SELECT agent_id_available(${null as unknown as string})`,
        /non-empty string/,
      );
      await assert.rejects(
        () => sql`SELECT agent_id_available('')`,
        /non-empty string/,
      );
    } finally {
      await sql.end();
    }
  },
);
