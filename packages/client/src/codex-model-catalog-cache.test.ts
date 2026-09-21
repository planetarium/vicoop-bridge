import test from 'node:test';
import assert from 'node:assert/strict';
import { createCodexModelCatalogCache } from './codex-model-catalog-cache.js';
import type { CodexCredential } from './codex-auth-broker.js';
const signal = () => new AbortController().signal;
const response = () => Response.json({ models: [{ slug: 'gpt-test' }] });

test('catalog coalesces concurrent scopes and invalidates on credential/version changes', async () => {
  let calls = 0;
  let auth: CodexCredential = { kind: 'oauth', accountId: 'account', secret: 'first' };
  const cache = createCodexModelCatalogCache(() => auth, async () => { calls++; return response(); });
  const values = await Promise.all(Array.from({ length: 32 }, () => cache('0.153.4', signal())));
  assert.equal(calls, 1);
  assert.ok(values.every(v => v === values[0]));
  await cache('0.153.4', signal());
  assert.equal(calls, 1);
  auth = { ...auth, secret: 'rotated' };
  await cache('0.153.4', signal());
  assert.equal(calls, 2);
  await cache('0.153.5', signal());
  assert.equal(calls, 3);
  auth = { kind: 'api-key', secret: 'api' };
  assert.equal(await cache('0.153.5', signal()), undefined);
  assert.equal(calls, 3);
});

test('failed catalog fetches retry and cached results still validate credentials', async () => {
  let calls = 0, valid = true;
  const cache = createCodexModelCatalogCache(() => {
    if (!valid) throw new Error('expired');
    return { kind: 'oauth', accountId: 'account', secret: 'secret' };
  }, async () => { if (++calls === 1) throw new Error('upstream'); return response(); });
  await assert.rejects(cache('0.153.4', signal()), /upstream/);
  await cache('0.153.4', signal());
  assert.equal(calls, 2);
  valid = false;
  await assert.rejects(cache('0.153.4', signal()), /expired/);
});

test('one canceled waiter leaves the shared request alive; last cancellation aborts and permits retry', async () => {
  let calls = 0;
  let resolve!: (value: Response) => void;
  let upstream!: AbortSignal;
  const cache = createCodexModelCatalogCache(() => ({ kind: 'oauth', secret: 'secret', accountId: 'account' }), async (_url, opts) => {
    calls++;
    upstream = opts!.signal!;
    return new Promise<Response>((ok, reject) => {
      resolve = ok;
      upstream.addEventListener('abort', () => reject(upstream.reason), { once: true });
    });
  });
  const a = new AbortController(), b = new AbortController();
  const first = cache('0.153.4', a.signal), second = cache('0.153.4', b.signal);
  await new Promise<void>(r => setImmediate(r));
  const rejected = assert.rejects(first);
  a.abort();
  await rejected;
  assert.equal(upstream.aborted, false);
  resolve(response());
  assert.ok(await second);
  assert.equal(calls, 1);
  const c = new AbortController();
  const third = cache('0.153.5', c.signal);
  await new Promise<void>(r => setImmediate(r));
  const lastRejected = assert.rejects(third);
  c.abort();
  await lastRejected;
  assert.equal(upstream.aborted, true);
  const retried = cache('0.153.5', signal());
  await new Promise<void>(r => setImmediate(r));
  resolve(response());
  assert.ok(await retried);
  assert.equal(calls, 3);
});
