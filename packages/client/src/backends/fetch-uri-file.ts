import dns from 'node:dns/promises';
import https from 'node:https';
import net from 'node:net';
import { Readable } from 'node:stream';

export const INPUT_IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

export const INPUT_FILE_MAX_BYTES = 5 * 1024 * 1024;

export type FetchUriErrorCode =
  | 'fetch_blocked_host'
  | 'fetch_failed'
  | 'fetch_too_large'
  | 'fetch_mime_mismatch';

export class FetchUriError extends Error {
  readonly code: FetchUriErrorCode;
  constructor(code: FetchUriErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
    this.name = 'FetchUriError';
  }
}

export interface FetchUriPolicy {
  enabled?: boolean;
  timeoutMs?: number;
  maxRedirects?: number;
  fetchImpl?: typeof fetch;
  resolveHost?: (hostname: string) => Promise<string[]>;
}

export interface FetchedUriFile {
  bytes: string;
  mimeType: string;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_REDIRECTS = 3;

export function isSupportedInputFileMime(mime: string): boolean {
  return INPUT_IMAGE_MIME.has(mime) || mime === 'application/pdf';
}

function normalizeMime(raw: string | null): string {
  return (raw ?? '').split(';', 1)[0].trim().toLowerCase();
}

function parseIpv4(ip: string): number[] | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    out.push(n);
  }
  return out;
}

function isBlockedIpv4(ip: string): boolean {
  const p = parseIpv4(ip);
  if (!p) return true;
  const [a, b] = p;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    a >= 224
  );
}

function expandIpv6(ip: string): number[] | null {
  const zone = ip.indexOf('%');
  const clean = (zone >= 0 ? ip.slice(0, zone) : ip).toLowerCase();
  const mapped = clean.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) {
    const v4 = parseIpv4(mapped[1]);
    if (!v4) return null;
    return [0, 0, 0, 0, 0, 0xffff, (v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]];
  }
  const pieces = clean.split('::');
  if (pieces.length > 2) return null;
  const left = pieces[0] ? pieces[0].split(':') : [];
  const right = pieces.length === 2 && pieces[1] ? pieces[1].split(':') : [];
  if (pieces.length === 1 && left.length !== 8) return null;
  const missing = 8 - left.length - right.length;
  if (missing < 0) return null;
  const nums = [...left, ...Array.from({ length: missing }, () => '0'), ...right].map((part) => {
    if (!/^[0-9a-f]{1,4}$/.test(part)) return -1;
    return Number.parseInt(part, 16);
  });
  return nums.length === 8 && nums.every((n) => n >= 0 && n <= 0xffff) ? nums : null;
}

function isBlockedIpv6(ip: string): boolean {
  const p = expandIpv6(ip);
  if (!p) return true;
  const isUnspecified = p.every((n) => n === 0);
  const isLoopback = p.slice(0, 7).every((n) => n === 0) && p[7] === 1;
  const firstByte = p[0] >> 8;
  const secondByte = p[0] & 0xff;
  const isUniqueLocal = (firstByte & 0xfe) === 0xfc;
  const isLinkLocal = firstByte === 0xfe && (secondByte & 0xc0) === 0x80;
  const isMulticast = firstByte === 0xff;
  const isMappedIpv4 = p.slice(0, 5).every((n) => n === 0) && p[5] === 0xffff;
  if (isMappedIpv4) {
    const a = p[6] >> 8;
    const b = p[6] & 0xff;
    const c = p[7] >> 8;
    const d = p[7] & 0xff;
    return isBlockedIpv4(`${a}.${b}.${c}.${d}`);
  }
  return isUnspecified || isLoopback || isUniqueLocal || isLinkLocal || isMulticast;
}

function isBlockedIp(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 4) return isBlockedIpv4(ip);
  if (family === 6) return isBlockedIpv6(ip);
  return true;
}

async function defaultResolveHost(hostname: string): Promise<string[]> {
  const host = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  const directFamily = net.isIP(host);
  if (directFamily !== 0) return [host];
  const records = await dns.lookup(host, { all: true, verbatim: true });
  return records.map((r) => r.address);
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new FetchUriError('fetch_failed', 'file.uri fetch timed out or was aborted');
  }
}

