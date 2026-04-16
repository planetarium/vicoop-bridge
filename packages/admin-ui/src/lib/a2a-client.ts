import {
  ClientFactory,
  JsonRpcTransportFactory,
  type AuthenticationHandler,
  type HttpHeaders,
  createAuthenticatingFetchWithRetry,
} from '@a2a-js/sdk/client';
import type { Message, Task } from '@a2a-js/sdk';

export type { Message, Task };

const SERVER_URL = import.meta.env.VITE_SERVER_URL || window.location.origin;

function createAuthHandler(getToken: () => string | null): AuthenticationHandler {
  return {
    headers: async (): Promise<HttpHeaders> => {
      const token = getToken();
      if (token) return { Authorization: `Bearer ${token}` };
      return {};
    },
    shouldRetryWithHeaders: async () => undefined,
  };
}

export async function createA2AClient(getToken: () => string | null) {
  const authFetch = createAuthenticatingFetchWithRetry(fetch, createAuthHandler(getToken));

  const factory = new ClientFactory({
    transports: [new JsonRpcTransportFactory({ fetchImpl: authFetch })],
  });

  return factory.createFromUrl(SERVER_URL);
}
