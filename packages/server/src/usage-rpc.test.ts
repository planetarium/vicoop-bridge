import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DownFrame, UsageResponseFrame } from '@vicoop-bridge/protocol';
import type { Registry } from './registry.js';
import { requestUsage, resolveUsageResponse, UsageRpcError } from './usage-rpc.js';

// Minimal fake registry: records the down-frame sent and decides whether the
// agent is "connected" (sendToAgent returns false when not).
function fakeRegistry(opts: { connected: boolean; capture?: (f: DownFrame) => void }): Registry {
  return {
    sendToAgent(_agentId: string, frame: DownFrame): boolean {
      opts.capture?.(frame);
      return opts.connected;
    },
  } as unknown as Registry;
}

function lastRequestId(captured: DownFrame[]): string {
  const f = captured[captured.length - 1];
  if (!f || f.type !== 'usage.request') throw new Error('no usage.request captured');
  return f.requestId;
}

test('requestUsage rejects "offline" when the agent is not connected', async () => {
  const reg = fakeRegistry({ connected: false });
  await assert.rejects(
    requestUsage(reg, 'a1', 1000),
    (e: unknown) => e instanceof UsageRpcError && e.code === 'offline',
  );
});

test('requestUsage resolves with the payload from a matching usage.response', async () => {
  const captured: DownFrame[] = [];
  const reg = fakeRegistry({ connected: true, capture: (f) => captured.push(f) });
  const p = requestUsage(reg, 'a1', 1000);
  const resp: UsageResponseFrame = {
    type: 'usage.response',
    requestId: lastRequestId(captured),
    ok: true,
    usage: { accounts: [{ key: 'k1' }] },
  };
  resolveUsageResponse('a1', resp);
  assert.deepEqual(await p, { accounts: [{ key: 'k1' }] });
});

test('requestUsage rejects with the client-reported error code/message', async () => {
  const captured: DownFrame[] = [];
  const reg = fakeRegistry({ connected: true, capture: (f) => captured.push(f) });
  const p = requestUsage(reg, 'a1', 1000);
  resolveUsageResponse('a1', {
    type: 'usage.response',
    requestId: lastRequestId(captured),
    ok: false,
    error: { code: 'usage_failed', message: 'boom' },
  });
  await assert.rejects(
    p,
    (e: unknown) =>
      e instanceof UsageRpcError && e.code === 'usage_failed' && /boom/.test((e as Error).message),
  );
});

test('a response from a DIFFERENT agent does not resolve the request (id-binding guard)', async () => {
  const captured: DownFrame[] = [];
  const reg = fakeRegistry({ connected: true, capture: (f) => captured.push(f) });
  const p = requestUsage(reg, 'a1', 120);
  // An attacker-controlled client replies with the (unguessable in practice)
  // requestId but a different responding agentId — must be ignored.
  resolveUsageResponse('attacker', {
    type: 'usage.response',
    requestId: lastRequestId(captured),
    ok: true,
    usage: { spoof: true },
  });
  await assert.rejects(p, (e: unknown) => e instanceof UsageRpcError && e.code === 'timeout');
});

test('requestUsage rejects "timeout" when no response arrives', async () => {
  const reg = fakeRegistry({ connected: true });
  await assert.rejects(
    requestUsage(reg, 'a1', 50),
    (e: unknown) => e instanceof UsageRpcError && e.code === 'timeout',
  );
});

test('a stale/unknown requestId is ignored (no throw)', () => {
  // resolveUsageResponse for an id with no pending entry must be a safe no-op.
  assert.doesNotThrow(() =>
    resolveUsageResponse('a1', { type: 'usage.response', requestId: 'nope', ok: true, usage: {} }),
  );
});
