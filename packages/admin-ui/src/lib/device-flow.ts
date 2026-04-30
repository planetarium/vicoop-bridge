// Browser-side driver for the bridge's RFC-8628 device flow with
// intent=owner_session. Issues a vbc_owner_* opaque token after the user
// signs in to Google in a popup window — that token is what the admin UI
// presents to /graphql and POST / for self-service. See
// packages/server/src/auth/device-flow.ts for the wire surface and
// issue #79 PR D for the audience split.

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
  /** Aborts the in-flight poll loop. The result promise will reject. */
  cancel: () => void;
}

class CanceledError extends Error {
  constructor() {
    super('canceled');
    this.name = 'CanceledError';
  }
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
  const json = (await res.json()) as DeviceCodeResponse;
  return json;
}

interface PollOk {
  kind: 'ok';
  token: string;
}
interface PollPending {
  kind: 'pending';
}
interface PollSlowDown {
  kind: 'slow_down';
}
interface PollFatal {
  kind: 'fatal';
  message: string;
}

async function pollOnce(deviceCode: string): Promise<PollOk | PollPending | PollSlowDown | PollFatal> {
  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    device_code: deviceCode,
  });
  const res = await fetch('/oauth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (res.ok) {
    const payload = (await res.json()) as { access_token?: unknown; token_type?: unknown };
    if (typeof payload.access_token !== 'string' || !payload.access_token.startsWith(OWNER_SESSION_PREFIX)) {
      return { kind: 'fatal', message: 'malformed access_token (expected vbc_owner_* prefix)' };
    }
    return { kind: 'ok', token: payload.access_token };
  }
  let parsed: { error?: string; error_description?: string } | null = null;
  try {
    parsed = (await res.json()) as { error?: string; error_description?: string };
  } catch {
    // non-JSON
  }
  const code = parsed?.error;
  if (code === 'authorization_pending') return { kind: 'pending' };
  if (code === 'slow_down') return { kind: 'slow_down' };
  return {
    kind: 'fatal',
    message: parsed?.error_description ?? parsed?.error ?? `HTTP ${res.status}`,
  };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new CanceledError());
      return;
    }
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new CanceledError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Start a device-flow session. The caller is responsible for opening
 * `verificationUriComplete` in a popup as part of a click handler so the
 * browser doesn't block it. The polling loop runs immediately and resolves
 * once the user finishes Google approval.
 */
export async function startDeviceFlow(): Promise<DeviceFlowSession> {
  const code = await postDeviceCode();
  const ac = new AbortController();
  const deadline = Date.now() + code.expires_in * 1000;
  let intervalMs = Math.max(code.interval, 1) * 1000;

  const result = (async () => {
    while (Date.now() < deadline) {
      const r = await pollOnce(code.device_code);
      if (r.kind === 'ok') return r.token;
      if (r.kind === 'fatal') throw new Error(r.message);
      if (r.kind === 'slow_down') intervalMs += 5000;
      try {
        await sleep(intervalMs, ac.signal);
      } catch {
        throw new Error('canceled');
      }
    }
    throw new Error('device session expired');
  })();

  return {
    verificationUriComplete: code.verification_uri_complete,
    userCode: code.user_code,
    result,
    cancel: () => ac.abort(),
  };
}
