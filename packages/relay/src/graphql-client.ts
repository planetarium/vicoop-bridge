import { AsyncLocalStorage } from 'node:async_hooks';

const POSTGRAPHILE_URL =
  process.env.POSTGRAPHILE_URL ||
  `http://localhost:${process.env.POSTGRAPHILE_PORT || '5433'}/graphql`;

const bearerTokenStore = new AsyncLocalStorage<string>();

export function runWithBearerToken<T>(token: string, fn: () => T): T {
  return bearerTokenStore.run(token, fn);
}

export function getBearerToken(): string | undefined {
  return bearerTokenStore.getStore();
}

export interface GraphQLResponse<T = Record<string, unknown>> {
  data?: T;
  errors?: Array<{ message: string; locations?: unknown[]; path?: unknown[] }>;
}

export async function executeGraphQL<T = Record<string, unknown>>(
  query: string,
  variables?: Record<string, unknown>,
  jwtToken?: string,
): Promise<GraphQLResponse<T>> {
  const token = jwtToken ?? getBearerToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const response = await fetch(POSTGRAPHILE_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({ query, variables }),
  });

  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    return response.json() as Promise<GraphQLResponse<T>>;
  }

  if (!response.ok) {
    throw new Error(`GraphQL request failed: ${response.status} ${response.statusText}`);
  }

  return response.json() as Promise<GraphQLResponse<T>>;
}
