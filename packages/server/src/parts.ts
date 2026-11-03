import type { Message, Part, PartBase, Task } from '@a2x/sdk';
import type { Part as WirePart } from '@vicoop-bridge/protocol';

// WS parts (and tasks persisted before #549) use the v0.3 nested file
// shape. SDK response mappers require flat fields, even for v0.3 output.
export function partToA2X(part: Part | (WirePart & PartBase)): Part {
  if ('file' in part) {
    const { kind: _kind, file, ...rest } = part;
    return {
      ...rest,
      ...(file.bytes !== undefined ? { raw: file.bytes } : {}),
      ...(file.uri !== undefined ? { url: file.uri } : {}),
      ...(file.name !== undefined ? { filename: file.name } : {}),
      ...(file.mimeType !== undefined ? { mediaType: file.mimeType } : {}),
    };
  }
  if ('kind' in part) {
    const { kind: _kind, ...rest } = part;
    return rest;
  }
  return part;
}

// Normalize only part-bearing fields, leaving metadata / extension payloads
// opaque. Reads remain compatible with both old rows and new SDK-shaped rows;
// no database migration or mutation of the supplied task is required.
export function normalizeTaskParts(task: Task): Task {
  const message = (m: Message): Message => ({ ...m, parts: m.parts.map(partToA2X) });
  return {
    ...task,
    ...(task.status.message ? {
      status: { ...task.status, message: message(task.status.message) },
    } : {}),
    ...(task.history ? { history: task.history.map(message) } : {}),
    ...(task.artifacts ? {
      artifacts: task.artifacts.map((a) => ({ ...a, parts: a.parts.map(partToA2X) })),
    } : {}),
  };
}
