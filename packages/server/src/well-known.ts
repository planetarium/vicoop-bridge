import type { Hono } from 'hono';
import type { AgentCardV03 } from '@a2x/sdk';
import type { ClientConnection } from './registry.js';
import {
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

function listDirectoryEntries(deps: WellKnownDeps): DirectoryEntry[] {
  const entries: DirectoryEntry[] = [];
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

function findConnByLocal(deps: WellKnownDeps, local: string): ClientConnection | undefined {
  const lower = local.toLowerCase();
  for (const conn of deps.listAgents()) {
    if (
      isValidMentionableLocal(conn.agentId) &&
      conn.agentId.toLowerCase() === lower
    ) {
      return conn;
    }
  }
  return undefined;
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
export function mountWellKnown(app: Hono, deps: WellKnownDeps): void {
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
    const conn = findConnByLocal(deps, parsed.local);
    if (!conn) return c.json({ error: 'not found' }, 404);

    const subject = `acct:${conn.agentId}@${deps.domain.toLowerCase()}`;
    const jrd = {
      subject,
      aliases: [`${deps.publicUrl}/agents/${conn.agentId}`],
      links: [
        {
          rel: MENTIONABLE_AGENT_CARD_REL,
          type: 'application/json',
          href: `${deps.publicUrl}/.well-known/agent-card/${conn.agentId}`,
        },
        {
          rel: 'http://webfinger.net/rel/profile-page',
          type: 'text/html',
          href: `${deps.publicUrl}/`,
        },
      ],
    };
    return new Response(JSON.stringify(jrd), {
      headers: {
        'Content-Type': 'application/jrd+json; charset=utf-8',
        'Cache-Control': 'public, max-age=300, s-maxage=300',
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
    const conn = findConnByLocal(deps, local);
    if (!conn) return c.json({ error: 'not found' }, 404);
    const card = deps.getAgentCard(conn);
    const mentionable = buildMentionableCard(card, {
      local: conn.agentId,
      domain: deps.domain.toLowerCase(),
      baseUrl: deps.publicUrl,
      publicUrl: deps.publicUrl,
      deviceFlowEnabled: deps.deviceFlowEnabled,
    });
    c.header('Cache-Control', 'public, max-age=300, s-maxage=300');
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
    c.header('Cache-Control', 'public, max-age=60, s-maxage=60');
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
