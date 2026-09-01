// Integration tests for PostgresTaskStore against a real Postgres, gated on
// DATABASE_URL (like the other DB integration tests in this package):
//   - updateTask concurrency / lost-update serialization (issue #366)
//   - pruneStaleContexts time-based retention (issue #385)
// Both need a real table (transactions / row locks / controlled timestamps),
// so they cannot be exercised without a database and are skipped otherwise.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import postgres from 'postgres';
import { TaskState } from '@a2x/sdk';
import type { Message, Task } from '@a2x/sdk';
import { OPENAI_COMPAT_EXTENSION_URI } from '@vicoop-bridge/protocol';
import {
  PostgresTaskStore,
  stripSensitiveMetadata,
  parsePersistRequestEnvelope,
} from './postgres-task-store.js';
import { ensureSchema } from './db.js';

const hasDb = !!process.env.DATABASE_URL;

function msg(id: string, text: string): Message {
  return { messageId: id, role: 'agent', parts: [{ kind: 'text', text }] } as unknown as Message;
}

// A terminal status carrying the principal in message metadata, which is how
// owner_principal is derived (extractOwnerPrincipal reads status.message
// .metadata._principalId). Needed for the count-based retention path, which
// only fires for owned terminal tasks.
function ownedTerminalStatus(
  principalId: string,
  id: string,
  state: TaskState = TaskState.COMPLETED,
) {
  return {
    state,
    timestamp: new Date().toISOString(),
    message: {
      messageId: id,
      role: 'agent',
      parts: [{ kind: 'text', text: 'done' }],
      metadata: { _principalId: principalId },
    },
  } as unknown as Parameters<PostgresTaskStore['updateTask']>[1]['status'];
}

// Insert a row straight into infra.a2a_tasks aged by `age` (a Postgres interval
// literal like '40 days'), so we can simulate stale contexts without waiting.
async function seed(
  sql: postgres.Sql,
  row: { taskId: string; contextId: string; state: string; age: string },
): Promise<void> {
  await sql`
    INSERT INTO infra.a2a_tasks (task_id, context_id, state, task_json, owner_principal, created_at, updated_at)
    VALUES (
      ${row.taskId}, ${row.contextId}, ${row.state},
      ${sql.json({ id: row.taskId, contextId: row.contextId })},
      ${'eth:0xtest'},
      now() - ${row.age}::interval, now() - ${row.age}::interval
    )
  `;
}

// ── stripSensitiveMetadata: openai-compat request-envelope strip (issue #408) ─
// Pure (no DB), so these always run. The persisted copy must drop the
// request-scoped `chat_completions_request` envelope (~half of task_json) while
// leaving the live object, the response envelope, and everything else intact.

const OAI = OPENAI_COMPAT_EXTENSION_URI;

function taskWithRequestEnvelope(extra?: Record<string, unknown>): Task {
  return {
    id: 't1',
    contextId: 'c1',
    status: { state: TaskState.COMPLETED, timestamp: '2026-01-01T00:00:00.000Z' },
    metadata: {
      [OAI]: {
        chat_completions_request: {
          model: 'gpt-4',
          messages: [{ role: 'user', content: 'x'.repeat(1000) }],
        },
        ...extra,
      },
    },
  } as unknown as Task;
}

test('stripSensitiveMetadata drops the openai-compat chat_completions_request from the persisted copy', () => {
  const task = taskWithRequestEnvelope();
  const persisted = stripSensitiveMetadata(task);
  const ext = (persisted.metadata as Record<string, Record<string, unknown>> | undefined)?.[OAI];
  // The whole extension key is gone because the request envelope was its only member.
  assert.equal(ext, undefined, 'request envelope must not be persisted');
  // Empty metadata collapses to undefined rather than `{}`.
  assert.equal(persisted.metadata, undefined);
});

test('stripSensitiveMetadata does not mutate the live task object', () => {
  const task = taskWithRequestEnvelope();
  stripSensitiveMetadata(task);
  const liveExt = (task.metadata as Record<string, Record<string, unknown>>)[OAI];
  assert.ok(
    liveExt && 'chat_completions_request' in liveExt,
    'the in-flight task the caller still forwards from must keep the envelope',
  );
});

test('stripSensitiveMetadata keeps sibling openai-compat keys (e.g. response envelope) while dropping only the request', () => {
  const task = taskWithRequestEnvelope({ chat_completion: { id: 'resp-1', usage: { total_tokens: 5 } } });
  const persisted = stripSensitiveMetadata(task);
  const ext = (persisted.metadata as Record<string, Record<string, unknown>>)[OAI];
  assert.ok(ext, 'extension key survives when a sibling key remains');
  assert.equal('chat_completions_request' in ext, false, 'request envelope dropped');
  assert.deepEqual(ext.chat_completion, { id: 'resp-1', usage: { total_tokens: 5 } });
});

