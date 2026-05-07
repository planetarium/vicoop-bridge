import {
  A2XAgent,
  HttpBearerAuthorization,
  OAuth2DeviceCodeAuthorization,
  type TaskStore,
} from '@a2x/sdk';
import { SIWE_BEARER_AUTH_EXTENSION_URI } from '@vicoop-bridge/protocol';
import type { ClientConnection, Registry } from './registry.js';
import { WSForwardingExecutor } from './executor.js';

export interface AgentA2XOptions {
  publicUrl: string | undefined;
  deviceFlowEnabled: boolean;
}

/**
 * Build the A2XAgent for a WS-connected client. Each per-agent A2XAgent
 * owns a `WSForwardingExecutor` bound to that agent's id and the
 * shared task store.
 *
 * The card surface is derived from the wire `AgentCard` the client sent
 * in its hello frame, plus security schemes synthesised from the
 * connection's `allowedCallers` policy: when callers are configured,
 * the agent advertises a Bearer scheme (and a device-flow scheme too
 * when Google OAuth is configured on this deployment, so the AgentCard
 * stays consistent with the actually-mounted endpoints).
 */
export function buildAgentA2XAgent(
  conn: ClientConnection,
  taskStore: TaskStore,
  registry: Registry,
  opts: AgentA2XOptions,
): A2XAgent {
  const wire = conn.agentCard;
  const url = opts.publicUrl
    ? `${opts.publicUrl}/agents/${conn.agentId}`
    : `/agents/${conn.agentId}`;

  const executor = new WSForwardingExecutor(conn.agentId, registry, taskStore);

  const a2xAgent = new A2XAgent({
    taskStore,
    executor,
    protocolVersion: '0.3',
  })
    .setName(wire.name)
    .setDescription(wire.description ?? '')
    .setVersion(wire.version)
    .setDefaultUrl(url)
    .setDefaultInputModes(wire.defaultInputModes ?? ['text/plain'])
    .setDefaultOutputModes(wire.defaultOutputModes ?? ['text/plain'])
    // a2x derives `capabilities.streaming` from the executor's
    // runConfig.streamingMode (always SSE for our forwarder), so we
    // override here to honour the wire card's declaration. Clients that
    // declare streaming:false continue to be advertised as such.
    .setCapabilities({
      streaming: wire.capabilities?.streaming ?? false,
      pushNotifications: wire.capabilities?.pushNotifications ?? false,
    });

  const wireExtensions = wire.capabilities?.extensions ?? [];
  for (const extension of wireExtensions) {
    a2xAgent.addExtension(extension);
  }

  // Advertise SIWE bearer-auth (siwe-bearer-auth/v0.1) when this agent is
  // restricted to a non-empty allowed_callers set. Mentionable / A2A clients
  // discover this URI to know they can mint a base64url SIWE bearer locally
  // (no exchange step) and present it directly. Skip when the wire card
  // already declares it — the client's own opt-in wins.
  //
  // `required: true` matches vicoop-db-agent-builder's advertisement so
  // Mentionable clients that fail-closed on unknown required extensions
  // behave identically across both hosts. Clients that don't understand
  // the URI can still authenticate via the opaque vbc_caller_* path on
  // the bridge.
  const restricted = conn.allowedCallers.length > 0;
  const wireDeclaresSiwe = wireExtensions.some((e) => e.uri === SIWE_BEARER_AUTH_EXTENSION_URI);
  if (restricted && opts.publicUrl && !wireDeclaresSiwe) {
    // Match http.tsx's siwe domain derivation (.hostname strips the port) so
    // the advertised domain matches what /auth/siwe/exchange and the bearer
    // fast-path actually validate against.
    const siweDomain = new URL(opts.publicUrl).hostname;
    a2xAgent.addExtension({
      uri: SIWE_BEARER_AUTH_EXTENSION_URI,
      description:
        'Sign-In with Ethereum (EIP-4361) bearer auth. Clients sign a SIWE message locally and present it as a base64url-encoded Bearer token; no exchange step needed.',
      required: true,
      params: {
        domain: siweDomain,
        uri: opts.publicUrl,
        maxTokenTtl: '7d',
        domainBinding: true,
        usageHint: {
          mintToken: `a2a-wallet siwe auth --domain ${siweDomain} --uri ${opts.publicUrl} --ttl 1h --json | jq -r '.token'`,
          sendMessage: `a2a-wallet a2a send --bearer "$TOKEN" ${opts.publicUrl}/agents/${conn.agentId}/.well-known/agent-card.json "Hello"`,
        },
      },
    });
  }

  for (const skill of wire.skills ?? []) {
    a2xAgent.addSkill({
      id: skill.id,
      name: skill.name,
      description: skill.description ?? '',
      tags: skill.tags ?? [],
    });
  }

  if (restricted) {
    // Auth is enforced upstream at the route layer (agentAuthMiddleware);
    // the schemes here are advertised on the AgentCard for spec-compliant
    // card consumers but their `validator` callbacks are never reached at
    // runtime.
    //
    // Schema mirrors vicoop-db-agent-builder so Mentionable clients that
    // key off `securitySchemes.{bearerAuth,deviceFlow}` find the same
    // shape on both hosts:
    //   bearerAuth — http+bearer+bearerFormat:SIWE; the client signs a
    //                SIWE message locally and presents it directly.
    //   deviceFlow — oauth2+deviceCode (Google); only advertised when the
    //                deployment actually mounts the device-flow endpoints.
    // `security` lists the schemes as alternatives (OR), so a caller may
    // satisfy either.
    if (opts.publicUrl) {
      a2xAgent.addSecurityScheme(
        'bearerAuth',
        new HttpBearerAuthorization({
          scheme: 'bearer',
          bearerFormat: 'SIWE',
          description:
            'Sign-In with Ethereum (EIP-4361) bearer auth. Sign a SIWE message and present it as a base64url-encoded Bearer token, or exchange it at POST /auth/siwe/exchange for an opaque vbc_caller_* token first.',
        }),
      );
      a2xAgent.addSecurityRequirement({ bearerAuth: [] });

      if (opts.deviceFlowEnabled) {
        a2xAgent.addSecurityScheme(
          'deviceFlow',
          new OAuth2DeviceCodeAuthorization({
            deviceAuthorizationUrl: `${opts.publicUrl}/oauth/device/code`,
            tokenUrl: `${opts.publicUrl}/oauth/token`,
            scopes: {},
            description:
              'Bridge-issued opaque bearer token (vbc_caller_*) via Google OAuth device flow.',
          }),
        );
        a2xAgent.addSecurityRequirement({ deviceFlow: [] });
      }
    } else {
      // No publicUrl configured (typically local dev with custom hostname):
      // SIWE bearer fast-path can't run without a stable domain, so fall
      // back to advertising opaque-only bearer auth.
      a2xAgent.addSecurityScheme(
        'bearerAuth',
        new HttpBearerAuthorization({
          scheme: 'bearer',
          bearerFormat: 'Opaque',
          description:
            'Bridge-issued opaque bearer token (vbc_caller_*). Acquire via POST /auth/siwe/exchange by signing a SIWE message.',
        }),
      );
      a2xAgent.addSecurityRequirement({ bearerAuth: [] });
    }
  }

  return a2xAgent;
}
