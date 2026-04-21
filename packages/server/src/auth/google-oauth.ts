// Google OAuth 2.0 (web server flow) used internally to authenticate device flow sessions.
// Callers never see Google endpoints directly — bridge-server is their OAuth AS.

import { OAuth2Client } from 'google-auth-library';

export interface GoogleConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;      // `${PUBLIC_URL}/oauth/google/callback`
}

export interface GoogleUserInfo {
  sub: string;              // stable, unique Google account id
  email: string;
  emailVerified: boolean;
  hostedDomain?: string;    // 'hd' claim for Workspace accounts
}

// Build a Google OAuth authorize URL. The `state` param is already HMAC-signed
// by the caller (device-ui.ts); this function does not add any additional binding.
export function buildAuthorizeUrl(cfg: GoogleConfig, state: string): string {
  const client = new OAuth2Client(cfg.clientId, cfg.clientSecret, cfg.redirectUri);
  return client.generateAuthUrl({
    access_type: 'online',
    scope: ['openid', 'email', 'profile'],
    state,
    // Force account chooser so users on shared machines can pick the right identity.
    prompt: 'select_account',
  });
}

// Exchange an authorization code for an id_token. Verifies aud, iss, exp, and
// email_verified. Throws on any mismatch.
export async function exchangeCode(
  cfg: GoogleConfig,
  code: string,
): Promise<GoogleUserInfo> {
  // Fresh client per call — keeps this stateless and avoids token leakage across requests.
  const client = new OAuth2Client(cfg.clientId, cfg.clientSecret, cfg.redirectUri);

  let idToken: string | null | undefined;
  try {
    const { tokens } = await client.getToken(code);
    idToken = tokens.id_token;
  } catch {
    // Don't leak raw code or upstream error text.
    throw new Error('Google token exchange failed');
  }

  if (!idToken) {
    throw new Error('Google response missing id_token');
  }

  let payload;
  try {
    // verifyIdToken validates signature (JWKS), aud, iss (accounts.google.com),
    // and exp automatically.
    const ticket = await client.verifyIdToken({
      idToken,
      audience: cfg.clientId,
    });
    payload = ticket.getPayload();
  } catch {
    throw new Error('Google id_token verification failed');
  }

  if (!payload) {
    throw new Error('Google id_token payload missing');
  }

  const sub = payload.sub;
  const email = payload.email;
  const emailVerified = payload.email_verified;
  const hd = payload.hd;

  if (!sub || typeof sub !== 'string') {
    throw new Error('Google id_token missing sub claim');
  }
  if (!email || typeof email !== 'string') {
    throw new Error('Google id_token missing email claim');
  }
  if (emailVerified !== true) {
    throw new Error('Google account email is not verified');
  }

  return {
    sub,
    email,
    emailVerified: true,
    hostedDomain: typeof hd === 'string' && hd.length > 0 ? hd : undefined,
  };
}
