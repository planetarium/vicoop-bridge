import assert from 'node:assert/strict';
import test from 'node:test';
import { submitSync } from './argocd-sync.mjs';

const revision = 'a'.repeat(40);
const job = {
  operation: 'argocd-sync', version: '1', state: 'executing',
  expiresAt: '2099-01-01T00:00:00Z', arguments: { application: 'ops', namespace: 'argocd', project: 'apps', revision },
};
const env = {
  ARGOCD_APPLICATION: 'ops', ARGOCD_NAMESPACE: 'argocd', ARGOCD_PROJECT: 'apps',
  ARGOCD_URL: 'https://argocd.example', ARGOCD_TOKEN: 'fixture', ARGOCD_REPOSITORY: 'https://git.example/ops',
};
const app = { metadata: { name: 'ops', namespace: 'argocd' }, spec: { project: 'apps', source: { repoURL: env.ARGOCD_REPOSITORY } } };

test('submits one project-scoped, revision-pinned sync and reports acceptance', async () => {
  const requests = [];
  const result = await submitSync(job, env, async (url, options) => {
    requests.push([url, options]);
    return Response.json(options.method ? { operation: { sync: { revision } } } : app);
  });
  assert.equal(result.state, 'succeeded');
  assert.equal(requests.length, 2);
  assert.equal(requests[0][0].searchParams.get('project'), 'apps');
  assert.equal(requests[1][0].href, 'https://argocd.example/api/v1/applications/ops/sync');
  assert.equal(requests[1][1].redirect, 'error');
  assert.deepEqual(JSON.parse(requests[1][1].body), { name: 'ops', appNamespace: 'argocd', project: 'apps', revision, prune: false });
});

test('rejects stale requests, mutable revision names, and a different application', async () => {
  let calls = 0;
  for (const invalid of [{ expiresAt: 'invalid' }, { expiresAt: '2001-01-01' },
    { arguments: { ...job.arguments, revision: 'main' } }, { arguments: { ...job.arguments, application: 'other' } }]) {
    assert.equal((await submitSync({ ...job, ...invalid }, env, () => { calls++; })).state, 'failed');
  }
  assert.equal(calls, 0);
});

test('refuses multi-source and busy applications before submitting', async () => {
  for (const value of [{ ...app, spec: { ...app.spec, sources: [{}] } }, { ...app, operation: { sync: {} } }]) {
    let calls = 0;
    assert.equal((await submitSync(job, env, async () => { calls++; return Response.json(value); })).state, 'failed');
    assert.equal(calls, 1);
  }
});

test('an ambiguous sync response requires reconciliation without repeating the POST', async () => {
  let posts = 0;
  const result = await submitSync(job, env, async (_url, options) => {
    if (!options.method) return Response.json(app);
    posts++;
    throw new Error('disconnected');
  });
  assert.equal(result.state, 'unknown');
  assert.equal(posts, 1);
});
