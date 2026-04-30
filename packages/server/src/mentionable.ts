import type { AgentCardV03 } from '@a2x/sdk';

export const MENTIONABLE_PROTOCOL_VERSION = '0.1' as const;
export const MENTIONABLE_AGENT_CARD_REL = 'https://mentionable.dev/agent-card';

// RFC 5321 §4.1.2 allows a wider local-part charset, but agentIds at this
// layer are unconstrained client-supplied strings (see registry.ts). Restrict
// the Mentionable surface to a safe subset — letter, digit, dot, hyphen,
// underscore — so a client cannot smuggle path/CRLF/`@` characters into the
// `acct:` URI we render. Length cap mirrors typical local-part limits.
const LOCAL_RE = /^[A-Za-z0-9._-]{1,64}$/;

export function isValidMentionableLocal(local: string): boolean {
  return LOCAL_RE.test(local);
}

// Mentionable v0.1 §1 also defines an 'artifact' mode (mime + optional
// artifact_type). A2A `defaultInputModes`/`defaultOutputModes` are bare
// strings with no `artifact` form, so this mapper never produces it.
export type Mode =
  | { kind: 'text'; mime: 'text/plain' | 'text/markdown' | 'text/html' }
  | { kind: 'link' }
  | { kind: 'file'; mime: string };

export function toMode(m: string): Mode {
  if (m === 'text' || m === 'text/plain') return { kind: 'text', mime: 'text/plain' };
  if (m === 'text/markdown') return { kind: 'text', mime: 'text/markdown' };
  if (m === 'text/html') return { kind: 'text', mime: 'text/html' };
  if (m === 'link') return { kind: 'link' };
  return { kind: 'file', mime: m };
}

export type MentionableAuth =
  | { scheme: 'none' }
  | {
      scheme: 'oauth2';
      issuer: string;
      authorization_endpoint: string;
      token_endpoint: string;
      scopes: string[];
    };

export interface MentionableCard {
  address: string;
  name: string;
  description?: string;
  version: string;
  protocol_version: typeof MENTIONABLE_PROTOCOL_VERSION;
  a2a: {
    endpoint: string;
    transport: 'https+sse' | 'https+jsonrpc';
    capabilities: {
      streaming: boolean;
      push_notifications: boolean;
      extensions: unknown[];
    };
    skills: Array<{
      id: string;
      name: string;
      description?: string;
      examples?: string[];
      input_modes?: Mode[];
      output_modes?: Mode[];
    }>;
    input_modes: Mode[];
    output_modes: Mode[];
    auth: MentionableAuth;
  };
  mentionable: {
    supported_inbound: ['a2a'];
    homepage?: string;
  };
}

export interface MentionableCardOptions {
  local: string;
  domain: string;
  baseUrl?: string;
  deviceFlowEnabled: boolean;
  publicUrl?: string;
}

// Pull the device-code flow off whatever security scheme the underlying card
// declared. The SDK's OAuthFlows shape doesn't include `deviceCode` (RFC 8628
// is an A2A-spec extension), so we read it through an `unknown` cast.
function findDeviceFlow(
  card: AgentCardV03,
): { deviceAuthorizationUrl: string; tokenUrl: string; scopes?: Record<string, string> } | undefined {
  const schemes = card.securitySchemes ?? {};
  for (const scheme of Object.values(schemes)) {
    if (!scheme || (scheme as { type?: string }).type !== 'oauth2') continue;
    const flows = (scheme as { flows?: Record<string, unknown> }).flows ?? {};
    const dc = flows.deviceCode as
      | { deviceAuthorizationUrl?: string; tokenUrl?: string; scopes?: Record<string, string> }
      | undefined;
    if (dc?.deviceAuthorizationUrl && dc?.tokenUrl) {
      return {
        deviceAuthorizationUrl: dc.deviceAuthorizationUrl,
        tokenUrl: dc.tokenUrl,
        scopes: dc.scopes,
      };
    }
  }
  return undefined;
}

