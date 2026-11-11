import { APPROVAL_EXTENSION_URI, REMOTE_APPROVAL_CAPABILITY, CONSUMER_CONSENT_EXTENSION_URI } from '@vicoop-bridge/protocol';
import {
  A2A_TRANSPORTS,
  A2XServer,
  HttpBearerAuthorization,
  OAuth2DeviceCodeAuthorization,
  type ProtocolVersion,
  type TaskStore,
} from '@a2x/sdk';
import {
  CALLER_CONTEXT_V2_CAPABILITY,
  CALLER_RUNTIME_V1_CAPABILITY,
  FEDERATED_EXECUTION_SCOPE_V1_CAPABILITY,
  supportsExecutionScopeV1,
  OPENAI_COMPAT_EXTENSION_URI,
  TRACEABILITY_EXTENSION_URI,
  MENTIONABLE_IDENTITY_VC_EXTENSION_URI,
  SIWE_BEARER_AUTH_EXTENSION_URI,
} from '@vicoop-bridge/protocol';
import type { ClientConnection, Registry } from './registry.js';
import { WSForwardingExecutor } from './executor.js';
import { isX402ExtensionUri } from '@a2x/sdk/x402';
import { X402_FOUNDATION_EXTENSION_URI } from './x402/gate.js';
import { logEvent } from './log.js';
import type { Sql } from './db.js';
import { supportsCallerContext } from './caller-context.js';
import { parsePrincipal } from './auth/principal.js';
import { OAUTH_FEDERATION_EXTENSION_URI } from './oauth/profiles/mentionable-v0.1.js';

export interface AgentA2XOptions {
  publicUrl: string | undefined;
  deviceFlowEnabled: boolean;
  protocolVersion?: ProtocolVersion;
  // DB handle for the x402 offering store. Absent on deployments assembled
  // without a payment path; the executor then never installs the gate.
  db?: Sql;
}

/**
 * Build the A2XServer for a WS-connected client. Each per-agent A2XServer
 * owns a `WSForwardingExecutor` bound to that agent's id and an
 * agent-scoped task store.
 *
 * The card surface is derived from the wire `AgentCard` the client sent
 * in its hello frame, plus security schemes synthesised from the
 * connection's `allowedCallers` policy. Advertise only credential types
 * permitted by that policy and backed by the deployed authentication paths.
 * Empty-policy caller runtimes still require a verified direct identity.
 */
