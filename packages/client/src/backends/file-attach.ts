import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

// Marker convention agents emit inside their assistant message text to
// request that bridge-client deliver an on-disk file as a FilePart artifact
// to the caller. Single-line, multiple per message allowed.
//
// Examples:
//   [bridge-attach: /Users/me/output/report.pdf]
//   prefix [bridge-attach: ./relative/inside-root.png] suffix
//
// Whitespace inside the path is preserved (trimmed at the edges only); we
// stop at the first `]` to keep the regex simple. Newlines inside the path
// are not allowed — agents that need to attach paths with newlines (rare)
// must rename the file.
const BRIDGE_ATTACH_MARKER_RE = /\[bridge-attach:\s+([^\]\n]+?)\s*\]/g;

export type ParsedAttachMarkers = {
  /**
   * Original text with successfully-resolved markers removed. Markers that
   * could not be resolved are left in place so the caller still sees the
   * agent's intent and can debug.
   */
  cleanedText: string;
  /** Distinct paths in encounter order. Duplicates are de-duped. */
  paths: string[];
  /**
   * Raw marker substrings (including brackets) per path, in encounter order.
   * Used by the caller to strip a specific marker after a successful read.
   */
  markersByPath: Map<string, string[]>;
};

export function parseBridgeAttachMarkers(text: string): ParsedAttachMarkers {
  const paths: string[] = [];
  const seen = new Set<string>();
  const markersByPath = new Map<string, string[]>();
  for (const match of text.matchAll(BRIDGE_ATTACH_MARKER_RE)) {
    const raw = match[1].trim();
    if (raw.length === 0) continue;
    if (!seen.has(raw)) {
      seen.add(raw);
      paths.push(raw);
    }
    const list = markersByPath.get(raw) ?? [];
    list.push(match[0]);
    markersByPath.set(raw, list);
  }
  return { cleanedText: text, paths, markersByPath };
}

/**
 * Strip a specific path's markers from the text. Used after a successful
 * read so the user-visible artifact text doesn't contain the raw on-disk
 * location (privacy + UX). Failed reads keep their markers visible.
 *
 * Cleanup is scoped to lines that contain (only) the marker:
 * - A marker-only line (with optional surrounding whitespace) is removed entirely.
 * - An inline marker is removed in place; the rest of the line is preserved.
 *
 * Whitespace and newlines unrelated to the stripped marker are left
 * untouched so the agent's intended formatting (leading/trailing
 * whitespace, blank lines elsewhere, etc.) survives.
 */
export function stripMarkersForPath(
  text: string,
  parsed: ParsedAttachMarkers,
  attachPath: string,
): string {
  const markers = parsed.markersByPath.get(attachPath);
  if (!markers || markers.length === 0) return text;
  const markerSet = new Set(markers);
  const lines = text.split('\n');
  const out: string[] = [];
  for (const line of lines) {
    // A line that is exactly the marker (modulo surrounding whitespace)
    // disappears entirely so we don't leave a blank line gap behind.
    if (markerSet.has(line.trim())) continue;
    // Otherwise, strip any inline marker substrings but preserve the rest
    // of the line as-is — including original whitespace.
    let lineOut = line;
    for (const m of markers) {
      lineOut = lineOut.split(m).join('');
    }
    out.push(lineOut);
  }
  return out.join('\n');
}

export type SafeReadErrorCode =
  | 'invalid-path'
  | 'outside-roots'
  | 'not-found'
  | 'symlink'
  | 'not-file'
  | 'hardlink'
  | 'too-large';

export class SafeReadError extends Error {
  readonly code: SafeReadErrorCode;
  constructor(code: SafeReadErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
    this.name = 'SafeReadError';
  }
}

export type SafeReadResult = {
  buffer: Buffer;
  realPath: string;
  size: number;
};

const SUPPORTS_NOFOLLOW = process.platform !== 'win32' && 'O_NOFOLLOW' in fsConstants;
// O_NOFOLLOW only blocks the *terminal* path component on Linux/macOS. We
// canonicalize via realpath beforehand so intermediate symlinks are followed
// (otherwise we'd reject `~/Documents/foo.pdf` whenever Documents itself is
// a symlink, which is common on macOS). The terminal-component guard plus
// post-open identity check is sufficient to prevent TOCTOU races where a
// regular file gets swapped for a symlink between resolve and open.
const OPEN_READ_FLAGS = fsConstants.O_RDONLY | (SUPPORTS_NOFOLLOW ? fsConstants.O_NOFOLLOW : 0);

