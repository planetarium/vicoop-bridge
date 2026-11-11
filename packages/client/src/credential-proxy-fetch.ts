// Materialized inside the runtime as an ESM module. No host secrets or secret
// references are embedded. Native SDK methods and data schemas stay unchanged.
export const CREDENTIAL_PROXY_FETCH = String.raw`
export function createProxyFetch(service, options = {}) {
  const send = options.fetch || globalThis.fetch;
  const passthrough = new Set(options.passthroughOrigins || []);
  return async function proxyFetch(input, init) {
    let request = new Request(input, init);
    let replayBody = init?.body;
    let canReplay = request.body === null || (replayBody != null && !(replayBody instanceof ReadableStream));
    const generatedMultipart = replayBody instanceof FormData && !new Headers(init?.headers).has('content-type');
    let redirects = 0;
    for (;;) {
      const target = new URL(request.url);
      if (target.protocol !== 'https:' || target.username || target.password) throw new Error('Unsupported proxy destination');
      const proxied = service.origins.includes(target.origin);
      if (!proxied && !passthrough.has(target.origin)) throw new Error('Unregistered proxy destination');
      const headers = new Headers(request.headers);
      headers.delete('x-vicoop-proxy-token');
      headers.delete('x-vicoop-target-url');
      headers.delete('x-fal-target-url');
      // A placeholder is never forwarded directly to a storage/download host.
      for (const name of ['authorization', 'x-api-key']) {
        if ((headers.get(name) || '').includes(service.token)) headers.delete(name);
      }
      if (proxied) {
        headers.set('x-vicoop-proxy-token', service.token);
        headers.set('x-vicoop-target-url', target.href);
      }
      const hasBody = request.body !== null;
      // Keep known-size BodyInit values intact. Turning Blob/string/bytes into
      // a ReadableStream loses native Content-Length (release/storage uploads
      // commonly reject chunked encoding). FormData gets a fresh matching header.
      if (hasBody && generatedMultipart) headers.delete('content-type');
      const response = await send(proxied ? service.url : target.href, {
        method: request.method, headers, body: hasBody ? (canReplay ? replayBody : request.body) : undefined,
        ...(hasBody ? { duplex: 'half' } : {}), signal: request.signal, redirect: 'manual',
      });
      const location = response.headers.get('location');
      if (![301,302,303,307,308].includes(response.status) || !location || request.redirect === 'manual') {
        // Do not expose the transport URL as the resource's canonical URL.
        Object.defineProperty(response, 'url', { value: target.href });
        return response;
      }
      if (request.redirect === 'error' || ++redirects > 10) {
        await response.body?.cancel();
        throw new Error('Proxy redirect rejected');
      }
      const next = new URL(location, target);
      const nextHeaders = new Headers(request.headers);
      if (next.origin !== target.origin) {
        for (const name of ['authorization', 'x-api-key', 'cookie']) nextHeaders.delete(name);
      }
      const dropBody = (response.status === 303 && !['GET','HEAD'].includes(request.method)) ||
        ([301,302].includes(response.status) && request.method === 'POST');
      if (dropBody) for (const name of ['content-type','content-length','content-encoding']) nextHeaders.delete(name);
      if (!dropBody && generatedMultipart) nextHeaders.delete('content-type');
      await response.body?.cancel();
      if (!dropBody && hasBody && !canReplay) throw new Error('Cannot replay streaming body across redirect');
      if (dropBody) {replayBody = undefined;canReplay = true;}
      request = new Request(next, { method: dropBody ? 'GET' : request.method,
        headers: nextHeaders, body: !dropBody && hasBody ? replayBody : undefined,
        ...(!dropBody && hasBody ? { duplex: 'half' } : {}), signal: request.signal, redirect: request.redirect });
    }
  };
}
`;
