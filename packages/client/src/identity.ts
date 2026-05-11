// Mirrors server/src/mentionable.ts:LOCAL_RE. Kept locally instead of imported
// from @vicoop-bridge/protocol to avoid pulling server internals into the
// client bundle; the regex is small and the validation rule is part of the
// public mention surface.
const LOCAL_RE = /^[A-Za-z0-9._-]{1,64}$/;

export function isValidMentionableLocal(local: string): boolean {
  if (local === '.' || local === '..') return false;
  return LOCAL_RE.test(local);
}

export interface AgentIdentity {
  agentId: string;
  host: string;
}

// `<agentId>@<host>` — the canonical mention form a user types in the bridge
// playground (with a leading `@`). Used by the claude backend's self-reference
// system prompt and by the `whoami` CLI.
export function formatMention(id: AgentIdentity): string {
  return `@${id.agentId}@${id.host}`;
}

// `acct:<agentId>@<host>` — the RFC 7565 form, used as the `resource` query
// parameter when looking the agent up via WebFinger.
export function formatAcct(id: AgentIdentity): string {
  return `acct:${id.agentId}@${id.host}`;
}

// WebFinger lookup URL, useful for sanity-checking that the bridge actually
// resolves this agent's acct from outside.
export function webfingerUrl(id: AgentIdentity): string {
  const acct = encodeURIComponent(formatAcct(id));
  return `https://${id.host}/.well-known/webfinger?resource=${acct}`;
}

// A2A JSON-RPC endpoint for this agent — what a caller POSTs to via
// `a2a-wallet a2a stream` etc. The corresponding agent card lives one path
// segment deeper (see `a2aCardUrl`).
export function a2aEndpoint(id: AgentIdentity): string {
  return `https://${id.host}/agents/${id.agentId}`;
}

// Agent card JSON URL served by the bridge for this agent (see
// `packages/server/src/http.tsx` — route `/agents/:id/.well-known/agent-card.json`).
// `a2a-wallet a2a card <endpoint>` derives this URL itself from the endpoint,
// so most operators don't need to type it directly, but printing it makes
// the discovery path explicit.
export function a2aCardUrl(id: AgentIdentity): string {
  return `${a2aEndpoint(id)}/.well-known/agent-card.json`;
}

// Best-effort host derivation from the bridge WebSocket URL. The bridge's
// WebFinger surface is rooted at the same hostname as the WS endpoint in the
// usual deployment (`wss://<host>/ws` ↔ `https://<host>/.well-known/...`); if
// PUBLIC_URL is configured to a different host on the server side the derived
// mention will not resolve via WebFinger and `whoami` will say so.
export function hostFromServerUrl(serverUrl: string): string | null {
  try {
    return new URL(serverUrl).hostname || null;
  } catch {
    return null;
  }
}

export function deriveIdentity(
  agentId: string,
  serverUrl: string,
): AgentIdentity | null {
  const host = hostFromServerUrl(serverUrl);
  if (!host) return null;
  if (!isValidMentionableLocal(agentId)) return null;
  return { agentId, host };
}
