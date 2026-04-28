import {
  A2XAgent,
  HttpBearerAuthorization,
  OAuth2DeviceCodeAuthorization,
  type TaskStore,
} from '@a2x/sdk';
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

  for (const skill of wire.skills ?? []) {
    a2xAgent.addSkill({
      id: skill.id,
      name: skill.name,
      description: skill.description ?? '',
      tags: skill.tags ?? [],
    });
  }

  if (conn.allowedCallers.length > 0) {
    // Auth is enforced upstream at the route layer (agentAuthMiddleware);
    // we invoke `handler.handle()` without a RequestContext so a2x's
    // per-request authenticate path is skipped. The schemes here are
    // advertised on the AgentCard for spec-compliant card consumers
    // but their `validator` callbacks are never reached at runtime.
    if (opts.deviceFlowEnabled && opts.publicUrl) {
      a2xAgent.addSecurityScheme(
        'bridge',
        new OAuth2DeviceCodeAuthorization({
          deviceAuthorizationUrl: `${opts.publicUrl}/oauth/device/code`,
          tokenUrl: `${opts.publicUrl}/oauth/token`,
          scopes: {},
          description:
            'Bridge-issued opaque bearer token. Acquire via /oauth/token (Google device flow) or /auth/siwe/exchange (SIWE).',
        }),
      );
    } else {
      a2xAgent.addSecurityScheme(
        'bridge',
        new HttpBearerAuthorization({
          scheme: 'bearer',
          bearerFormat: 'Opaque',
          description:
            'Bridge-issued opaque bearer token (vbc_caller_*). Acquire via POST /auth/siwe/exchange by signing a SIWE message.',
        }),
      );
    }
    a2xAgent.addSecurityRequirement({ bridge: [] });
  }

  return a2xAgent;
}

