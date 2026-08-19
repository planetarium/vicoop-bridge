import { lookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';
import type { DidDocumentResolver, ResolvedDidDocument } from './types.js';

export class DidResolutionError extends Error {}

const blockedV4 = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['192.88.99.0', 24],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  blockedV4.addSubnet(network, prefix, 'ipv4');
}
const blockedV6 = new BlockList();
for (const [network, prefix] of [
  ['::', 96],
  ['::ffff:0:0', 96],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2002::', 16],
  ['fc00::', 7],
  ['fec0::', 10],
  ['fe80::', 10],
  ['ff00::', 8],
  ['2001:db8::', 32],
] as const) {
  blockedV6.addSubnet(network, prefix, 'ipv6');
}
const globalUnicastV6 = new BlockList();
globalUnicastV6.addSubnet('2000::', 3, 'ipv6');

export function isDisallowedIpAddress(address: string): boolean {
  const family = isIP(address);
  // Keep the families in separate BlockLists. Node represents IPv4 addresses
  // internally as IPv4-mapped IPv6 in a mixed list, which would make the
  // `::ffff:0:0/96` guard match every IPv4 address as well.
  if (family === 4) return blockedV4.check(address, 'ipv4');
  if (family === 6) {
    return (
      !globalUnicastV6.check(address, 'ipv6') || blockedV6.check(address, 'ipv6')
    );
  }
  return true;
}

