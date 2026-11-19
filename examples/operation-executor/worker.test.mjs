import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergePull } from './github-merge.mjs';
import { fileURLToPath } from 'node:url';
import { runOnce } from './worker.mjs';

const handler = fileURLToPath(new URL('./github-merge.mjs', import.meta.url));
const env = {
  BRIDGE_URL: 'https://bridge.test',
  AGENT_ID: 'my-agent',
  OPERATION: 'merge-pr',
  OPERATION_VERSION: '1',
  EXECUTOR_TOKEN: 'fixture-only',
  OPERATION_HANDLER: handler,
};
const job = {
  id: '1',
  operation: 'merge-pr',
  version: '1',
  state: 'executing',
  expiresAt: new Date(Date.now() + 120000).toISOString(),
  arguments: { repository: 'org/repo', pull: 7, base: 'main', head: 'a'.repeat(40) },
};
const ok = (data) => new Response(JSON.stringify(data), { status: 200 });

test('worker gives the host handler one immutable claim and reports only its explicit result', async () => {
  const calls = [];
  await runOnce(
    env,
    async (url, init) => {
      assert.equal(init.redirect, 'error');
      assert.equal(init.headers.Authorization, 'Bearer fixture-only');
      calls.push([url.pathname, init.body]);
      return ok({ operation: job });
    },
    async (path, input, handlerEnv) => {
      assert.equal(path, handler);
      assert.deepEqual(input, job);
      assert.equal(handlerEnv.EXECUTOR_TOKEN, undefined);
      return { state: 'succeeded', result: 'Fixture merge acknowledged.' };
    },
  );
  assert.deepEqual(calls, [
    ['/operation-executors/my-agent/merge-pr/claim', undefined],
    [
      '/operation-executors/my-agent/merge-pr/1/result',
      JSON.stringify({ state: 'succeeded', result: 'Fixture merge acknowledged.' }),
    ],
  ]);
});
test('empty, expired or different version cannot execute; a lost result does not repeat a side effect', async () => {
  for (const item of [
    null,
    { ...job, version: '2' },
    { ...job, expiresAt: '1970-01-01T00:00:00Z' },
  ]) {
    await runOnce(
      env,
      async () => ok({ operation: item }),
      () => assert.fail('must not execute'),
    );
  }
  let attempts = 0;
  await assert.rejects(
    runOnce(
      env,
      async (url) => {
        if (url.pathname.endsWith('/claim')) return ok({ operation: job });
        throw Error('connection lost');
      },
      async () => {
        attempts++;
        return { state: 'succeeded', result: 'done' };
      },
    ),
    /connection lost/,
  );
  assert.equal(attempts, 1);
});
test('GitHub handler checks the approved base repository, branch and head before merging', async () => {
  const github = {
    GITHUB_REPOSITORY: 'org/repo',
    GITHUB_BASE_BRANCH: 'main',
    GITHUB_TOKEN: 'fixture',
  };
  const expected = {
    number: 7,
    state: 'open',
    base: { repo: { full_name: 'org/repo' }, ref: 'main' },
    head: { sha: job.arguments.head },
  };
  for (const pr of [
    { ...expected, base: { ...expected.base, ref: 'staging' } },
    { ...expected, base: { ...expected.base, repo: { full_name: 'old/repo' } } },
    { ...expected, head: { sha: 'b'.repeat(40) } },
    { ...expected, state: 'closed' },
  ]) {
    const calls = [];
    assert.equal(
      (
        await mergePull(job, github, async (url, init) => {
          calls.push([url, init.method ?? 'GET']);
          return ok(pr);
        })
      ).state,
      'failed',
    );
    assert.deepEqual(calls, [['https://api.github.com/repos/org/repo/pulls/7', 'GET']]);
  }
  for (const [code, state] of [
    [200, 'succeeded'],
    [409, 'failed'],
    [500, 'unknown'],
    [0, 'unknown'],
  ]) {
    const calls = [];
    const actual = await mergePull(job, github, async (url, init) => {
      calls.push([url, init.method ?? 'GET', init.body]);
      if (!init.method) return ok(expected);
      if (!code) throw Error('timeout');
      return new Response(JSON.stringify({ merged: true }), { status: code });
    });
    assert.equal(actual.state, state);
    assert.deepEqual(calls, [
      ['https://api.github.com/repos/org/repo/pulls/7', 'GET', undefined],
      [
        'https://api.github.com/repos/org/repo/pulls/7/merge',
        'PUT',
        JSON.stringify({ sha: job.arguments.head, merge_method: 'merge' }),
      ],
    ]);
  }
});
