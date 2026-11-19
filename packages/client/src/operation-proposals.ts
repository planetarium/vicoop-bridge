import { randomUUID } from 'node:crypto';
import { OPERATION_APPROVAL_EXTENSION_URI } from '@vicoop-bridge/protocol';
import { z } from 'zod';
import type { Emit } from './backend.js';

const name = z.string().regex(/^[a-z][a-z0-9_-]{0,62}$/);
export const OperationNames = z.array(name).min(1).max(64);
const proposal = z
  .object({
    operation: name,
    arguments: z.record(
      name,
      z.union([z.string().max(2048), z.number().int().safe(), z.boolean()]),
    ),
  })
  .strict();

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
    if (++count > 8) throw new Error('Proposal limit reached');
    const artifactId = randomUUID();
    emit({
      type: 'task.artifact',
      taskId,
      lastChunk: true,
      artifact: {
        artifactId,
        name: 'operation-proposal',
        extensions: [OPERATION_APPROVAL_EXTENSION_URI],
        parts: [{ kind: 'data', data: { type: 'vicoop.operation-proposal.v1', ...parsed } }],
      },
    });
    return { proposed: true, artifactId };
  };
}