export function buildMentionableCard(
  card: AgentCardV03,
  opts: MentionableCardOptions,
): MentionableCard {
  const streaming = card.capabilities?.streaming ?? false;
  const deviceFlow = opts.deviceFlowEnabled ? findDeviceFlow(card) : undefined;
  const auth: MentionableAuth = deviceFlow
    ? {
        scheme: 'oauth2',
        issuer: opts.publicUrl ?? `https://${opts.domain}`,
        authorization_endpoint: deviceFlow.deviceAuthorizationUrl,
        token_endpoint: deviceFlow.tokenUrl,
        scopes: Object.keys(deviceFlow.scopes ?? {}),
      }
    : { scheme: 'none' };

  return {
    address: `@${opts.local}@${opts.domain}`,
    name: card.name,
    description: card.description,
    version: card.version,
    protocol_version: MENTIONABLE_PROTOCOL_VERSION,
    a2a: {
      endpoint: card.url,
      transport: streaming ? 'https+sse' : 'https+jsonrpc',
      capabilities: {
        streaming,
        push_notifications: card.capabilities?.pushNotifications ?? false,
        extensions: card.capabilities?.extensions ?? [],
      },
      skills: (card.skills ?? []).map((s) => ({
        id: s.id,
        name: s.name,
        description: s.description ?? undefined,
        examples: s.examples ?? undefined,
        input_modes: s.inputModes ? s.inputModes.map(toMode) : undefined,
        output_modes: s.outputModes ? s.outputModes.map(toMode) : undefined,
      })),
      input_modes: (card.defaultInputModes ?? ['text/plain']).map(toMode),
      output_modes: (card.defaultOutputModes ?? ['text/plain']).map(toMode),
      auth,
    },
    mentionable: {
      supported_inbound: ['a2a'],
      homepage: opts.baseUrl,
    },
  };
}

// Schema.org `Organization` payload as defined in mentionable's
// agent-directory.md. Each ContactPoint is one publicly addressable agent.
export interface OrganizationContactPoint {
  '@type': 'ContactPoint';
  contactType: 'AI assistant';
  name: string;
  email: string;
  url: string;
  description?: string;
  'https://mentionable.dev/ns/v1#protocols'?: string[];
  'https://mentionable.dev/ns/v1#webfinger'?: string;
}

export interface AgentDirectoryOrganization {
  '@context': 'https://schema.org';
  '@type': 'Organization';
  url: string;
  name: string;
  contactPoint: OrganizationContactPoint[];
}

export interface DirectoryEntry {
  local: string;
  name: string;
  description?: string;
}

export function buildAgentDirectory(opts: {
  baseUrl: string;
  domain: string;
  organizationName: string;
  entries: DirectoryEntry[];
}): AgentDirectoryOrganization {
  return {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    url: `${opts.baseUrl}/`,
    name: opts.organizationName,
    contactPoint: opts.entries.map((e) => ({
      '@type': 'ContactPoint',
      contactType: 'AI assistant',
      name: e.name,
      email: `${e.local}@${opts.domain}`,
      url: `${opts.baseUrl}/.well-known/agent-card/${e.local}`,
      ...(e.description !== undefined ? { description: e.description } : {}),
      'https://mentionable.dev/ns/v1#protocols': ['a2a'],
      'https://mentionable.dev/ns/v1#webfinger': `${opts.baseUrl}/.well-known/webfinger?resource=acct:${e.local}@${opts.domain}`,
    })),
  };
}

export interface ParsedAcct {
  local: string;
  domain: string;
}

export function parseAcct(resource: string): ParsedAcct | null {
  // RFC 7565 acct: URI; scheme is case-insensitive (RFC 3986 §3.1).
  const match = /^acct:([^@]+)@(.+)$/i.exec(resource);
  if (!match) return null;
  return { local: match[1]!, domain: match[2]! };
}
