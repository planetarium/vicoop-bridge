import {
  AgentCard,
  type AgentCard as AgentCardType,
  type HelloFrame,
} from '@vicoop-bridge/protocol';
import claudeCard from './cards/claude.json' with { type: 'json' };
import echoCard from './cards/echo.json' with { type: 'json' };
import openclawCard from './cards/openclaw.json' with { type: 'json' };

const canonicalCards = new Map<string, AgentCardType>(
  Object.entries({
    claude: AgentCard.parse(claudeCard),
    echo: AgentCard.parse(echoCard),
    openclaw: AgentCard.parse(openclawCard),
  }),
);

export type ResolvedAgentCard =
  | { ok: true; agentCard: AgentCardType; source: 'inline' | 'canonical' }
  | { ok: false; code: number; reason: string; backendKind?: string };

export function resolveHelloAgentCard(
  frame: Pick<HelloFrame, 'agentCard' | 'backendKind'>,
): ResolvedAgentCard {
  if (frame.agentCard) {
    return { ok: true, agentCard: frame.agentCard, source: 'inline' };
  }

  if (!frame.backendKind) {
    return { ok: false, code: 4012, reason: 'missing agent card or backend kind' };
  }

  const canonical = canonicalCards.get(frame.backendKind);
  if (!canonical) {
    return {
      ok: false,
      code: 4013,
      reason: 'unknown backend kind',
      backendKind: frame.backendKind,
    };
  }

  return {
    ok: true,
    agentCard: canonical,
    source: 'canonical',
  };
}
