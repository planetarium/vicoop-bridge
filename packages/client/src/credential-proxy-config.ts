import { z } from 'zod';
import { isAbsolute } from 'node:path';

// These are operator configuration, never model arguments. Keep credentials
// as host-side references; neither the reference nor its value goes on wire.
const origin = z.string().url().refine(value => {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && u.origin === value && !u.username && !u.password;
  } catch { return false; }
}, 'origins must be canonical HTTPS origins without paths or credentials');
export const CredentialProxyConfig = z.object({
  services: z.array(z.object({
    name: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/),
    origins: z.array(origin).min(1).max(16),
    credential: z.union([
      z.object({ env: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/) }).strict(),
      z.object({ file: z.string().refine(isAbsolute, 'credential file must be absolute') }).strict(),
    ]),
    header: z.string().regex(/^[a-zA-Z0-9!#$%&'*+.^_`|~-]+$/)
      .transform(v => v.toLowerCase())
      .refine(v => !['host', 'connection', 'content-length', 'transfer-encoding', 'upgrade', 'trailer',
        'te', 'expect', 'cookie', 'accept-encoding', 'proxy-authorization', 'proxy-authenticate',
        'x-fal-target-url', 'x-vicoop-target-url', 'x-vicoop-proxy-token'].includes(v), 'invalid credential header'),
    prefix: z.string().max(64).regex(/^[\x20-\x7e]*$/).default(''),
  }).strict()).min(1).max(8)
    .refine(services => new Set(services.map(s => s.name)).size === services.length, 'service names must be unique'),
  maxConcurrent: z.number().int().min(1).max(16).default(4),
  maxRequests: z.number().int().min(1).max(100000).default(1024),
  maxRequestBytes: z.number().int().min(1).max(1024 * 1024 * 1024).default(64 * 1024 * 1024),
  maxResponseBytes: z.number().int().min(1).max(1024 * 1024 * 1024).default(256 * 1024 * 1024),
  timeoutMs: z.number().int().min(1000).max(3600000).default(300000),
}).strict();
export type CredentialProxyOptions = z.infer<typeof CredentialProxyConfig>;
