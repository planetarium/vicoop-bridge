import { spawn as nodeSpawn } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { Duplex, PassThrough, Writable } from 'node:stream';
import { createClaudeAuthBroker, type BrokerOptions } from './claude-auth-broker.js';
import { CLAUDE_BROKER_RELAY } from './claude-broker-relay.js';
import { CLAUDE_BROKER_SUPERVISOR } from './claude-broker-supervisor.js';
import type { ChildHandle, SpawnFn } from './spawn-adapter.js';

// The Docker channel itself binds a grant to this execution and runtime.
// A grant stolen by runtime B is useless on B's separate HTTP parser; there
// is no host TCP listener to address and A listens on container loopback only.
export function createClaudeBrokerSpawn(container: string, opts: BrokerOptions & {
  spawnImpl?: typeof nodeSpawn;
}) {
  const running = new Set<() => void>();
  let stopped = false;
  const spawn: SpawnFn = (command, args, options) => {
    if (stopped) throw new Error('Claude authentication transport is stopped');
    const env = options.env ?? {};
    // Per-spawn backend knobs only. Never carry arbitrary host environment.
    for (const key of Object.keys(env)) {
      if (!['ENABLE_PROMPT_CACHING_1H', 'CLAUDE_CODE_MAX_OUTPUT_TOKENS', 'MAX_THINKING_TOKENS', 'CLAUDE_CODE_EFFORT_LEVEL', 'CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING'].includes(key)) {
        throw new Error(`Unsupported Claude container spawn environment: ${key}`);
      }
    }
    const promptFiles: Array<{argIndex:number; content:Buffer}> = [];
    let stagedBytes = 0;
    for (let i = 0; i < args.length; i++) {
      if (!['--append-system-prompt-file', '--system-prompt-file'].includes(args[i])) continue;
      const path = args[++i];
      if (!path || promptFiles.length >= 2) throw new Error('Invalid Claude prompt-file arguments');
      const stat = statSync(path);
      stagedBytes += stat.size;
      if (!stat.isFile() || stagedBytes > 16 * 1024 * 1024) throw new Error('Claude prompt files exceed the staging limit');
      promptFiles.push({argIndex:i,content:readFileSync(path)});
    }
    const broker = createClaudeAuthBroker(opts);
    // Absolute trusted binaries; disable runtime injection into the privileged
    // supervisor. The last argument is opaque relay source, run only as node.
    const relay = (opts.spawnImpl ?? nodeSpawn)('docker', ['exec', '-i', '--user', '0',
      '-e', 'NODE_OPTIONS=', '-e', 'NODE_PATH=', '-e', 'LD_PRELOAD=', '-e', 'LD_LIBRARY_PATH=',
      container, '/usr/bin/tini', '-s', '--', '/usr/local/bin/node', '-e',
      CLAUDE_BROKER_SUPERVISOR, String(opts.ttlMs ?? 60 * 60_000), CLAUDE_BROKER_RELAY], { stdio: ['pipe', 'pipe', 'pipe'] });
    const events = new EventEmitter();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const sockets = new Map<number, Duplex>();
    let pending = '';
    let ready = false;
    let ended = false;
    let terminating = false;
    let resultCode: number | undefined;
    let readyWrite: (() => void) | undefined;
    let readyEnd: (() => void) | undefined;
    const send = (frame: object) => {
      if (ended || !relay.stdin || relay.stdin.destroyed || relay.stdin.writableEnded) return;
      if (relay.stdin.writableLength > 8 * 1024 * 1024) { fail(); return; }
      relay.stdin.write(JSON.stringify(frame) + '\n');
    };
    const stop = () => {
      broker.revoke();
      send({ t: 'kill', signal: 'SIGKILL' });
      relay.stdin?.end();
    };
    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (ended) return;
      // Mark closed before destroying sockets: their callbacks may call send(),
      // including while a full transport queue is failing this execution.
      ended = true;
      stop();
      clearTimeout(startup);
      clearTimeout(lifetime);
      running.delete(stop);
      stdout.end(); stderr.end();
      events.emit('close', code, signal);
    };
    const fail = () => {
      if (ended || terminating) return;
      terminating = true;
      resultCode = 1;
      stop();
    };
    const startup = setTimeout(fail, 15_000);
    const lifetime = setTimeout(fail, opts.ttlMs ?? 60 * 60_000);
    running.add(stop);
    const stdin = new Writable({
      write(chunk, _encoding, callback) {
        const write = () => {
          for (let offset = 0; offset < chunk.length; offset += 48 * 1024) send({ t: 'stdin', data: chunk.subarray(offset, offset + 48 * 1024).toString('base64') });
          callback();
        };
        if (ready) write(); else readyWrite = write;
      },
      final(callback) {
        const end = () => { send({ t: 'end' }); callback(); };
        if (ready) end(); else readyEnd = end;
      },
    });
    relay.stdin?.on('error', fail);
    relay.on('error', fail);
    relay.on('close', (code) => {
      // A successful supervisor exit proves descendant cleanup, irrespective
      // of the untrusted relay's claimed exit frame. Never finish on that frame.
      if (code === 0) { finish(resultCode ?? 1, null); return; }
      // Supervisor/Docker failure leaves cleanup uncertain. Fail closed for the
      // shared runtime through the independent Docker control plane.
      stopped = true;
      for (const stop of running) stop();
      const cleanup = nodeSpawn('docker', ['stop', '-t', '0', container], {stdio:'ignore'});
      let cleanupReported = false;
      const cleanupFinished = (confirmed: boolean) => {
        if (cleanupReported) return;
        cleanupReported = true;
        if (!confirmed) console.error('Claude runtime cleanup could not be confirmed; new executions are disabled. Restore Docker access and stop the runtime before restarting.');
        finish(1, null);
      };
      cleanup.on('error', () => cleanupFinished(false));
      cleanup.on('close', (code) => cleanupFinished(code === 0));
    });
    // Docker diagnostics can include command lines; keep them off task output.
    relay.stderr?.resume();
    relay.stdout?.on('data', (chunk: Buffer) => {
      if (ended) return;
      pending += chunk.toString('utf8');
      let end: number;
      while ((end = pending.indexOf('\n')) !== -1) {
        if (end > 256 * 1024) { fail(); return; }
        const line = pending.slice(0, end); pending = pending.slice(end + 1);
        try {
          const m = JSON.parse(line);
          if (m.t === 'ready') { ready = true; clearTimeout(startup); readyWrite?.(); readyWrite = undefined; readyEnd?.(); readyEnd = undefined; }
          else if (m.t === 'exit') { resultCode ??= Number.isInteger(m.code) ? m.code : 1; return; }
          else if (m.t === 'error') { fail(); return; }
          else if (m.t === 'stdout' || m.t === 'stderr') {
            const stream = m.t === 'stdout' ? stdout : stderr;
            if (stream.readableLength > 8 * 1024 * 1024) { fail(); return; }
            stream.write(Buffer.from(m.data, 'base64'));
          } else if (m.t === 'open') {
            if (!Number.isSafeInteger(m.id) || m.id < 1 || sockets.has(m.id) || sockets.size >= 16) { fail(); return; }
            const socket = new Duplex({
              read() {},
              write(data, _encoding, callback) {
                for (let offset = 0; offset < data.length; offset += 48 * 1024) send({ t: 'data', id: m.id, data: data.subarray(offset, offset + 48 * 1024).toString('base64') });
                callback();
              },
              destroy(_err, callback) { send({ t: 'close', id: m.id }); sockets.delete(m.id); callback(); },
            });
            socket.on('error', () => socket.destroy());
            sockets.set(m.id, socket);
            broker.attach(socket);
          } else if (m.t === 'data') {
            const socket = sockets.get(m.id);
            if (socket) {
              if (socket.readableLength > 1024 * 1024) socket.destroy();
              else socket.push(Buffer.from(m.data, 'base64'));
            }
          } else if (m.t === 'close') sockets.get(m.id)?.destroy();
          else { fail(); return; }
        } catch { fail(); return; }
      }
      if (pending.length > 256 * 1024) fail();
    });
    // Only host-generated CLI prompt-file arguments are read here. Workload
    // frames cannot request host files. Transfer in bounded chunks before ready.
    void (async () => {
      for (let id = 0; id < promptFiles.length; id++) {
        const content = promptFiles[id].content;
        for (let offset = 0; offset < content.length; offset += 48 * 1024) {
          if (ended || !relay.stdin || relay.stdin.destroyed) return;
          const frame = {t:'file',id,data:content.subarray(offset,offset + 48 * 1024).toString('base64')};
          await new Promise<void>((resolve,reject) => relay.stdin!.write(JSON.stringify(frame) + '\n', err => err ? reject(err) : resolve()));
        }
      }
      send({ t: 'start', command, args, cwd: options.cwd, env, token: broker.token,
        authentication: opts.authentication ?? 'oauth', files:promptFiles.map((file,id)=>({id,argIndex:file.argIndex})) });
    })().catch(fail);
    return Object.assign(events, {
      stdin, stdout, stderr,
      kill(signal: NodeJS.Signals = 'SIGTERM') {
        broker.revoke();
        send({ t: 'kill', signal });
        return !ended;
      },
    }) as ChildHandle;
  };
  return { spawn, close() { stopped = true; for (const stop of running) stop(); } };
}
