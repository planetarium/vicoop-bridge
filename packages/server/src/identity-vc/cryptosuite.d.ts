declare module '@digitalbazaar/eddsa-jcs-2022-cryptosuite' {
  export function createVerifyCryptosuite(): unknown;
  export function createSignCryptosuite(): unknown;
}

declare module '@digitalbazaar/data-integrity' {
  export class DataIntegrityProof {
    constructor(options: { cryptosuite: unknown });
  }
}

declare module '@digitalbazaar/vc' {
  export class CredentialIssuancePurpose {
    constructor(options?: { controller?: Record<string, unknown> });
  }

  export function verifyCredential(options: {
    credential: Record<string, unknown>;
    suite: unknown;
    purpose: CredentialIssuancePurpose;
    documentLoader(url: string): Promise<{
      contextUrl: null;
      documentUrl: string;
      document: Record<string, unknown>;
    }>;
    now?: Date;
    maxClockSkew?: number;
  }): Promise<{ verified: boolean; error?: unknown }>;
}

declare module '@digitalbazaar/ed25519-multikey' {
  export function generate(options?: { seed?: Uint8Array }): Promise<{
    id: string;
    controller: string;
    signer(): { sign(input: { data: Uint8Array }): Promise<Uint8Array> };
    export(options: { publicKey: boolean; includeContext?: boolean }): Promise<Record<string, unknown>>;
  }>;
  export function from(input: Record<string, unknown>): Promise<unknown>;
}
