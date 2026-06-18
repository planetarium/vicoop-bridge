import { z } from 'zod';

export const PROTOCOL_VERSION = '0.1';
export const TRACEABILITY_EXTENSION_URI =
  'https://github.com/a2aproject/a2a-samples/extensions/traceability/v1';
export const SIWE_BEARER_AUTH_EXTENSION_URI =
  'https://github.com/planetarium/a2a-x402-wallet/tree/main/docs/siwe-bearer-auth/v0.1';
export const OPENAI_COMPAT_EXTENSION_URI =
  'https://github.com/planetarium/oai2a2a/extensions/openai-compat/v1';

export const TextPart = z.object({
  kind: z.literal('text'),
  text: z.string(),
});

export const FilePart = z.object({
  kind: z.literal('file'),
  file: z.object({
    name: z.string().optional(),
    mimeType: z.string().optional(),
    bytes: z.string().optional(),
    uri: z.string().optional(),
  }),
});

export const DataPart = z.object({
  kind: z.literal('data'),
  data: z.record(z.string(), z.unknown()),
});

export const Part = z.discriminatedUnion('kind', [TextPart, FilePart, DataPart]);
export type Part = z.infer<typeof Part>;

export const Message = z.object({
  role: z.enum(['user', 'agent']),
  parts: z.array(Part),
  messageId: z.string(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  extensions: z.array(z.string()).optional(),
});
export type Message = z.infer<typeof Message>;

export const TaskStatusState = z.enum([
  'submitted',
  'working',
  'input-required',
  'completed',
  'canceled',
  'failed',
]);
export type TaskStatusState = z.infer<typeof TaskStatusState>;

export const TaskStatus = z.object({
  state: TaskStatusState,
  message: Message.optional(),
  timestamp: z.string().optional(),
});
export type TaskStatus = z.infer<typeof TaskStatus>;

export const Artifact = z.object({
  artifactId: z.string(),
  name: z.string().optional(),
  parts: z.array(Part),
  metadata: z.record(z.string(), z.unknown()).optional(),
  extensions: z.array(z.string()).optional(),
});
export type Artifact = z.infer<typeof Artifact>;

export const AgentSkill = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

export const AgentExtension = z.object({
  uri: z.string(),
  description: z.string().optional(),
  required: z.boolean().optional(),
  params: z.record(z.string(), z.unknown()).optional(),
});
export type AgentExtension = z.infer<typeof AgentExtension>;

// Per planetarium/oai2a2a#63: `openai-compat/v1` AgentExtension may carry an
// optional `params.models[]` advertise block. Each entry: `id` required;
// `reasoning` / `default` optional. The shape is advisory and forward-compat
// — receivers MUST ignore unknown sub-fields.
export const OpenAICompatModelAdvertise = z.object({
  id: z.string().min(1),
  reasoning: z.boolean().optional(),
  default: z.boolean().optional(),
});
export type OpenAICompatModelAdvertise = z.infer<typeof OpenAICompatModelAdvertise>;

// `.passthrough()` so a future forward-compatible sub-field added in the same
// extension URI (the spec explicitly allows additive growth without a new
// URI) parses through ours instead of stripping the value.
export const OpenAICompatExtensionParams = z
  .object({
    models: z.array(OpenAICompatModelAdvertise).optional(),
  })
  .passthrough();
export type OpenAICompatExtensionParams = z.infer<typeof OpenAICompatExtensionParams>;

// Build the `params` value for the openai-compat/v1 AgentExtension entry.
// Returns `undefined` when `models` is empty so callers can omit `params`
// entirely rather than emit a `{ models: [] }` that advertises emptiness —
// per spec, absence of `params.models` MUST NOT be read as "no models
// supported."
//
// First-wins `default` normalisation: spec says "At most one entry SHOULD
// set default: true; if multiple do, receivers SHOULD treat the first as
// the default." We enforce on the producer side by stripping `default` from
// subsequent entries, so the wire we emit is always conformant.
export function buildOpenAICompatExtensionParams(
  models: readonly OpenAICompatModelAdvertise[],
): OpenAICompatExtensionParams | undefined {
  if (models.length === 0) return undefined;
  let sawDefault = false;
  const normalised = models.map((m) => {
    if (!m.default) return { ...m };
    if (sawDefault) {
      const { default: _drop, ...rest } = m;
      return { ...rest };
    }
    sawDefault = true;
    return { ...m };
  });
  return { models: normalised };
}

// Return a shallow copy of `card` with `params.models` set on the
// `openai-compat/v1` extension entry. No-op (returns the input as-is) when
// `models` is empty or when the card does not declare the extension — we
// never *add* the extension just to advertise models, because that would
// imply support the agent may not have.
export function withOpenAICompatModelsAdvertise(
  card: AgentCard,
  models: readonly OpenAICompatModelAdvertise[],
): AgentCard {
  const params = buildOpenAICompatExtensionParams(models);
  if (!params) return card;
  const exts = card.capabilities?.extensions;
  if (!exts) return card;
  const idx = exts.findIndex((e) => e.uri === OPENAI_COMPAT_EXTENSION_URI);
  if (idx < 0) return card;
  const target = exts[idx];
  const mergedParams = { ...(target.params ?? {}), ...params };
  const nextExts = exts.slice();
  nextExts[idx] = { ...target, params: mergedParams };
  return {
    ...card,
    capabilities: { ...card.capabilities, extensions: nextExts },
  };
}

export const SecurityScheme = z.object({
  type: z.string(),
  scheme: z.string().optional(),
  bearerFormat: z.string().optional(),
  description: z.string().optional(),
  in: z.enum(['header', 'query', 'cookie']).optional(),
  name: z.string().optional(),
}).passthrough();

export const AgentCard = z.object({
  name: z.string(),
  description: z.string().optional(),
  version: z.string(),
  protocolVersion: z.string().default('0.3.0'),
  url: z.string().optional(),
  capabilities: z
    .object({
      streaming: z.boolean().optional(),
      pushNotifications: z.boolean().optional(),
      extensions: z.array(AgentExtension).optional(),
    })
    .optional(),
  defaultInputModes: z.array(z.string()).optional(),
  defaultOutputModes: z.array(z.string()).optional(),
  skills: z.array(AgentSkill).optional(),
  securitySchemes: z.record(z.string(), SecurityScheme).optional(),
  security: z.array(z.record(z.string(), z.array(z.string()))).optional(),
});
export type AgentCard = z.infer<typeof AgentCard>;

export const BackendKind = z.string().min(1);
export type BackendKind = z.infer<typeof BackendKind>;

export const HelloFrame = z.object({
  type: z.literal('hello'),
  agentId: z.string(),
  agentCard: AgentCard.optional(),
  backendKind: BackendKind.optional(),
  version: z.literal(PROTOCOL_VERSION),
  token: z.string(),
});

export const TaskStatusFrame = z.object({
  type: z.literal('task.status'),
  taskId: z.string(),
  status: TaskStatus,
  // Optional, passed through verbatim onto the A2A
  // `TaskStatusUpdateEvent.metadata` (top-level) by the server. Used by the
  // openai-compat/v1 liveness heartbeat: a non-terminal `working` status
  // tagged `metadata[OPENAI_COMPAT_EXTENSION_URI] = { heartbeat: true }` is
  // translated by the oai2a2a codec into a `: a2a-heartbeat` SSE comment so a
  // byte-silent-but-live backend re-arms the consumer's stall watchdog rather
  // than being false-failed-over (planetarium/a2x-internal-router#95).
  //
  // Intentionally FREEFORM (mirrors `Message.metadata` / `Artifact.metadata`
  // above, and the A2A SDK's own `TaskStatusUpdateEvent.metadata`). This is the
  // generic transport layer; it stays a namespaced-by-extension-URI passthrough
  // and deliberately does NOT schematize `heartbeat` (or any other marker).
  // Schematizing here would couple the transport to one extension's semantics
  // and force a protocol change for every future marker — defeating the A2A
  // extension model (additive, transport-agnostic, "receivers MUST ignore
  // unknown metadata"). The marker's schema lives at the edges that own the
  // semantics: the typed producer `buildHeartbeatStatusFrame()` (client) and
  // the oai2a2a codec + openai-compat/v1 spec (consumer). Go structured here
  // only if liveness ever becomes a first-class transport concept rather than
  // an extension marker.
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const TaskArtifactFrame = z.object({
  type: z.literal('task.artifact'),
  taskId: z.string(),
  artifact: Artifact,
  append: z.boolean().optional(),
  lastChunk: z.boolean().optional(),
});

export const TaskCompleteFrame = z.object({
  type: z.literal('task.complete'),
  taskId: z.string(),
  status: TaskStatus,
});

export const TaskFailFrame = z.object({
  type: z.literal('task.fail'),
  taskId: z.string(),
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
});

export const PongFrame = z.object({ type: z.literal('pong') });

// Response to a server-initiated `usage.request` (see DownFrame). Correlated by
// `requestId`. `usage` is the backend's opaque usage payload (e.g. the
// vicoop-codex `{ accounts: [...] }` shape) — kept `unknown` so the payload can
// evolve without a protocol bump; the server passes it through verbatim.
export const UsageResponseFrame = z.object({
  type: z.literal('usage.response'),
  requestId: z.string(),
  ok: z.boolean(),
  usage: z.unknown().optional(),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
    })
    .optional(),
});

export type HelloFrame = z.infer<typeof HelloFrame>;
export type TaskStatusFrame = z.infer<typeof TaskStatusFrame>;
export type TaskArtifactFrame = z.infer<typeof TaskArtifactFrame>;
export type TaskCompleteFrame = z.infer<typeof TaskCompleteFrame>;
export type TaskFailFrame = z.infer<typeof TaskFailFrame>;
export type UsageResponseFrame = z.infer<typeof UsageResponseFrame>;

export const UpFrame = z.discriminatedUnion('type', [
  HelloFrame,
  TaskStatusFrame,
  TaskArtifactFrame,
  TaskCompleteFrame,
  TaskFailFrame,
  PongFrame,
  UsageResponseFrame,
]);
export type UpFrame = z.infer<typeof UpFrame>;

export const TaskAssignFrame = z.object({
  type: z.literal('task.assign'),
  taskId: z.string(),
  contextId: z.string(),
  message: Message,
  requestedExtensions: z.array(z.string()).optional(),
});

export const TaskCancelFrame = z.object({
  type: z.literal('task.cancel'),
  taskId: z.string(),
});

export const PingFrame = z.object({ type: z.literal('ping') });

// Server→client request for the backend's current usage snapshot. The client
// replies with a `usage.response` UpFrame carrying the same `requestId`. Only
// backends that implement `usage()` can satisfy it; others reply with an error.
export const UsageRequestFrame = z.object({
  type: z.literal('usage.request'),
  requestId: z.string(),
});

export type TaskAssignFrame = z.infer<typeof TaskAssignFrame>;
export type TaskCancelFrame = z.infer<typeof TaskCancelFrame>;
export type UsageRequestFrame = z.infer<typeof UsageRequestFrame>;

export const DownFrame = z.discriminatedUnion('type', [
  TaskAssignFrame,
  TaskCancelFrame,
  PingFrame,
  UsageRequestFrame,
]);
export type DownFrame = z.infer<typeof DownFrame>;

export function encodeFrame(frame: UpFrame | DownFrame): string {
  return JSON.stringify(frame);
}

export function parseUpFrame(raw: string): UpFrame {
  return UpFrame.parse(JSON.parse(raw));
}

export function parseDownFrame(raw: string): DownFrame {
  return DownFrame.parse(JSON.parse(raw));
}
