import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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
  arguments: { repository: 'org/repo', pull: 7, head: 'a'.repeat(40) },
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
test('GitHub handler pins host repository, PR and expected SHA and reconciles ambiguous outcomes', () => {
  const prelude = `const fs=require('node:fs'); globalThis.fetch=async(url,init)=>{
    require('node:assert/strict').equal(url,'https://api.github.com/repos/org/repo/pulls/7/merge');
    require('node:assert/strict').equal(JSON.parse(init.body).sha,'a'.repeat(40));
    require('node:assert/strict').equal(init.method,'PUT');
    const code=Number(process.env.FIXTURE_CODE); if(code===0)throw Error('timeout');
    return new Response(JSON.stringify({merged:true}),{status:code});
  };`;
  for (const [code, expected] of [
    [200, 'succeeded'],
    [409, 'failed'],
    [500, 'unknown'],
    [0, 'unknown'],
  ]) {
    // Install the fake upstream before running the actual executable body.
    const source =
      prelude +
      'import(' +
      JSON.stringify(new URL('./github-merge.mjs', import.meta.url).href) +
      ')';
    const processResult = spawnSync(process.execPath, ['-e', source], {
      input: JSON.stringify(job),
      encoding: 'utf8',
      env: {
        GITHUB_TOKEN: 'fixture-only',
        GITHUB_REPOSITORY: 'org/repo',
        FIXTURE_CODE: String(code),
      },
    });
    assert.equal(processResult.status, 0, processResult.stderr);
    assert.equal(JSON.parse(processResult.stdout).state, expected);
  }
});
