import {
  CALLER_CONTEXT_V1_CAPABILITY,
  CALLER_CONTEXT_V2_CAPABILITY,
  CallerContextV1,
  CallerContextV2,
  type CallerAttestationV2,
  type CallerContextV1 as CallerContextV1Value,
  type CallerContextV2 as CallerContextV2Value,
} from '@vicoop-bridge/protocol';

export type CallerContextWireVersion = 'v1' | 'v2';
export interface CanonicalCallerContext {
  principal?: { id: string };
  actor?: { id: string };
  attestations?: CallerAttestationV2[];
}

export function selectCallerContextVersion(
  capabilities: readonly string[] | undefined,
): CallerContextWireVersion | undefined {
  if (capabilities?.includes(CALLER_CONTEXT_V2_CAPABILITY)) return 'v2';
  if (capabilities?.includes(CALLER_CONTEXT_V1_CAPABILITY)) return 'v1';
  return undefined;
}

export function supportsCallerContext(capabilities: readonly string[] | undefined): boolean {
  return selectCallerContextVersion(capabilities) !== undefined;
}

function isEmpty(context: CanonicalCallerContext): boolean {
  return (
    context.principal === undefined &&
    context.actor === undefined &&
    (context.attestations === undefined || context.attestations.length === 0)
  );
}

export function createCanonicalCallerContext(input: {
  principalId?: string;
  actorId?: string;
  attestations?: readonly CallerAttestationV2[];
}): CanonicalCallerContext | undefined {
  const parsed = CallerContextV2.safeParse({
    ...(input.principalId !== undefined ? { principal: { id: input.principalId } } : {}),
    ...(input.actorId !== undefined ? { actor: { id: input.actorId } } : {}),
    ...(input.attestations !== undefined && input.attestations.length > 0
      ? { attestations: [...input.attestations] }
      : {}),
  });
  if (!parsed.success || isEmpty(parsed.data)) return undefined;
  return parsed.data;
}

export function canonicalizeCallerContextV1(
  context: CallerContextV1Value,
): CanonicalCallerContext | undefined {
  return createCanonicalCallerContext({
    ...(context.authenticated !== undefined
      ? { principalId: context.authenticated.principalId }
      : {}),
    ...(context.presented !== undefined ? { attestations: context.presented } : {}),
  });
}

export function serializeCallerContextV1(
  context: CanonicalCallerContext,
): CallerContextV1Value | undefined {
  // v1 cannot express a distinct actor. #487 must require v2 before it can
  // construct delegated context, rather than silently collapsing identities.
  if (context.actor !== undefined) return undefined;
  const parsed = CallerContextV1.safeParse({
    ...(context.principal !== undefined
      ? { authenticated: { principalId: context.principal.id } }
      : {}),
    ...(context.attestations !== undefined && context.attestations.length > 0
      ? { presented: context.attestations }
      : {}),
  });
  if (!parsed.success) return undefined;
  if (parsed.data.authenticated === undefined && (parsed.data.presented?.length ?? 0) === 0) {
    return undefined;
  }
  return parsed.data;
}

export function serializeCallerContextV2(
  context: CanonicalCallerContext,
): CallerContextV2Value | undefined {
  const parsed = CallerContextV2.safeParse(context);
  if (!parsed.success || isEmpty(parsed.data)) return undefined;
  return parsed.data;
}

export function serializeCallerContext(
  context: CanonicalCallerContext | undefined,
  version: CallerContextWireVersion | undefined,
): CallerContextV1Value | CallerContextV2Value | undefined {
  if (context === undefined || version === undefined) return undefined;
  return version === 'v2'
    ? serializeCallerContextV2(context)
    : serializeCallerContextV1(context);
}
