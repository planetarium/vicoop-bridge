import { z } from 'zod';
import { isAbsolute } from 'node:path';

export const CallerRuntimeConfig = z
  .object({
    image: z
      .string()
      .regex(
        /^(?:sha256:[a-f0-9]{64}|\S+@sha256:[a-f0-9]{64})$/,
        'caller image must be pinned by digest',
      ),
    stateDirectory: z.string().min(1).refine(isAbsolute, 'stateDirectory must be an absolute path; for existing state, use its original absolute location'),
    maxScopes: z.number().int().min(1).max(32).default(8),
    queueLimit: z.number().int().min(0).max(128).default(16),
    maxContexts: z.number().int().min(1).max(4096).default(256),
    taskTimeoutMs: z.number().int().min(1000).max(3600000).default(600000),
    memoryMiB: z.number().int().min(512).max(16384).default(2048),
    cpus: z.number().min(0.25).max(16).default(1),
    pids: z.number().int().min(64).max(1024).default(256),
    storageMiB: z.number().int().min(64).max(65536).default(1024),
  })
  .strict();
export type CallerRuntimeOptions = z.infer<typeof CallerRuntimeConfig>;