async function waitForResolution(
  hostname: string,
  resolveHost: (hostname: string) => Promise<string[]>,
  signal: AbortSignal,
): Promise<string[]> {
  throwIfAborted(signal);
  return new Promise<string[]>((resolve, reject) => {
    const abort = () => reject(new FetchUriError('fetch_failed', 'file.uri fetch timed out or was aborted'));
    signal.addEventListener('abort', abort, { once: true });
    resolveHost(hostname).then(
      (addresses) => {
        signal.removeEventListener('abort', abort);
        if (signal.aborted) {
          reject(new FetchUriError('fetch_failed', 'file.uri fetch timed out or was aborted'));
          return;
        }
        resolve(addresses);
      },
      (err: unknown) => {
        signal.removeEventListener('abort', abort);
        reject(err);
      },
    );
  });
}

function stripIpv6Brackets(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

async function validateUrlForFetch(
  url: URL,
  resolveHost: (hostname: string) => Promise<string[]>,
  signal: AbortSignal,
): Promise<string[]> {
  throwIfAborted(signal);
  if (url.protocol !== 'https:') {
    throw new FetchUriError('fetch_blocked_host', `file.uri must use https (got ${url.protocol || 'unknown'})`);
  }
  if (url.username || url.password) {
    throw new FetchUriError('fetch_blocked_host', 'file.uri must not include userinfo');
  }
  let addresses: string[];
  try {
    addresses = await waitForResolution(url.hostname, resolveHost, signal);
  } catch (err) {
    if (err instanceof FetchUriError) throw err;
    throw new FetchUriError('fetch_failed', `failed to resolve ${url.hostname}`, { cause: err });
  }
  if (addresses.length === 0) {
    throw new FetchUriError('fetch_failed', `failed to resolve ${url.hostname}`);
  }
  for (const address of addresses) {
    if (isBlockedIp(address)) {
      throw new FetchUriError('fetch_blocked_host', `file.uri host resolves to a blocked address (${address})`);
    }
  }
  throwIfAborted(signal);
  return addresses;
}

function makeTimeoutSignal(parent: AbortSignal, timeoutMs: number): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | null = null;
  const abort = () => controller.abort(parent.reason);
  if (parent.aborted) {
    abort();
  } else {
    parent.addEventListener('abort', abort, { once: true });
    timeout = setTimeout(() => controller.abort(new Error(`fetch timed out after ${timeoutMs}ms`)), timeoutMs);
    timeout.unref?.();
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      parent.removeEventListener('abort', abort);
      if (timeout) clearTimeout(timeout);
    },
  };
}

async function cancelResponseBody(res: Response): Promise<void> {
  await res.body?.cancel().catch(() => undefined);
}

function headersFromIncoming(headers: Record<string, string | string[] | undefined>): Headers {
  const out = new Headers();
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const v of value) out.append(key, v);
    } else {
      out.set(key, value);
    }
  }
  return out;
}

function fetchPinned(url: URL, addresses: readonly string[], signal: AbortSignal): Promise<Response> {
  const address = addresses[0];
  if (!address) {
    return Promise.reject(new FetchUriError('fetch_failed', `failed to resolve ${url.hostname}`));
  }
  const family = net.isIP(address);
  return new Promise<Response>((resolve, reject) => {
    let activeResponse: Readable | null = null;
    const cleanupAbort = () => signal.removeEventListener('abort', abort);
    const abort = () => {
      const err = new FetchUriError('fetch_failed', 'file.uri fetch timed out or was aborted');
      activeResponse?.destroy(err);
      req.destroy(err);
    };
    const req = https.request({
      protocol: 'https:',
      hostname: stripIpv6Brackets(url.hostname),
      port: url.port ? Number(url.port) : 443,
      path: `${url.pathname}${url.search}`,
      method: 'GET',
      servername: stripIpv6Brackets(url.hostname),
      lookup: (_hostname, _options, cb) => {
        cb(null, address, family);
      },
    });
    signal.addEventListener('abort', abort, { once: true });
    req.on('response', (res) => {
      activeResponse = res;
      res.once('close', cleanupAbort);
      res.once('end', cleanupAbort);
      res.once('error', cleanupAbort);
      const body = Readable.toWeb(res) as ReadableStream<Uint8Array>;
      resolve(new Response(body, {
        status: res.statusCode ?? 0,
        statusText: res.statusMessage,
        headers: headersFromIncoming(res.headers),
      }));
    });
    req.on('error', (err) => {
      cleanupAbort();
      reject(err);
    });
    req.end();
  });
}

