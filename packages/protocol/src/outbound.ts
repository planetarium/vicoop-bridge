import { z } from 'zod';

export const OUTBOUND_CAPABILITY = 'mentionable-publication-v1';

export const OutboundRequest = z.object({
  target: z.string().max(4096).refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && !url.username && !url.password &&
        !value.includes('#') && url.href === value;
    } catch { return false; }
  }, 'expected a canonical HTTPS target URI'),
  // SHA-256, padded canonical base64 (the last symbol has two zero pad bits).
  digest: z.string().length(44).regex(/^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/),
}).strict();
export type OutboundRequest = z.infer<typeof OutboundRequest>;

export const OutboundHeaders = z.object({
  'content-type': z.literal('application/json'),
  'content-digest': z.string().max(80),
  'mentionable-agent': z.string().max(256),
  'mentionable-subject': z.string().max(2048),
  'signature-input': z.string().max(1024),
  signature: z.string().max(128),
}).strict();
export type OutboundHeaders = z.infer<typeof OutboundHeaders>;

export const OutboundSignFrame = z.object({
  type: z.literal('outbound.sign'), requestId: z.string().uuid(), request: OutboundRequest,
}).strict();
export const OutboundResultFrame = z.object({
  type: z.literal('outbound.result'), requestId: z.string().uuid(), headers: OutboundHeaders.nullable(),
});
