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
  // Hostname only (no scheme, no port). Used in the mention/acct subject
  // (`@<agentId>@<host>` / `acct:<agentId>@<host>`).
  host: string;
  // HTTP(S) origin of the bridge (`scheme://host[:port]`). Used to build
  // WebFinger / A2A / agent-card URLs. Carried separately from `host` so a
  // dev deployment on `ws://localhost:8787` resolves to `http://localhost:8787`
  // for URLs while the mention stays `<agentId>@localhost`.
  httpOrigin: string;
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

// Self-identity directive injected into the spawned backend's system / developer
// prompt so the model recognises its OWN A2A mention / acct in a user message
// and answers directly instead of treating it as an external destination. The
// concrete failure mode this prevents: a Claude-as-caller or codex-as-caller
// skill (a2a-wallet) interpreting the agent's own mention as another agent and
// emitting an outbound A2A call that the bridge then rejects (the agent's own
// wallet isn't in its own `allowed_callers`). See PR #129 / issue #128. Lives
// in identity.ts (not a backend file) so the claude and codex backends both
// inject the exact same wording without one cross-importing the other.
export function buildSelfIdentitySystemPrompt(id: AgentIdentity): string {
  const mention = formatMention(id);
  const acct = formatAcct(id);
  return [
    `You are an A2A agent reachable as the mention \`${mention}\` (${acct}).`,
    `If a user message references this mention or acct, treat it as a self-reference and respond directly — do not invoke any outbound A2A tool or skill (e.g. a2a-wallet) to contact this address as if it were a separate agent.`,
  ].join(' ');
}

// WebFinger lookup URL, useful for sanity-checking that the bridge actually
// resolves this agent's acct from outside.
export function webfingerUrl(id: AgentIdentity): string {
  const acct = encodeURIComponent(formatAcct(id));
  return `${id.httpOrigin}/.well-known/webfinger?resource=${acct}`;
}

// A2A JSON-RPC endpoint for this agent — what a caller POSTs to via
// `a2a-wallet a2a stream` etc. The corresponding agent card lives one path
// segment deeper (see `a2aCardUrl`). `agentId` is %-encoded defensively even
// though valid Mentionable locals never require it, so the URL stays valid
// when whoami is asked to print an out-of-charset id.
export function a2aEndpoint(id: AgentIdentity): string {
  return `${id.httpOrigin}/agents/${encodeURIComponent(id.agentId)}`;
}

// Agent card JSON URL served by the bridge for this agent (see
// `packages/server/src/http.tsx` — route `/agents/:id/.well-known/agent-card.json`).
// `a2a-wallet a2a card <endpoint>` derives this URL itself from the endpoint,
// so most operators don't need to type it directly, but printing it makes
// the discovery path explicit.
export function a2aCardUrl(id: AgentIdentity): string {
  return `${a2aEndpoint(id)}/.well-known/agent-card.json`;
}

// Best-effort host derivation from the bridge WebSocket URL. Hostname only
// (no port) — used for the mention/acct subject. See `httpOriginFromServerUrl`
// for the URL-building counterpart.
//
// IPv6 literals are returned bracketed (`[::1]`) so the `acct:` form follows
// the RFC 7565 / RFC 3986 host-with-brackets convention and matches the
// bridge's own Mentionable surface (see `packages/server/src/well-known.ts`
// `isIpLiteral`).
//
// Different URL parsers disagree on whether `URL.hostname` includes the
// brackets — some surface a bare `::1`, others keep `[::1]`. We normalise to
// the bracketed form regardless: if the hostname contains `:` (which a legal
// DNS hostname cannot) and is not already bracketed, wrap it.
export function hostFromServerUrl(serverUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(serverUrl);
  } catch {
    return null;
  }
  const hostname = url.hostname;
  if (!hostname) return null;
  if (hostname.includes(':') && !hostname.startsWith('[')) {
    return `[${hostname}]`;
  }
  return hostname;
}

// HTTP(S) origin counterpart to `hostFromServerUrl`. ws↔http / wss↔https
// (`URL.protocol` is `ws:`/`wss:`/`http:`/`https:`), preserving the port so
// dev deployments like `ws://localhost:8787` get the correct
// `http://localhost:8787` for WebFinger / A2A URLs.
export function httpOriginFromServerUrl(serverUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(serverUrl);
  } catch {
    return null;
  }
  if (!url.hostname) return null;
  const scheme =
    url.protocol === 'wss:' || url.protocol === 'https:' ? 'https' : 'http';
  return `${scheme}://${url.host}`;
}

export function deriveIdentity(
  agentId: string,
  serverUrl: string,
): AgentIdentity | null {
  const host = hostFromServerUrl(serverUrl);
  const httpOrigin = httpOriginFromServerUrl(serverUrl);
  if (!host || !httpOrigin) return null;
  if (!isValidMentionableLocal(agentId)) return null;
  return { agentId, host, httpOrigin };
}
