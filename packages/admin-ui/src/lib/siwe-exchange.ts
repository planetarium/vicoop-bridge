// Exchanges a signed SIWE (message, signature) pair for a bridge-issued
// opaque caller token (`vbc_caller_*`). The returned token is the only
// credential subsequently presented to the bridge — admin GraphQL, A2A
// /agents/:id, and the root admin agent all accept opaque tokens and no
// longer accept raw SIWE bearers (see issue #31).

const CALLER_TOKEN_PREFIX = 'vbc_caller_';

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

  // Validate the 2xx body shape: a misconfigured proxy / redirected HTML page
  // could respond 200 with junk, which we'd otherwise silently persist as
  // the auth token.
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new Error('SIWE exchange returned a non-JSON response');
  }
  const payload = body as { access_token?: unknown; token_type?: unknown };
  if (typeof payload.access_token !== 'string' || !payload.access_token.startsWith(CALLER_TOKEN_PREFIX)) {
    throw new Error('SIWE exchange response missing or malformed access_token');
  }
  if (typeof payload.token_type === 'string' && payload.token_type.toLowerCase() !== 'bearer') {
    throw new Error(`SIWE exchange returned unsupported token_type: ${payload.token_type}`);
  }
  return payload.access_token;
}
