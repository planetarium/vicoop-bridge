import { OPERATION_APPROVAL_EXTENSION_URI, OPENAI_COMPAT_EXTENSION_URI, TRACEABILITY_EXTENSION_URI, type AgentCard } from '@vicoop-bridge/protocol';

/** Match advertised input modes to the caller admission gate, without mutating host cards. */
export function callerRuntimeCard(card: AgentCard, kind: string, custom = false, fileDelivery = false, operations: readonly string[] = []): AgentCard {
  if (fileDelivery && kind !== 'claude' && kind !== 'codex') throw new Error('caller fileDelivery currently supports Claude and Codex only');
  const outputModes = ['text/plain', ...(operations.length ? ['application/json'] : []), ...(fileDelivery ? ['*/*'] : [])];
  const outputDescription = [fileDelivery ? 'Files can be delivered as inline A2A FileParts through send_file, subject to operator path and size limits.' : '', operations.length ? 'The agent can emit structured operation proposals for human review.' : ''].filter(Boolean).join(' ') || 'Output is text only; outgoing files are unsupported.';
  const allowed = ['text/plain', 'image/png', 'image/jpeg', 'image/gif', 'image/webp',
    ...(kind === 'claude' ? ['application/pdf'] : [])];
  const inputModes = (card.defaultInputModes ?? allowed).filter(mode => allowed.includes(mode));
  if (!inputModes.length) throw new Error('container agent card must advertise supported text or inline-file inputs');
  const inputDescription = `Accepts text and inline PNG/JPEG/GIF/WebP images${kind === 'claude' ? ' or PDF documents' : ''}; files must be provided as file.bytes and be at most 5 MiB each.`;
  const customContract = `Container input contract: ${inputDescription} JSON data parts and URI files are unsupported. ${outputDescription}`;
  return {
    ...card,
    description: custom
      ? `${card.description ?? card.name}\n\n${customContract}`
      : `Caller-isolated ${kind} coding agent with a persistent workspace per authenticated caller. ${inputDescription}${fileDelivery || operations.length ? ` ${outputDescription}` : ''}`,
    defaultInputModes: inputModes,
    defaultOutputModes: outputModes,
    capabilities: {
      ...card.capabilities,
      extensions: [
        ...(card.capabilities?.extensions ?? []).filter(extension =>
          ![OPENAI_COMPAT_EXTENSION_URI, TRACEABILITY_EXTENSION_URI, OPERATION_APPROVAL_EXTENSION_URI].includes(extension.uri)),
        ...(operations.length ? [{ uri: OPERATION_APPROVAL_EXTENSION_URI, required: false, params: { operations } }] : []),
      ],
    },
    skills: card.skills?.map(skill => ({
      ...skill,
      description: custom ? `${skill.description ?? skill.name}\n\n${customContract}`
        : `Give an instruction or ask a question in natural language. ${inputDescription}${fileDelivery || operations.length ? ` ${outputDescription}` : ''}`,
    })),
  };
}
