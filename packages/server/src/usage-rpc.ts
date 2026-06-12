import { randomUUID } from 'node:crypto';
import type { UsageResponseFrame } from '@vicoop-bridge/protocol';
import type { Registry } from './registry.js';

// Minimal request/response RPC layered over the otherwise task-streaming WS
// protocol: the server sends a `usage.request` DownFrame to a connected client
// and awaits the matching `usage.response` UpFrame (correlated by requestId).
// The pending map is module-level so the HTTP route (requestUsage) and the WS
// message handler (resolveUsageResponse) share it.

interface Pending {
  // The agent the request was sent to — only that agent may resolve it.
  agentId: string;
  resolve: (usage: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const pending = new Map<string, Pending>();

export class UsageRpcError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'UsageRpcError';
    this.code = code;
  }
}

/**
 * Ask a connected agent for its backend usage snapshot. Resolves with the
 * opaque payload the client returns, or rejects with a {@link UsageRpcError}
 * (`offline` if not connected, `timeout`, or the client-reported error code).
 */
export function requestUsage(
  registry: Registry,
  agentId: string,
  timeoutMs = 10_000,
): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
    const requestId = randomUUID();
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(new UsageRpcError('timeout', `usage request timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    pending.set(requestId, { agentId, resolve, reject, timer });
    const sent = registry.sendToAgent(agentId, { type: 'usage.request', requestId });
    if (!sent) {
      clearTimeout(timer);
      pending.delete(requestId);
      reject(new UsageRpcError('offline', 'agent is not connected'));
    }
  });
}

/**
 * Settle the pending request for `frame.requestId`. `respondingAgentId` is the
 * authenticated agent that sent the response; it must match the agent the
 * request was issued to (defense against a client resolving another agent's
 * request). Unknown/expired/mismatched ids are ignored.
 */
export function resolveUsageResponse(
  respondingAgentId: string,
  frame: UsageResponseFrame,
): void {
  const p = pending.get(frame.requestId);
  if (!p || p.agentId !== respondingAgentId) return;
  clearTimeout(p.timer);
  pending.delete(frame.requestId);
  if (frame.ok) {
    p.resolve(frame.usage);
  } else {
    p.reject(
      new UsageRpcError(
        frame.error?.code ?? 'usage_failed',
        frame.error?.message ?? 'usage query failed on the client',
      ),
    );
  }
}
