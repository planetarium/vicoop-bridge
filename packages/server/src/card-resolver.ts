import { readFileSync } from 'node:fs';
import {
  AgentCard,
  type AgentCard as AgentCardType,
  type HelloFrame,
} from '@vicoop-bridge/protocol';

function readCanonicalCard(kind: string): AgentCardType {
  const url = new URL(`./cards/${kind}.json`, import.meta.url);
  return AgentCard.parse(JSON.parse(readFileSync(url, 'utf8')));
}

const canonicalCards = new Map<string, AgentCardType>(
  Object.entries({
    claude: readCanonicalCard('claude'),
    codex: readCanonicalCard('codex'),
    echo: readCanonicalCard('echo'),
    openclaw: readCanonicalCard('openclaw'),
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
