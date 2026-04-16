import { z } from 'zod';

export const PROTOCOL_VERSION = '0.1';

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
});
export type Artifact = z.infer<typeof Artifact>;

export const AgentSkill = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

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
    })
    .optional(),
  defaultInputModes: z.array(z.string()).optional(),
  defaultOutputModes: z.array(z.string()).optional(),
  skills: z.array(AgentSkill).optional(),
  securitySchemes: z.record(z.string(), SecurityScheme).optional(),
  security: z.array(z.record(z.string(), z.array(z.string()))).optional(),
});
export type AgentCard = z.infer<typeof AgentCard>;

export const HelloFrame = z.object({
  type: z.literal('hello'),
  agentId: z.string(),
  agentCard: AgentCard,
  version: z.literal(PROTOCOL_VERSION),
  token: z.string(),
});

export const TaskStatusFrame = z.object({
  type: z.literal('task.status'),
  taskId: z.string(),
  status: TaskStatus,
});

export const TaskArtifactFrame = z.object({
  type: z.literal('task.artifact'),
  taskId: z.string(),
  artifact: Artifact,
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

export type HelloFrame = z.infer<typeof HelloFrame>;
export type TaskStatusFrame = z.infer<typeof TaskStatusFrame>;
export type TaskArtifactFrame = z.infer<typeof TaskArtifactFrame>;
export type TaskCompleteFrame = z.infer<typeof TaskCompleteFrame>;
export type TaskFailFrame = z.infer<typeof TaskFailFrame>;

export const UpFrame = z.discriminatedUnion('type', [
  HelloFrame,
  TaskStatusFrame,
  TaskArtifactFrame,
  TaskCompleteFrame,
  TaskFailFrame,
  PongFrame,
]);
export type UpFrame = z.infer<typeof UpFrame>;

export const TaskAssignFrame = z.object({
  type: z.literal('task.assign'),
  taskId: z.string(),
  contextId: z.string(),
  message: Message,
});

export const TaskCancelFrame = z.object({
  type: z.literal('task.cancel'),
  taskId: z.string(),
});

export const PingFrame = z.object({ type: z.literal('ping') });

export type TaskAssignFrame = z.infer<typeof TaskAssignFrame>;
export type TaskCancelFrame = z.infer<typeof TaskCancelFrame>;

export const DownFrame = z.discriminatedUnion('type', [
  TaskAssignFrame,
  TaskCancelFrame,
  PingFrame,
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
