import { createServer } from 'node:http';
import { lstatSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { OutboundRequest, type OutboundHeaders } from '@vicoop-bridge/protocol';

export async function listenOutbound(path: string, issue: (input: OutboundRequest) => Promise<OutboundHeaders>) {
  if (Buffer.byteLength(path) > 103) throw new Error('Outbound socket path exceeds 103 bytes');
  const parent = dirname(path);
  const stat = lstatSync(parent);
  if (!process.getuid || path !== resolve(path) || realpathSync(parent) !== parent ||
      !stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) {
    throw new Error('Outbound socket requires an absolute path in a private, owned directory');
  }
  const server = createServer({ requestTimeout: 5000 }, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'POST' || req.url !== '/sign') { res.writeHead(404).end(); return; }
    let input;
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 8192) { res.writeHead(413).end(); return; }
        chunks.push(chunk);
      }
      input = OutboundRequest.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    } catch { res.writeHead(400).end(); return; }
    try {
      const headers = await issue(input);
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(headers));
    } catch { res.writeHead(503).end(); }
  });
  await new Promise<void>((done, fail) => {
    server.once('error', fail);
    server.listen(path, () => { server.off('error', fail); done(); });
  });
  return server;
}
