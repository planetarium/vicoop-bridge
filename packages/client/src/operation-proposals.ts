import { randomUUID } from 'node:crypto';
import { MAX_OPERATION_FIELDS, MAX_OPERATION_REGISTRATION_BYTES, OPERATION_APPROVAL_EXTENSION_URI, OPERATION_PROPOSAL_TYPE, type AgentCard } from '@vicoop-bridge/protocol';
import { z } from 'zod';
import type { TaskAssign, Emit } from './backend.js';

const name = z.string().regex(/^[a-z][a-z0-9_-]{0,62}$/);
export const OperationNames = z.array(name).min(1).max(64);
const proposal = z
  .object({
    operation: name,
    arguments: z.record(
      name,
      z.union([z.string().max(2048), z.number().int().safe(), z.boolean()]),
    ).refine(fields => Object.keys(fields).length <= MAX_OPERATION_FIELDS),
  })
  .strict();

export function hostOperationCard(card: AgentCard, operations?: readonly string[]): AgentCard {
  if (!operations?.length) return card;
  return {
    ...card,
    defaultOutputModes: [...new Set([...(card.defaultOutputModes ?? ['text/plain']), 'application/json'])],
    capabilities: {
      ...card.capabilities,
      extensions: [
        ...(card.capabilities?.extensions ?? []).filter(e => e.uri !== OPERATION_APPROVAL_EXTENSION_URI),
        { uri: OPERATION_APPROVAL_EXTENSION_URI, required: false, params: { operations } },
      ],
    },
  };
}

/** Bind one authenticated, negotiated host turn to the server-selected subset. */
export function hostProposalTool(configured: readonly string[] | undefined, task: TaskAssign, emit: Emit, signal: AbortSignal) {
  if (!configured?.length || !task.executionId || !task.executionScope ||
      !task.requestedExtensions?.includes(OPERATION_APPROVAL_EXTENSION_URI)) return undefined;
  const operations = configured.filter(name => task.operationNames?.includes(name));
  if (!operations.length) return undefined;
  return { definition: proposalToolDefinition(operations), propose: proposalEmitter(operations, task.taskId, emit, signal) };
}

export function proposalToolDefinition(operations: readonly string[]) {
  return {
    name: 'propose_operation',
    description: 'Propose an operation for operator review and host execution.',
    inputSchema: { type: 'object', properties: { operation: { type: 'string', enum: operations }, arguments: { type: 'object' } },
      required: ['operation', 'arguments'], additionalProperties: false },
  };
}

export function proposalEmitter(
  operations: string[],
  taskId: string,
  emit: Emit,
  signal: AbortSignal,
) {
  let count = 0;
  return (input: unknown) => {
    signal.throwIfAborted();
    const parsed = proposal.parse(input);
    if (!operations.includes(parsed.operation)) throw new Error('Unregistered operation');
    const artifactId = randomUUID();
    const registration = { taskId, proposalKey: artifactId, ...parsed };
    if (Buffer.byteLength(JSON.stringify(registration)) > MAX_OPERATION_REGISTRATION_BYTES)
      throw new Error('Proposal exceeds registration limit');
    if (++count > 8) throw new Error('Proposal limit reached');
    emit({
      type: 'task.artifact',
      taskId,
      lastChunk: true,
      artifact: {
        artifactId,
        name: 'operation-proposal',
        extensions: [OPERATION_APPROVAL_EXTENSION_URI],
        parts: [{ kind: 'data', data: { type: OPERATION_PROPOSAL_TYPE, ...parsed } }],
      },
    });
    return { proposed: true, artifactId };
  };
}