test('stripSensitiveMetadata leaves a non-openai-compat task untouched', () => {
  const task = {
    id: 't2',
    contextId: 'c2',
    status: { state: TaskState.COMPLETED, timestamp: '2026-01-01T00:00:00.000Z' },
    metadata: { someOtherKey: { a: 1 } },
  } as unknown as Task;
  const persisted = stripSensitiveMetadata(task);
  assert.deepEqual(persisted.metadata, { someOtherKey: { a: 1 } });
});

test('stripSensitiveMetadata preserves an openai-compat key that has no request envelope (e.g. response-only / heartbeat marker)', () => {
  const ext = { chat_completion: { id: 'resp-2' } };
  const task = {
    id: 't3',
    contextId: 'c3',
    status: { state: TaskState.COMPLETED, timestamp: '2026-01-01T00:00:00.000Z' },
    metadata: { [OAI]: ext },
  } as unknown as Task;
  const persisted = stripSensitiveMetadata(task);
  // No `chat_completions_request` to strip → the key (and its contents) is left as-is.
  assert.deepEqual((persisted.metadata as Record<string, unknown>)[OAI], ext);
});

test('stripSensitiveMetadata does not throw on absent or malformed metadata', () => {
  const base = {
    id: 't4',
    contextId: 'c4',
    status: { state: TaskState.COMPLETED, timestamp: '2026-01-01T00:00:00.000Z' },
  };
  // metadata entirely absent
  assert.doesNotThrow(() => stripSensitiveMetadata({ ...base } as unknown as Task));
  // openai-compat value is null
  assert.doesNotThrow(() =>
    stripSensitiveMetadata({ ...base, metadata: { [OAI]: null } } as unknown as Task),
  );
  // openai-compat value is an array
  assert.doesNotThrow(() =>
    stripSensitiveMetadata({ ...base, metadata: { [OAI]: [1, 2, 3] } } as unknown as Task),
  );
  // openai-compat value is a primitive
  assert.doesNotThrow(() =>
    stripSensitiveMetadata({ ...base, metadata: { [OAI]: 'x' } } as unknown as Task),
  );
});

// ── issue #419: opt-in retention of the request envelope ────────────────────
// Stripping is the default (post-#409, keeps the table lean). The
// persistRequestEnvelope store flag flips it into a forensics mode that keeps
// the full envelope on every persisted row; reads still strip on the hot replay
// path. `stripSensitiveMetadata`'s preserveEnvelope option is the write-side
// primitive the flag drives.

test('parsePersistRequestEnvelope: truthy spellings enable, everything else (incl. unset) stays off', () => {
  for (const on of ['1', 'true', 'TRUE', 'yes', 'Yes', 'on', 'ON']) {
    assert.equal(parsePersistRequestEnvelope(on), true, `${on} must enable`);
  }
  for (const off of [undefined, '', '0', 'false', 'off', 'no', 'nope', ' 1', '1 ', 'enabled']) {
    assert.equal(parsePersistRequestEnvelope(off), false, `${String(off)} must stay off (safe default)`);
  }
});

test('stripSensitiveMetadata with preserveEnvelope keeps the request envelope intact', () => {
  const task = taskWithRequestEnvelope();
  const original = (task.metadata as Record<string, Record<string, unknown>>)[OAI]
    .chat_completions_request;
  const persisted = stripSensitiveMetadata(task, { preserveEnvelope: true });
  const ext = (persisted.metadata as Record<string, Record<string, unknown>> | undefined)?.[OAI];
  assert.ok(ext, 'the openai-compat extension must survive');
  // Content equality, not just presence — a shallow-copy bug that dropped
  // messages[] would pass a presence-only check.
  assert.deepEqual(ext.chat_completions_request, original);
});

