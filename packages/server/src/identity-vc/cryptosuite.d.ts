declare module '@digitalbazaar/eddsa-jcs-2022-cryptosuite' {
  export function createVerifyCryptosuite(): unknown;
  export function createSignCryptosuite(): unknown;
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
