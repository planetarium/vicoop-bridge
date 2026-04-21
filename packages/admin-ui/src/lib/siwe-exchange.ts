// Exchanges a signed SIWE (message, signature) pair for a bridge-issued
// opaque caller token (`vbc_caller_*`). The returned token is the only
// credential subsequently presented to the bridge — admin GraphQL, A2A
// /agents/:id, and the root admin agent all accept opaque tokens and no
// longer accept raw SIWE bearers (see issue #31).

interface ExchangeResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
}

export async function exchangeSiweForCallerToken(
  message: string,
  signature: string,
): Promise<string> {
  const res = await fetch('/auth/siwe/exchange', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message, signature }),
  });
  if (!res.ok) {
    let description = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error_description?: string; error?: string };
      description = body.error_description ?? body.error ?? description;
    } catch {
      // ignore: non-JSON body
    }
    throw new Error(`SIWE exchange failed: ${description}`);
  }
  const body = (await res.json()) as ExchangeResponse;
  return body.access_token;
}
