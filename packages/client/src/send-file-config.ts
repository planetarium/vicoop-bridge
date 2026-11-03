import { isAbsolute } from 'node:path';
import { z } from 'zod';

// Leave room for base64 and JSON inside the server's 16 MiB WS frame limit.
export const MAX_CLAUDE_SEND_FILE_BYTES = 8 * 1024 * 1024;
export const DEFAULT_CLAUDE_SEND_FILE_BYTES = 6 * 1024 * 1024;
export const ClaudeSendFileConfig = z.object({
  allowed_roots: z.array(z.string().trim().min(1).refine(isAbsolute, 'send_file roots must be absolute paths')).min(1).max(16),
  max_bytes: z.number().int().min(1).max(MAX_CLAUDE_SEND_FILE_BYTES).default(DEFAULT_CLAUDE_SEND_FILE_BYTES),
}).strict();
export type ClaudeSendFileConfig = z.infer<typeof ClaudeSendFileConfig>;

export function sendFilePendingBytes(config: ClaudeSendFileConfig | undefined): number | undefined {
  // Retain at least two full file frames while awaiting gateway acknowledgements.
  return config ? Math.max(4 * 1024 * 1024, 2 * (4 * Math.ceil(config.max_bytes / 3) + 1024 * 1024)) : undefined;
}
