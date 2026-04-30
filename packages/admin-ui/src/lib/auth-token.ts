import { useSyncExternalStore } from 'react';

// SIWE and Google sign-in both produce `vbc_owner_*` tokens after the
// audience split (#84), so the token prefix can't tell us who issued
// the session. Persist the provider alongside the token so the header
// can decide whether to defer to WalletAuth (which owns the wagmi
// disconnect on sign-out) or just clear the token.
export type AuthProvider = 'wallet' | 'google';

export interface AuthSession {
  token: string;
  provider: AuthProvider;
}

const AUTH_KEY = 'vicoop-admin-auth-token';

const listeners = new Set<() => void>();

// `useSyncExternalStore` requires `getSnapshot` to return a stable
// reference when nothing changed (otherwise React detects state churn
// and bails out with "infinite loop"). Cache the parsed object keyed
// by the raw localStorage string so repeat reads return the same
// object identity.
let cachedRaw: string | null = null;
let cachedSession: AuthSession | null = null;
let cacheInitialized = false;

function parse(raw: string | null): AuthSession | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as { token?: unknown }).token === 'string' &&
      ((parsed as { provider?: unknown }).provider === 'wallet' ||
        (parsed as { provider?: unknown }).provider === 'google')
    ) {
      return parsed as AuthSession;
    }
  } catch {
    // Pre-provider blobs were a bare token string and won't parse as
    // JSON. Drop them; user re-signs in.
  }
  return null;
}

function read(): AuthSession | null {
  const raw = localStorage.getItem(AUTH_KEY);
  if (cacheInitialized && raw === cachedRaw) return cachedSession;
  cachedRaw = raw;
  cachedSession = parse(raw);
  cacheInitialized = true;
  return cachedSession;
}

function subscribe(callback: () => void): () => void {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

export function setSession(session: AuthSession | null) {
  if (session) {
    localStorage.setItem(AUTH_KEY, JSON.stringify(session));
  } else {
    localStorage.removeItem(AUTH_KEY);
  }
  listeners.forEach((cb) => cb());
}

export function useAuthSession(): AuthSession | null {
  return useSyncExternalStore(subscribe, read, () => null);
}