export function didWebToHttpsUrl(did: string): URL {
  if (!did.startsWith('did:web:')) throw new DidResolutionError('unsupported did method');
  const methodId = did.slice('did:web:'.length);
  if (!methodId || /[/?#\\\s]/u.test(methodId)) {
    throw new DidResolutionError('invalid did:web identifier');
  }
  const segments = methodId.split(':').map((part) => {
    try {
      return decodeURIComponent(part);
    } catch {
      throw new DidResolutionError('invalid did:web encoding');
    }
  });
  if (segments.some((part) => part === '' || part === '.' || part === '..')) {
    throw new DidResolutionError('invalid did:web path');
  }

  const host = segments.shift()!;
  const url = new URL(`https://${host}`);
  if (url.username || url.password || url.protocol !== 'https:') {
    throw new DidResolutionError('invalid did:web host');
  }
  url.pathname =
    segments.length === 0
      ? '/.well-known/did.json'
      : `/${segments.map(encodeURIComponent).join('/')}/did.json`;
  return url;
}

export interface SafeDidWebResolverOptions {
  timeoutMs?: number;
  maxResponseBytes?: number;
  cacheTtlMs?: number;
  refreshCooldownMs?: number;
  maxCacheEntries?: number;
  now?: () => number;
  resolveAddresses?: typeof lookup;
  requestDocument?: (url: URL, pinnedAddress: string, signal: AbortSignal) => Promise<unknown>;
}

interface CacheEntry {
  expiresAt: number;
  document: ResolvedDidDocument;
}

export class SafeDidWebResolver implements DidDocumentResolver {
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly cacheTtlMs: number;
  private readonly refreshCooldownMs: number;
  private readonly maxCacheEntries: number;
  private readonly now: () => number;
  private readonly resolveAddresses: typeof lookup;
  private readonly requestDocument: (
    url: URL,
    pinnedAddress: string,
    signal: AbortSignal,
  ) => Promise<unknown>;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly lastRefreshAttempt = new Map<string, number>();
  private readonly inFlight = new Map<string, Promise<ResolvedDidDocument>>();

  constructor(options: SafeDidWebResolverOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 3_000;
    this.maxResponseBytes = options.maxResponseBytes ?? 64 * 1024;
    this.cacheTtlMs = options.cacheTtlMs ?? 5 * 60 * 1000;
    this.refreshCooldownMs = options.refreshCooldownMs ?? 5_000;
    this.maxCacheEntries = options.maxCacheEntries ?? 128;
    this.now = options.now ?? Date.now;
    this.resolveAddresses = options.resolveAddresses ?? lookup;
    this.requestDocument = options.requestDocument ?? this.httpsGetJson.bind(this);
  }

  async resolve(issuer: string, options: { refresh?: boolean } = {}): Promise<ResolvedDidDocument> {
    const currentTime = this.now();
    const cached = this.cache.get(issuer);
    if (!options.refresh) {
      if (cached && cached.expiresAt > currentTime) {
        this.cache.delete(issuer);
        this.cache.set(issuer, cached);
        return cached.document;
      }
    }

    const pending = this.inFlight.get(issuer);
    if (pending) return pending;

    if (options.refresh && cached && cached.expiresAt > currentTime) {
      const lastAttempt = this.lastRefreshAttempt.get(issuer);
      if (
        lastAttempt !== undefined &&
        currentTime - lastAttempt < this.refreshCooldownMs
      ) {
        return cached.document;
      }
      this.lastRefreshAttempt.set(issuer, currentTime);
    }

    const load = this.load(issuer);
    this.inFlight.set(issuer, load);
    try {
      return await load;
    } finally {
      if (this.inFlight.get(issuer) === load) this.inFlight.delete(issuer);
    }
  }

  private async load(issuer: string): Promise<ResolvedDidDocument> {
    const url = didWebToHttpsUrl(issuer);
    if (isIP(url.hostname) !== 0 || url.hostname === 'localhost' || url.hostname.endsWith('.localhost')) {
      throw new DidResolutionError('literal or local host is not allowed');
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const addresses = await waitForAbort(
        this.resolveAddresses(url.hostname, { all: true, verbatim: true }),
        controller.signal,
      );
      if (addresses.length === 0 || addresses.some(({ address }) => isDisallowedIpAddress(address))) {
        throw new DidResolutionError('did:web resolves to a non-public address');
      }

      const raw = await waitForAbort(
        this.requestDocument(url, addresses[0]!.address, controller.signal),
        controller.signal,
      );
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        throw new DidResolutionError('DID document is not an object');
      }
      const doc = raw as ResolvedDidDocument;
      if (doc.id !== issuer) throw new DidResolutionError('DID document id mismatch');
      if (
        (doc.verificationMethod !== undefined && !Array.isArray(doc.verificationMethod)) ||
        (doc.assertionMethod !== undefined && !Array.isArray(doc.assertionMethod))
      ) {
        throw new DidResolutionError('DID document relationships are malformed');
      }
      this.cache.set(issuer, { document: doc, expiresAt: this.now() + this.cacheTtlMs });
      while (this.cache.size > this.maxCacheEntries) {
        const oldest = this.cache.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        this.cache.delete(oldest);
        this.lastRefreshAttempt.delete(oldest);
      }
      return doc;
    } catch (error) {
      if (controller.signal.aborted) {
        throw new DidResolutionError('DID document resolution timed out');
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  private httpsGetJson(url: URL, pinnedAddress: string, signal: AbortSignal): Promise<unknown> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const resolveOnce = (value: unknown) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      const rejectOnce = (error: Error) => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      const req = httpsRequest(
        {
          protocol: 'https:',
          hostname: pinnedAddress,
          port: url.port || 443,
          path: `${url.pathname}${url.search}`,
          method: 'GET',
          servername: url.hostname,
          headers: { host: url.host, accept: 'application/did+ld+json, application/json' },
          signal,
        },
        (res) => {
          if ((res.statusCode ?? 0) >= 300 && (res.statusCode ?? 0) < 400) {
            res.resume();
            rejectOnce(new DidResolutionError('DID document redirects are not allowed'));
            return;
          }
          if (res.statusCode !== 200) {
            res.resume();
            rejectOnce(new DidResolutionError('DID document request failed'));
            return;
          }
          const chunks: Buffer[] = [];
          let size = 0;
          res.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > this.maxResponseBytes) {
              const error = new DidResolutionError('DID document is too large');
              rejectOnce(error);
              req.destroy(error);
              return;
            }
            chunks.push(chunk);
          });
          res.once('aborted', () => {
            rejectOnce(new DidResolutionError('DID document response was aborted'));
          });
          res.once('error', (error) => {
            rejectOnce(error);
          });
          res.once('close', () => {
            if (!res.complete) {
              rejectOnce(new DidResolutionError('DID document response ended prematurely'));
            }
          });
          res.once('end', () => {
            try {
              resolveOnce(JSON.parse(Buffer.concat(chunks).toString('utf8')));
            } catch {
              rejectOnce(new DidResolutionError('DID document is invalid JSON'));
            }
          });
        },
      );
      req.once('error', rejectOnce);
      req.end();
    });
  }
}

function waitForAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new DidResolutionError('operation aborted'));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new DidResolutionError('operation aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}