test('stripSensitiveMetadata with preserveEnvelope still scrubs bearer/principal from message metadata', () => {
  const task = {
    id: 't5',
    contextId: 'c5',
    status: {
      state: TaskState.FAILED,
      timestamp: '2026-01-01T00:00:00.000Z',
      message: {
        messageId: 'm',
        role: 'agent',
        parts: [{ kind: 'text', text: 'x' }],
        metadata: {
          _bearerToken: 'secret',
          _principalId: 'eth:0x1',
          _actorId: 'did:web:connector.example',
          _authorizationProfile: 'https://mentionable.dev/ns/oauth-federation/v0.1',
          _authorizationKey: 'federated:v1:private-policy-binding',
          _identityVcPresented: [{ profile: { displayName: 'private' } }],
          keep: 1,
        },
      },
    },
    metadata: { [OAI]: { chat_completions_request: { model: 'gpt-4', messages: [] } } },
  } as unknown as Task;
  const persisted = stripSensitiveMetadata(task, { preserveEnvelope: true });
  const ext = (persisted.metadata as Record<string, Record<string, unknown>>)[OAI];
  assert.ok(ext && 'chat_completions_request' in ext, 'envelope retained');
  const sm = (persisted.status.message as { metadata: Record<string, unknown> }).metadata;
  assert.equal(sm._bearerToken, undefined, 'bearer token scrubbed even with preserveEnvelope');
  assert.equal(sm._principalId, undefined, 'principal scrubbed even with preserveEnvelope');
  assert.equal(sm._actorId, undefined, 'federated actor handoff is never persisted in task JSON');
  assert.equal(sm._authorizationProfile, undefined, 'OAuth profile handoff is never persisted in task JSON');
  assert.equal(sm._authorizationKey, undefined, 'federated policy handoff is never persisted in task JSON');
  assert.equal(sm._identityVcPresented, undefined, 'normalized VC handoff is never persisted');
  assert.equal(sm.keep, 1, 'non-sensitive message metadata retained');
});

// ── updateTask concurrency (issue #366) ─────────────────────────────────────

test(
  'federated task identity is persisted in dedicated columns, not task JSON',
  { skip: !hasDb },
  async () => {
    const sql = postgres(process.env.DATABASE_URL!);
    const ownerAgent = `federated-owner-${crypto.randomUUID()}`;
    const store = new PostgresTaskStore(sql, { ownerAgent });
    const maintenanceStore = new PostgresTaskStore(sql);
    let taskId: string | undefined;
    try {
      await ensureSchema(sql);
      const task = await store.createTask({});
      taskId = task.id;
      const history = [{
        messageId: 'federated-message',
        role: 'user',
        parts: [{ kind: 'text', text: 'hello' }],
        metadata: {
          _principalId: 'slack:T123/U456',
          _actorId: 'did:web:connector.example',
          _authorizationProfile: 'https://mentionable.dev/ns/oauth-federation/v0.1',
          _authorizationKey: 'federated:v1:test-binding',
        },
      }] as unknown as Message[];
      await store.updateTask(task.id, { history });
      const rows = await sql<{
        owner_principal: string | null;
        owner_actor: string | null;
        authorization_profile: string | null;
        authorization_key: string | null;
        task_json: Record<string, unknown>;
      }[]>`
        SELECT owner_principal, owner_actor, authorization_profile, authorization_key, task_json
        FROM infra.a2a_tasks WHERE task_id = ${task.id}
      `;
      assert.equal(rows[0]?.owner_principal, 'slack:T123/U456');
      assert.equal(rows[0]?.owner_actor, 'did:web:connector.example');
      assert.equal(rows[0]?.authorization_profile, 'https://mentionable.dev/ns/oauth-federation/v0.1');
      assert.equal(rows[0]?.authorization_key, 'federated:v1:test-binding');
      const serialized = JSON.stringify(rows[0]?.task_json);
      assert.equal(serialized.includes('_principalId'), false);
      assert.equal(serialized.includes('_actorId'), false);
      assert.equal(serialized.includes('_authorizationProfile'), false);
      assert.equal(serialized.includes('_authorizationKey'), false);
    } finally {
      if (taskId) await maintenanceStore.deleteTask(taskId);
      await sql.end();
    }
  },
);

test(
  'owner-scoped stores cannot read, update, or delete another agent task',
  { skip: !hasDb },
  async () => {
    const sql = postgres(process.env.DATABASE_URL!);
    try {
      await ensureSchema(sql);
      const victimStore = new PostgresTaskStore(sql, { ownerAgent: 'scope-victim' });
      const attackerStore = new PostgresTaskStore(sql, { ownerAgent: 'scope-attacker' });
      const maintenanceStore = new PostgresTaskStore(sql);
      const task = await victimStore.createTask({});

      try {
        const rows = await sql<{ owner_agent: string | null }[]>`
          SELECT owner_agent FROM infra.a2a_tasks WHERE task_id = ${task.id}
        `;
        assert.equal(rows[0]?.owner_agent, 'scope-victim');
        assert.equal(await attackerStore.getTask(task.id), null);
        await assert.rejects(
          attackerStore.updateTask(task.id, {
            status: { state: TaskState.CANCELED, timestamp: new Date().toISOString() },
          }),
          /Task not found/,
        );

        await attackerStore.deleteTask(task.id);
        assert.ok(await victimStore.getTask(task.id), 'cross-agent delete must be a no-op');
      } finally {
        await maintenanceStore.deleteTask(task.id);
      }
    } finally {
      await sql.end();
    }
  },
);

