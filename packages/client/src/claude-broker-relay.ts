// Runs INSIDE the workload. Contains no host credential or host destination.
// JSON-lines multiplex raw HTTP sockets and the agent's stdio over docker exec.
// Keep as source text so Bun-compiled clients need no extra runtime asset.
export const CLAUDE_BROKER_RELAY = String.raw`
'use strict';
const net = require('node:net');
const {spawn} = require('node:child_process');
let child, server, next = 0, pending = '', started = false, closing = false;
const sockets = new Map();
function send(frame) {
  if (process.stdout.writableLength > 8 * 1024 * 1024) return shutdown(1);
  process.stdout.write(JSON.stringify(frame) + '\n');
}
function killGroup(signal) {
  if (child && child.pid) { try { process.kill(-child.pid, signal); } catch {} }
}
function shutdown(code) {
  if (closing) return;
  closing = true;
  killGroup('SIGKILL');
  for (const socket of sockets.values()) socket.destroy();
  if (server) server.close();
  process.exit(code);
}
process.stdin.on('end', () => shutdown(1));
process.stdin.on('error', () => shutdown(1));
process.stdout.on('error', () => shutdown(1));
process.on('SIGTERM', () => shutdown(1));
process.on('SIGINT', () => shutdown(1));
process.stdin.on('data', chunk => {
  pending += chunk.toString('utf8');
  let end;
  while ((end = pending.indexOf('\n')) !== -1) {
    if (end > 256 * 1024) return shutdown(1);
    const line = pending.slice(0, end); pending = pending.slice(end + 1);
    try { receive(JSON.parse(line)); } catch { return shutdown(1); }
  }
  if (pending.length > 256 * 1024) shutdown(1);
});
function receive(m) {
  if (m.t === 'start' && !started) {
    started = true;
    server = net.createServer(socket => {
      if (sockets.size >= 16) return socket.destroy();
      const id = ++next;
      sockets.set(id, socket);
      send({t:'open', id});
      socket.on('data', data => send({t:'data', id, data:data.toString('base64')}));
      socket.on('error', () => {});
      socket.on('close', () => { sockets.delete(id); send({t:'close', id}); });
    });
    server.on('error', () => shutdown(1));
    server.listen(0, '127.0.0.1', () => {
      // Container creation rejects provider credentials; also strip inherited
      // provider overrides so a custom image cannot redirect the selected API.
      const env = {...process.env};
      for (const k of Object.keys(env)) {
        if (/^(ANTHROPIC_|CLAUDE_CODE_OAUTH|CLAUDE_CODE_USE_)/.test(k)) delete env[k];
      }
      Object.assign(env, m.env, {
        ANTHROPIC_BASE_URL:'http://127.0.0.1:' + server.address().port,
        ...(m.authentication === 'api-key' ? {ANTHROPIC_API_KEY:m.token} : {CLAUDE_CODE_OAUTH_TOKEN:m.token}),
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',
      });
      child = spawn(m.command, m.args, {cwd:m.cwd, env, detached:true, stdio:['pipe','pipe','pipe']});
      child.stdout.on('data', data => send({t:'stdout', data:data.toString('base64')}));
      child.stderr.on('data', data => send({t:'stderr', data:data.toString('base64')}));
      child.stdin.on('error', () => {});
      child.on('error', () => { send({t:'error'}); shutdown(1); });
      child.on('exit', () => killGroup('SIGKILL'));
      child.on('close', (code, signal) => {
        killGroup('SIGKILL');
        send({t:'exit', code, signal});
        // Flush the exit frame before closing the Docker stream.
        process.stdout.write('', () => shutdown(0));
      });
      send({t:'ready'});
    });
  } else if (m.t === 'stdin' && child) {
    if (child.stdin.writableLength > 8 * 1024 * 1024) return shutdown(1);
    child.stdin.write(Buffer.from(m.data, 'base64'));
  } else if (m.t === 'end' && child) child.stdin.end();
  else if (m.t === 'kill') {
    killGroup(m.signal === 'SIGKILL' ? 'SIGKILL' : 'SIGTERM');
    setTimeout(() => shutdown(1), 2000).unref();
  } else if (m.t === 'data') {
    const socket = sockets.get(m.id);
    if (socket) {
      if (socket.writableLength > 1024 * 1024) socket.destroy();
      else socket.write(Buffer.from(m.data, 'base64'));
    }
  } else if (m.t === 'close') sockets.get(m.id)?.destroy();
}
`;
