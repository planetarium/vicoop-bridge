import {
  A2XServer,
  HttpBearerAuthorization,
  OAuth2DeviceCodeAuthorization,
  type TaskStore,
} from '@a2x/sdk';
import { SIWE_BEARER_AUTH_EXTENSION_URI } from '@vicoop-bridge/protocol';
import type { ClientConnection, Registry } from './registry.js';
import { WSForwardingExecutor } from './executor.js';
import { X402_FOUNDATION_EXTENSION_URI } from './x402/gate.js';
import type { Sql } from './db.js';

export interface AgentA2XOptions {
  publicUrl: string | undefined;
  deviceFlowEnabled: boolean;
  // DB handle for the x402 offering store. Absent on deployments assembled
  // without a payment path; the executor then never installs the gate.
  db?: Sql;
}

/**
 * Build the A2XServer for a WS-connected client. Each per-agent A2XServer
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
export function buildAgentA2XServer(
  conn: ClientConnection,
  taskStore: TaskStore,
  registry: Registry,
  opts: AgentA2XOptions,
): A2XServer {
  const wire = conn.agentCard;
  const url = opts.publicUrl
    ? `${opts.publicUrl}/agents/${conn.agentId}`
    : `/agents/${conn.agentId}`;

  const executor = new WSForwardingExecutor(
    conn.agentId,
    registry,
    taskStore,
    undefined,
    opts.db ? { sql: opts.db, resource: url } : undefined,
  );

  const a2xServer = new A2XServer({
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

  // Advertise SIWE bearer-auth (siwe-bearer-auth/v0.1) when this agent is
  // restricted to a non-empty allowed_callers set. Mentionable / A2A clients
  // discover this URI to know they can mint a base64url SIWE bearer locally
  // (no exchange step) and present it directly.
  //
  // For restricted agents the bridge owns the SIWE bearer-auth
  // advertisement: it is authoritative for the bridge-side facts in `params`
  // (domain / exchange URL / usage hints) and for the `required` flag, and
  // — critically — is the only side that knows whether the SIWE-bearer
  // fast-path is actually wired. The middleware accepts SIWE bearers iff a
  // siweDomain is configured, which on this layer maps to opts.publicUrl
  // being set (http.tsx derives one from the other). So for restricted
  // agents we always strip a wire-declared SIWE entry and re-emit our own
  // only when publicUrl is set; without publicUrl we drop it entirely so a
  // wire client can't advertise auth that the server won't accept.
  //
  // Public agents pass wire SIWE entries through unchanged: auth isn't
  // enforced there, so the advertisement is informational and the wire
  // client's intent (e.g. "I'd like SIWE if you ever restrict me") is
  // preserved.
  //
  // `required: true` matches vicoop-db-agent-builder's advertisement so
  // Mentionable clients that fail-closed on unknown required extensions
  // behave identically across both hosts. Clients that don't understand
  // the URI can still authenticate via the opaque vbc_caller_* path on
  // the bridge.
  const wireExtensions = wire.capabilities?.extensions ?? [];
  const restricted = conn.allowedCallers.length > 0;
  const bridgeWillEmitSiwe = restricted && Boolean(opts.publicUrl);
  for (const extension of wireExtensions) {
    if (restricted && extension.uri === SIWE_BEARER_AUTH_EXTENSION_URI) {
      // Bridge owns this advertisement on restricted agents — drop wire
      // entry whether or not we re-emit our own (the latter is gated by
      // publicUrl).
      continue;
    }
    a2xServer.addExtension(extension);
  }
  if (bridgeWillEmitSiwe) {
    // Match http.tsx's siwe domain derivation (.hostname strips the port) so
    // the advertised domain matches what /auth/siwe/exchange and the bearer
    // fast-path actually validate against.
    const siweDomain = new URL(opts.publicUrl!).hostname;
    a2xServer.addExtension({
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

  // Advertise x402 when this agent charges. The bridge owns this
  // advertisement for the same reason it owns the SIWE one: it is the only
  // side that knows whether a payment gate is actually installed, and pricing
  // is DB-owned rather than declared by the connecting client.
  //
  // `required: false` — a caller that cannot pay still gets a well-formed
  // `input-required` response naming the price, which is more useful than
  // being refused at extension activation. `params` mirrors the offering so a
  // client can decide whether it is willing to pay before spending a turn.
  if (conn.x402Pricing) {
    const pricing = conn.x402Pricing;
    a2xServer.addExtension({
      uri: X402_FOUNDATION_EXTENSION_URI,
      description:
        pricing.scheme === 'upto'
          ? 'x402 metered payments. Calls are answered with an input-required task carrying x402.payment.required; sign the payload (upto requires opting in on the client) and resubmit against the same taskId. You are charged for the tokens actually consumed, up to the authorized maximum.'
          : 'x402 payments. Calls are answered with an input-required task carrying x402.payment.required; sign the payload and resubmit against the same taskId.',
      required: false,
      params:
        pricing.scheme === 'upto'
          ? {
              scheme: 'upto',
              network: pricing.network,
              asset: pricing.asset,
              payTo: pricing.payTo,
              // The ceiling, not the charge — named to match, because a
              // client that read it as the price would refuse offers it can
              // comfortably afford.
              maxAmount: pricing.maxAmount,
              ratesPerMTok: pricing.rates,
              ...(pricing.minAmount !== undefined ? { minAmount: pricing.minAmount } : {}),
            }
          : {
              scheme: 'exact',
              network: pricing.network,
              amount: pricing.amount,
              asset: pricing.asset,
              payTo: pricing.payTo,
            },
    });
  }

  for (const skill of wire.skills ?? []) {
    a2xServer.addSkill({
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
      a2xServer.addSecurityScheme(
        'bearerAuth',
        new HttpBearerAuthorization({
          scheme: 'bearer',
          bearerFormat: 'SIWE',
          description:
            'Sign-In with Ethereum (EIP-4361) bearer auth. Sign a SIWE message and present it as a base64url-encoded Bearer token, or exchange it at POST /auth/siwe/exchange for an opaque vbc_caller_* token first.',
        }),
      );
      a2xServer.addSecurityRequirement({ bearerAuth: [] });

      if (opts.deviceFlowEnabled) {
        a2xServer.addSecurityScheme(
          'deviceFlow',
          new OAuth2DeviceCodeAuthorization({
            deviceAuthorizationUrl: `${opts.publicUrl}/oauth/device/code`,
            tokenUrl: `${opts.publicUrl}/oauth/token`,
            scopes: {},
            description:
              'Bridge-issued opaque bearer token (vbc_caller_*) via Google OAuth device flow.',
          }),
        );
        a2xServer.addSecurityRequirement({ deviceFlow: [] });
      }
    } else {
      // No publicUrl configured (typically local dev with custom hostname):
      // SIWE bearer fast-path can't run without a stable domain, so fall
      // back to advertising opaque-only bearer auth.
      a2xServer.addSecurityScheme(
        'bearerAuth',
        new HttpBearerAuthorization({
          scheme: 'bearer',
          bearerFormat: 'Opaque',
          description:
            'Bridge-issued opaque bearer token (vbc_caller_*). Acquire via POST /auth/siwe/exchange by signing a SIWE message.',
        }),
      );
      a2xServer.addSecurityRequirement({ bearerAuth: [] });
    }
  }

  return a2xServer;
}