test(
  'listTasks paginates and remains scoped to the owning agent',
  { skip: !hasDb },
  async () => {
    const sql = postgres(process.env.DATABASE_URL!);
    const suffix = crypto.randomUUID();
    const ownerA = `list-owner-a-${suffix}`;
    const ownerB = `list-owner-b-${suffix}`;
    const contextA = `list-context-a-${suffix}`;
    const maintenanceStore = new PostgresTaskStore(sql);
    const createdIds: string[] = [];
    try {
      await ensureSchema(sql);
      const storeA = new PostgresTaskStore(sql, { ownerAgent: ownerA });
      const storeB = new PostgresTaskStore(sql, { ownerAgent: ownerB });
      createdIds.push(
        (await storeA.createTask({ contextId: contextA })).id,
        (await storeA.createTask({ contextId: contextA })).id,
        (await storeB.createTask({ contextId: contextA })).id,
      );

      const firstPage = await storeA.listTasks({ pageSize: 1, contextId: contextA });
      assert.equal(firstPage.tasks.length, 1);
      assert.equal(firstPage.totalSize, 2);
      assert.equal(firstPage.pageSize, 1);
      assert.equal(firstPage.nextPageToken, '1');
      assert.equal(firstPage.tasks[0]!.artifacts, undefined);

      const secondPage = await storeA.listTasks({
        pageSize: 1,
        pageToken: firstPage.nextPageToken,
        contextId: contextA,
      });
      assert.equal(secondPage.tasks.length, 1);
      assert.equal(secondPage.totalSize, 2);
      assert.equal(secondPage.nextPageToken, '');
      assert.notEqual(secondPage.tasks[0]!.id, firstPage.tasks[0]!.id);

      const otherOwner = await storeB.listTasks({ contextId: contextA });
      assert.equal(otherOwner.tasks.length, 1);
      assert.equal(otherOwner.totalSize, 1);
      assert.equal(createdIds.includes(otherOwner.tasks[0]!.id), true);
    } finally {
      await Promise.all(createdIds.map((taskId) => maintenanceStore.deleteTask(taskId)));
      await sql.end();
    }
  },
);

test(
  'updateTask: concurrent updates touching different fields do not lose either write (issue #366)',
  { skip: !hasDb },
  async () => {
    const sql = postgres(process.env.DATABASE_URL!);
    try {
      await ensureSchema(sql);
      const store = new PostgresTaskStore(sql);

      // Repeat to give an unserialized read-modify-write ample chance to
      // interleave and clobber. With the FOR UPDATE row lock both writes
      // always survive, so this is deterministic under the fix. Detecting the
      // *bug* is probabilistic — it relies on the two Promise.all calls
      // actually interleaving on the connection pool; on a degenerate
      // single-connection setup that serialized them it could false-pass. In
      // practice (and as verified by running this against the pre-fix code,
      // which failed on iteration 1) the pool interleaves reliably.
      for (let i = 0; i < 25; i++) {
        const created = await store.createTask({});
        const taskId = created.id;

        // Mirror the real conflict: executeStream's terminal save writes
        // history (+status), message/cancel's save writes only status.
        // Here we split them so each call sets a field the other leaves
        // untouched — a lost update would drop one of them.
        const history = [msg(`h-${i}`, 'streamed message')];
        const canceledStatus = {
          state: TaskState.CANCELED,
          timestamp: new Date().toISOString(),
        };

        await Promise.all([
          store.updateTask(taskId, { history }),
          store.updateTask(taskId, { status: canceledStatus }),
        ]);

        const final = await store.getTask(taskId);
        assert.ok(final, `task ${taskId} must exist after concurrent updates`);
        // history written by call A must survive call B's status-only write
        assert.equal(
          final.history?.length,
          1,
          `iteration ${i}: history was lost (overwritten by the status-only update)`,
        );
        assert.equal(final.history?.[0]?.messageId, `h-${i}`);
        // status written by call B must survive call A's history-only write
        assert.equal(
          final.status.state,
          TaskState.CANCELED,
          `iteration ${i}: status was lost (overwritten by the history-only update)`,
        );

        await store.deleteTask(taskId);
      }
    } finally {
      await sql.end();
    }
  },
);

