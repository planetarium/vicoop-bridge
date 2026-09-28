import { createHash } from 'node:crypto';
import { loadCodexModelCatalog, type CodexCredentialReader } from './codex-auth-broker.js';

/** Daemon-local catalog, shared across scopes, invalidated by login/version changes. */
export function createCodexModelCatalogCache(
  credential: CodexCredentialReader,
  fetchImpl: typeof fetch = fetch,
) {
  type Entry = { key: string; controller: AbortController; promise: Promise<string | undefined>; users: number; settled: boolean };
  let current: Entry | undefined;
  return async (version: string, signal: AbortSignal): Promise<string | undefined> => {
    signal.throwIfAborted();
    const auth = await credential(); // Validate the current login even on a cache hit.
    signal.throwIfAborted();
    const key = createHash('sha256').update(JSON.stringify([version, auth.kind, auth.accountId, auth.secret])).digest('hex');
    if (!current || current.key !== key) {
      const controller = new AbortController();
      const entry: Entry = { key, controller, users: 0, settled: false, promise: Promise.resolve(undefined) };
      entry.promise = loadCodexModelCatalog(() => auth, version, fetchImpl, controller.signal).then(
        value => { entry.settled = true; return value; },
        error => {
          entry.settled = true;
          if (current === entry) current = undefined;
          throw error;
        },
      );
      current = entry;
    }
    const entry = current;
    entry.users++;
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (error: unknown, value?: string) => {
        if (done) return;
        done = true;
        signal.removeEventListener('abort', abort);
        entry.users--;
        // One canceled caller cannot cancel another caller's shared request.
        if (!entry.users && !entry.settled) {
          if (current === entry) current = undefined;
          entry.controller.abort();
        }
        if (error !== undefined) reject(error);
        else resolve(value);
      };
      const abort = () => finish(signal.reason ?? new Error('catalog request aborted'));
      signal.addEventListener('abort', abort, { once: true });
      entry.promise.then(value => finish(undefined, value), error => finish(error));
      if (signal.aborted) abort();
    });
  };
}
