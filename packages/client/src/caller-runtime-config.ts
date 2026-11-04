import { CallerFileDeliveryConfig, callerFilePendingBytes } from './caller-file-delivery.js';
import { z } from 'zod';
import { isAbsolute, posix } from 'node:path';

export const CallerRuntimeConfig = z
  .object({
    image: z
      .string()
      .regex(
        /^(?:sha256:[a-f0-9]{64}|\S+@sha256:[a-f0-9]{64})$/,
        'caller image must be pinned by digest',
      ),
    stateDirectory: z.string().min(1).refine(isAbsolute, 'stateDirectory must be an absolute path; for existing state, use its original absolute location'),
    // Only operators choose sources; destinations cannot overlap private storage.
    sharedBinds: z.array(z.object({
      name: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/),
      source: z.string().refine(source =>
        source.startsWith('/') && source !== '/' && posix.normalize(source) === source &&
        !source.endsWith('/') && !/[,"\\\x00-\x1f\x7f]/.test(source),
      'shared bind source must be a normalized absolute directory path without mount-option delimiters'),
    }).strict()).max(16).default([])
      .refine(entries => new Set(entries.map(entry => entry.name)).size === entries.length, 'shared bind names must be unique')
      .refine(entries => new Set(entries.map(entry => entry.source)).size === entries.length, 'shared bind sources must be unique'),
    systemPrompt: z.string().refine(value => value.trim().length > 0 &&
      !value.includes('\0') && Buffer.byteLength(value, 'utf8') <= 64 * 1024,
    'systemPrompt must be nonblank, NUL-free and at most 64 KiB').optional(),
    // Operator-owned plain Docker volumes, shared by all callers of this agent.
    sharedVolumes: z.array(z.object({
      name: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/),
      volume: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/)
        .refine(name => !name.startsWith('vb-') && !name.startsWith('vicoop-'), 'bridge-managed volumes cannot be shared'),
    }).strict()).max(16).default([])
      .refine(entries => new Set(entries.map(entry => entry.name)).size === entries.length, 'shared volume names must be unique')
      .refine(entries => new Set(entries.map(entry => entry.volume)).size === entries.length, 'shared volumes must be unique'),
    fileDelivery: CallerFileDeliveryConfig.optional(),
    maxScopes: z.number().int().min(1).max(32).default(8),
    queueLimit: z.number().int().min(0).max(128).default(16),
    maxContexts: z.number().int().min(1).max(4096).default(256),
    taskTimeoutMs: z.number().int().min(1000).max(3600000).default(600000),
    memoryMiB: z.number().int().min(512).max(16384).default(2048),
    cpus: z.number().min(0.25).max(16).default(1),
    pids: z.number().int().min(64).max(1024).default(256),
    // container init enables filesystem enforcement. Reservation is within the Docker daemon's
    // backing filesystem; a thin VM disk does not reserve outer host capacity.
    fixedImageStorage: z.object({
      image: z.string().regex(/^sha256:[a-f0-9]{64}$/, 'storage manager image must be pinned by local image ID'),
      poolVolume: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/),
      capacityMiB: z.number().int().min(64).max(16777216),
      reserveMiB: z.number().int().min(64).max(16777216),
      reservationBoundary: z.literal('docker-filesystem'),
    }).strict().optional(),
    storageMiB: z.number().int().min(64).max(65536).default(1024),
  })
  .strict()
  .superRefine((config, context) => {
    try { callerFilePendingBytes(config.fileDelivery, config.maxScopes); }
    catch (error) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['fileDelivery'],
        message: error instanceof Error ? error.message : String(error) });
    }
  })
  .refine(config => new Set([...config.sharedVolumes, ...config.sharedBinds].map(entry => entry.name)).size ===
    config.sharedVolumes.length + config.sharedBinds.length, 'shared mount targets must be unique across volumes and binds');
export type CallerRuntimeOptions = z.infer<typeof CallerRuntimeConfig>;

export function assertCallerRuntimeBackend(kind: string, config: { systemPrompt?: unknown }): void {
  if (kind !== 'claude' && config.systemPrompt !== undefined)
    throw new Error('caller_runtime.systemPrompt is supported only for Claude');
}