test(
  'updateTask: retention still trims a context to MAX_CONTEXT_TASKS terminal tasks after moving it post-commit',
  { skip: !hasDb },
  async () => {
    // Guards the refactor that pulled the count-based retention DELETE out of
    // the FOR UPDATE transaction: terminal-task GC must still cap a context at 10.
    const sql = postgres(process.env.DATABASE_URL!);
    const principalId = `eth:0xretention-${Date.now()}`;
    const contextId = `ctx-retention-${Date.now()}`;
    try {
      await ensureSchema(sql);
      const store = new PostgresTaskStore(sql);

      // 15 owned tasks in one context, each driven to a terminal state.
      for (let i = 0; i < 15; i++) {
        const created = await store.createTask({ contextId });
        await store.updateTask(created.id, { status: ownedTerminalStatus(principalId, `m-${i}`) });
      }

      const remaining = await store.loadByContextId(contextId, principalId);
      assert.equal(remaining.length, 10, 'context must be trimmed to MAX_CONTEXT_TASKS (10)');
    } finally {
      await sql`DELETE FROM infra.a2a_tasks WHERE context_id = ${contextId}`;
      await sql.end();
    }
  },
);

test(
  'updateTask: concurrent terminal updates in the same context do not deadlock and both persist (issue #366 retention)',
  { skip: !hasDb },
  async () => {
    // With retention inside the FOR UPDATE transaction, two same-context
    // tasks going terminal at once could lock each other's rows (one holds
    // its own row, the other's retention DELETE wants it) → deadlock, and the
    // aborted txn loses its state write. Post-commit retention confines the
    // lock to the single updated row, so this must always succeed.
    const sql = postgres(process.env.DATABASE_URL!);
    const principalId = `eth:0xdeadlock-${Date.now()}`;
    const contextId = `ctx-deadlock-${Date.now()}`;
    try {
      await ensureSchema(sql);
      const store = new PostgresTaskStore(sql);

      // Seed MAX_CONTEXT_TASKS terminal tasks so the context already sits at
      // the retention cap before each round.
      for (let i = 0; i < 10; i++) {
        const seedTask = await store.createTask({ contextId });
        await store.updateTask(seedTask.id, { status: ownedTerminalStatus(principalId, `seed-${i}`) });
      }

      // Each round introduces TWO fresh tasks and terminalizes them
      // concurrently. With the context already at the cap, both rounds'
      // retention DELETEs fire every time (the two new terminal rows push the
      // count over MAX_CONTEXT_TASKS) — so the lock window that the in-txn
      // version deadlocked on is exercised on every round, not just the first.
      for (let round = 0; round < 20; round++) {
        const a = await store.createTask({ contextId });
        const b = await store.createTask({ contextId });
        const results = await Promise.allSettled([
          store.updateTask(a.id, { status: ownedTerminalStatus(principalId, `a-${round}`) }),
          store.updateTask(b.id, { status: ownedTerminalStatus(principalId, `b-${round}`) }),
        ]);
        for (const r of results) {
          assert.equal(
            r.status,
            'fulfilled',
            `round ${round}: updateTask must not throw/deadlock — ${
              r.status === 'rejected' ? String(r.reason) : ''
            }`,
          );
        }
      }
    } finally {
      await sql`DELETE FROM infra.a2a_tasks WHERE context_id = ${contextId}`;
      await sql.end();
    }
  },
);

// ── request-envelope retention end-to-end (issue #419) ──────────────────────

test(
  'default store strips the request envelope from persisted rows',
  { skip: !hasDb },
  async () => {
    const sql = postgres(process.env.DATABASE_URL!);
    const contextId = `ctx-envelope-off-${Date.now()}`;
    const principalId = `eth:0xenvelope-off-${Date.now()}`;
    try {
      await ensureSchema(sql);
      const store = new PostgresTaskStore(sql); // persistRequestEnvelope defaults to false

      const envelope = { model: 'gpt-4', messages: [{ role: 'user', content: 'x'.repeat(2000) }] };
      const metadata = { [OAI]: { chat_completions_request: envelope } };

      const task = await store.createTask({ contextId, metadata });
      await store.updateTask(task.id, { status: ownedTerminalStatus(principalId, 'done') });

      const stored = await store.getTask(task.id);
      assert.equal(
        (stored?.metadata as Record<string, unknown> | undefined)?.[OAI],
        undefined,
        'default store must strip the request envelope even for getTask',
      );
    } finally {
      await sql`DELETE FROM infra.a2a_tasks WHERE context_id = ${contextId}`;
      await sql.end();
    }
  },
);

