import type { Message } from '@a2x/sdk';
import type { ClientConnection } from '../registry.js';
import { supportsCallerContext } from '../caller-context.js';
import { extractAndStripIdentityCarrier } from './carrier.js';
import { PlatformIdentityVerifier } from './verifier.js';
import type {
  DidDocumentResolver,
  IdentityReplayStore,
  IdentityVcRejection,
  VerifiedPresentedIdentity,
} from './types.js';
import { IDENTITY_VC_PRESENTED_METADATA_KEY } from './types.js';

export interface PrepareIdentityVcOptions {
  conn: ClientConnection;
  expectedDomain: string | undefined;
  resolver: DidDocumentResolver;
  replayStore: IdentityReplayStore;
  now?: () => Date;
}

export interface PrepareIdentityVcResult {
  accepted: number;
  rejections: IdentityVcRejection[];
}

function replaceMetadata(
  message: Record<string, unknown>,
  metadata: Record<string, unknown> | undefined,
): void {
  if (metadata === undefined) delete message.metadata;
  else message.metadata = metadata;
}

/**
 * Strip all raw identity carriers and, when this receiver negotiated caller
 * context and configured trust, verify the v0.2 VC carrier. Optional evidence
 * never rejects the outer A2A request.
 */
export async function prepareIdentityVcAtBoundary(
  message: Record<string, unknown>,
  options: PrepareIdentityVcOptions,
): Promise<PrepareIdentityVcResult> {
  const extracted = extractAndStripIdentityCarrier(
    message.metadata as Message['metadata'],
  );
  replaceMetadata(message, extracted.metadata);

  const rejections = [...extracted.rejections];
  const trustedIssuers = options.conn.identityTrust?.trustedIssuers ?? [];
  const enabled =
    options.expectedDomain !== undefined &&
    trustedIssuers.length > 0 &&
    supportsCallerContext(options.conn.protocolCapabilities);
  if (!enabled || extracted.credentials.length === 0) {
    return { accepted: 0, rejections };
  }

  if (typeof message.messageId !== 'string' || message.messageId.length === 0) {
    rejections.push({ code: 'malformed' });
    return { accepted: 0, rejections };
  }

  const verifier = new PlatformIdentityVerifier({
    trustedIssuers,
    resolver: options.resolver,
    replayStore: options.replayStore,
    ...(options.now !== undefined ? { now: options.now } : {}),
  });
  const results = await Promise.all(
    extracted.credentials.map((credential) =>
      verifier.verify(credential, {
        expectedDomain: options.expectedDomain!,
        messageId: message.messageId as string,
      }),
    ),
  );
  const identities: VerifiedPresentedIdentity[] = [];
  for (const result of results) {
    if (result.ok) identities.push(result.identity);
    else rejections.push(result.rejection);
  }

  if (identities.length > 0) {
    message.metadata = {
      ...(message.metadata as Record<string, unknown> | undefined),
      [IDENTITY_VC_PRESENTED_METADATA_KEY]: identities,
    };
  }
  return { accepted: identities.length, rejections };
}

export function canonicalAgentMention(
  agentId: string,
  publicUrl: string | undefined,
): string | undefined {
  if (!publicUrl) return undefined;
  let hostname: string;
  try {
    hostname = new URL(publicUrl).hostname;
  } catch {
    return undefined;
  }
  if (!hostname) return undefined;
  if (hostname.includes(':') && !hostname.startsWith('[')) hostname = `[${hostname}]`;
  return `@${agentId}@${hostname}`;
}