function ensureTrailingSep(p: string): string {
  return p.endsWith(path.sep) ? p : p + path.sep;
}

function isPathInside(rootWithSep: string, candidate: string): boolean {
  if (candidate === rootWithSep.slice(0, -1)) return true;
  return candidate.startsWith(rootWithSep);
}

async function realpathOrUndefined(p: string): Promise<string | undefined> {
  try {
    return await fs.realpath(p);
  } catch {
    return undefined;
  }
}

/**
 * Canonicalize allowed roots — operators may have provided paths that
 * contain symlinks (e.g. /var/folders on macOS). Drops any root whose
 * realpath cannot be resolved; an unresolvable root cannot match anything.
 * Throws SafeReadError('outside-roots') if none resolved.
 */
async function resolveCanonicalRoots(allowedRoots: string[]): Promise<string[]> {
  if (allowedRoots.length === 0) {
    throw new SafeReadError('outside-roots', 'no allowed roots configured');
  }
  const canonicalRoots: string[] = [];
  for (const r of allowedRoots) {
    const real = await realpathOrUndefined(path.resolve(r));
    if (real) canonicalRoots.push(ensureTrailingSep(real));
  }
  if (canonicalRoots.length === 0) {
    throw new SafeReadError('outside-roots', 'no allowed roots resolvable on disk');
  }
  return canonicalRoots;
}

/**
 * Build a reader that canonicalizes its allowed roots once (lazily, on
 * first read) and reuses the result across subsequent reads. Use this when
 * the same caller will read multiple files under the same configured
 * roots — e.g. one assistant message containing several `[bridge-attach]`
 * markers, or a per-backend instance handling many tool calls.
 *
 * For one-shot reads (or when roots may have rotated since the last
 * call), `readBoundedFileWithinRoots` does the resolution per-call.
 */
export function createBoundedFileReader(opts: {
  allowedRoots: string[];
  maxBytes: number;
}): (filePath: string) => Promise<SafeReadResult> {
  let canonicalRootsPromise: Promise<string[]> | null = null;
  return async (filePath) =>
    readWithRoots({
      filePath,
      maxBytes: opts.maxBytes,
      getCanonicalRoots: async () => {
        if (!canonicalRootsPromise) {
          canonicalRootsPromise = resolveCanonicalRoots(opts.allowedRoots).catch((err) => {
            // On failure, clear the cache so a subsequent call retries
            // (e.g. operator fixed the missing dir between attempts).
            canonicalRootsPromise = null;
            throw err;
          });
        }
        return canonicalRootsPromise;
      },
    });
}

/**
 * Read a file from disk under operator-controlled roots. Designed for the
 * narrow case where the bridge-client forwards on-disk artifacts produced by
 * a co-located agent (OpenClaw) to a remote A2A caller — i.e. the agent
 * picks the path, but the operator restricts the search space.
 *
 * Defenses, in order:
 *   1. Path must canonicalize via realpath() into one of the canonicalized
 *      allowed roots. Catches `..` traversal, hardcoded `/etc/...`, etc.
 *   2. lstat() must report a regular file (no dirs/sockets/devices).
 *   3. open() with O_NOFOLLOW so the terminal component cannot be a symlink
 *      pointing outside roots between realpath and open.
 *   4. fstat().nlink === 1 — hardlinks could anchor a file inside roots
 *      that is also reachable via an outside-root path the operator doesn't
 *      see. Reject so the model cannot use hardlinks to smuggle paths.
 *   5. size <= maxBytes — bound the per-attachment payload before reading.
 *
 * For repeated reads under the same roots, prefer `createBoundedFileReader`
 * which caches the canonicalization.
 */
export async function readBoundedFileWithinRoots(params: {
  filePath: string;
  allowedRoots: string[];
  maxBytes: number;
}): Promise<SafeReadResult> {
  return readWithRoots({
    filePath: params.filePath,
    maxBytes: params.maxBytes,
    getCanonicalRoots: () => resolveCanonicalRoots(params.allowedRoots),
  });
}