test(
  'persistRequestEnvelope store retains the envelope for getTask/SQL but still strips it from replay (issue #419)',
  { skip: !hasDb },
  async () => {
    const sql = postgres(process.env.DATABASE_URL!);
    const contextId = `ctx-envelope-on-${Date.now()}`;
    const principalId = `eth:0xenvelope-on-${Date.now()}`;
    try {
      await ensureSchema(sql);
      const store = new PostgresTaskStore(sql, { persistRequestEnvelope: true });

      const envelope = {
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'boom'.repeat(500) }],
      };
      const metadata = { [OAI]: { chat_completions_request: envelope } };

      // createTask persists SUBMITTED with the envelope; the terminal update
      // merges onto that row. The envelope must survive into the stored row even
      // though the update itself carries only status (the merge reads the raw
      // row, so the carrier envelope is preserved regardless of terminal state).
      const task = await store.createTask({ contextId, metadata });
      await store.updateTask(task.id, { status: ownedTerminalStatus(principalId, 'done') });

      // Forensic read (getTask): full envelope retained.
      const stored = await store.getTask(task.id);
      const ext = (stored?.metadata as Record<string, Record<string, unknown>> | undefined)?.[OAI];
      assert.ok(ext?.chat_completions_request, 'getTask must retain the request envelope when on');
      assert.deepEqual(ext.chat_completions_request, envelope);

      // Hot replay (loadByContextId): envelope stripped regardless of the flag.
      const replay = await store.loadByContextId(contextId, principalId);
      assert.ok(replay.length >= 1, 'the owned task is replayed');
      for (const t of replay) {
        const rext = (t.metadata as Record<string, Record<string, unknown>> | undefined)?.[OAI];
        assert.equal(
          rext?.chat_completions_request,
          undefined,
          'loadByContextId must strip the envelope even when persistRequestEnvelope is on',
        );
      }
    } finally {
      await sql`DELETE FROM infra.a2a_tasks WHERE context_id = ${contextId}`;
      await sql.end();
    }
  },
);

test(
  'persistRequestEnvelope retains the envelope on a FAILED terminal row (the named forensics case, #419)',
  { skip: !hasDb },
  async () => {
    // The feature exists for failures — drive a task all the way to FAILED with
    // the flag on and confirm getTask still hands back its full input.
    const sql = postgres(process.env.DATABASE_URL!);
    const contextId = `ctx-envelope-fail-${Date.now()}`;
    const principalId = `eth:0xenvelope-fail-${Date.now()}`;
    try {
      await ensureSchema(sql);
      const store = new PostgresTaskStore(sql, { persistRequestEnvelope: true });

      const envelope = { model: 'gpt-4', messages: [{ role: 'user', content: 'kaboom'.repeat(400) }] };
      const task = await store.createTask({
        contextId,
        metadata: { [OAI]: { chat_completions_request: envelope } },
      });
      await store.updateTask(task.id, {
        status: ownedTerminalStatus(principalId, 'boom', TaskState.FAILED),
      });

      const failed = await store.getTask(task.id);
      assert.equal(failed?.status.state, TaskState.FAILED, 'task reached FAILED');
      const ext = (failed?.metadata as Record<string, Record<string, unknown>> | undefined)?.[OAI];
      assert.deepEqual(ext?.chat_completions_request, envelope, 'failed row retains its full input');
    } finally {
      await sql`DELETE FROM infra.a2a_tasks WHERE context_id = ${contextId}`;
      await sql.end();
    }
  },
);

