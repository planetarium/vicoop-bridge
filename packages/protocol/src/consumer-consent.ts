import { z } from 'zod';

export const CONSUMER_CONSENT_EXTENSION_URI = 'https://github.com/planetarium/vicoop-bridge/blob/main/docs/consumer-consent-v1.md';
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const label = z.string().min(1).max(4096);
const amount = z.string().regex(/^(0|[1-9]\d*)(\.\d+)?$/);
// Estimates are explicitly distinct from executor-enforced caps. The bridge
// records consent; only the registered executor can enforce provider spending.
export const ConsentCost = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('estimate'), currency: label, amount, terms: label }).strict(),
  z.object({ kind: z.literal('variable'), currency: label, terms: label }).strict(),
  z.object({ kind: z.literal('cap'), currency: label, amount, terms: label, enforcedBy: label }).strict(),
]);
export const ConsentRequest = z.object({
  prompt: label,
  references: z.array(z.object({ id: label, sha256: digest }).strict()).max(64),
  provider: label,
  model: label,
  settings: z.record(z.unknown()),
  output: z.record(z.unknown()),
  limitations: z.array(label).max(64),
  externalUpload: z.object({ required: z.boolean(), destinations: z.array(z.string().url()).max(32) }).strict(),
  cost: ConsentCost,
}).strict();
export type ConsentRequest = z.infer<typeof ConsentRequest>;
export const ConsentRegistration = z.object({
  operationId: z.string().uuid(),
  sourceTaskId: label,
  sourceExecutionId: label,
  expiresAt: z.string().datetime(),
  approverPolicy: z.object({ kind: z.literal('originating-consumer') }).strict(),
  maxAttempts: z.literal(1),
  request: ConsentRequest,
}).strict();
export type ConsentRegistration = z.infer<typeof ConsentRegistration>;
export const ConsentCorrelation = z.object({ version: z.literal(1), payloadDigest: digest }).strict();
export const ConsentDecision = ConsentCorrelation.extend({
  contextId: label,
  decisionId: z.string().uuid(),
  decision: z.enum(['approve', 'reject']),
}).strict();
export type ConsentDecision = z.infer<typeof ConsentDecision>;
export const ConsentClaim = ConsentCorrelation.extend({ claimId: z.string().uuid() }).strict();
export type ConsentClaim = z.infer<typeof ConsentClaim>;
export const ConsentResult = ConsentClaim.extend({
  outcome: z.enum(['succeeded', 'failed', 'unknown']),
  providerJobId: label.optional(),
  result: z.record(z.unknown()).optional(),
}).strict();
export type ConsentResult = z.infer<typeof ConsentResult>;
