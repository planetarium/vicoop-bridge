import type { Hono, MiddlewareHandler } from 'hono';
import type { AgentCardV03 } from '@a2x/sdk';
import type { ClientConnection } from './registry.js';
import {
  MENTIONABLE_ADMIN_LOCAL,
  MENTIONABLE_AGENT_CARD_REL,
  buildAgentDirectory,
  buildMentionableCard,
  isValidMentionableLocal,
  parseAcct,
  type DirectoryEntry,
} from './mentionable.js';

export interface WellKnownDeps {
  // Snapshot of currently connected client agents. Called per-request so
  // connect/disconnect changes are reflected immediately (no caching here —
  // the registry is already in-memory).
  listAgents: () => ClientConnection[];
  // Resolves a connection's runtime AgentCardV03 (post-auth synthesis,
  // streaming/extensions/security all reflected). The HTTP layer hands us
  // a closure over its per-agent cache so we don't rebuild cards here.
  getAgentCard: (conn: ClientConnection) => AgentCardV03;
  // Bridge's own admin agent card. Listed under @admin@<host> in every
  // well-known surface — does not depend on a WS connection (it's the
  // bridge itself).
  adminCard: AgentCardV03;
  // Bridge's external HTTPS base, e.g. `https://bridge.example.com`. When
  // unset, every Mentionable route degrades to 404 — RFC 7033 requires HTTPS
  // and we can't render a self-referential URL without knowing our origin.
  publicUrl?: string;
  // Bridge's external hostname (URL.hostname of publicUrl). Carried
  // separately because callers already derive it once for SIWE.
  domain?: string;
  // Whether the deployment actually mounts the device-flow token endpoints.
  // SIWE-only deployments advertise `auth.scheme: 'none'` instead of
  // pointing clients at oauth2 URLs that aren't served.
  deviceFlowEnabled: boolean;
  // Display name for the Schema.org Organization payload. Typically the
  // admin agent card's `name`.
  organizationName: string;
}

interface ResolvedLocal {
  local: string; // canonical local-part as it appears in addresses
  card: AgentCardV03;
}

function listDirectoryEntries(deps: WellKnownDeps): DirectoryEntry[] {
  // Admin always appears first so a casual reader of the directory finds
  // the bridge itself before the connected clients.
  const entries: DirectoryEntry[] = [
    {
      local: MENTIONABLE_ADMIN_LOCAL,
      name: deps.adminCard.name,
      description: deps.adminCard.description ?? undefined,
    },
  ];
  for (const conn of deps.listAgents()) {
    if (!isValidMentionableLocal(conn.agentId)) continue;
    const card = deps.getAgentCard(conn);
    entries.push({
      local: conn.agentId,
      name: card.name,
      description: card.description ?? undefined,
    });
  }
  return entries;
}

function resolveLocal(deps: WellKnownDeps, local: string): ResolvedLocal | undefined {
  const lower = local.toLowerCase();
  if (lower === MENTIONABLE_ADMIN_LOCAL.toLowerCase()) {
    return { local: MENTIONABLE_ADMIN_LOCAL, card: deps.adminCard };
  }
  // Mentionable lookups are case-insensitive (RFC 1035 / RFC 5321), but the
  // registry treats `agentId` as case-sensitive at the moment, so two
  // distinct connections like `Foo` and `foo` could both fold to the same
  // local. Picking one would silently route mentions to whichever connected
  // first; refuse the lookup instead so the ambiguity surfaces as a 404
  // rather than misdelivery. The right long-term fix is to enforce
  // case-insensitive uniqueness at registration time.
  let match: ResolvedLocal | undefined;
  for (const conn of deps.listAgents()) {
    if (
      !isValidMentionableLocal(conn.agentId) ||
      conn.agentId.toLowerCase() !== lower
    ) {
      continue;
    }
    if (match) return undefined;
    match = { local: conn.agentId, card: deps.getAgentCard(conn) };
  }
  return match;
}

/**
 * Mount the Mentionable v0.1 surface — WebFinger, the agent-card document,
 * and the Agent Directory accelerator — on `app`.
 *
 * - `GET /.well-known/webfinger?resource=acct:<local>@<domain>` resolves to
 *   any connected client whose agentId matches `<local>` (case-insensitive,
 *   per RFC 1035 + a practical reading of RFC 5321).
 * - `GET /.well-known/agent-card/<local>` returns the Mentionable-shaped
 *   card (wraps the per-client A2A AgentCardV03).
 * - `GET /.well-known/mentionable-agents.json` returns the Schema.org
 *   `Organization` payload listing every connected client whose agentId is
 *   a Mentionable-safe local-part.
 */