test(
  'persistRequestEnvelope keeps each row\'s own envelope across a multi-turn context (no cross-contamination)',
  { skip: !hasDb },
  async () => {
    const sql = postgres(process.env.DATABASE_URL!);
    const contextId = `ctx-envelope-multi-${Date.now()}`;
    const principalId = `eth:0xenvelope-multi-${Date.now()}`;
    try {
      await ensureSchema(sql);
      const store = new PostgresTaskStore(sql, { persistRequestEnvelope: true });

      // Three turns in one context, each with a distinct envelope.
      const ids: string[] = [];
      const envelopes: Record<string, unknown>[] = [];
      for (let i = 0; i < 3; i++) {
        const envelope = { model: 'gpt-4', messages: [{ role: 'user', content: `turn-${i}` }] };
        envelopes.push(envelope);
        const t = await store.createTask({
          contextId,
          metadata: { [OAI]: { chat_completions_request: envelope } },
        });
        await store.updateTask(t.id, { status: ownedTerminalStatus(principalId, `m-${i}`) });
        ids.push(t.id);
      }

      // Each stored row must carry ITS OWN envelope, not a neighbour's.
      for (let i = 0; i < ids.length; i++) {
        const stored = await store.getTask(ids[i]!);
        const ext = (stored?.metadata as Record<string, Record<string, unknown>> | undefined)?.[OAI];
        assert.deepEqual(ext?.chat_completions_request, envelopes[i], `row ${i} keeps its own envelope`);
      }

      // Replay of the whole context stays lean regardless.
      const replay = await store.loadByContextId(contextId, principalId);
      assert.equal(replay.length, 3, 'all three turns replayed');
      for (const t of replay) {
        const ext = (t.metadata as Record<string, Record<string, unknown>> | undefined)?.[OAI];
        assert.equal(ext?.chat_completions_request, undefined, 'replay strips every row');
      }
    } finally {
      await sql`DELETE FROM infra.a2a_tasks WHERE context_id = ${contextId}`;
      await sql.end();
    }
  },
);

// ── pruneStaleContexts time-based retention (issue #385) ────────────────────

test(
  'pruneStaleContexts reclaims idle contexts but spares active ones (incl. their old turns)',
  { skip: !hasDb },
  async () => {
    const sql = postgres(process.env.DATABASE_URL!);
    await ensureSchema(sql);
    const store = new PostgresTaskStore(sql);
    const tag = `prune-${Date.now()}`;

    try {
      // Context A: fully idle (single old terminal task) -> should be deleted.
      await seed(sql, { taskId: `${tag}-a1`, contextId: `${tag}-ctxA`, state: 'completed', age: '40 days' });

      // Context B: active — one OLD turn + one RECENT turn. The whole context
      // (including the old turn) must survive because it's still in use.
      await seed(sql, { taskId: `${tag}-b1`, contextId: `${tag}-ctxB`, state: 'completed', age: '40 days' });
      await seed(sql, { taskId: `${tag}-b2`, contextId: `${tag}-ctxB`, state: 'completed', age: '1 hour' });

      const deleted = await store.pruneStaleContexts(30);
      assert.equal(deleted, 1, 'exactly the one idle context A row is deleted');

      const surviving = await sql<{ task_id: string }[]>`
        SELECT task_id FROM infra.a2a_tasks WHERE task_id LIKE ${tag + '-%'} ORDER BY task_id
      `;
      assert.deepEqual(
        surviving.map((r) => r.task_id),
        [`${tag}-b1`, `${tag}-b2`],
        'idle context A gone; active context B fully retained (old turn included)',
      );
    } finally {
      await sql`DELETE FROM infra.a2a_tasks WHERE task_id LIKE ${tag + '-%'}`;
      await sql.end();
    }
  },
);

test(
  'pruneStaleContexts spares an idle context that still holds an in-flight task',
  { skip: !hasDb },
  async () => {
    const sql = postgres(process.env.DATABASE_URL!);
    await ensureSchema(sql);
    const store = new PostgresTaskStore(sql);
    const tag = `prune-inflight-${Date.now()}`;
    try {
      // Old, but non-terminal (working): a legitimately long-running task whose
      // updated_at is frozen at creation. Must NOT be reaped out from under the
      // live executor even though the context looks idle by timestamp.
      await seed(sql, { taskId: `${tag}-1`, contextId: `${tag}-ctx`, state: 'working', age: '40 days' });
      const deleted = await store.pruneStaleContexts(30);
      assert.equal(deleted, 0, 'context with an in-flight task is spared');
      const after = await sql<{ c: number }[]>`
        SELECT count(*)::int c FROM infra.a2a_tasks WHERE task_id = ${tag + '-1'}
      `;
      assert.equal(after[0]!.c, 1);
    } finally {
      await sql`DELETE FROM infra.a2a_tasks WHERE task_id LIKE ${tag + '-%'}`;
      await sql.end();
    }
  },
);

test(
  'pruneStaleContexts leaves a fresh context untouched',
  { skip: !hasDb },
  async () => {
    const sql = postgres(process.env.DATABASE_URL!);
    await ensureSchema(sql);
    const store = new PostgresTaskStore(sql);
    const tag = `prune-fresh-${Date.now()}`;
    try {
      await seed(sql, { taskId: `${tag}-1`, contextId: `${tag}-ctx`, state: 'completed', age: '0 seconds' });
      await store.pruneStaleContexts(30);
      const after = await sql<{ c: number }[]>`
        SELECT count(*)::int c FROM infra.a2a_tasks WHERE task_id = ${tag + '-1'}
      `;
      assert.equal(after[0]!.c, 1, 'fresh context survives');
    } finally {
      await sql`DELETE FROM infra.a2a_tasks WHERE task_id LIKE ${tag + '-%'}`;
      await sql.end();
    }
  },
);