async function responseStreamToBase64(res: Response, maxBytes: number): Promise<string> {
  const body = res.body;
  if (!body) {
    throw new FetchUriError('fetch_failed', 'file.uri response had no body');
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new FetchUriError('fetch_too_large', `file.uri response exceeded INPUT_FILE_MAX_BYTES (${total} > ${maxBytes})`);
    }
    chunks.push(value);
  }
  if (total === 0) {
    throw new FetchUriError('fetch_failed', 'file.uri response body was empty');
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('base64');
}

export async function fetchUriToBytes(
  uri: string,
  declaredMimeType: string | undefined,
  policy: FetchUriPolicy | undefined,
  signal: AbortSignal,
): Promise<FetchedUriFile> {
  const timeoutMs = policy?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRedirects = policy?.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const fetchImpl = policy?.fetchImpl;
  const resolveHost = policy?.resolveHost ?? defaultResolveHost;
  let current: URL;
  try {
    current = new URL(uri);
  } catch (err) {
    throw new FetchUriError('fetch_blocked_host', 'file.uri must be an absolute https URL', { cause: err });
  }

  const timeout = makeTimeoutSignal(signal, timeoutMs);
  try {
    for (let redirects = 0; redirects <= maxRedirects; redirects++) {
      const addresses = await validateUrlForFetch(current, resolveHost, timeout.signal);
      let res: Response;
      try {
        res = fetchImpl
          ? await fetchImpl(current, { redirect: 'manual', signal: timeout.signal })
          : await fetchPinned(current, addresses, timeout.signal);
      } catch (err) {
        throw new FetchUriError('fetch_failed', `failed to fetch file.uri (${current.hostname})`, { cause: err });
      }

      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        if (!location) {
          await cancelResponseBody(res);
          throw new FetchUriError('fetch_failed', `file.uri redirect missing Location header (${res.status})`);
        }
        if (redirects === maxRedirects) {
          await cancelResponseBody(res);
          throw new FetchUriError('fetch_failed', `file.uri exceeded max redirects (${maxRedirects})`);
        }
        await cancelResponseBody(res);
        current = new URL(location, current);
        continue;
      }

      if (!res.ok) {
        await cancelResponseBody(res);
        throw new FetchUriError('fetch_failed', `file.uri fetch returned HTTP ${res.status}`);
      }

      const contentLength = res.headers.get('content-length');
      if (contentLength !== null) {
        const n = Number(contentLength);
        if (Number.isFinite(n) && n > INPUT_FILE_MAX_BYTES) {
          await cancelResponseBody(res);
          throw new FetchUriError('fetch_too_large', `file.uri Content-Length exceeds INPUT_FILE_MAX_BYTES (${n} > ${INPUT_FILE_MAX_BYTES})`);
        }
      }

      const observedMime = normalizeMime(res.headers.get('content-type'));
      const declared = normalizeMime(declaredMimeType ?? null);
      if (!observedMime || !isSupportedInputFileMime(observedMime)) {
        await cancelResponseBody(res);
        throw new FetchUriError('fetch_mime_mismatch', `file.uri Content-Type is not supported (${observedMime || 'unknown'})`);
      }
      if (declared && declared !== observedMime) {
        await cancelResponseBody(res);
        throw new FetchUriError('fetch_mime_mismatch', `file.uri declared mimeType ${declared} does not match Content-Type ${observedMime}`);
      }

      const bytes = await responseStreamToBase64(res, INPUT_FILE_MAX_BYTES);
      return { bytes, mimeType: observedMime };
    }
  } finally {
    timeout.cleanup();
  }
  throw new FetchUriError('fetch_failed', 'file.uri fetch failed');
}
