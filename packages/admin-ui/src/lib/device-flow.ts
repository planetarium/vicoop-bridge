// Browser-side driver for the bridge's onsite Google sign-in.
//
// The wire surface is still RFC-8628 device flow under the hood —
// /oauth/device/code allocates a device_session row, /oauth/google/start
// runs Google consent — but the browser receives the issued
// `vbc_owner_*` token via `postMessage` from the popup once the callback
// finishes, instead of polling /oauth/token. The server-side onsite
// branch (packages/server/src/auth/device-ui.ts) issues the token inline
// in the callback handler and posts it back to the opener.
//
// CLI device flow (no `onsite_origin` in state) keeps polling — that
// path is unchanged.

const OWNER_SESSION_PREFIX = 'vbc_owner_';

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

export interface DeviceFlowSession {
  /** Open this in a popup so the user can sign in to Google. */
  verificationUriComplete: string;
  userCode: string;
  /**
   * Resolves with a `vbc_owner_*` token once the popup approval completes.
   * Rejects on expiry, server error, or `cancel()` invocation.
   */
  result: Promise<string>;
  /** Aborts the pending flow. The result promise will reject. */
  cancel: () => void;
}

interface PostMessagePayload {
  type?: unknown;
  access_token?: unknown;
  token_type?: unknown;
  expires_in?: unknown;
  audience?: unknown;
}

async function postDeviceCode(): Promise<DeviceCodeResponse> {
  const body = new URLSearchParams({ intent: 'owner_session' });
  const res = await fetch('/oauth/device/code', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) {
    throw new Error(`device/code HTTP ${res.status}`);
  }
  return (await res.json()) as DeviceCodeResponse;
}

/**
 * Start an onsite Google sign-in session. The caller opens
 * `verificationUriComplete` in a popup as part of a click handler.
 * The popup runs Google consent on the bridge origin, then posts the
 * issued token back here via `postMessage`.
 */
export async function startDeviceFlow(): Promise<DeviceFlowSession> {
  const code = await postDeviceCode();
  const expiresAt = Date.now() + code.expires_in * 1000;

  // Skip the CLI-style /oauth/device confirmation page; popup goes
  // straight to /oauth/google/start. Pass the admin UI's own origin so
  // the callback knows where to postMessage the issued token. The
  // popup still loads on the bridge origin (PUBLIC_URL), reused from
  // verification_uri_complete.
  const startUrl = new URL(code.verification_uri_complete);
  const bridgeOrigin = startUrl.origin;
  startUrl.pathname = '/oauth/google/start';
  startUrl.search =
    `?user_code=${encodeURIComponent(code.user_code)}` +
    `&onsite_origin=${encodeURIComponent(window.location.origin)}`;
  const directStart = startUrl.toString();

  let resolve!: (token: string) => void;
  let reject!: (err: Error) => void;
  const result = new Promise<string>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  let settled = false;
  let timer: number | undefined;

  const onMessage = (event: MessageEvent) => {
    if (event.origin !== bridgeOrigin) return;
    const data = event.data as PostMessagePayload | null;
    if (!data || typeof data !== 'object') return;
    if (data.type !== 'vbc_session_token') return;
    const token = data.access_token;
    if (typeof token !== 'string' || !token.startsWith(OWNER_SESSION_PREFIX)) {
      finish(() => reject(new Error('malformed access_token (expected vbc_owner_* prefix)')));
      return;
    }
    finish(() => resolve(token));
  };

  const finish = (run: () => void) => {
    if (settled) return;
    settled = true;
    if (timer !== undefined) window.clearTimeout(timer);
    window.removeEventListener('message', onMessage);
    run();
  };

  window.addEventListener('message', onMessage);

  // Reject if the device session window passes without a token. The
  // server-side TTL is what matters for security; this is just a UI
  // safety net so the result promise doesn't dangle forever.
  const remainingMs = Math.max(1, expiresAt - Date.now());
  timer = window.setTimeout(() => {
    finish(() => reject(new Error('sign-in window expired')));
  }, remainingMs);

  return {
    verificationUriComplete: directStart,
    userCode: code.user_code,
    result,
    cancel: () => finish(() => reject(new Error('canceled'))),
  };
}
