import { useSyncExternalStore } from 'react';

const AUTH_TOKEN_KEY = 'vicoop-admin-auth-token';

const listeners = new Set<() => void>();

function getSnapshot(): string | null {
  return localStorage.getItem(AUTH_TOKEN_KEY);
}

function subscribe(callback: () => void): () => void {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

export function setToken(token: string | null) {
  if (token) {
    localStorage.setItem(AUTH_TOKEN_KEY, token);
  } else {
    localStorage.removeItem(AUTH_TOKEN_KEY);
  }
  listeners.forEach((cb) => cb());
}

export function useAuthToken(): string | null {
  return useSyncExternalStore(subscribe, getSnapshot, () => null);
}