// ── updateTask timing instrumentation (issue #414) ──────────────────────────

// logEvent() writes one JSON object per line to console.log. Capture those
// lines while `fn` runs and return the parsed events plus any thrown error, so
// a test can assert on both the emitted telemetry and the rethrow.
async function captureLogEvents(
  fn: () => Promise<void>,
): Promise<{ events: Array<Record<string, unknown>>; error: unknown }> {
  const events: Array<Record<string, unknown>> = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    const line = args[0];
    if (typeof line !== 'string') return;
    try {
      const obj = JSON.parse(line) as Record<string, unknown>;
      if (obj && typeof obj === 'object' && 'event' in obj) events.push(obj);
    } catch {
      // non-JSON console output — ignore
    }
  };
  let error: unknown;
  try {
    await fn();
  } catch (err) {
    error = err;
  } finally {
    console.log = original;
  }
  return { events, error };
}

test(
  'updateTask logs task_store_slow_update with per-phase timing when it crosses the threshold (issue #414)',
  { skip: !hasDb },
  async () => {
    const sql = postgres(process.env.DATABASE_URL!);
    const prev = process.env.VICOOP_TASKSTORE_SLOW_MS;
    try {
      await ensureSchema(sql);
      const store = new PostgresTaskStore(sql);
      const created = await store.createTask({});
      const status = { state: TaskState.WORKING, timestamp: new Date().toISOString() };

      // Threshold 0 → every write counts as "slow", so a normal beat is logged.
      process.env.VICOOP_TASKSTORE_SLOW_MS = '0';
      const { events, error } = await captureLogEvents(async () => {
        await store.updateTask(created.id, { status });
      });
      assert.equal(error, undefined, 'updateTask must succeed');
      const slow = events.filter((e) => e.event === 'task_store_slow_update');
      assert.equal(slow.length, 1, 'exactly one slow-update event per updateTask');
      const e = slow[0]!;
      assert.equal(e.taskId, created.id);
      assert.equal(e.state, TaskState.WORKING);
      assert.equal(typeof e.totalMs, 'number');
      assert.equal(typeof e.txnMs, 'number');
      // A non-terminal (working) write is heartbeat-shaped: enforceRetention is
      // a no-op that returns before any awaited work, so its phase time is ~0
      // — the beat's cost is the txn alone. (<=1 rather than ===0 to tolerate a
      // scheduling hiccup crossing a millisecond boundary between the samples.)
      assert.ok((e.retentionMs as number) <= 1, `retentionMs should be ~0, got ${e.retentionMs}`);

      // A high threshold suppresses the log for the same fast write.
      process.env.VICOOP_TASKSTORE_SLOW_MS = '600000';
      const quiet = await captureLogEvents(async () => {
        await store.updateTask(created.id, { status });
      });
      assert.equal(
        quiet.events.filter((ev) => ev.event === 'task_store_slow_update').length,
        0,
        'no slow-update event below the threshold',
      );

      await store.deleteTask(created.id);
    } finally {
      if (prev === undefined) delete process.env.VICOOP_TASKSTORE_SLOW_MS;
      else process.env.VICOOP_TASKSTORE_SLOW_MS = prev;
      await sql.end();
    }
  },
);

test(
  'updateTask logs task_store_update_error and rethrows when the write fails (issue #414)',
  { skip: !hasDb },
  async () => {
    const sql = postgres(process.env.DATABASE_URL!);
    try {
      await ensureSchema(sql);
      const store = new PostgresTaskStore(sql);
      const missingId = `missing-${Date.now()}`;
      const status = { state: TaskState.WORKING, timestamp: new Date().toISOString() };

      const { events, error } = await captureLogEvents(async () => {
        // No row exists → the FOR UPDATE read throws "Task not found".
        await store.updateTask(missingId, { status });
      });

      assert.ok(error, 'updateTask must rethrow the underlying failure');
      assert.match(String(error), /Task not found/);
      const errs = events.filter((ev) => ev.event === 'task_store_update_error');
      assert.equal(errs.length, 1, 'the failure is logged once');
      assert.equal(errs[0]!.taskId, missingId);
      assert.equal(errs[0]!.state, TaskState.WORKING);
      assert.equal(typeof errs[0]!.totalMs, 'number');
    } finally {
      await sql.end();
    }
  },
);