export function buildAgentA2XServer(
  conn: ClientConnection,
  taskStore: TaskStore,
  registry: Registry,
  opts: AgentA2XOptions,
): A2XServer {
  const wire = conn.agentCard;
  const protocolVersion = opts.protocolVersion ?? '0.3';
  const versionPath = protocolVersion === '1.0' ? '/v1' : '';
  const url = opts.publicUrl
    ? `${opts.publicUrl}/agents/${conn.agentId}${versionPath}`
    : `/agents/${conn.agentId}${versionPath}`;

  // x402 `resource` must be an absolute URL — strict facilitators reject
  // anything else, so without `publicUrl` a paid agent would publish offerings
  // that can never verify or settle. Withhold the gate instead: the agent
  // serves for free and says so in the log, which is a working deployment with
  // a visible misconfiguration rather than a broken payment loop. Same posture
  // as an unparseable pricing row.
  const paymentsWired = Boolean(opts.db) && Boolean(opts.publicUrl);
  if (opts.db && !opts.publicUrl && conn.x402Pricing) {
    logEvent('x402_config_invalid', {
      agentId: conn.agentId,
      reason: 'pricing is configured but PUBLIC_URL is not, so no absolute resource URL exists',
    });
  }

  const executor = new WSForwardingExecutor(
    conn.agentId,
    registry,
    taskStore,
    undefined,
    paymentsWired ? { sql: opts.db!, resource: url } : undefined,
  );

  const a2xServer = new A2XServer({
    taskStore,
    executor,
    protocolVersion,
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

  // A2A v1 decouples the protocol version from the HTTP binding. Publish both
  // bindings on the same owner-defined base URL: POSTing JSON-RPC to the base
  // remains available, while the HTTP+JSON operation paths (message:send,
  // tasks/{id}, etc.) are resolved relative to it.
  if (protocolVersion === '1.0') {
    a2xServer
      .setDefaultTransport(A2A_TRANSPORTS.JSONRPC)
      .addInterface({
        url,
        protocol: A2A_TRANSPORTS.HTTP_JSON,
        protocolVersion: '1.0',
      });
  }

  // Authentication discovery is server-owned. Restriction alone says nothing
  // about which credentials can authorize a caller; derive those alternatives
  // from the same parsed principals the authorization middleware matches.
  if (conn.protocolCapabilities?.includes(REMOTE_APPROVAL_CAPABILITY)) {
    a2xServer.addExtension({ uri: APPROVAL_EXTENSION_URI, required: false,
      description: 'Remote tool approval via auth-required. Decisions require an authenticated agent owner or administrator, or the originating federated requester when the owner has enabled requester approvals.',
      params: { decisions: ['allow_once', 'deny'], delivery: 'https',
        decisionUrlTemplate: `${opts.publicUrl ?? ''}/admin-api/agents/${encodeURIComponent(conn.agentId)}/approvals/{requestId}`,
        requesterApprovalUrlTemplate: `${opts.publicUrl ?? ''}/agents/${encodeURIComponent(conn.agentId)}/approvals/{requestId}` },
    });
  }
  if (opts.db) a2xServer.addExtension({ uri: CONSUMER_CONSENT_EXTENSION_URI, required: false,
    description: 'Explicit consumer consent for immutable paid-operation proposals. The originating authenticated consumer decides through the advertised HTTPS endpoint; chat text never approves.',
    params: { statusUrlTemplate: `${opts.publicUrl ?? ''}/agents/${encodeURIComponent(conn.agentId)}/consent-proposals/{operationId}`,
      decisionUrlTemplate: `${opts.publicUrl ?? ''}/agents/${encodeURIComponent(conn.agentId)}/consent-proposals/{operationId}/decision` },
  });
  const wireExtensions = (wire.capabilities?.extensions ?? []).filter(e =>
    e.uri !== APPROVAL_EXTENSION_URI && e.uri !== CONSUMER_CONSENT_EXTENSION_URI);
  const callerRuntime = conn.protocolCapabilities?.includes(CALLER_RUNTIME_V1_CAPABILITY) === true;
  const restricted = conn.allowedCallers.length > 0 || callerRuntime;
  const principals = conn.allowedCallers.map(parsePrincipal);
  // Empty-policy caller runtimes still require a verified direct caller, but
  // accept any direct principal. Federation always needs an exact grant.
  const anyDirectCaller = callerRuntime && conn.allowedCallers.length === 0;
  const allowsEthereum = anyDirectCaller || principals.some((p) => p?.kind === 'eth');
  const allowsGoogle = anyDirectCaller || principals.some((p) => p?.kind.startsWith('google-'));
  const allowsApiKey = anyDirectCaller || principals.some((p) => p?.kind === 'apikey');
  const allowsOpaque = allowsEthereum || allowsGoogle || allowsApiKey;
  const bridgeWillEmitSiwe = allowsEthereum && Boolean(opts.publicUrl);
  const bridgeWillEmitIdentityVc =
    Boolean(opts.publicUrl) &&
    Boolean(opts.db) &&
    supportsCallerContext(conn.protocolCapabilities) &&
    (conn.identityTrust?.trustedIssuers.length ?? 0) > 0;
  const bridgeWillEmitOAuthFederation =
    restricted &&
    Boolean(opts.publicUrl) &&
    conn.protocolCapabilities?.includes(CALLER_CONTEXT_V2_CAPABILITY) === true &&
    // The registry retains hello capabilities, so require the full set that
    // the server can acknowledge and the executor needs for a federated scope.
    (!callerRuntime || (
      supportsExecutionScopeV1(conn.protocolCapabilities) &&
      conn.protocolCapabilities.includes(FEDERATED_EXECUTION_SCOPE_V1_CAPABILITY)
    )) &&
    principals.some((p) => p?.kind === 'federated');
  for (const extension of wireExtensions) {
    if (callerRuntime && [OPENAI_COMPAT_EXTENSION_URI, TRACEABILITY_EXTENSION_URI].includes(extension.uri)) continue;
    if (extension.uri === SIWE_BEARER_AUTH_EXTENSION_URI) {
      // Never let a hello advertise SIWE independently of bridge policy and
      // verifier availability, including after the final grant is removed.
      continue;
    }
    if (extension.uri === MENTIONABLE_IDENTITY_VC_EXTENSION_URI) {
      // The bridge owns this advertisement because only it knows whether
      // trust, replay storage, recipient binding, and caller-context delivery
      // are all active. Never echo private trust entries onto the public card.
      continue;
    }
    if (extension.uri === OAUTH_FEDERATION_EXTENSION_URI) {
      // Federation authorization is server-owned and only exists when an
      // exact persisted federated caller is active. Never trust the WS hello
      // to advertise an STS or resource on the bridge's behalf.
      continue;
    }
    if (isX402ExtensionUri(extension.uri)) {
      // Always dropped, paid or not. `addExtension` is append-only, so leaving
      // a wire-declared x402 entry in would let a free agent advertise a price
      // the bridge will never ask for, and would give a paid agent two entries
      // for the same URI at different prices — with no rule saying which one a
      // client reads. Pricing is DB-owned; so is saying so on the card.
      logEvent('x402_wire_advertisement_dropped', {
        agentId: conn.agentId,
        uri: extension.uri,
      });
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
        'Sign-In with Ethereum (EIP-4361) bearer authentication alternative. Clients may sign a SIWE message locally and present it as a base64url-encoded Bearer token; no exchange step needed. Extension activation is not required when using another advertised authentication method.',
      required: false,
      params: {
        domain: siweDomain,
        uri: opts.publicUrl,
        maxTokenTtl: '7d',
        domainBinding: true,
        usageHint: {
          mintToken: `a2a-wallet siwe auth --domain ${siweDomain} --uri ${opts.publicUrl} --ttl 1h --json | jq -r '.token'`,
          sendMessage: `a2a-wallet a2a send --bearer "$TOKEN" ${url}/.well-known/agent-card.json "Hello"`,
        },
      },
    });
  }
  if (bridgeWillEmitOAuthFederation) {
    a2xServer.addExtension({
      uri: OAUTH_FEDERATION_EXTENSION_URI,
      description:
        'DID-backed OAuth 2.0 Token Exchange for exact Mentionable federated callers. This is an authentication alternative; extension activation is not required when using another advertised method.',
      required: false,
      params: {
        authorization_server: `${opts.publicUrl}/.well-known/oauth-authorization-server`,
        resource: `${opts.publicUrl}/agents/${conn.agentId}`,
      },
    });
  }
  if (bridgeWillEmitIdentityVc) {
    a2xServer.addExtension({
      uri: MENTIONABLE_IDENTITY_VC_EXTENSION_URI,
      description:
        'Optional Mentionable PlatformIdentityCredential presentation. The bridge verifies trusted VC 2.0 eddsa-jcs-2022 credentials and forwards only normalized caller identity.',
      required: false,
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
  // Gated on `paymentsWired`, not just on pricing being set: the card must not
  // quote a price the gate is not installed to collect.
  if (conn.x402Pricing && paymentsWired) {
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

  // Authentication remains enforced by agentAuthMiddleware. Each requirement
  // object is an OR alternative; optional extension negotiation neither grants
  // access nor requires clients using an API key to activate SIWE/federation.
  if (allowsOpaque) {
    const acquisition = [
      ...(allowsApiKey ? ['Ask the agent operator for an API key; no wallet signing is needed.'] : []),
      ...(allowsEthereum && opts.publicUrl ? ['Ethereum callers may exchange SIWE at POST /auth/siwe/exchange.'] : []),
      ...(allowsGoogle && opts.deviceFlowEnabled && opts.publicUrl ? ['Google callers may use the advertised device flow.'] : []),
    ].join(' ');
    a2xServer.addSecurityScheme(
      'bearerAuth',
      new HttpBearerAuthorization({
        scheme: 'bearer',
        bearerFormat: 'Opaque',
        description: `Bridge-issued opaque bearer token (vbc_caller_*) for an authorized caller. ${acquisition}`.trim(),
      }),
    );
    a2xServer.addSecurityRequirement({ bearerAuth: [] });
  }
  if (bridgeWillEmitSiwe) {
    a2xServer.addSecurityScheme(
      'siweBearer',
      new HttpBearerAuthorization({
        scheme: 'bearer',
        bearerFormat: 'SIWE',
        description: 'Sign a SIWE message for the advertised domain and present it as a base64url-encoded Bearer token. An alternative to an opaque caller token.',
      }),
    );
    a2xServer.addSecurityRequirement({ siweBearer: [] });
  }
  if (bridgeWillEmitOAuthFederation) {
    a2xServer.addSecurityScheme(
      'oauthFederation',
      new HttpBearerAuthorization({
        scheme: 'bearer',
        bearerFormat: 'vbc_oauth_*',
        description: 'Opaque access token from the OAuth federation token-exchange service advertised by the federation extension. Requires an exact federated caller grant; no wallet signing is needed.',
      }),
    );
    a2xServer.addSecurityRequirement({ oauthFederation: [] });
  }
  if (allowsGoogle && opts.deviceFlowEnabled && opts.publicUrl) {
    a2xServer.addSecurityScheme(
      'deviceFlow',
      new OAuth2DeviceCodeAuthorization({
        deviceAuthorizationUrl: `${opts.publicUrl}/oauth/device/code`,
        tokenUrl: `${opts.publicUrl}/oauth/token`,
        scopes: {},
        description: 'Bridge-issued opaque bearer token (vbc_caller_*) via Google OAuth device flow for an authorized Google caller.',
      }),
    );
    a2xServer.addSecurityRequirement({ deviceFlow: [] });
  }

  return a2xServer;
}