// Mentionable §3 encourages aggressive caching ("card changes are expected
// to be infrequent"), but our payloads track live WS connections — a client
// that disconnects (or that hasn't connected yet, producing a 404) must not
// be cached, otherwise shared caches keep returning unreachable / stale
// addressability for the TTL window. 404s are cacheable by HTTP defaults
// too, so the header has to apply uniformly across every status. Until we
// add ETag/Last-Modified for conditional revalidation, no-store is the
// only honest answer.
const noStoreOnAllResponses: MiddlewareHandler = async (c, next) => {
  await next();
  c.header('Cache-Control', 'no-store');
};

export function mountWellKnown(app: Hono, deps: WellKnownDeps): void {
  app.use('/.well-known/webfinger', noStoreOnAllResponses);
  app.use('/.well-known/agent-card/:local', noStoreOnAllResponses);
  app.use('/.well-known/mentionable-agents.json', noStoreOnAllResponses);

  app.get('/.well-known/webfinger', (c) => {
    if (!deps.domain || !deps.publicUrl) {
      return c.json({ error: 'webfinger not available (no PUBLIC_URL configured)' }, 404);
    }
    const resource = c.req.query('resource');
    if (!resource) {
      return c.json({ error: 'missing resource parameter' }, 400);
    }
    const parsed = parseAcct(resource);
    if (
      !parsed ||
      parsed.domain.toLowerCase() !== deps.domain.toLowerCase() ||
      !isValidMentionableLocal(parsed.local)
    ) {
      return c.json({ error: 'not found' }, 404);
    }
    const resolved = resolveLocal(deps, parsed.local);
    if (!resolved) return c.json({ error: 'not found' }, 404);

    // Admin lives at the bridge root; clients live under /agents/<id>.
    const isAdmin = resolved.local === MENTIONABLE_ADMIN_LOCAL;
    const aliasUrl = isAdmin
      ? `${deps.publicUrl}/`
      : `${deps.publicUrl}/agents/${resolved.local}`;
    const subject = `acct:${resolved.local}@${deps.domain.toLowerCase()}`;
    const jrd = {
      subject,
      aliases: [aliasUrl],
      links: [
        {
          rel: MENTIONABLE_AGENT_CARD_REL,
          type: 'application/json',
          href: `${deps.publicUrl}/.well-known/agent-card/${resolved.local}`,
        },
        {
          rel: 'http://webfinger.net/rel/profile-page',
          type: 'text/html',
          href: `${deps.publicUrl}/`,
        },
      ],
    };
    // Cache-Control: no-store is applied uniformly by the route-scoped
    // middleware above, so every status (including the 400/404 errors)
    // carries it.
    return new Response(JSON.stringify(jrd), {
      headers: {
        'Content-Type': 'application/jrd+json; charset=utf-8',
      },
    });
  });

  app.get('/.well-known/agent-card/:local', (c) => {
    if (!deps.domain || !deps.publicUrl) {
      return c.json({ error: 'agent-card not available (no PUBLIC_URL configured)' }, 404);
    }
    const local = c.req.param('local');
    if (!isValidMentionableLocal(local)) {
      return c.json({ error: 'not found' }, 404);
    }
    const resolved = resolveLocal(deps, local);
    if (!resolved) return c.json({ error: 'not found' }, 404);
    const mentionable = buildMentionableCard(resolved.card, {
      local: resolved.local,
      domain: deps.domain.toLowerCase(),
      baseUrl: deps.publicUrl,
      publicUrl: deps.publicUrl,
      deviceFlowEnabled: deps.deviceFlowEnabled,
    });
    return c.json(mentionable);
  });

  app.get('/.well-known/mentionable-agents.json', (c) => {
    if (!deps.domain || !deps.publicUrl) {
      return c.json({ error: 'directory not available (no PUBLIC_URL configured)' }, 404);
    }
    const directory = buildAgentDirectory({
      baseUrl: deps.publicUrl,
      domain: deps.domain.toLowerCase(),
      organizationName: deps.organizationName,
      entries: listDirectoryEntries(deps),
    });
    return c.json(directory);
  });
}

// Re-exported so the HTTP layer can also embed the same payload as JSON-LD
// in the landing page (Layer 1 source of truth per Mentionable's
// Agent Directory spec).
export function buildLandingDirectory(deps: WellKnownDeps) {
  if (!deps.domain || !deps.publicUrl) return undefined;
  return buildAgentDirectory({
    baseUrl: deps.publicUrl,
    domain: deps.domain.toLowerCase(),
    organizationName: deps.organizationName,
    entries: listDirectoryEntries(deps),
  });
}
