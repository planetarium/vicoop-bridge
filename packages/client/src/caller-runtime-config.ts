import { z } from 'zod';
import { isAbsolute } from 'node:path';

const absolutePath = z
  .string()
  .min(1)
  .refine(isAbsolute, 'must be an absolute path');
export const CallerRuntimeConfig = z
  .object({
    image: z
      .string()
      .regex(/^(?:sha256:[a-f0-9]{64}|\S+@sha256:[a-f0-9]{64})$/),
    credentialSource: z.enum(['api-key-file', 'host-claude']).default('api-key-file'),
    credentialFile: absolutePath.optional(),
    stateDirectory: absolutePath,
    maxScopes: z.number().int().min(1).max(32).optional(),
    queueLimit: z.number().int().min(0).max(128).optional(),
    workspaceMiB: z.number().int().min(8).max(512).optional(),
    taskTimeoutMs: z.number().int().min(1000).max(3_600_000).optional(),
  })
  .strict()
  .superRefine((config, ctx) => {
    if (config.credentialSource === 'api-key-file' && !config.credentialFile)
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['credentialFile'], message: 'required for api-key-file' });
    if (config.credentialSource === 'host-claude' && config.credentialFile)
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['credentialFile'], message: 'must be omitted for host-claude' });
  });
