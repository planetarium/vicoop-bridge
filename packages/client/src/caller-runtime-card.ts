import { OPENAI_COMPAT_EXTENSION_URI, type AgentCard } from '@vicoop-bridge/protocol';

/** Match advertised input modes to the caller admission gate, without mutating host cards. */
export function callerRuntimeCard(card: AgentCard, kind: string, custom = false): AgentCard {
  const allowed = ['text/plain', 'image/png', 'image/jpeg', 'image/gif', 'image/webp',
    ...(kind === 'claude' ? ['application/pdf'] : [])];
  const inputModes = (card.defaultInputModes ?? allowed).filter(mode => allowed.includes(mode));
  if (!inputModes.length) throw new Error('container agent card must advertise supported text or inline-file inputs');
  const inputDescription = `Accepts text and inline PNG/JPEG/GIF/WebP images${kind === 'claude' ? ' or PDF documents' : ''}; files must be provided as file.bytes and be at most 5 MiB each.`;
  const customContract = `Container input contract: ${inputDescription} JSON data parts and URI files are unsupported.`;
  return {
    ...card,
    description: custom
      ? `${card.description ?? card.name}\n\n${customContract}`
      : `Caller-isolated ${kind} coding agent with a persistent workspace per authenticated caller. ${inputDescription}`,
    defaultInputModes: inputModes,
    capabilities: {
      ...card.capabilities,
      extensions: card.capabilities?.extensions?.filter(extension => extension.uri !== OPENAI_COMPAT_EXTENSION_URI),
    },
    skills: card.skills?.map(skill => ({
      ...skill,
      description: custom ? `${skill.description ?? skill.name}\n\n${customContract}`
        : `Give an instruction or ask a question in natural language. ${inputDescription}`,
    })),
  };
}