async function readWithRoots(params: {
  filePath: string;
  maxBytes: number;
  getCanonicalRoots: () => Promise<string[]>;
}): Promise<SafeReadResult> {
  if (typeof params.filePath !== 'string' || params.filePath.length === 0) {
    throw new SafeReadError('invalid-path', 'empty path');
  }
  if (params.filePath.includes('\0')) {
    throw new SafeReadError('invalid-path', 'path contains NUL');
  }

  const canonicalRoots = await params.getCanonicalRoots();

  // Resolve the candidate. Relative paths resolve against the first root for
  // ergonomics — agents typically emit absolute paths, but a bare filename
  // shouldn't be a hard error if there's only one root configured.
  const candidate = path.isAbsolute(params.filePath)
    ? params.filePath
    : path.resolve(canonicalRoots[0], params.filePath);

  let realPath: string;
  try {
    realPath = await fs.realpath(candidate);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new SafeReadError('not-found', `file not found: ${params.filePath}`);
    }
    throw err;
  }

  const insideRoot = canonicalRoots.some((r) => isPathInside(r, realPath));
  if (!insideRoot) {
    throw new SafeReadError(
      'outside-roots',
      `resolved path is outside allowed roots: ${realPath}`,
    );
  }

  const lstat = await fs.lstat(realPath);
  if (lstat.isSymbolicLink()) {
    // realpath() above should have stripped any terminal symlink, so this
    // is defensive: a symlink that swapped in between realpath and lstat.
    throw new SafeReadError('symlink', `path is a symlink: ${realPath}`);
  }
  if (!lstat.isFile()) {
    throw new SafeReadError('not-file', `path is not a regular file: ${realPath}`);
  }

  const handle = await fs.open(realPath, OPEN_READ_FLAGS);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw new SafeReadError('not-file', `opened path is not a regular file: ${realPath}`);
    }
    // Cross-platform symlink TOCTOU defense: compare device + inode of the
    // opened descriptor against the lstat we did before open. On POSIX
    // O_NOFOLLOW already blocks a terminal-component symlink swap; on
    // win32 (where O_NOFOLLOW is unavailable) this identity check is the
    // only thing standing between us and a swapped-in symlink. Defense
    // in depth on POSIX too. Mismatched dev/ino means the path resolved
    // to a different file at open time than at lstat time.
    if (stat.dev !== lstat.dev || stat.ino !== lstat.ino) {
      throw new SafeReadError(
        'symlink',
        `path identity changed between stat and open (possible symlink swap): ${realPath}`,
      );
    }
    if (stat.nlink > 1) {
      throw new SafeReadError(
        'hardlink',
        `hardlinked file refused (nlink=${stat.nlink}): ${realPath}`,
      );
    }
    if (stat.size > params.maxBytes) {
      throw new SafeReadError(
        'too-large',
        `file exceeds maxBytes (${stat.size} > ${params.maxBytes}): ${realPath}`,
      );
    }
    // Bounded read: cap allocation at maxBytes + 1 so a file that grew
    // between fstat and readFile (TOCTOU) is detected and rejected
    // instead of silently inflating the in-memory buffer beyond
    // maxBytes. We read until EOF or the cap+1-th byte appears.
    const cap = params.maxBytes;
    const buf = Buffer.alloc(cap + 1);
    let totalRead = 0;
    while (totalRead < cap + 1) {
      const { bytesRead } = await handle.read(
        buf,
        totalRead,
        cap + 1 - totalRead,
        totalRead,
      );
      if (bytesRead === 0) break; // EOF
      totalRead += bytesRead;
    }
    if (totalRead > cap) {
      throw new SafeReadError(
        'too-large',
        `file exceeds maxBytes during read (>${cap} bytes, file grew between stat and read): ${realPath}`,
      );
    }
    return { buffer: buf.subarray(0, totalRead), realPath, size: totalRead };
  } finally {
    await handle.close().catch(() => {});
  }
}

// Minimal extension→mime lookup for the common cases bridge callers will
// consume. Unknown extensions fall back to application/octet-stream so the
// caller still receives the bytes; the FilePart spec allows this.
const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.pdf': 'application/pdf',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.xml': 'application/xml',
  '.zip': 'application/zip',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.webm': 'video/webm',
};

export function inferMimeFromPath(p: string): string {
  const ext = path.extname(p).toLowerCase();
  return MIME_BY_EXT[ext] ?? 'application/octet-stream';
}
