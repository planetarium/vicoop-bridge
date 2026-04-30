// Exchanges a signed SIWE (message, signature) pair for a bridge-issued
// opaque owner-session token (`vbc_owner_*`). The returned token is what
// the admin UI presents on /graphql and POST / for self-service operations
// (see issue #31 for the original opaque-token model and #79 PR D for the
// caller/owner-session audience split).

const OWNER_SESSION_PREFIX = 'vbc_owner_';

export async function exchangeSiweForCallerToken(
  message: string,
  signature: string,
): Promise<string> {
  const res = await fetch('/auth/siwe/exchange', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    // intent=owner_session: SIWE in the admin UI is for the wallet owner
    // managing their own clients/policies, not for being added as a third-
    // party caller of someone else's agent. The server defaults to
    // owner_session anyway, but be explicit so a future server default
    // change doesn't silently break the UI.
    body: JSON.stringify({ message, signature, intent: 'owner_session' }),
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
  if (typeof payload.access_token !== 'string' || !payload.access_token.startsWith(OWNER_SESSION_PREFIX)) {
    throw new Error('SIWE exchange response missing or malformed access_token (expected vbc_owner_* prefix)');
  }
  if (typeof payload.token_type === 'string' && payload.token_type.toLowerCase() !== 'bearer') {
    throw new Error(`SIWE exchange returned unsupported token_type: ${payload.token_type}`);
  }
  return payload.access_token;
}
