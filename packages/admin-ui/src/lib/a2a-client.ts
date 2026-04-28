import { A2XClient } from '@a2x/sdk/client';
import type { Message, Task } from '@a2x/sdk';

export type { Message, Task };

const SERVER_URL = import.meta.env.VITE_SERVER_URL || window.location.origin;

/**
 * Build an `A2XClient` whose every fetch carries the current bearer
 * token. The token getter is called per request so token rotation
 * (e.g. SIWE re-exchange) takes effect on the next call without
 * rebuilding the client.
 */
export async function createA2AClient(getToken: () => string | null): Promise<A2XClient> {
  const authFetch: typeof fetch = (input, init) => {
    const token = getToken();
    const headers = new Headers(init?.headers);
    if (token) headers.set('Authorization', `Bearer ${token}`);
    return fetch(input, { ...init, headers });
  };
  return new A2XClient(SERVER_URL, { fetch: authFetch });
}
