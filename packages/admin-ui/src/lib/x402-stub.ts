// Stub for the optional `x402/*` peer dependency that @a2x/sdk imports
// at module top level for its payment-flow code path. Admin UI never
// passes `x402: {...}` to A2XClient, so the payment helpers are never
// invoked at runtime. The stubs exist purely so Vite/Rollup's static
// import resolution succeeds.

export const createPaymentHeader = () => {
  throw new Error('x402 payment flow is not supported in admin-ui');
};

export const safeBase64Decode = (s: string): string => s;

export const PaymentPayloadSchema = {
  parse: (v: unknown) => v,
  safeParse: (v: unknown) => ({ success: true, data: v }),
};

export type Network = string;
export type PaymentPayload = unknown;
export type PaymentRequirements = unknown;
export type VerifyResponse = unknown;
