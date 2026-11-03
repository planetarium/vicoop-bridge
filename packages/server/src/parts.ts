import type { Message, Part, PartBase, Task } from '@a2x/sdk';
import type { Part as WirePart } from '@vicoop-bridge/protocol';

// WS parts (and tasks persisted before #549) use the v0.3 nested file
// shape. SDK response mappers require flat fields, even for v0.3 output.
export function partToA2X(part: Part | (WirePart & PartBase)): Part {
  // Caller history is not parsed by the WS schema. Match the SDK's field
  // precedence: an extra `file` property must not turn text/data or an
  // already-flat file into a nested file (and may be null or a primitive).
  const sdkPart = 'text' in part || 'data' in part || 'raw' in part || 'url' in part;
  if (!sdkPart && 'file' in part && typeof part.file === 'object'
    && part.file !== null && !Array.isArray(part.file)) {
    const { kind: _kind, file, ...rest } = part;
    return {
      ...rest,
      ...(typeof file.bytes === 'string' ? { raw: file.bytes } : {}),
      ...(typeof file.uri === 'string' ? { url: file.uri } : {}),
      ...(typeof file.name === 'string' ? { filename: file.name } : {}),
      ...(typeof file.mimeType === 'string' ? { mediaType: file.mimeType } : {}),
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
