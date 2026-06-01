import { test } from 'node:test';
import assert from 'node:assert/strict';
import { INPUT_FILE_MAX_BYTES, fetchUriToBytes } from './fetch-uri-file.js';

const NEVER: AbortSignal = new AbortController().signal;
const PUBLIC_IP = ['93.184.216.34'];

test('fetchUriToBytes: fetches supported https content as base64', async () => {
  const body = Buffer.from('png-bytes');
  const result = await fetchUriToBytes(
    'https://example.com/x.png',
    'image/png',
    {
      fetchImplForTest: async () =>
        new Response(body, {
          headers: { 'content-type': 'image/png', 'content-length': String(body.length) },
        }),
      resolveHost: async () => PUBLIC_IP,
    },
    NEVER,
  );
  assert.equal(result.mimeType, 'image/png');
  assert.equal(result.bytes, body.toString('base64'));
});

test('fetchUriToBytes: blocks non-https schemes before fetch', async () => {
  let fetched = false;
  await assert.rejects(
    fetchUriToBytes(
      'file:///etc/passwd',
      'image/png',
      {
        fetchImplForTest: async () => {
          fetched = true;
          return new Response(Buffer.from('unused'), { headers: { 'content-type': 'image/png' } });
        },
        resolveHost: async () => PUBLIC_IP,
      },
      NEVER,
    ),
    { name: 'FetchUriError', code: 'fetch_blocked_host' },
  );
  assert.equal(fetched, false);
});

test('fetchUriToBytes: blocks hosts resolving to private addresses', async () => {
  await assert.rejects(
    fetchUriToBytes(
      'https://example.com/x.png',
      'image/png',
      {
        fetchImplForTest: async () => new Response(Buffer.from('unused'), { headers: { 'content-type': 'image/png' } }),
        resolveHost: async () => ['169.254.169.254'],
      },
      NEVER,
    ),
    { name: 'FetchUriError', code: 'fetch_blocked_host' },
  );
});

test('fetchUriToBytes: blocks direct IPv6 loopback hosts', async () => {
  await assert.rejects(
    fetchUriToBytes(
      'https://[::1]/x.png',
      'image/png',
      {
        fetchImplForTest: async () => new Response(Buffer.from('unused'), { headers: { 'content-type': 'image/png' } }),
      },
      NEVER,
    ),
    { name: 'FetchUriError', code: 'fetch_blocked_host' },
  );
});

test('fetchUriToBytes: timeout bounds hostname resolution', async (t) => {
  // Drive the deadline with mock timers instead of a real sub-10ms timer.
  // A real short timer racing a never-resolving resolveHost is flaky under
  // CI load: the timeout timer is unref'd, so if it becomes the only live
  // handle the runner can begin to exit and cancel in-flight siblings
  // (`cancelledByParent`). Ticking deterministically keeps it instant and
  // off the wall clock. See issue #312.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = fetchUriToBytes(
    'https://example.com/x.png',
    'image/png',
    {
      timeoutMs: 5,
      fetchImplForTest: async () => new Response(Buffer.from('unused'), { headers: { 'content-type': 'image/png' } }),
      resolveHost: async () => new Promise<string[]>(() => undefined),
    },
    NEVER,
  );
  t.mock.timers.tick(5);
  await assert.rejects(pending, { name: 'FetchUriError', code: 'fetch_failed' });
});

test('fetchUriToBytes: revalidates redirect targets', async () => {
  await assert.rejects(
    fetchUriToBytes(
      'https://example.com/start',
      'image/png',
      {
        fetchImplForTest: async () =>
          new Response(null, {
            status: 302,
            headers: { location: 'https://private.example/x.png' },
          }),
        resolveHost: async (host) => (host === 'private.example' ? ['10.0.0.1'] : PUBLIC_IP),
      },
      NEVER,
    ),
    { name: 'FetchUriError', code: 'fetch_blocked_host' },
  );
});

test('fetchUriToBytes: rejects Content-Length over the inbound cap', async () => {
  await assert.rejects(
    fetchUriToBytes(
      'https://example.com/x.png',
      'image/png',
      {
        fetchImplForTest: async () =>
          new Response(Buffer.from('unused'), {
            headers: { 'content-type': 'image/png', 'content-length': String(6 * 1024 * 1024) },
          }),
        resolveHost: async () => PUBLIC_IP,
      },
      NEVER,
    ),
    { name: 'FetchUriError', code: 'fetch_too_large' },
  );
});

test('fetchUriToBytes: rejects responses that exceed the inbound cap while streaming', async () => {
  await assert.rejects(
    fetchUriToBytes(
      'https://example.com/x.png',
      'image/png',
      {
        fetchImplForTest: async () =>
          new Response(Buffer.alloc(INPUT_FILE_MAX_BYTES + 1), {
            headers: { 'content-type': 'image/png' },
          }),
        resolveHost: async () => PUBLIC_IP,
      },
      NEVER,
    ),
    { name: 'FetchUriError', code: 'fetch_too_large' },
  );
});

test('fetchUriToBytes: rejects empty response bodies', async () => {
  await assert.rejects(
    fetchUriToBytes(
      'https://example.com/x.png',
      'image/png',
      {
        fetchImplForTest: async () =>
          new Response(null, {
            headers: { 'content-type': 'image/png' },
          }),
        resolveHost: async () => PUBLIC_IP,
      },
      NEVER,
    ),
    { name: 'FetchUriError', code: 'fetch_failed' },
  );
});

test('fetchUriToBytes: rejects unsupported observed MIME', async () => {
  await assert.rejects(
    fetchUriToBytes(
      'https://example.com/archive.zip',
      'application/zip',
      {
        fetchImplForTest: async () =>
          new Response(Buffer.from('zip'), {
            headers: { 'content-type': 'application/zip', 'content-length': '3' },
          }),
        resolveHost: async () => PUBLIC_IP,
      },
      NEVER,
    ),
    { name: 'FetchUriError', code: 'fetch_mime_mismatch' },
  );
});
